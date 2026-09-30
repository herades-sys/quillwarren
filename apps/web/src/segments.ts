// The Segment tool (K): save part of the map under a name, place saved
// segments again (a ghost follows the pointer, Q and E turn it), or fill an
// area with one while the rooms stay clear. The library lives on the server
// (/api/v1/segments); placing and filling are worked out here with core and
// sent as ops like every other edit, so each is one undo step.
import {
  buildScene,
  collectSegment,
  countsText,
  fillSegmentOps,
  placeSegmentOps,
  regionAround,
  sceneToSvg,
  segmentCounts,
  segmentMap,
  turnSegment,
  type Bounds,
  type MapSegment,
  type Op,
  type Point,
  type SegmentContent,
  type SegmentPick,
  type Shape,
} from '@delve/core';
import { artLoader } from './art.ts';
import { SVG_NS, type ViewerCtx } from './ctx.ts';

export type SegmentMode = 'save' | 'place' | 'fill';

interface Summary {
  id: string;
  name: string;
  size: [number, number];
  counts: Record<string, number>;
}

/** What the editor lends the tool. */
export interface SegmentHost {
  ctx: ViewerCtx;
  /** Send ops as one undo step and select `select` once they are on the map. */
  apply(ops: Op[], select?: string[]): Promise<void>;
  refreshTools(): void;
  refreshPanel(): void;
  redraw(): void;
}

export interface SegmentTool {
  mode(): SegmentMode;
  /** The tool options: the three modes, the name form, the library. */
  options(): HTMLElement[];
  /** The tool was picked: load the library the first time. */
  activate(): void;
  /** A click on the map in Place mode. */
  click(p: Point): void;
  /** A box dragged on the map: Save names it, Fill fills it. */
  area(rect: [number, number, number, number]): void;
  /** The ghost of the segment about to be placed, under the pointer. */
  draw(layer: SVGElement, hover: Point | null): void;
  /** Q / E: turn the segment about to be placed. */
  turn(by: number): void;
  /** The selection panel's "Save as segment…" button, or its name form. */
  selectionSave(ids: string[]): HTMLElement;
  /** Escape: drop a half-done save or rename, or the picked segment (only while the tool is active). true if there was one. */
  cancel(active?: boolean): boolean;
}

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) el.append(kid);
  return el;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const MODES: { id: SegmentMode; name: string; hint: string }[] = [
  { id: 'save', name: 'Save', hint: 'Drag a box around what to save. Or select rooms with the Select tool and use “Save as segment…”: they bring their doors, furniture and corridors.' },
  { id: 'place', name: 'Place', hint: 'Pick a segment, then click the map to place a copy. Q and E turn it. Room numbers carry on from the map’s.' },
  { id: 'fill', name: 'Fill', hint: 'Pick a segment, then drag an area to fill with its props and terrain. Rooms and corridors stay clear.' },
];
/** "Fill around the rooms": the map's rooms and corridors grown by this many squares. */
const AROUND = 5;

const sizeText = (s: readonly number[]) => `${s[0]}×${s[1]}`;

