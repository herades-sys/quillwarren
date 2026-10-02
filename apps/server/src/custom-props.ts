// This Delve's own props: one shared library for every GM and admin, drawn by
// Claude in the editor's chat (MCP create_prop) or sent over the API. Each prop
// is <dir>/<id>.svg (the checked, inked, cleaned art the renderer draws) and
// <dir>/<id>.source.svg (the SVG as it was sent, for redrawing it later), with
// the metadata in <dir>/index.json. Without a data directory the library lives
// in a temp dir removed on close (tests). Every change re-registers the list
// with core (registerAssets), so assetInfo, propBounds, the renderer and the
// chat know custom props like built-in ones, and the server's renders find
// their art through assets.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assetInfo,
  assetSvg,
  buildScene,
  checkPropSize,
  checkPropSvg,
  CUSTOM_ID,
  CUSTOM_PREFIX,
  FORMAT,
  FORMAT_VERSION,
  parseAssetSvg,
  PROP_CATEGORIES,
  registerAssets,
  resolveStyle,
  scaleBody,
  sceneToSvg,
  type AssetInfo,
  type Blocks,
  type DelveMap,
} from '@delve/core';
import { currentAccount } from './accounts/http.ts';
import { bearer, checkToken } from './auth.ts';
import { writeGuard } from './api.ts';
import { addCustomPropSource, assets } from './assets.ts';
import type { EditorAuth } from './login.ts';
import { svgToPng } from './png.ts';
import type { MapStore } from './store.ts';

export interface CustomProp {
  id: string;
  name: string;
  category: string;
  w: number;
  h: number;
  tags: string[];
  blocks: Blocks;
  /** false: the lines are kept exactly as drawn (art that is already hand-inked). */
  ink: boolean;
  created: string;
  updated: string;
  by: string;
}

/** What a create or an update asks for; a create needs name, w, h and svg. */
export interface PropInput {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  w?: unknown;
  h?: unknown;
  tags?: unknown;
  blocks?: unknown;
  svg?: unknown;
  ink?: unknown;
}

export class PropError extends Error {
  readonly status: number;
  readonly problems: string[];
  constructor(status: number, problems: string[] | string) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.length === 1 ? list[0] : `${list.length} problems:\n- ${list.join('\n- ')}`);
    this.name = 'PropError';
    this.status = status;
    this.problems = list;
  }
}

const BLOCKS: readonly Blocks[] = ['none', 'movement', 'sight'];
const CATEGORY_IDS = new Set(PROP_CATEGORIES.map((c) => c.id));
export const MAX_CUSTOM_PROPS = 1000;

/** A printable name, trimmed, at most 60 characters. */
const cleanName = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '');
const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '') // blacksmith's -> blacksmiths
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

/** "my-" plus a slug of what was asked for (an id or the name). */
export function customId(wanted: string): string {
  const s = slug(wanted.startsWith(CUSTOM_PREFIX) ? wanted.slice(CUSTOM_PREFIX.length) : wanted);
  return `${CUSTOM_PREFIX}${s || 'prop'}`;
}

function cleanTags(v: unknown): string[] | null {
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!list) return null;
  const out = list.filter((t): t is string => typeof t === 'string').map((t) => slug(t).slice(0, 24)).filter(Boolean);
  return [...new Set(out)].slice(0, 12);
}

export const toAssetInfo = (p: CustomProp): AssetInfo => ({
  id: p.id,
  name: p.name,
  category: p.category,
  kind: 'prop',
  w: p.w,
  h: p.h,
  tags: p.tags,
  blocks: p.blocks,
  file: `props/${p.id}.svg`,
  custom: true,
  by: p.by,
  created: p.created,
  updated: p.updated,
});

/** The library whose list is in core's registry right now (the last one to change), and every open one (tests run several). */
let registered: PropLibrary | null = null;
const open = new Set<PropLibrary>();

export class PropLibrary {
  private dir: string | null;
  private readonly temporary: boolean;
  private index: Map<string, CustomProp> | null = null;
  private readonly bodies = new Map<string, string>();
  private readonly detach: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(dir: string | undefined) {
    this.dir = dir ?? null;
    this.temporary = !dir;
    // the renderer (assets.body) finds custom art here
    this.detach = addCustomPropSource((id) => this.body(id));
    open.add(this);
    this.sync();
  }

