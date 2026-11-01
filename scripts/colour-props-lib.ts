// Imports the colour props (docs/ASSETS-COLOUR.md) from the folder their
// batches are drawn in (~/colour-props on the dev container: batch-NN/manifest.json plus
// batch-NN/colour/<category>/<id>.svg, finished when batch-NN/DONE exists) into
// the repo:
//   delve-props-design-system/assets/colour/<category>/<id>.svg   the art, as drawn
//   delve-props-design-system/assets/colour/manifest.json         every imported entry, with its batch
//   packages/core/src/assets/catalog-colour.json                  what Quillwarren knows about each (core catalog.ts)
// Seamless textures (`"tile": true`) go in as colour terrain, for the Terrain
// tool and add_terrain, not as props. Only manifest entries count: a stray SVG
// in a batch is ignored. Any batch-00 … batch-99 folder is looked at.
// Unfinished batches are skipped, and every run rebuilds all three from the
// finished batches, so it can run again whenever more are done. Each prop is
// checked with the art's own rules (the same as ~/colour-props/tools/props.mjs,
// with the palette read from the prompt pack) and with the renderer's
// whitelist; a prop that fails is left out and reported.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASSETS, COLOUR_HEX, COLOUR_PREFIX, parseAssetSvg } from '../packages/core/src/index.ts';

export const COLOUR_DIR = 'delve-props-design-system/assets/colour';
export const COLOUR_CATALOG = 'packages/core/src/assets/catalog-colour.json';
const PACK = 'docs/ASSETS-COLOUR.md';
const MAX_BYTES = 40 * 1024;

/** Picker names for the categories the pack uses, in picker order; any other comes after them, named by its id. */
const CATEGORY_NAMES: Record<string, string> = { trees: 'Trees', plants: 'Plants', nature: 'Nature', rocks: 'Rocks', carpets: 'Carpets', trapdoors: 'Trapdoors', traps: 'Hidden traps', ruins: 'Ruins', furniture: 'Furniture', tavern: 'Tavern', kitchen: 'Kitchen', hall: 'Hall', library: 'Library', market: 'Market', camp: 'Camp', water: 'Water', light: 'Light', arcane: 'Arcane', floors: 'Floors', ground: 'Ground', climb: 'Climbable', portals: 'Portals', magic: 'Magic' };
const ORDER = Object.keys(CATEGORY_NAMES);
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
const categoryName = (id: string) => CATEGORY_NAMES[id] ?? id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Modular pieces (EXTRA-RUINS.md): the ruin walls and foundations, whose open ends meet when placed on whole squares. */
const isModular = (e: Entry) => e.category === 'ruins' && /^ruin-(wall|foundation)/.test(e.group ?? '');
/** Seamless textures (`tile`, EXTRA-SET2.md) become colour terrain; water you swim in or wade through is difficult terrain. */
const isDifficult = (e: Entry) => e.tile === true && e.tags.some((t) => t === 'swim' || t === 'difficult terrain');

type Blocks = 'none' | 'movement' | 'sight';
interface Entry {
  id: string;
  name: string;
  category: string;
  w: number;
  h: number;
  tags: string[];
  blocks: Blocks;
  palette: 'colour';
  layer: 'floor' | 'props';
  group?: string;
  hidden?: true;
  /** A seamless texture: copies placed edge to edge form one surface. Quillwarren makes it a colour terrain texture. */
  tile?: true;
}

export interface ImportOptions {
  /** The batches' folder, e.g. ~/colour-props. */
  source: string;
  /** The repo root: the pack is read from it, the art and the catalog are written into it. */
  repo: string;
}

export interface ImportResult {
  /** Finished batches, imported. */
  batches: string[];
  /** Batches without DONE, left for a later run. */
  unfinished: string[];
  /** Props and textures imported, and how many of them are textures (terrain). */
  props: number;
  textures: number;
  categories: { id: string; name: string; count: number }[];
  /** Props left out, and why. */
  problems: string[];
}

/** The palette from Prompt 0 of the pack: every hex between "THE QUILLWARREN PALETTE" and "FILES:". */
export function packPalette(text: string): Set<string> {
  const a = text.indexOf('THE QUILLWARREN PALETTE');
  const b = text.indexOf('FILES:', a);
  if (a < 0 || b < 0) throw new Error(`no palette found in ${PACK}`);
  return new Set((text.slice(a, b).match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));
}