export function initSegments(host: SegmentHost): SegmentTool {
  const { ctx } = host;
  let mode: SegmentMode = 'place';
  let library: Summary[] | null = null;
  let loading = false;
  let chosen: string | null = null;
  let rotation = 0;
  /** A save waiting for its name: from a box (tool options) or the selection (selection panel). */
  let pending: { pick: SegmentPick; key: string; name: string; text: string } | null = null;
  let renaming: { id: string; name: string } | null = null;
  let busy = false;
  const full = new Map<string, MapSegment | 'loading' | 'failed'>();
  const thumbs = new Map<string, string>();
  const turned = new Map<string, SegmentContent>();
  const ghosts = new Map<string, { url: string; b: Bounds; size: [number, number] }>();
  // Prop and terrain art for thumbnails and the ghost; as it arrives, they are drawn again.
  const art = artLoader(() => {
    thumbs.clear();
    clearGhosts();
    document.querySelectorAll<HTMLElement>('[data-seg-thumb]').forEach((el) => fillThumb(el, el.dataset.segThumb!));
    host.redraw();
  });

  async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { ...init, ...(init.body ? { headers: { 'content-type': 'application/json' } } : {}) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
    return body;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      library = (await api<{ segments: Summary[] }>('/api/v1/segments')).segments;
    } catch (e) {
      ctx.toast(`Loading the saved segments failed: ${(e as Error).message}`);
      library ??= [];
    } finally {
      loading = false;
    }
    if (chosen && !library.some((s) => s.id === chosen)) chosen = null;
    host.refreshTools();
  }

  /** The whole segment, or null while it's being fetched. */
  function segment(id: string): MapSegment | null {
    const s = full.get(id);
    if (s && typeof s === 'object') return s;
    if (!s) {
      full.set(id, 'loading');
      api<{ segment: MapSegment }>(`/api/v1/segments/${encodeURIComponent(id)}`)
        .then(({ segment: seg }) => {
          full.set(id, seg);
          document.querySelectorAll<HTMLElement>(`[data-seg-thumb="${CSS.escape(id)}"]`).forEach((el) => fillThumb(el, id));
          host.redraw();
        })
        .catch(() => full.set(id, 'failed'));
    }
    return null;
  }

  const current = (): MapSegment | null => (chosen ? segment(chosen) : null);

  function turnedOf(seg: MapSegment): SegmentContent {
    const key = `${seg.id}:${rotation}`;
    let t = turned.get(key);
    if (!t) turned.set(key, (t = turnSegment(seg, rotation)));
    return t;
  }

  // ---------- pictures ----------

  /** A small picture of the segment, drawn here with the map's own style. */
  function fillThumb(el: HTMLElement, id: string): void {
    const seg = segment(id);
    if (!seg) return;
    let svg = thumbs.get(id);
    if (svg === undefined) {
      const m = segmentMap(seg.objects, ctx.map());
      art.ensure(m);
      svg = sceneToSvg(buildScene(m, { view: 'gm', assets: art.body, margin: 0.3 }), { ppg: 8, idPrefix: `segthumb-${id}-` });
      thumbs.set(id, svg);
    }
    el.innerHTML = svg;
  }

  function clearGhosts(): void {
    for (const g of ghosts.values()) URL.revokeObjectURL(g.url);
    ghosts.clear();
  }

  function ghostOf(seg: MapSegment): { url: string; b: Bounds; size: [number, number] } {
    const key = `${seg.id}:${rotation}`;
    let g = ghosts.get(key);
    if (!g) {
      const t = turnedOf(seg);
      const m = segmentMap(t.objects, ctx.map());
      art.ensure(m);
      const scene = buildScene(m, { view: 'gm', assets: art.body, background: false, grid: false, margin: 0 });
      const url = URL.createObjectURL(new Blob([sceneToSvg(scene, { ppg: 20, idPrefix: 'segghost-' })], { type: 'image/svg+xml' }));
      g = { url, b: scene.bounds, size: t.size };
      ghosts.set(key, g);
    }
    return g;
  }

  /** Where the segment's top-left corner goes for pointer p: centred on it, on whole squares. */
  const topLeft = (p: Point, size: readonly number[]): Point => [Math.round(p[0] - size[0]! / 2), Math.round(p[1] - size[1]! / 2)];

  // ---------- actions ----------

  function setMode(m: SegmentMode): void {
    mode = m;
    if (pending && 'rect' in pending.pick) pending = null;
    host.refreshTools();
    host.redraw();
  }

  function choose(id: string): void {
    chosen = id;
    segment(id);
    if (mode === 'save') mode = 'place';
    host.refreshTools();
    host.redraw();
  }

  function needSegment(): MapSegment | null {
    const seg = current();
    if (!seg) ctx.toast(!library?.length ? 'No segments saved yet. Choose Save and drag a box around part of the map.' : chosen ? 'One moment: the segment is still loading.' : 'Pick a segment in the list first.', 'info');
    return seg;
  }

  function click(p: Point): void {
    const seg = needSegment();
    if (!seg) return;
    try {
      const plan = placeSegmentOps(ctx.map(), seg, topLeft(p, turnedOf(seg).size), rotation);
      void host.apply(plan.ops, plan.ids);
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  }

  function fill(region: Shape): void {
    const seg = needSegment();
    if (!seg) return;
    try {
      const r = fillSegmentOps(ctx.map(), seg, region, { seed: Math.floor(Math.random() * 2 ** 31) });
      if (!r.ops.length) return ctx.toast('Nothing fits there: every spot is on or next to the floor, or already taken.', 'info');
      const left = r.left.length ? ` Its ${r.left.join(', ')} ${r.left.length === 1 ? 'was' : 'were'} left out: use Place for those.` : '';
      ctx
        .send(r.ops)
        .then(() => ctx.toast(`Filled with ${r.props} prop${r.props === 1 ? '' : 's'} and ${r.terrain} terrain area${r.terrain === 1 ? '' : 's'}.${left}`, 'info'))
        .catch((e: Error) => ctx.toast(e.message));
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  }

  function fillAround(): void {
    const region = regionAround(ctx.map(), AROUND);
    if (!region) return ctx.toast('The map is empty, so there are no rooms to fill around.', 'info');
    fill(region);
  }

  function focusIn(selector: string): void {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(selector);
      el?.focus();
      el?.select();
    });
  }

  function startSave(pick: SegmentPick): void {
    const key = 'ids' in pick ? `ids:${pick.ids.join(',')}` : 'rect';
    try {
      const c = collectSegment(ctx.map(), pick);
      pending = { pick, key, name: pending?.name ?? '', text: `${sizeText(c.size)} squares: ${countsText(segmentCounts(c.objects))}` };
    } catch (e) {
      pending = null;
      ctx.toast((e as Error).message, 'info');
    }
    // the panel keeps its content while something in it has focus (the button just clicked)
    (document.activeElement as HTMLElement | null)?.blur();
    if ('ids' in pick) host.refreshPanel();
    else host.refreshTools();
    if (pending) focusIn('.seg-save input');
  }

  async function save(): Promise<void> {
    if (!pending || busy) return;
    const name = pending.name.trim();
    if (!name) {
      ctx.toast('Give the segment a name first.', 'info');
      return focusIn('.seg-save input');
    }
    busy = true;
    try {
      const body = { name, map: ctx.mapId, ...pending.pick };
      const { segment: seg } = await api<{ segment: MapSegment }>('/api/v1/segments', { method: 'POST', body: JSON.stringify(body) });
      full.set(seg.id, seg);
      chosen = seg.id;
      pending = null;
      ctx.toast(`Saved “${seg.name}”. Place it or fill an area with it.`, 'info');
      await load();
    } catch (e) {
      ctx.toast((e as Error).message);
    } finally {
      busy = false;
      // the name field goes away, and the panel only redraws once nothing in it has focus
      if (!pending) (document.activeElement as HTMLElement | null)?.blur();
      host.refreshTools();
      host.refreshPanel();
    }
  }

  /** `active`: the Segment tool is the current tool (otherwise only a half-done save from the selection panel is dropped). */
  function cancel(active = true): boolean {
    if (pending) pending = null;
    else if (active && renaming) renaming = null;
    else if (active && mode === 'place' && chosen) chosen = null;
    else return false;
    (document.activeElement as HTMLElement | null)?.blur();
    host.refreshTools();
    host.refreshPanel();
    host.redraw();
    return true;
  }

  async function rename(id: string, name: string): Promise<void> {
    renaming = null;
    const clean = name.trim();
    if (!clean || clean === library?.find((s) => s.id === id)?.name) return host.refreshTools();
    try {
      await api(`/api/v1/segments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: clean }) });
      const seg = full.get(id);
      if (seg && typeof seg === 'object') seg.name = clean;
    } catch (e) {
      ctx.toast((e as Error).message);
    }
    await load();
  }

  async function remove(s: Summary): Promise<void> {
    if (!confirm(`Delete the segment “${s.name}”? Copies already placed on maps stay.`)) return;
    try {
      await api(`/api/v1/segments/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    } catch (e) {
      ctx.toast((e as Error).message);
    }
    if (chosen === s.id) chosen = null;
    full.delete(s.id);
    thumbs.delete(s.id);
    await load();
    host.redraw();
  }

  function turn(by: number): void {
    rotation = (((rotation + by) % 360) + 360) % 360;
    host.refreshTools();
    host.redraw();
  }

  // ---------- panel parts ----------

  /** Enter saves, Escape gives up; neither reaches the editor's own panel keys. */
  function nameInput(value: string, placeholder: string, on: (v: string) => void, done: () => void, quit: () => void): HTMLInputElement {
    return h('input', {
      type: 'text',
      value,
      placeholder,
      maxlength: 100,
      'aria-label': 'Segment name',
      oninput: (e: Event) => on((e.target as HTMLInputElement).value),
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if (k !== 'Enter' && k !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (k === 'Enter') done();
        else quit();
      },
    });
  }

  function saveForm(): HTMLElement {
    const p = pending!;
    return h(
      'div',
      { class: 'seg-save' },
      h('p', { class: 'hint' }, `Save ${p.text} as a segment called:`),
      nameInput(p.name, 'e.g. Temple of Efferd', (v) => (p.name = v), () => void save(), () => void cancel()),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => void save() }, 'Save'), h('button', { type: 'button', onclick: () => void cancel() }, 'Cancel')),
    );
  }

  function item(s: Summary): HTMLElement {
    const pic = h('span', { class: 'seg-thumb', 'data-seg-thumb': s.id, 'aria-hidden': 'true' });
    fillThumb(pic, s.id);
    const meta = h('span', { class: 'seg-meta' }, `${sizeText(s.size)} · ${countsText(s.counts)}`);
    if (renaming?.id === s.id) {
      const r = renaming;
      return h(
        'div',
        { class: 'seg-item', role: 'option', 'aria-selected': String(s.id === chosen) },
        h('div', { class: 'seg-pick' }, pic, h('span', { class: 'seg-text' }, nameInput(r.name, s.name, (v) => (r.name = v), () => void rename(s.id, r.name), () => void cancel()), meta)),
        h('div', { class: 'seg-acts' }, h('button', { type: 'button', onclick: () => void rename(s.id, r.name) }, 'Save name'), h('button', { type: 'button', onclick: () => void cancel() }, 'Cancel')),
      );
    }
    return h(
      'div',
      { class: 'seg-item', role: 'option', 'aria-selected': String(s.id === chosen) },
      h('button', { type: 'button', class: 'seg-pick', title: `${s.name}: ${sizeText(s.size)} squares`, onclick: () => choose(s.id) }, pic, h('span', { class: 'seg-text' }, h('span', { class: 'seg-name' }, s.name), meta)),
      h(
        'div',
        { class: 'seg-acts' },
        h('button', { type: 'button', onclick: () => ((renaming = { id: s.id, name: s.name }), host.refreshTools(), focusIn('.seg-item input')) }, 'Rename'),
        h('button', { type: 'button', class: 'danger', onclick: () => void remove(s) }, 'Delete'),
      ),
    );
  }

  function options(): HTMLElement[] {
    if (!library && !loading) void load();
    const out: HTMLElement[] = [
      h(
        'div',
        { class: 'seg-modes', role: 'radiogroup', 'aria-label': 'What the Segment tool does' },
        ...MODES.map((m) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(m.id === mode), 'aria-pressed': String(m.id === mode), onclick: () => setMode(m.id) }, m.name)),
      ),
      h('p', { class: 'hint' }, MODES.find((m) => m.id === mode)!.hint),
    ];
    if (mode === 'save' && pending && !('ids' in pending.pick)) out.push(saveForm());
    if (mode === 'place') {
      out.push(
        h(
          'div',
          { class: 'rotate' },
          'Turned ',
          h('button', { type: 'button', title: 'Turn left (Q)', onclick: () => turn(-90) }, '↺'),
          h('strong', {}, `${rotation}°`),
          h('button', { type: 'button', title: 'Turn right (E)', onclick: () => turn(90) }, '↻'),
        ),
      );
    }
    if (mode === 'fill') out.push(h('button', { type: 'button', class: 'seg-around', onclick: fillAround }, `Fill around the rooms (${AROUND} squares out)`));
    if (!library) out.push(h('p', { class: 'hint' }, 'Loading the saved segments…'));
    else if (!library.length) out.push(h('p', { class: 'hint' }, 'No segments saved yet. Choose Save and drag a box around part of the map.'));
    else out.push(h('div', { class: 'seg-lib', role: 'listbox', 'aria-label': 'Saved segments' }, ...library.map(item)));
    return out;
  }

  function selectionSave(ids: string[]): HTMLElement {
    const key = `ids:${ids.join(',')}`;
    if (pending?.key === key) return saveForm();
    return h('button', { type: 'button', onclick: () => startSave({ ids }) }, 'Save as segment…');
  }

  function draw(layer: SVGElement, hover: Point | null): void {
    if (mode !== 'place' || !hover) return;
    const seg = current();
    if (!seg) return;
    const g = ghostOf(seg);
    const [x, y] = topLeft(hover, g.size);
    layer.appendChild(svgEl('rect', { x, y, width: g.size[0], height: g.size[1], class: 'ghost' }));
    layer.appendChild(svgEl('image', { href: g.url, x: x + g.b.x0, y: y + g.b.y0, width: g.b.x1 - g.b.x0, height: g.b.y1 - g.b.y0, preserveAspectRatio: 'none', class: 'ghost-seg' }));
  }

  return {
    mode: () => mode,
    options,
    activate: () => {
      if (!library && !loading) void load();
    },
    click,
    area: (rect) => (mode === 'save' ? startSave({ rect }) : mode === 'fill' ? fill({ rect }) : undefined),
    draw,
    turn,
    selectionSave,
    cancel,
  };
}