  private folder(): string {
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'delve-props-'));
    else mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /** index.json, plus any prop file it doesn't know about (a lost or older index). */
  private entries(): Map<string, CustomProp> {
    if (this.index) return this.index;
    const index = new Map<string, CustomProp>();
    if (this.dir && existsSync(this.dir)) {
      let saved: Record<string, Partial<CustomProp>> = {};
      try {
        saved = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as Record<string, Partial<CustomProp>>;
      } catch {
        saved = {};
      }
      for (const file of readdirSync(this.dir)) {
        const m = /^(my-[a-z0-9-]+)\.svg$/.exec(file);
        if (!m || !CUSTOM_ID.test(m[1]!)) continue;
        const id = m[1]!;
        const known = saved[id] ?? {};
        let w = Number(known.w);
        let h = Number(known.h);
        if (checkPropSize(w, h).length) {
          const parsed = parseAssetSvg(readFileSync(join(this.dir, file), 'utf8'));
          w = parsed.w;
          h = parsed.h;
        }
        if (checkPropSize(w, h).length) continue;
        const when = typeof known.created === 'string' ? known.created : new Date(0).toISOString();
        index.set(id, {
          id,
          name: cleanName(known.name) || id.slice(CUSTOM_PREFIX.length).replace(/-/g, ' '),
          category: typeof known.category === 'string' && CATEGORY_IDS.has(known.category) ? known.category : 'custom',
          w,
          h,
          tags: cleanTags(known.tags) ?? [],
          blocks: BLOCKS.includes(known.blocks as Blocks) ? (known.blocks as Blocks) : 'movement',
          ink: known.ink !== false,
          created: when,
          updated: typeof known.updated === 'string' ? known.updated : when,
          by: typeof known.by === 'string' ? known.by.slice(0, 60) : 'unknown',
        });
      }
    }
    this.index = index;
    return index;
  }

  private save(): void {
    const dir = this.folder();
    const tmp = join(dir, `.index.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries()), null, 1));
    renameSync(tmp, join(dir, 'index.json'));
  }

  private write(name: string, text: string): void {
    const dir = this.folder();
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, name));
  }

  /** Tell core (and so the renderer, the chat and MCP) what the library holds. */
  private sync(): void {
    registerAssets(this.list().map(toAssetInfo));
    registered = this;
    for (const f of this.listeners) f();
  }

  /** Runs after every change (create, update, delete). Returns the undo. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Newest first. */
  list(): CustomProp[] {
    return [...this.entries().values()].sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }

  get(id: string): CustomProp | undefined {
    return CUSTOM_ID.test(id) ? this.entries().get(id) : undefined;
  }

  /** The cleaned art body, as the renderer wants it. */
  body(id: string): string | undefined {
    const p = this.get(id);
    if (!p || !this.dir) return undefined;
    const cached = this.bodies.get(id);
    if (cached !== undefined) return cached;
    try {
      const body = parseAssetSvg(readFileSync(join(this.dir, `${id}.svg`), 'utf8')).body;
      this.bodies.set(id, body);
      return body;
    } catch {
      return undefined;
    }
  }

  /** The standalone cleaned SVG (what /assets/props/<id>.svg serves). */
  svg(id: string): string | undefined {
    const p = this.get(id);
    const body = this.body(id);
    return p && body !== undefined ? assetSvg({ w: p.w, h: p.h, body }) : undefined;
  }

  /** The SVG as it was sent (before inking), for redrawing it. */
  source(id: string): string | undefined {
    if (!this.get(id) || !this.dir) return undefined;
    const file = join(this.dir, `${id}.source.svg`);
    return existsSync(file) ? readFileSync(file, 'utf8') : this.svg(id);
  }

  private parseMeta(input: PropInput, base: Partial<CustomProp>, creating: boolean): { meta: Omit<CustomProp, 'id' | 'created' | 'updated' | 'by'>; problems: string[] } {
    const problems: string[] = [];
    let name = base.name ?? '';
    if (input.name !== undefined) {
      name = cleanName(input.name);
      if (!name) problems.push('name: give the prop a name, e.g. "Blacksmith’s anvil"');
    } else if (creating) problems.push('name: give the prop a name, e.g. "Blacksmith’s anvil"');
    let category = base.category ?? 'custom';
    if (input.category !== undefined && input.category !== null && input.category !== '') {
      if (typeof input.category !== 'string' || !CATEGORY_IDS.has(input.category)) problems.push(`category: one of ${[...CATEGORY_IDS].join(', ')}`);
      else category = input.category;
    }
    let tags = base.tags ?? [];
    if (input.tags !== undefined) {
      const t = cleanTags(input.tags);
      if (!t) problems.push('tags: a list of words, e.g. ["smithy", "metal"]');
      else tags = t;
    }
    let blocks: Blocks = base.blocks ?? 'movement';
    if (input.blocks !== undefined) {
      if (!BLOCKS.includes(input.blocks as Blocks)) problems.push('blocks: none (walk over it), movement (blocks walking) or sight (blocks walking and the view)');
      else blocks = input.blocks as Blocks;
    }
    let ink = base.ink ?? true;
    if (input.ink !== undefined) {
      if (typeof input.ink !== 'boolean') problems.push('ink: true or false');
      else ink = input.ink;
    }
    const w = input.w !== undefined ? (input.w as number) : base.w;
    const h = input.h !== undefined ? (input.h as number) : base.h;
    if (creating && (w === undefined || h === undefined)) problems.push('w and h: the footprint in squares, e.g. w 1, h 1');
    else problems.push(...checkPropSize(w, h));
    return { meta: { name, category, tags, blocks, ink, w: w as number, h: h as number }, problems };
  }

  /** Check and ink the art; throws PropError with every problem. */
  private art(svg: string, w: number, h: number, ink: boolean, id: string): { body: string; notes: string[] } {
    const check = checkPropSvg(svg, { w, h, ink, seed: id });
    if (!check.ok) throw new PropError(400, check.problems);
    return { body: check.body, notes: check.notes };
  }

  /** Save a new prop. The id is "my-" + a slug of `id` or the name; a taken name gets -2, -3… unless the id was asked for. */
  create(input: PropInput, by: string): { prop: CustomProp; notes: string[] } {
    const { meta, problems } = this.parseMeta(input, {}, true);
    if (typeof input.svg !== 'string' || !input.svg.trim()) problems.push('svg: the drawing, a standalone <svg> with viewBox "0 0 {w*100} {h*100}"');
    if (input.id !== undefined && (typeof input.id !== 'string' || !slug(input.id))) problems.push('id: lower-case words, e.g. "anvil-tongs" (it becomes my-anvil-tongs)');
    if (problems.length) throw new PropError(400, problems);
    const index = this.entries();
    if (index.size >= MAX_CUSTOM_PROPS) throw new PropError(409, `the library is full (${MAX_CUSTOM_PROPS} props): delete some first`);
    let id = customId(typeof input.id === 'string' ? input.id : meta.name);
    if (index.has(id)) {
      if (input.id !== undefined) throw new PropError(409, `${id} already exists: pick another id, or change it with update_prop`);
      const stem = id.slice(0, 56);
      let k = 2;
      while (index.has(`${stem}-${k}`)) k++;
      id = `${stem}-${k}`;
    }
    const { body, notes } = this.art(input.svg as string, meta.w, meta.h, meta.ink, id);
    const now = new Date().toISOString();
    const prop: CustomProp = { id, ...meta, created: now, updated: now, by: by.slice(0, 60) };
    this.write(`${id}.source.svg`, input.svg as string);
    this.write(`${id}.svg`, assetSvg({ w: meta.w, h: meta.h, body }));
    this.bodies.set(id, body);
    index.set(id, prop);
    this.save();
    this.sync();
    return { prop, notes };
  }

  /**
   * Change a prop's art and/or metadata. A new size without new art redraws
   * the old drawing at that size (line weights stay); new art must fit the
   * size it is sent with.
   */
  update(id: string, input: PropInput): { prop: CustomProp; notes: string[]; redrawn: boolean } {
    const old = this.get(id);
    if (!old) throw new PropError(404, `no custom prop ${id} (see GET /api/v1/props)`);
    if (input.id !== undefined && input.id !== id) throw new PropError(400, 'id: a prop keeps its id (maps use it); give it a new name instead');
    const { meta, problems } = this.parseMeta(input, old, false);
    if (input.svg !== undefined && (typeof input.svg !== 'string' || !input.svg.trim())) problems.push('svg: the drawing, a standalone <svg>');
    if (problems.length) throw new PropError(400, problems);
    const resized = meta.w !== old.w || meta.h !== old.h;
    let source: string | undefined;
    let art: { body: string; notes: string[] } | undefined;
    if (typeof input.svg === 'string') {
      source = input.svg;
      art = this.art(source, meta.w, meta.h, meta.ink, id);
    } else if (resized || meta.ink !== old.ink) {
      // no new drawing: the old one, scaled to the new footprint (or inked differently)
      const was = this.source(id) ?? '';
      const parsed = parseAssetSvg(was);
      source = resized ? assetSvg({ w: meta.w, h: meta.h, body: scaleBody(parsed.body, meta.w / old.w, meta.h / old.h) }) : was;
      art = this.art(source, meta.w, meta.h, meta.ink, id);
      if (resized) art.notes.unshift(`redrew the old drawing at ${meta.w}×${meta.h} (line weights kept)`);
    }
    const prop: CustomProp = { ...old, ...meta, updated: new Date().toISOString() };
    if (art && source !== undefined) {
      this.write(`${id}.source.svg`, source);
      this.write(`${id}.svg`, assetSvg({ w: meta.w, h: meta.h, body: art.body }));
      this.bodies.set(id, art.body);
    }
    this.entries().set(id, prop);
    this.save();
    this.sync();
    return { prop, notes: art?.notes ?? [], redrawn: Boolean(art) };
  }

  remove(id: string): boolean {
    if (!this.get(id) || !this.dir) return false;
    for (const f of [`${id}.svg`, `${id}.source.svg`]) rmSync(join(this.dir, f), { force: true });
    this.entries().delete(id);
    this.bodies.delete(id);
    this.save();
    this.sync();
    return true;
  }

  close(): void {
    this.detach();
    open.delete(this);
    if (registered === this) {
      registered = null;
      const other = [...open].at(-1);
      if (other) other.sync();
      else registerAssets([]);
    }
    if (this.temporary && this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The maps (not deleted) that place this prop, with how many copies. */
export function mapsUsingProp(store: MapStore, id: string): { id: string; name: string; count: number }[] {
  const out: { id: string; name: string; count: number }[] = [];
  for (const m of store.list()) {
    try {
      const count = store.get(m.id).map.objects.filter((o) => o.type === 'prop' && o.asset === id).length;
      if (count) out.push({ id: m.id, name: m.name, count });
    } catch {
      // gone in the meantime
    }
  }
  return out;
}

// ---------- the preview: the prop on a small floor, in three styles ----------

export const PREVIEW_STYLES = ['classic-hatching', 'print', 'parchment'] as const;
export const PREVIEW_PPG = 70;

/**
 * The prop in the middle of a floor at least 3×3 squares (one square of floor
 * around it), at 70 px per square, in each preview style side by side, each
 * with its name underneath, then the prop alone, enlarged (about 3×, at most
 * 420 px a side) on white, to check the drawing itself. What Claude looks at
 * to judge its own work.
 */
export function previewSvg(propId: string, o: { ppg?: number; styles?: readonly string[]; detail?: boolean } = {}): string {
  const ppg = o.ppg ?? PREVIEW_PPG;
  const styles = o.styles ?? PREVIEW_STYLES;
  const info = assetInfo(propId);
  const w = info?.w ?? 1;
  const h = info?.h ?? 1;
  const fw = Math.max(3, Math.ceil(w) + 2);
  const fh = Math.max(3, Math.ceil(h) + 2);
  const pad = 0.5;
  const panelW = (fw + 2 * pad) * ppg;
  const panelH = (fh + 2 * pad) * ppg;
  const gap = 12;
  const label = 26;
  // the detail panel: the footprint and a quarter square around it, in the print style without a grid
  const detail = o.detail !== false;
  const dppg = Math.round(Math.min(3 * ppg, 420 / (Math.max(w, h) + 0.5)));
  const dW = detail ? (w + 0.5) * dppg : 0;
  const dH = detail ? (h + 0.5) * dppg : 0;
  const W = styles.length * panelW + (styles.length + 1) * gap + (detail ? dW + gap : 0);
  const H = Math.max(panelH, dH) + label + 2 * gap;
  const map: DelveMap = {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: 'map_prop_preview',
    name: 'Prop preview',
    grid: { type: 'square', unit: '5 ft' },
    style: { preset: 'classic-hatching' },
    seed: 7,
    objects: [
      { id: 'r1', type: 'room', shape: { rect: [0, 0, fw, fh] } },
      { id: 'i1', type: 'prop', asset: propId, at: [fw / 2, fh / 2] },
    ],
  } as DelveMap;
  let panels = '';
  styles.forEach((preset, k) => {
    const m = { ...map, style: { preset } } as DelveMap;
    const scene = buildScene(m, { view: 'gm', grid: true, assets: assets.body, frame: { x0: -pad, y0: -pad, x1: fw + pad, y1: fh + pad } }, resolveStyle(m));
    const x = gap + k * (panelW + gap);
    panels += sceneToSvg(scene, { frame: { x, y: gap, width: panelW, height: panelH }, idPrefix: `pv${k}-` });
    panels += `<text x="${x + panelW / 2}" y="${gap + panelH + 19}" font-family="IM FELL English" font-size="16" text-anchor="middle" fill="#3A3530">${preset}</text>`;
  });
  if (detail) {
    const m = { ...map, style: { preset: 'print' } } as DelveMap;
    const [cx, cy] = [fw / 2, fh / 2];
    const scene = buildScene(m, { view: 'gm', grid: false, assets: assets.body, frame: { x0: cx - w / 2 - 0.25, y0: cy - h / 2 - 0.25, x1: cx + w / 2 + 0.25, y1: cy + h / 2 + 0.25 } }, resolveStyle(m));
    const x = gap + styles.length * (panelW + gap);
    panels += sceneToSvg(scene, { frame: { x, y: gap, width: dW, height: dH }, idPrefix: 'pvd-' });
    panels += `<text x="${x + dW / 2}" y="${gap + Math.max(panelH, dH) + 19}" font-family="IM FELL English" font-size="16" text-anchor="middle" fill="#3A3530">detail, ${Math.round((dppg / ppg) * 10) / 10}×</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#E9E5DA"/>${panels}</svg>`;
}

export const previewPng = async (propId: string): Promise<Buffer> => svgToPng(previewSvg(propId));

// ---------- routes ----------

export interface PropDeps {
  props: PropLibrary;
  store: MapStore;
  token: string | undefined;
  auth: EditorAuth;
}

/** Who made a change: the account's name, "api" for the token, "editor" for the shared password or an open dev server. */
export function changedBy(auth: EditorAuth, token: string | undefined, req: FastifyRequest): string {
  const account = currentAccount(auth, req)?.user.name;
  if (account) return account;
  return checkToken(token, bearer(req.headers.authorization)) === 'ok' ? 'api' : 'editor';
}

const withUrls = (p: CustomProp) => ({ ...p, custom: true, url: `/assets/props/${p.id}.svg?v=${encodeURIComponent(p.updated)}`, preview: `/api/v1/props/${p.id}/preview.png?v=${encodeURIComponent(p.updated)}` });

export function registerPropRoutes(app: FastifyInstance, { props, store, token, auth }: PropDeps): void {
  const writer = writeGuard(token, auth.sessions);
  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PropError) return reply.code(e.status).send({ error: e.message, problems: e.problems });
    throw e;
  };
  const opts = { preHandler: writer, bodyLimit: 512 * 1024 };

  app.get('/api/v1/props', async () => ({ categories: PROP_CATEGORIES, props: props.list().map(withUrls) }));

  app.get('/api/v1/props/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = props.get(id);
    if (!p) return reply.code(404).send({ error: 'no such prop' });
    return { ...withUrls(p), svg: props.source(id), maps: mapsUsingProp(store, id) };
  });

  app.get('/api/v1/props/:id/preview.png', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!props.get(id)) return reply.code(404).send({ error: 'no such prop' });
    return reply.type('image/png').header('cache-control', 'no-cache').send(await previewPng(id));
  });

  app.post('/api/v1/props', opts, async (req, reply) => {
    try {
      const { prop, notes } = props.create((req.body ?? {}) as PropInput, changedBy(auth, token, req));
      return reply.code(201).send({ prop: withUrls(prop), notes });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.put('/api/v1/props/:id', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { prop, notes } = props.update(id, (req.body ?? {}) as PropInput);
      return reply.send({ prop: withUrls(prop), notes });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  // Deleting a prop that maps still use is refused with the list of maps;
  // ?force=1 deletes it anyway, and those maps then draw a dashed outline in its place.
  app.delete('/api/v1/props/:id', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!props.get(id)) return reply.code(404).send({ error: 'no such prop' });
    const force = (req.query as { force?: string }).force === '1';
    const maps = mapsUsingProp(store, id);
    if (maps.length && !force) {
      return reply.code(409).send({
        error: `still used on ${maps.length === 1 ? 'the map' : `${maps.length} maps:`} ${maps.map((m) => `"${m.name}"`).join(', ')}; remove it there first, or delete with ?force=1 (those maps then show a dashed outline in its place)`,
        maps,
      });
    }
    props.remove(id);
    return reply.code(204).send();
  });
}