// ---------- the art's rules, as in tools/props.mjs ----------

const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const ATTRS = new Set(['xmlns', 'viewBox', 'width', 'height', 'version', 'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'transform', 'stroke-dasharray']);
const BLOCKS = new Set(['none', 'movement', 'sight']);
const LAYERS = new Set(['floor', 'props']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkEntry(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!KEBAB.test(String(e.id ?? ''))) out.push('id must be kebab-case');
  if (!KEBAB.test(String(e.category ?? ''))) out.push('category must be kebab-case');
  if (typeof e.name !== 'string' || !e.name.trim()) out.push('name missing');
  for (const k of ['w', 'h']) if (!Number.isInteger(e[k]) || (e[k] as number) < 1 || (e[k] as number) > 6) out.push(`${k} must be a whole number from 1 to 6`);
  if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string' && !t.includes(','))) out.push('tags must be an array of words (no commas)');
  if (!BLOCKS.has(e.blocks as string)) out.push('blocks must be none, movement or sight');
  if (e.palette !== 'colour') out.push('palette must be "colour"');
  if (!LAYERS.has(e.layer as string)) out.push('layer must be floor or props');
  if (e.group !== undefined && !KEBAB.test(String(e.group))) out.push('group must be kebab-case');
  if (e.hidden !== undefined && e.hidden !== true) out.push('hidden is true or left out');
  if (e.tile !== undefined && e.tile !== true) out.push('tile is true or left out');
  return out;
}

function checkSvg(svg: string, e: Entry, colours: Set<string>): string[] {
  const out: string[] = [];
  if (Buffer.byteLength(svg, 'utf8') > MAX_BYTES) out.push('over 40 KB');
  const body = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!body.startsWith('<svg')) out.push('does not start with <svg>');
  let root: string | null = null;
  for (const m of body.matchAll(/<\s*([A-Za-z][\w:.-]*)([^>]*)>/g)) {
    const [, tag, rest] = m as unknown as [string, string, string];
    if (!TAGS.has(tag)) {
      out.push(`<${tag}> is not allowed`);
      continue;
    }
    if (tag === 'svg') {
      if (root !== null) out.push('nested <svg>');
      root = rest;
    }
    for (const a of rest.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1]!;
      const value = a[3] ?? a[4] ?? '';
      if (!ATTRS.has(name)) {
        out.push(`attribute ${name} on <${tag}> is not allowed`);
        continue;
      }
      if ((name === 'fill' || name === 'stroke') && value.trim() !== 'none' && (!/^#[0-9A-Fa-f]{6}$/.test(value.trim()) || !colours.has(value.trim().toUpperCase()))) {
        out.push(`${name}="${value}" is not a palette colour`);
      }
      if (name === 'stroke-dasharray' && e.hidden !== true) out.push('stroke-dasharray only on hidden props (the GM outline)');
      if (name === 'transform' && !/^\s*((translate|rotate)\([^)]*\)\s*)+$/.test(value)) out.push(`transform "${value}": only translate/rotate`);
    }
  }
  const vb = root === null ? null : /viewBox\s*=\s*["']\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*["']/.exec(root);
  if (!vb) out.push('viewBox must be "0 0 W H"');
  else if (Number(vb[1]) !== e.w * 100 || Number(vb[2]) !== e.h * 100) out.push(`viewBox ${vb[1]}×${vb[2]}, manifest says ${e.w}×${e.h} squares`);
  // and what Quillwarren's renderer makes of it: nothing may be dropped or snapped
  for (const p of parseAssetSvg(svg, { palette: 'colour', hidden: e.hidden === true }).problems) out.push(`whitelist: ${p}`);
  return [...new Set(out)];
}

// ---------- the import ----------

export function importColourProps(o: ImportOptions): ImportResult {
  const colours = packPalette(readFileSync(join(o.repo, PACK), 'utf8'));
  const drift = [...new Set([...colours, ...COLOUR_HEX])].filter((h) => !colours.has(h) || !COLOUR_HEX.has(h));
  if (drift.length) throw new Error(`the pack's palette and core COLOUR_PALETTE (assets/colour.ts) differ: ${drift.join(', ')}; make them agree first`);
  const ink = new Set(ASSETS.map((a) => a.id));

  const all = readdirSync(o.source).filter((d) => /^batch-\d\d$/.test(d) && statSync(join(o.source, d)).isDirectory()).sort();
  const batches = all.filter((b) => existsSync(join(o.source, b, 'DONE')));
  const unfinished = all.filter((b) => !batches.includes(b));
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const taken: { e: Entry; batch: string; file: string }[] = [];

  for (const batch of batches) {
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(join(o.source, batch, 'manifest.json'), 'utf8'));
    } catch (err) {
      problems.push(`${batch}/manifest.json: ${(err as Error).message}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      problems.push(`${batch}/manifest.json: not an array`);
      continue;
    }
    for (const raw of entries as Record<string, unknown>[]) {
      const where = `${batch}/${String(raw?.category ?? '?')}/${String(raw?.id ?? '?')}`;
      const bad = raw && typeof raw === 'object' ? checkEntry(raw) : ['entry is not an object'];
      if (bad.length) {
        problems.push(`${where}: ${bad.join('; ')}`);
        continue;
      }
      const e = raw as unknown as Entry;
      if (seen.has(e.id)) {
        problems.push(`${where}: id also used in ${seen.get(e.id)}`);
        continue;
      }
      seen.set(e.id, batch);
      if (ink.has(COLOUR_PREFIX + e.id)) {
        problems.push(`${where}: ${COLOUR_PREFIX}${e.id} clashes with an ink prop`);
        continue;
      }
      const file = join(o.source, batch, 'colour', e.category, `${e.id}.svg`);
      if (!existsSync(file)) {
        problems.push(`${where}: no colour/${e.category}/${e.id}.svg`);
        continue;
      }
      const svgProblems = checkSvg(readFileSync(file, 'utf8'), e, colours);
      if (svgProblems.length) {
        problems.push(`${where}: ${svgProblems.join('; ')}`);
        continue;
      }
      taken.push({ e, batch, file });
    }
  }

  // the art and its manifest: rebuilt from scratch, so props dropped from a batch go too
  const out = join(o.repo, COLOUR_DIR);
  rmSync(out, { recursive: true, force: true });
  for (const { e, file } of taken) {
    const to = join(out, e.category, `${e.id}.svg`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file, to);
  }
  mkdirSync(out, { recursive: true });
  const manifest = taken.map(({ e, batch }) => ({ id: e.id, name: e.name, category: e.category, w: e.w, h: e.h, tags: e.tags, blocks: e.blocks, palette: e.palette, layer: e.layer, ...(e.group ? { group: e.group } : {}), ...(e.hidden ? { hidden: true } : {}), ...(e.tile ? { tile: true } : {}), batch }));
  writeFileSync(join(out, 'manifest.json'), `[\n${manifest.map((m) => `  ${JSON.stringify(m)}`).join(',\n')}\n]\n`);

  // the catalog: categories in picker order, one compact row per prop in the order the art came in (core catalog.ts reads it)
  const cats = [...new Set(taken.map((t) => t.e.category))].map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  const rows = taken.map(({ e }) => {
    const flags = [e.hidden ? 'hidden' : '', isModular(e) ? 'modular' : '', e.tile ? 'tile' : '', isDifficult(e) ? 'difficult' : ''].filter(Boolean).join(' ');
    const row: (string | number)[] = [COLOUR_PREFIX + e.id, e.name, e.category, e.w, e.h, e.tags.join(','), e.blocks, e.layer, e.group ?? ''];
    if (flags) row.push(flags);
    else if (!e.group) row.pop();
    return row;
  });
  writeFileSync(
    join(o.repo, COLOUR_CATALOG),
    `{\n"categories": [\n${cats.map((c) => `  ${JSON.stringify([c, categoryName(c)])}`).join(',\n')}\n],\n"assets": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n}\n`,
  );

  return {
    batches,
    unfinished,
    props: taken.length,
    textures: taken.filter((t) => t.e.tile).length,
    categories: cats.map((c) => ({ id: c, name: categoryName(c), count: taken.filter((t) => t.e.category === c).length })),
    problems,
  };
}
