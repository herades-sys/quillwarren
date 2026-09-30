// The map editor: tools, selection, drag previews, keyboard shortcuts and the
// properties panel. Every edit is sent as ops over the live socket; the map on
// screen only changes when the server's broadcast comes back, so the user and
// Claude always see the same thing.
import {
  ASSETS,
  assetInfo,
  CATEGORIES,
  computeFloor,
  connectOps,
  DOOR_STYLES,
  floorText,
  freehandShape,
  isConnector,
  MARKER_KINDS,
  MARKERS,
  nextId,
  nextLabel,
  PRESETS,
  propBounds,
  propCentre,
  scatterAlong,
  shapeBounds,
  shapeFromDrag,
  updateFog,
  withAttachedDoors,
  type AssetInfo,
  type Bounds,
  type BoxShape,
  type CutoutFill,
  type DelveMap,
  type DrawShape,
  type FogChange,
  type MapObject,
  type Op,
  type Placement,
  type Point,
  type Shape,
} from '@delve/core';
import { SVG_NS, type ViewerCtx } from './ctx.ts';
import { drawHint, FILL_CHOICES, SHAPE_CHOICES, shapeGhost } from './draw-shapes.ts';
import {
  closesPolygon,
  deletionSet,
  doorFromDrag,
  handleAt,
  handlePoint,
  HANDLES,
  hitAll,
  hitTest,
  nextHit,
  rectFromDrag,
  rectOf,
  resizeBounds,
  snap,
  snapPoint,
  type Handle,
} from './edit-logic.ts';
import { initImages } from './images.ts';
import { objectBounds, pad } from './logic.ts';
import { initSegments } from './segments.ts';

type Tool = 'select' | 'room' | 'poly' | 'corridor' | 'door' | 'cutout' | 'stairs' | 'label' | 'prop' | 'terrain' | 'marker' | 'reveal' | 'image' | 'segment';

const PROPS = ASSETS.filter((a) => a.kind === 'prop');
const TILES = ASSETS.filter((a) => a.kind === 'terrain');
const thumb = (id: string) => `/assets/props/${encodeURIComponent(id)}.svg`;
/** Rotation folded into 0, 90, 180, 270. */
const quarter = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
const FACING: Record<number, string> = { 0: 'south', 90: 'west', 180: 'north', 270: 'east' };

const TOOLS: { id: Tool; name: string; key: string; hint: string }[] = [
  { id: 'select', name: 'Select', key: 'V', hint: 'Click to select, Shift-click to add. Drag to move, drag a handle to resize. Drag empty space to pan.' },
  { id: 'room', name: 'Room', key: 'R', hint: 'Drag to draw a room in the shape picked below.' },
  { id: 'poly', name: 'Polygon', key: 'O', hint: 'Click corners; click the first corner, double-click or press Enter to finish.' },
  { id: 'corridor', name: 'Corridor', key: 'C', hint: 'Click one room, then another. The corridor routes itself and follows its rooms.' },
  { id: 'door', name: 'Door', key: 'D', hint: 'Drag along a wall or across an opening.' },
  { id: 'cutout', name: 'Pillar', key: 'P', hint: 'Drag to cut floor away: pillars, pits.' },
  { id: 'stairs', name: 'Stairs', key: 'S', hint: 'Drag to draw stairs; the direction is the way up.' },
  { id: 'label', name: 'Label', key: 'L', hint: 'Click to place text, then type it in the panel.' },
  { id: 'prop', name: 'Prop', key: 'A', hint: 'Pick a prop below (or select one on the map first), then click to place it, again and again. Shift-drag paints a row of them. Q and E turn it.' },
  { id: 'terrain', name: 'Terrain', key: 'T', hint: 'Pick a tile below, then drag an area: water, grass, rubble…' },
  { id: 'marker', name: 'Marker', key: 'M', hint: 'GM notes: pick ?, ! or trap below, click to pin one and type its note. Click a marker to read it, Shift-click to strike it through. Players never see them.' },
  { id: 'reveal', name: 'Reveal', key: 'G', hint: 'Fog of war: click a room or corridor to show or hide it for the players. Drag to reveal an area, Shift-drag to cover one.' },
  { id: 'image', name: 'Image', key: 'I', hint: 'Your own pictures: upload one below (or drop or paste it here), pick it, then click to place it. Q and E turn it.' },
  { id: 'segment', name: 'Segment', key: 'K', hint: 'Save part of the map, place saved segments again, or fill an area with one.' },
];

interface Drag {
  kind: 'move' | 'resize' | 'create' | 'door';
  start: Point;
  cur: Point;
  x: number;
  y: number;
  moved: boolean;
  handle?: Handle;
  bounds?: Bounds;
  /** The click landed on the object that was already selected: a plain click moves on to the next one under it. */
  cycle?: boolean;
  /** Reveal tool: the unsnapped point (for clicking a room) and whether Shift was held (cover instead). */
  raw?: Point;
  cover?: boolean;
  /** Room and Pillar tools: Shift is down, so the shape keeps width and height equal. */
  regular?: boolean;
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

export function initEditor(ctx: ViewerCtx): { selection(): string[]; tool(): string | null } {
  const panel = document.getElementById('panel')!;
  const toolbox = document.getElementById('tools')!;
  const props = document.getElementById('props')!;
  const toggle = document.getElementById('edit-toggle') as HTMLButtonElement | null;
  const layer = svgEl('g', { class: 'ed' });
  ctx.overlay.appendChild(layer);

  let editing = false;
  let tool: Tool = 'select';
  let selection: string[] = [];
  let drag: Drag | null = null;
  let poly: Point[] = [];
  let hover: Point | null = null;
  let hoverRaw: Point | null = null;
  let hoverStep = 1;
  let corridorFrom: string | null = null;
  /** A Shift-drag with the Prop tool: the path so far, a seed so the preview and the result agree, and the snap step. */
  let stroke: { path: Point[]; seed: number; step: number } | null = null;
  let focusField: string | null = null;
  const settings = {
    snap: 1,
    corridorWidth: 2,
    corridorDoors: 'both' as 'none' | 'both',
    doorStyle: 'normal' as (typeof DOOR_STYLES)[number],
    stairsDir: 'n' as 'n' | 'e' | 's' | 'w',
    prop: PROPS[0]?.id ?? '',
    propRotation: 0,
    propCategory: 'furniture',
    propSearch: '',
    tile: TILES[0]?.id ?? '',
    markerKind: 'discover' as (typeof MARKER_KINDS)[number],
    brushSpacing: 3,
    brushPlacement: 'regular' as 'regular' | 'irregular',
    brushSpread: 1,
    roomShape: 'rect' as DrawShape,
    pillarShape: 'rect' as DrawShape,
    pillarFill: 'rock' as CutoutFill,
  };
  /** A freehand outline being drawn with the Room or Pillar tool (unsnapped points). */
  let sketch: Point[] | null = null;
  const shapeOf = (t: Tool): DrawShape => (t === 'cutout' ? settings.pillarShape : settings.roomShape);
  const boxShapeOf = (t: Tool): BoxShape => {
    const k = shapeOf(t);
    return k === 'freehand' ? 'rect' : k;
  };

  const map = () => ctx.map();
  const byId = (id: string) => map().objects.find((o) => o.id === id);
  const step = (e?: { altKey: boolean }) => (e?.altKey ? 0.5 : settings.snap);
  const tol = () => 6 * ctx.squaresPerPx();

  // Storeys line up: while editing one, the floor of the storey below (the one
  // above, for the lowest) shows as a faint dashed outline.
  let guide: { name: string; d: string } | null = null;
  void (async () => {
    const list = ctx.storeys();
    const i = list.findIndex((s) => s.id === ctx.mapId);
    const other = i >= 0 ? (list[i + 1] ?? list[i - 1]) : undefined;
    if (!other) return;
    const res = await fetch(`/api/v1/maps/${encodeURIComponent(other.id)}`);
    if (!res.ok) return;
    const { map: m } = (await res.json()) as { map: DelveMap };
    const d = computeFloor(m)
      .flatMap((p) => [p.outer, ...p.holes])
      .map((ring) => `M${ring.map(([x, y]) => `${x} ${y}`).join('L')}Z`)
      .join('');
    if (!d) return;
    guide = { name: other.level?.name ?? other.name, d };
    draw();
    renderPanel();
  })();

  // The server acks a change just before its broadcast arrives, so a new
  // object isn't on the map yet at ack time: select it once the map catches up.
  let wantSelect: { ids: string[]; rev: number } | null = null;

  async function apply(ops: Op[], select?: string[]): Promise<void> {
    try {
      const rev = await ctx.send(ops);
      if (select) {
        if (ctx.rev() >= rev) selection = select;
        else wantSelect = { ids: select, rev };
      }
    } catch (e) {
      ctx.toast((e as Error).message);
    }
    renderPanel();
    draw();
  }

  // the Image tool (images.ts): uploads, the picker, placing and the picture's panel fields
  const images = initImages({
    stage: ctx.stage,
    map,
    active: () => editing && tool === 'image',
    toMap: ctx.toMap,
    apply,
    toast: ctx.toast,
    refresh: () => {
      renderTools();
      draw();
    },
    snap: () => settings.snap,
  });

  // the Segment tool (segments.ts): save, place and fill with saved pieces of maps
  const segments = initSegments({ ctx, apply, refreshTools: () => renderTools(), refreshPanel: () => renderPanel(), redraw: () => draw() });

  // ---------- mode ----------

  function setEditing(on: boolean): void {
    editing = on;
    panel.hidden = !on;
    toggle?.setAttribute('aria-pressed', String(on));
    ctx.setEditing(on);
    const url = new URL(location.href);
    if (on) url.searchParams.set('edit', '1');
    else url.searchParams.delete('edit');
    history.replaceState(null, '', url);
    if (!on) {
      selection = [];
      poly = [];
      corridorFrom = null;
    }
    setTool(on ? tool : 'select');
  }

  function setTool(t: Tool): void {
    // a prop selected on the map becomes the one the Prop tool (and its brush) places
    const picked = selection.length === 1 ? byId(selection[0]!) : undefined;
    if (t === 'prop' && tool !== 'prop' && picked?.type === 'prop' && assetInfo(picked.asset)) {
      settings.prop = picked.asset;
      settings.propRotation = quarter(picked.rotation ?? 0);
    }
    tool = t;
    poly = [];
    corridorFrom = null;
    stroke = null;
    sketch = null;
    if (t === 'segment') segments.activate();
    ctx.stage.dataset.tool = editing ? t : '';
    renderTools();
    draw();
  }

  // ---------- pointer ----------

  function onDown(e: PointerEvent): void {
    if (!editing || e.button !== 0) return;
    const p = ctx.toMap(e.clientX, e.clientY);
    if (!p) return;
    const ps = snapPoint(p, step(e));
    const start = (kind: Drag['kind'], extra: Partial<Drag> = {}, from = ps) => {
      drag = { kind, start: from, cur: from, x: e.clientX, y: e.clientY, moved: false, ...extra };
      ctx.handled.add(e);
      ctx.stage.setPointerCapture(e.pointerId);
    };

    switch (tool) {
      case 'select': {
        if (selection.length === 1) {
          const r = rectOf(byId(selection[0]!));
          if (r) {
            const b = { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] };
            const handle = handleAt(b, p, tol() * 1.3);
            if (handle) return start('resize', { handle, bounds: b });
          }
        }
        const hits = hitAll(map(), p, tol());
        const hit = hits[0];
        if (!e.shiftKey && selection.length === 1 && hits.includes(selection[0]!)) {
          // on the selected object (maybe under a prop or terrain): drag it, or click again for the next one down
          start('move', { cycle: true }, p);
        } else if (hit) {
          if (e.shiftKey) selection = selection.includes(hit) ? selection.filter((s) => s !== hit) : [...selection, hit];
          else if (!selection.includes(hit)) selection = [hit];
          renderPanel();
          start('move', {}, p);
        } else if (!e.shiftKey && selection.length) {
          selection = [];
          renderPanel();
        }
        break;
      }
      case 'room':
      case 'cutout':
        if (shapeOf(tool) === 'freehand') {
          // freehand: collect the outline until the button comes up
          sketch = [p];
          ctx.handled.add(e);
          ctx.stage.setPointerCapture(e.pointerId);
          break;
        }
        start('create', { regular: e.shiftKey });
        break;
      case 'stairs':
      case 'terrain':
        start('create');
        break;
      case 'prop':
        ctx.handled.add(e);
        if (e.shiftKey && assetInfo(settings.prop)) {
          // the brush: copies along the drag, placed when the button comes up
          stroke = { path: [propAt(p, step(e))], seed: Math.floor(Math.random() * 2 ** 31), step: step(e) };
          ctx.stage.setPointerCapture(e.pointerId);
        } else placeProp(p, step(e));
        break;
      case 'reveal':
        start('create', { raw: p, cover: e.shiftKey });
        break;
      case 'door':
        start('door');
        break;
      case 'poly':
        ctx.handled.add(e);
        if (closesPolygon(poly, ps, tol() * 2)) finishPoly();
        else if (!poly.length || ps[0] !== poly.at(-1)![0] || ps[1] !== poly.at(-1)![1]) poly.push(ps);
        break;
      case 'corridor': {
        const hit = hitTest(map(), p, tol());
        if (hit && byId(hit)?.type === 'room') {
          ctx.handled.add(e);
          if (!corridorFrom) {
            corridorFrom = hit;
            ctx.toast('Now click the room to connect it to.', 'info');
          } else if (hit !== corridorFrom) {
            connect(corridorFrom, hit);
            corridorFrom = null;
          }
        }
        break;
      }
      case 'label':
        ctx.handled.add(e);
        addLabel(snapPoint(p, 0.5));
        break;
      case 'marker':
        ctx.handled.add(e);
        // the middle of a square, or any half square with Alt
        addMarker(step(e) >= 1 ? [Math.floor(p[0]) + 0.5, Math.floor(p[1]) + 0.5] : snapPoint(p, 0.5));
        break;
      case 'image':
        ctx.handled.add(e);
        images.place(p, step(e));
        break;
      case 'segment':
        // Place: a click drops a copy; Save and Fill: drag a box (whole squares)
        if (segments.mode() === 'place') {
          ctx.handled.add(e);
          segments.click(p);
        } else start('create', {}, snapPoint(p, 1));
        break;
    }
    draw();
  }

  function onMove(e: PointerEvent): void {
    if (!editing) return;
    const p = ctx.toMap(e.clientX, e.clientY);
    if (!p) return;
    hover = snapPoint(p, step(e));
    hoverRaw = p;
    hoverStep = step(e);
    if (stroke) {
      const last = stroke.path.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.1) stroke.path.push(p);
      ctx.handled.add(e);
    }
    if (sketch) {
      const last = sketch.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.05) sketch.push(p);
      ctx.handled.add(e);
    }
    if (drag) {
      drag.cur = drag.kind === 'move' ? p : snapPoint(p, step(e));
      drag.regular = e.shiftKey;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;
      ctx.handled.add(e);
    }
    if (drag || tool !== 'select') draw();
  }

  function onUp(e: PointerEvent): void {
    if (editing && stroke) {
      ctx.handled.add(e);
      return finishStroke();
    }
    if (editing && sketch) {
      ctx.handled.add(e);
      return finishSketch();
    }
    if (!editing || !drag) return;
    const d = drag;
    drag = null;
    ctx.handled.add(e);
    const s = step(e);
    const m = map();
    switch (d.kind) {
      case 'move': {
        if (!d.moved) {
          if (d.cycle) {
            const next = nextHit(hitAll(m, d.start, tol()), selection[0]);
            if (next && next !== selection[0]) {
              selection = [next];
              renderPanel();
            }
          }
          break;
        }
        const dx = snap(d.cur[0] - d.start[0], s);
        const dy = snap(d.cur[1] - d.start[1], s);
        if (dx || dy) void apply([{ op: 'move', ids: withAttachedDoors(m, selection), dx, dy }]);
        break;
      }
      case 'resize': {
        const b = resizeBounds(d.bounds!, d.handle!, d.cur, s);
        const rect: [number, number, number, number] = [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0];
        const old = rectOf(byId(selection[0]!));
        if (old && rect.some((v, i) => v !== old[i])) void apply([{ op: 'update', id: selection[0]!, set: { shape: { rect } } }]);
        break;
      }
      case 'create': {
        if (tool === 'reveal') {
          const area = rectFromDrag(d.start, d.cur, s);
          if (d.moved && area) {
            fogChange(d.cover ? { coverArea: { rect: area } } : { revealArea: { rect: area } });
          } else {
            // a click: show or hide the room or corridor under the pointer
            const hit = hitAll(m, d.raw ?? d.start, tol())
              .map(byId)
              .find((o) => o?.type === 'room' || o?.type === 'corridor');
            if (hit) fogChange(m.fog?.on && m.fog.revealed?.includes(hit.id) ? { cover: [hit.id] } : { reveal: [hit.id] });
          }
          break;
        }
        if (tool === 'segment') {
          const area = rectFromDrag(d.start, d.cur, 1);
          if (area) segments.area(area);
          break;
        }
        const rect = rectFromDrag(d.start, d.cur, s);
        // rooms and pillars take the picked shape (Shift: as wide as high)
        const drawn = tool === 'room' || tool === 'cutout' ? shapeFromDrag(boxShapeOf(tool), d.start, d.cur, { regular: e.shiftKey, min: s }) : null;
        if (!rect && !drawn) break;
        const shape: Shape = drawn ?? { rect: rect! };
        let obj: MapObject;
        if (tool === 'room') obj = { id: nextId(m, 'r'), type: 'room', shape, label: nextLabel(m) };
        else if (tool === 'cutout') obj = { id: nextId(m, 'p'), type: 'cutout', shape, ...(settings.pillarFill === 'solid' ? { fill: 'solid' as const } : {}) };
        else if (tool === 'terrain') obj = { id: nextId(m, 't'), type: 'terrain', shape, asset: settings.tile };
        else obj = { id: nextId(m, 's'), type: 'stairs', shape, direction: settings.stairsDir };
        void apply([{ op: 'add', object: obj }], [obj.id]);
        break;
      }
      case 'door': {
        const door = doorFromDrag(d.start, d.cur, 0.5);
        if (!door) break;
        const id = nextId(m, 'd');
        void apply([{ op: 'add', object: { id, type: 'door', ...door, style: settings.doorStyle } }], [id]);
        break;
      }
    }
    draw();
  }

  function finishPoly(): void {
    if (poly.length >= 3) {
      const m = map();
      const id = nextId(m, 'r');
      void apply([{ op: 'add', object: { id, type: 'room', shape: { poly: [...poly] }, label: nextLabel(m) } }], [id]);
    }
    poly = [];
    draw();
  }

  /** A freehand outline, let go: closed, tidied and snapped (core freehandShape), then added as a room or pillar. */
  function finishSketch(): void {
    const shape = freehandShape(sketch ?? []);
    const moved = (sketch?.length ?? 0) > 2;
    sketch = null;
    if (!shape) {
      if (moved) ctx.toast('Too small to keep: draw the whole outline, a bit bigger.', 'info');
      return draw();
    }
    const m = map();
    const obj: MapObject =
      tool === 'cutout'
        ? { id: nextId(m, 'p'), type: 'cutout', shape, ...(settings.pillarFill === 'solid' ? { fill: 'solid' as const } : {}) }
        : { id: nextId(m, 'r'), type: 'room', shape, label: nextLabel(m) };
    void apply([{ op: 'add', object: obj }], [obj.id]);
    draw();
  }

  function connect(a: string, b: string): void {
    try {
      const plan = connectOps(map(), a, b, { width: settings.corridorWidth, doors: settings.corridorDoors, doorStyle: settings.doorStyle });
      void apply(plan.ops, [plan.corridor.id]);
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  }

  function addLabel(at: Point): void {
    const id = nextId(map(), 'l');
    focusField = 'text';
    setTool('select'); // one label per click of the tool; the text field takes over
    void apply([{ op: 'add', object: { id, type: 'label', text: 'Label', at } }], [id]);
  }

  function addMarker(at: Point): void {
    const id = nextId(map(), 'm');
    // the tool stays on for the next one; the note box opens for typing
    void apply([{ op: 'add', object: { id, type: 'marker', kind: settings.markerKind, at, text: '' } }], [id]).then(() => ctx.openMarker?.(id));
  }

  function fogChange(c: FogChange): void {
    try {
      void apply([{ op: 'update_map', set: { fog: updateFog(map(), c) } }]);
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  }

  /** Fog of war switch, reveal/cover everything, and the players' screen link. */
  function fogControls(): HTMLElement[] {
    const fog = map().fog;
    const on = h('input', { type: 'checkbox', checked: Boolean(fog?.on), onchange: (e: Event) => fogChange({ on: (e.target as HTMLInputElement).checked }) });
    const n = fog?.revealed?.length ?? 0;
    return [
      h('label', { class: 'check' }, on, ' Fog of war: players only see what you reveal'),
      h('p', { class: 'hint' }, fog?.on ? `${n} room${n === 1 ? '' : 's'} and corridor${n === 1 ? '' : 's'} revealed. The GM view shows the rest dimmed.` : 'Off: players see the whole map.'),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', onclick: () => fogChange({ revealAll: true }) }, 'Reveal all'),
        h('button', { type: 'button', onclick: () => fogChange({ reset: true, on: true }) }, 'Hide all'),
      ),
      h('a', { class: 'btn', href: `/maps/${encodeURIComponent(ctx.mapId)}/screen`, target: '_blank', rel: 'noopener' }, 'Open the players’ screen ↗'),
    ];
  }

  /** Where the prop tool would put the chosen prop for pointer p: its footprint snapped to the grid around p. */
  function propAt(p: Point, s: number): Point {
    const b = propBounds({ asset: settings.prop, at: [0, 0], rotation: settings.propRotation });
    const corner: Point = [snap(p[0] - (b.x1 - b.x0) / 2, s), snap(p[1] - (b.y1 - b.y0) / 2, s)];
    return propCentre(settings.prop, corner, settings.propRotation);
  }

  function placeProp(p: Point, s: number): void {
    if (!assetInfo(settings.prop)) return ctx.toast('Pick a prop in the panel first.', 'info');
    const id = nextId(map(), 'i');
    const at = propAt(p, s);
    void apply([{ op: 'add', object: { id, type: 'prop', asset: settings.prop, at, ...(settings.propRotation ? { rotation: settings.propRotation } : {}) } }], [id]);
  }

  /**
   * Where a brush stroke puts its copies: regular ones snap to the grid like a
   * click would, irregular ones stay where the scatter put them. Never on top of
   * the same prop already there.
   */
  function brushSpots(): Placement[] {
    if (!stroke) return [];
    const avoid = map().objects.flatMap((o) => (o.type === 'prop' && o.asset === settings.prop ? [o.at] : []));
    const regular = settings.brushPlacement === 'regular';
    const spots = scatterAlong(stroke.path, {
      spacing: settings.brushSpacing,
      placement: settings.brushPlacement,
      spread: settings.brushSpread,
      seed: stroke.seed,
      rotation: settings.propRotation,
      avoid,
    });
    const seen = new Set(avoid.map((a) => a.join(',')));
    return spots
      .map((s) => (regular ? { ...s, at: propAt(s.at, stroke!.step) } : s))
      .filter((s) => !seen.has(s.at.join(',')) && Boolean(seen.add(s.at.join(','))))
      .slice(0, 500);
  }

  function finishStroke(): void {
    const spots = brushSpots();
    stroke = null;
    if (!spots.length) return draw();
    const m = map();
    const ops: Op[] = spots.map((s, k) => ({
      op: 'add',
      object: { id: nextId(m, 'i', k), type: 'prop', asset: settings.prop, at: s.at, ...(s.rotation ? { rotation: s.rotation } : {}), ...(s.scale !== 1 ? { scale: s.scale } : {}) },
    }));
    void apply(ops); // one stroke, one undo step
    draw();
  }

  /** Q / E: turn the prop about to be placed, or the selected props, a quarter turn. */
  function turn(by: number): void {
    if (tool === 'segment') return segments.turn(by); // the segment about to be placed
    if (tool !== 'prop' && images.turn(by, tool === 'image', selection.map(byId))) return;
    const props = selection.map(byId).filter((o): o is Extract<MapObject, { type: 'prop' }> => o?.type === 'prop');
    if (tool === 'prop' || !props.length) {
      settings.propRotation = quarter(settings.propRotation + by);
      renderTools();
      draw();
      return;
    }
    void apply(props.map((o) => {
      const r = quarter((o.rotation ?? 0) + by);
      return r ? { op: 'update', id: o.id, set: { rotation: r } } : { op: 'update', id: o.id, unset: ['rotation'] };
    }));
  }

  async function addStorey(position: 'above' | 'below'): Promise<void> {
    const name = prompt(position === 'above' ? 'Name of the new storey above (e.g. "Upper floor"):' : 'Name of the new storey below (e.g. "Cellar"):');
    if (!name?.trim()) return;
    let currentName: string | undefined;
    if (!map().level) {
      const cur = prompt('And what is this storey called?', 'Ground floor');
      if (!cur?.trim()) return;
      currentName = cur.trim();
    }
    const res = await fetch(`/api/v1/maps/${encodeURIComponent(ctx.mapId)}/levels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), position, currentName, by: 'editor' }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) return ctx.toast(body.error ?? `adding the storey failed (${res.status})`);
    location.href = `/maps/${encodeURIComponent(body.id)}?edit=1`;
  }

  async function deleteMap(): Promise<void> {
    const m = map();
    const what = m.level ? `the storey "${m.level.name}" of "${m.name}"` : `the map "${m.name}"`;
    if (!confirm(`Delete ${what}? It disappears from Delve for everyone.`)) return;
    const res = await fetch(`/api/v1/maps/${encodeURIComponent(ctx.mapId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return ctx.toast(body.error ?? `deleting failed (${res.status})`);
    }
    const other = ctx.storeys().find((s) => s.id !== ctx.mapId);
    location.href = other ? `/maps/${encodeURIComponent(other.id)}?edit=1` : '/';
  }

  function deleteSelection(): void {
    if (!selection.length) return;
    const ids = deletionSet(map(), selection);
    selection = [];
    void apply([{ op: 'delete', ids }]);
  }

  ctx.stage.addEventListener('pointerdown', onDown, { capture: true });
  ctx.stage.addEventListener('pointermove', onMove, { capture: true });
  ctx.stage.addEventListener('pointerup', onUp, { capture: true });
  ctx.stage.addEventListener('pointerleave', () => {
    hover = null;
    hoverRaw = null;
    if (editing) draw();
  });
  ctx.stage.addEventListener(
    'dblclick',
    (e) => {
      if (!editing) return;
      if (tool === 'poly') {
        ctx.handled.add(e);
        finishPoly();
      } else if (tool !== 'select') ctx.handled.add(e);
    },
    { capture: true },
  );

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    if (!editing || (e.target as HTMLElement).closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      void ctx.history(e.shiftKey ? 'redo' : 'undo').catch((err: Error) => ctx.toast(err.message));
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      void ctx.history('redo').catch((err: Error) => ctx.toast(err.message));
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'q' || key === 'e') return turn(key === 'e' ? 90 : -90);
    const t = TOOLS.find((x) => x.key.toLowerCase() === key);
    if (t) return setTool(t.id);
    if (e.key === 'Escape') {
      if (stroke) stroke = null;
      else if (sketch) sketch = null;
      else if (drag) drag = null;
      else if (poly.length) poly = [];
      else if (corridorFrom) corridorFrom = null;
      else if (segments.cancel(tool === 'segment')) {
        // a half-done segment save, a rename, or the segment about to be placed
      } else if (selection.length) selection = [];
      else setTool('select');
      renderPanel();
      draw();
    } else if (e.key === 'Enter' && tool === 'poly') finishPoly();
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key.startsWith('Arrow') && selection.length) {
      e.preventDefault();
      const n = settings.snap * (e.shiftKey ? 5 : 1);
      const [dx, dy] = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key] ?? [0, 0];
      void apply([{ op: 'move', ids: withAttachedDoors(map(), selection), dx: dx!, dy: dy! }]);
    }
  });

  // ---------- overlay ----------

  function rectEl(b: Bounds, cls: string): SVGElement {
    return svgEl('rect', { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, class: cls });
  }

  function shapeElement(shape: Shape, cls: string): SVGElement {
    const g = shapeGhost(shape);
    return svgEl(g.tag, { ...g.attrs, class: cls });
  }

  function draw(): void {
    layer.replaceChildren();
    if (!editing) return;
    if (guide) layer.appendChild(svgEl('path', { d: guide.d, class: 'guide' }));
    const m = map();
    const px = ctx.squaresPerPx();
    const sel = selection.map(byId).filter((o): o is MapObject => Boolean(o));

    for (const o of sel) {
      const b = objectBounds(o, m);
      if (b) layer.appendChild(rectEl(pad(b, 0.08), 'sel'));
    }
    if (corridorFrom) {
      const o = byId(corridorFrom);
      const b = o && objectBounds(o, m);
      if (b) layer.appendChild(rectEl(pad(b, 0.12), 'from'));
    }

    if (drag?.kind === 'move' && drag.moved) {
      const dx = snap(drag.cur[0] - drag.start[0], settings.snap);
      const dy = snap(drag.cur[1] - drag.start[1], settings.snap);
      for (const o of sel) {
        const b = objectBounds(o, m);
        if (b) layer.appendChild(rectEl({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }, 'ghost'));
      }
    } else if (drag?.kind === 'resize') {
      layer.appendChild(rectEl(resizeBounds(drag.bounds!, drag.handle!, drag.cur, settings.snap), 'ghost'));
    } else if (drag?.kind === 'create') {
      const [a, c] = [drag.start, drag.cur];
      // rooms and pillars: a ghost of the exact shape they'll get
      const exact = tool === 'room' || tool === 'cutout' ? shapeFromDrag(boxShapeOf(tool), a, c, { regular: Boolean(drag.regular), min: 1e-6 }) : null;
      const b = exact ? shapeBounds(exact) : { x0: Math.min(a[0], c[0]), y0: Math.min(a[1], c[1]), x1: Math.max(a[0], c[0]), y1: Math.max(a[1], c[1]) };
      layer.appendChild(exact ? shapeElement(exact, 'ghost') : rectEl(b, 'ghost'));
      const label = svgEl('text', { x: b.x1 + 6 * px, y: b.y1 + 14 * px, 'font-size': 12 * px, class: 'dim' });
      label.textContent = `${b.x1 - b.x0}×${b.y1 - b.y0}`;
      layer.appendChild(label);
    } else if (drag?.kind === 'door') {
      const d = doorFromDrag(drag.start, drag.cur, 0);
      if (d) {
        const end: Point = d.along === 'x' ? [d.at[0] + d.width, d.at[1]] : [d.at[0], d.at[1] + d.width];
        layer.appendChild(svgEl('line', { x1: d.at[0], y1: d.at[1], x2: end[0], y2: end[1], class: 'ghost-door' }));
      }
    }

    if (!drag && tool === 'select' && sel.length === 1) {
      const r = rectOf(sel[0]);
      if (r) {
        const b = { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] };
        const s = 8 * px;
        for (const hd of HANDLES) {
          const [x, y] = handlePoint(b, hd);
          layer.appendChild(svgEl('rect', { x: x - s / 2, y: y - s / 2, width: s, height: s, class: 'handle' }));
        }
      }
    }

    if (tool === 'poly' && poly.length) {
      const pts = [...poly, ...(hover ? [hover] : [])].map((q) => q.join(',')).join(' ');
      layer.appendChild(svgEl('polyline', { points: pts, class: 'ghost-line' }));
      layer.appendChild(svgEl('circle', { cx: poly[0]![0], cy: poly[0]![1], r: 5 * px, class: 'start' }));
    }
    if (sketch) {
      // freehand: the line as drawn, and the tidy outline it will become
      const tidy = freehandShape(sketch);
      if (tidy) layer.appendChild(shapeElement(tidy, 'ghost'));
      layer.appendChild(svgEl('polyline', { points: sketch.map((q) => q.join(',')).join(' '), class: 'ghost-line' }));
    }
    if (hover && tool !== 'select' && tool !== 'corridor' && tool !== 'prop' && tool !== 'image' && !drag) {
      const s = 5 * px;
      layer.appendChild(svgEl('path', { d: `M${hover[0] - s} ${hover[1]}H${hover[0] + s}M${hover[0]} ${hover[1] - s}V${hover[1] + s}`, class: 'cross' }));
    }
    const info = tool === 'prop' ? assetInfo(settings.prop) : undefined;
    // the props as they would land: footprints and art, turned and sized; a brush stroke shows every copy
    const ghost = (at: Point, rotation: number, scale: number) => {
      if (!info) return;
      layer.appendChild(rectEl(propBounds({ asset: info.id, at, rotation, scale }), 'ghost'));
      layer.appendChild(
        svgEl('image', { href: thumb(info.id), x: -info.w / 2, y: -info.h / 2, width: info.w, height: info.h, transform: `translate(${at[0]} ${at[1]}) rotate(${rotation}) scale(${scale})`, class: 'ghost-prop' }),
      );
    };
    if (info && stroke) {
      layer.appendChild(svgEl('polyline', { points: stroke.path.map((q) => q.join(',')).join(' '), class: 'ghost-line brush-path' }));
      for (const s of brushSpots()) ghost(s.at, s.rotation, s.scale);
    } else if (info && hoverRaw && !drag) ghost(propAt(hoverRaw, hoverStep), settings.propRotation, 1);
    if (tool === 'image' && hoverRaw && !drag) images.ghost(layer, hoverRaw, hoverStep);
    if (tool === 'segment' && !drag) segments.draw(layer, hoverRaw);
  }

  // ---------- panel ----------

  function renderTools(): void {
    const info = TOOLS.find((t) => t.id === tool)!;
    const num = (value: number, stepv: number, min: number, on: (v: number) => void) =>
      h('input', { type: 'number', value, step: stepv, min, onchange: (e: Event) => on(Number((e.target as HTMLInputElement).value) || min) });
    const choose = <T extends string>(opts: [T, string][], value: T, on: (v: T) => void) =>
      h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value as T) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    const opts: HTMLElement[] = [];
    if (['room', 'poly', 'cutout', 'stairs', 'door', 'select', 'prop', 'terrain', 'image'].includes(tool)) {
      opts.push(h('label', {}, 'Snap ', choose([['1', '1 square'], ['0.5', '½ square']], String(settings.snap) as '1' | '0.5', (v) => (settings.snap = Number(v)))));
    }
    if (tool === 'corridor') {
      opts.push(h('label', {}, 'Width ', num(settings.corridorWidth, 0.5, 0.5, (v) => (settings.corridorWidth = v))));
      opts.push(h('label', {}, 'Doors ', choose([['both', 'at both ends'], ['none', 'none']], settings.corridorDoors, (v) => (settings.corridorDoors = v))));
    }
    if (tool === 'corridor' || tool === 'door') {
      opts.push(h('label', {}, 'Door ', choose(DOOR_STYLES.map((s) => [s, s] as [typeof s, string]), settings.doorStyle, (v) => (settings.doorStyle = v))));
    }
    if (tool === 'stairs') {
      opts.push(h('label', {}, 'Up towards ', choose([['n', 'north'], ['e', 'east'], ['s', 'south'], ['w', 'west']], settings.stairsDir, (v) => (settings.stairsDir = v))));
    }
    if (tool === 'room' || tool === 'cutout') {
      const set = (v: DrawShape) => {
        if (tool === 'cutout') settings.pillarShape = v;
        else settings.roomShape = v;
        renderTools(); // the hint changes with the shape
      };
      opts.push(h('label', {}, 'Shape ', choose(SHAPE_CHOICES, shapeOf(tool), set)));
    }
    if (tool === 'cutout') opts.push(h('label', {}, 'Fill ', choose(FILL_CHOICES, settings.pillarFill, (v) => (settings.pillarFill = v))));
    if (tool === 'marker') {
      opts.push(
        h(
          'div',
          { class: 'marker-kinds', role: 'radiogroup', 'aria-label': 'Marker' },
          ...MARKER_KINDS.map((k) =>
            h(
              'button',
              { type: 'button', role: 'radio', 'aria-checked': String(k === settings.markerKind), 'aria-pressed': String(k === settings.markerKind), 'data-kind': k, onclick: () => ((settings.markerKind = k), renderTools()) },
              h('span', { class: 'kind-dot' }, k === 'discover' ? '?' : k === 'interact' ? '!' : '☠'),
              MARKERS[k].name,
            ),
          ),
        ),
      );
    }
    if (tool === 'prop') {
      opts.push(
        h(
          'div',
          { class: 'brush' },
          h('strong', {}, 'Brush: Shift + drag'),
          h('label', {}, 'One every ', num(settings.brushSpacing, 0.5, 0.5, (v) => (settings.brushSpacing = Math.min(20, Math.max(0.5, v)))), ' squares'),
          h(
            'label',
            {},
            'Placement ',
            choose(
              [
                ['regular', 'regular'],
                ['irregular', 'irregular (natural)'],
              ],
              settings.brushPlacement,
              (v) => ((settings.brushPlacement = v), renderTools()),
            ),
          ),
          ...(settings.brushPlacement === 'irregular' ? [h('label', {}, 'Spread ', num(settings.brushSpread, 0.5, 0, (v) => (settings.brushSpread = Math.min(10, Math.max(0, v)))), ' squares to the sides')] : []),
        ),
      );
      opts.push(propPicker());
    }
    if (tool === 'terrain') opts.push(tilePicker());
    if (tool === 'image') opts.push(images.picker());
    if (tool === 'segment') opts.push(...segments.options());
    if (tool === 'reveal') opts.push(...fogControls());
    toolbox.replaceChildren(
      h(
        'div',
        { class: 'toolgrid', role: 'toolbar', 'aria-label': 'Tools' },
        ...TOOLS.map((t) =>
          h('button', { type: 'button', 'aria-pressed': String(t.id === tool), title: `${t.name} (${t.key})`, onclick: () => setTool(t.id) }, t.name, h('kbd', {}, t.key)),
        ),
      ),
      ...(opts.length ? [h('div', { class: 'opts' }, ...opts)] : []),
      h('p', { class: 'hint' }, tool === 'room' || tool === 'cutout' ? drawHint(shapeOf(tool), tool === 'room' ? 'room' : 'pillar') : info.hint, ' Hold Alt for half squares.'),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', onclick: () => void ctx.history('undo').catch((e: Error) => ctx.toast(e.message)) }, 'Undo'),
        h('button', { type: 'button', onclick: () => void ctx.history('redo').catch((e: Error) => ctx.toast(e.message)) }, 'Redo'),
      ),
    );
  }

  /** A button per asset with its picture; the pressed one is what the tool places. */
  function assetButton(a: AssetInfo, pressed: boolean, on: () => void): HTMLElement {
    const pic =
      a.kind === 'terrain'
        ? h('span', { class: 'swatch', style: `background-color:${a.tint ?? '#ccc'};background-image:url("${thumb(a.id)}")` })
        : h('img', { src: thumb(a.id), alt: '', loading: 'lazy' });
    const title = `${a.name}${a.kind === 'prop' ? ` · ${a.w}×${a.h}` : ''}${a.blocks === 'sight' ? ' · blocks sight' : a.blocks === 'movement' ? ' · blocks movement' : ''}${a.difficult ? ' · difficult' : ''}`;
    return h('button', { type: 'button', 'aria-pressed': String(pressed), title, onclick: on }, pic, a.name);
  }

  function propPicker(): HTMLElement {
    const grid = h('div', { class: 'picker-grid', role: 'listbox', 'aria-label': 'Props' });
    const fill = () => {
      const words = settings.propSearch.toLowerCase().split(/\s+/).filter(Boolean);
      const list = PROPS.filter(
        (a) =>
          (words.length ? true : settings.propCategory === 'all' || a.category === settings.propCategory) &&
          words.every((w) => a.id.includes(w) || a.name.toLowerCase().includes(w) || a.tags.some((t) => t.includes(w))),
      );
      grid.replaceChildren(
        ...(list.length
          ? list.map((a) =>
              assetButton(a, a.id === settings.prop, () => {
                settings.prop = a.id;
                fill();
              }),
            )
          : [h('p', { class: 'hint' }, 'Nothing matches.')]),
      );
    };
    fill();
    const cats = CATEGORIES.filter((c) => c.id !== 'terrain');
    return h(
      'div',
      { class: 'picker' },
      h(
        'div',
        { class: 'pair' },
        h('select', { 'aria-label': 'Category', onchange: (e: Event) => ((settings.propCategory = (e.target as HTMLSelectElement).value), fill()) }, h('option', { value: 'all', selected: settings.propCategory === 'all' }, 'All props'), ...cats.map((c) => h('option', { value: c.id, selected: c.id === settings.propCategory }, c.name))),
        h('input', { type: 'search', placeholder: 'Search…', value: settings.propSearch, 'aria-label': 'Search props', oninput: (e: Event) => ((settings.propSearch = (e.target as HTMLInputElement).value), fill()) }),
      ),
      h(
        'div',
        { class: 'rotate' },
        'Facing ',
        h('button', { type: 'button', title: 'Turn left (Q)', onclick: () => turn(-90) }, '↺'),
        h('strong', {}, FACING[settings.propRotation] ?? `${settings.propRotation}°`),
        h('button', { type: 'button', title: 'Turn right (E)', onclick: () => turn(90) }, '↻'),
      ),
      grid,
    );
  }

  function tilePicker(): HTMLElement {
    const grid = h('div', { class: 'picker-grid', role: 'listbox', 'aria-label': 'Terrain' });
    const fill = () =>
      grid.replaceChildren(
        ...TILES.map((a) =>
          assetButton(a, a.id === settings.tile, () => {
            settings.tile = a.id;
            fill();
          }),
        ),
      );
    fill();
    return h('div', { class: 'picker' }, grid);
  }

  const text = (id: string, key: string, value: string | undefined, opts: { required?: boolean; area?: boolean } = {}) => {
    const commit = (e: Event) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v === (value ?? '')) return;
      if (!v && opts.required) return renderPanel();
      void apply([v ? { op: 'update', id, set: { [key]: v } } : { op: 'update', id, unset: [key] }]);
    };
    return opts.area
      ? h('textarea', { rows: 4, 'data-field': key, onchange: commit }, value ?? '')
      : h('input', { type: 'text', value: value ?? '', 'data-field': key, onchange: commit });
  };
  const number = (value: number | undefined, stepv: number, on: (v: number) => void, placeholder?: string) =>
    h('input', {
      type: 'number',
      value: value ?? '',
      step: stepv,
      placeholder,
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) on(v);
      },
    });
  const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, h('span', {}, label), input);
  const pair = (...kids: HTMLElement[]) => h('div', { class: 'pair' }, ...kids);

  function shapeFields(o: MapObject & { shape: Shape }): HTMLElement[] {
    const s = o.shape;
    if ('rect' in s) {
      const [x, y, w, hh] = s.rect;
      const set = (i: number) => (v: number) => {
        const rect = [...s.rect] as [number, number, number, number];
        rect[i] = v;
        if (rect[2] > 0 && rect[3] > 0) void apply([{ op: 'update', id: o.id, set: { shape: { rect } } }]);
      };
      return [pair(field('X', number(x, 0.5, set(0))), field('Y', number(y, 0.5, set(1)))), pair(field('Width', number(w, 0.5, set(2))), field('Height', number(hh, 0.5, set(3))))];
    }
    if ('circle' in s) {
      const [cx, cy, r] = s.circle;
      const set = (i: number) => (v: number) => {
        const circle = [...s.circle] as [number, number, number];
        circle[i] = v;
        if (circle[2] > 0) void apply([{ op: 'update', id: o.id, set: { shape: { circle } } }]);
      };
      return [pair(field('Centre X', number(cx, 0.5, set(0))), field('Centre Y', number(cy, 0.5, set(1)))), field('Radius', number(r, 0.5, set(2)))];
    }
    return [h('p', { class: 'hint' }, `Polygon with ${s.poly.length} corners. Move it with drag or arrow keys.`)];
  }

  function objectFields(o: MapObject): HTMLElement[] {
    const id = o.id;
    const upd = (set: Record<string, unknown>) => void apply([{ op: 'update', id, set }]);
    const out: HTMLElement[] = [];
    if (o.type !== 'label' && o.type !== 'marker') out.push(field('Name', text(id, 'name', o.name)));
    switch (o.type) {
      case 'room':
        out.push(field('Room number', text(id, 'label', o.label)), field('GM notes (never drawn)', text(id, 'notes', o.notes, { area: true })), roughnessPick(o), ...shapeFields(o));
        break;
      case 'cutout': {
        const fill = (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          void apply([v === 'solid' ? { op: 'update', id, set: { fill: 'solid' } } : { op: 'update', id, unset: ['fill'] }]);
        };
        out.push(field('Fill', h('select', { onchange: fill }, ...FILL_CHOICES.map(([v, l]) => h('option', { value: v, selected: v === (o.fill ?? 'rock') }, l)))), roughnessPick(o), ...shapeFields(o));
        break;
      }
      case 'stairs':
        out.push(
          field('Up towards', h('select', { onchange: (e: Event) => upd({ direction: (e.target as HTMLSelectElement).value }) }, ...(['n', 'e', 's', 'w'] as const).map((d) => h('option', { value: d, selected: d === o.direction }, { n: 'north', e: 'east', s: 'south', w: 'west' }[d])))),
          stairLabelField(o),
          ...shapeFields(o),
        );
        break;
      case 'corridor':
        out.push(
          field('Width', number(o.width, 0.5, (v) => v > 0 && upd({ width: v }))),
          roughnessPick(o),
          h('p', { class: 'hint' }, `Connects ${o.from ?? '?'} and ${o.to ?? '?'}. ${o.path ? `Custom path, ${o.path.length} points.` : 'Routed automatically; it follows its rooms.'}`),
        );
        if (o.path && o.from && o.to) out.push(h('button', { type: 'button', onclick: () => void apply([{ op: 'update', id, unset: ['path'] }]) }, 'Route automatically'));
        break;
      case 'door':
        out.push(
          field('Style', h('select', { onchange: (e: Event) => upd({ style: (e.target as HTMLSelectElement).value }) }, ...DOOR_STYLES.map((s) => h('option', { value: s, selected: s === (o.style ?? 'normal') }, s)))),
          pair(
            field('Width', number(o.width, 0.5, (v) => v > 0 && upd({ width: v }))),
            field('Runs', h('select', { onchange: (e: Event) => upd({ along: (e.target as HTMLSelectElement).value }) }, h('option', { value: 'x', selected: o.along === 'x' }, 'across (x)'), h('option', { value: 'y', selected: o.along === 'y' }, 'down (y)'))),
          ),
          pair(field('X', number(o.at[0], 0.5, (v) => upd({ at: [v, o.at[1]] }))), field('Y', number(o.at[1], 0.5, (v) => upd({ at: [o.at[0], v] })))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(o.open), onchange: (e: Event) => void apply([(e.target as HTMLInputElement).checked ? { op: 'update', id, set: { open: true } } : { op: 'update', id, unset: ['open'] }]) }), ' Open'),
        );
        break;
      case 'label':
        out.push(
          field('Text', text(id, 'text', o.text, { required: true })),
          field('Size (squares)', number(o.size, 0.1, (v) => (v > 0 ? upd({ size: v }) : void apply([{ op: 'update', id, unset: ['size'] }])), 'default')),
          pair(field('X', number(o.at[0], 0.5, (v) => upd({ at: [v, o.at[1]] }))), field('Y', number(o.at[1], 0.5, (v) => upd({ at: [o.at[0], v] })))),
        );
        break;
      case 'prop': {
        const info = assetInfo(o.asset);
        const rot = quarter(o.rotation ?? 0);
        const setRot = (r: number) => void apply([quarter(r) ? { op: 'update', id, set: { rotation: quarter(r) } } : { op: 'update', id, unset: ['rotation'] }]);
        out.push(
          field('Prop', h('select', { onchange: (e: Event) => upd({ asset: (e.target as HTMLSelectElement).value }) }, ...assetOptions(PROPS, o.asset))),
          h('p', { class: 'hint' }, info ? `${info.w}×${info.h} squares · ${info.blocks === 'none' ? 'walk over it' : info.blocks === 'movement' ? 'blocks movement' : 'blocks sight'}` : `Unknown asset "${o.asset}".`),
          h('div', { class: 'rotate' }, 'Facing ', h('button', { type: 'button', title: 'Turn left (Q)', onclick: () => setRot(rot - 90) }, '↺'), h('strong', {}, FACING[rot] ?? `${rot}°`), h('button', { type: 'button', title: 'Turn right (E)', onclick: () => setRot(rot + 90) }, '↻')),
          pair(field('X (centre)', number(o.at[0], 0.5, (v) => upd({ at: [v, o.at[1]] }))), field('Y (centre)', number(o.at[1], 0.5, (v) => upd({ at: [o.at[0], v] })))),
          field('Scale', number(o.scale, 0.25, (v) => (v > 0 && v !== 1 ? upd({ scale: v }) : void apply([{ op: 'update', id, unset: ['scale'] }])), '1')),
          ...(isConnector(o) ? [stairLabelField(o)] : []),
          field('GM notes (never drawn)', text(id, 'notes', o.notes, { area: true })),
        );
        break;
      }
      case 'terrain':
        out.push(field('Terrain', h('select', { onchange: (e: Event) => upd({ asset: (e.target as HTMLSelectElement).value }) }, ...assetOptions(TILES, o.asset))), ...shapeFields(o));
        break;
      case 'marker':
        out.push(
          field('Kind', h('select', { onchange: (e: Event) => upd({ kind: (e.target as HTMLSelectElement).value }) }, ...MARKER_KINDS.map((k) => h('option', { value: k, selected: k === o.kind }, MARKERS[k].name)))),
          // the note may be empty, but it is never unset
          field('Note for the GM', h('textarea', { rows: 4, maxlength: 2000, 'data-field': 'text', onchange: (e: Event) => { const v = (e.target as HTMLTextAreaElement).value; if (v !== o.text) upd({ text: v }); } }, o.text)),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(o.done), onchange: (e: Event) => void apply([(e.target as HTMLInputElement).checked ? { op: 'update', id, set: { done: true } } : { op: 'update', id, unset: ['done'] }]) }), ' Done (struck through)'),
          pair(field('X', number(o.at[0], 0.5, (v) => upd({ at: [v, o.at[1]] }))), field('Y', number(o.at[1], 0.5, (v) => upd({ at: [o.at[0], v] })))),
          h('p', { class: 'hint' }, 'Only in the GM view. Shift-click the marker on the map to strike it through.'),
        );
        break;
      case 'image':
        out.push(...images.fields(o));
        break;
    }
    return out;
  }

  /** Options grouped by category, with the current one selected (kept even if it's not in the catalog). */
  function assetOptions(list: readonly AssetInfo[], current: string): HTMLElement[] {
    const groups = CATEGORIES.map((c) => ({ c, items: list.filter((a) => a.category === c.id) })).filter((g) => g.items.length);
    const out: HTMLElement[] = groups.map((g) => h('optgroup', { label: g.c.name }, ...g.items.map((a) => h('option', { value: a.id, selected: a.id === current }, a.name))));
    if (!list.some((a) => a.id === current)) out.unshift(h('option', { value: current, selected: true }, current));
    return out;
  }

  /** 1 smooth … 10 caves, as words for the slider and the pickers. */
  const roughWord = (v: number) => (v <= 1 ? 'smooth' : v <= 3 ? 'worn' : v <= 5 ? 'rough-hewn' : v <= 7 ? 'rough' : v <= 9 ? 'cave' : 'extremely rough');

  /** The map's wall roughness: a slider from 1 to 10, or the style's own look. */
  function roughnessSlider(value: number | undefined): HTMLElement {
    const out = h('output', {}, value ? `${value} · ${roughWord(value)}` : 'style default');
    const range = h('input', {
      type: 'range',
      min: 1,
      max: 10,
      step: 1,
      value: value ?? 1,
      'aria-label': 'Wall roughness, 1 smooth to 10 caves',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        out.textContent = `${v} · ${roughWord(v)}`;
      },
      onchange: (e: Event) => void apply([{ op: 'update_map', set: { roughness: Number((e.target as HTMLInputElement).value) } }]),
    });
    return h(
      'div',
      { class: 'field rough' },
      h('span', {}, 'Wall roughness ', out),
      h('div', { class: 'row' }, range, ...(value ? [h('button', { type: 'button', title: "Back to the style's own walls", onclick: () => void apply([{ op: 'update_map', unset: ['roughness'] }]) }, 'Default')] : [])),
    );
  }

  /** A room's, corridor's or cutout's own roughness, or the map's. */
  function roughnessPick(o: MapObject & { roughness?: number }): HTMLElement {
    const pick = (e: Event) => {
      const v = Number((e.target as HTMLSelectElement).value);
      void apply([v ? { op: 'update', id: o.id, set: { roughness: v } } : { op: 'update', id: o.id, unset: ['roughness'] }]);
    };
    return field(
      'Wall roughness',
      h('select', { onchange: pick }, h('option', { value: '0', selected: !o.roughness }, "the map's"), ...Array.from({ length: 10 }, (_, i) => h('option', { value: String(i + 1), selected: o.roughness === i + 1 }, `${i + 1} · ${roughWord(i + 1)}`))),
    );
  }

  /** A stair's, ladder's or trapdoor's GM label (0A, -1C): set by "Number the stairs", editable by hand. */
  function stairLabelField(o: MapObject & { label?: string }): HTMLElement {
    const input = text(o.id, 'label', o.label);
    input.setAttribute('maxlength', '8');
    input.setAttribute('placeholder', 'e.g. 0A');
    return field('Label (GM view: floor, then flight letter)', input);
  }

  /** The storey's floor number (level.order): 0 ground level, below it −1, −2; above it 1, 2. */
  function floorField(level: NonNullable<DelveMap['level']>): HTMLElement {
    const set = (v: number) => {
      if (!Number.isInteger(v) || v === level.order) return renderPanel();
      const clash = ctx.storeys().find((s) => s.id !== ctx.mapId && s.level?.order === v);
      if (clash) ctx.toast(`“${clash.level?.name ?? clash.name}” is floor ${floorText(v)} too. Give each storey its own number.`);
      void apply([{ op: 'update_map', set: { level: { ...level, order: v } } }]);
    };
    return field('Floor number (0 ground, −1 below, 1 above)', number(level.order, 1, set));
  }

  /** Label every stair of this place's storeys (or of this map, as floor 0): 0A, 1A, 2A… */
  async function numberStairs(): Promise<void> {
    const res = await fetch(`/api/v1/maps/${encodeURIComponent(ctx.mapId)}/levels/label-stairs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'editor' }),
    });
    const body = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
    if (!res.ok) return ctx.toast(body.error ?? `numbering the stairs failed (${res.status})`);
    ctx.toast(body.summary ?? 'Stairs numbered.', 'info');
  }

  function mapFields(): HTMLElement[] {
    const m = map();
    const style = m.style ?? { preset: 'classic-hatching' };
    const setMap = (set: Record<string, unknown>) => void apply([{ op: 'update_map', set }]);
    return [
      h('h3', {}, 'Map'),
      field('Name', h('input', { type: 'text', value: m.name, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== m.name) setMap({ name: v }); } })),
      field('Style', h('select', { onchange: (e: Event) => setMap({ style: { ...style, preset: (e.target as HTMLSelectElement).value } }) }, ...Object.entries(PRESETS).map(([k, s]) => h('option', { value: k, selected: k === style.preset }, s.name)))),
      roughnessSlider(m.roughness),
      pair(
        field('Seed', number(m.seed, 1, (v) => Number.isInteger(v) && setMap({ seed: v }))),
        h('button', { type: 'button', class: 'align', title: 'New random hatching and wall wobble', onclick: () => setMap({ seed: Math.floor(Math.random() * 2 ** 31) }) }, 'Reroll'),
      ),
      h('h3', {}, 'Storeys'),
      ...(m.level
        ? [field('This storey', h('input', { type: 'text', value: m.level.name, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== m.level!.name) setMap({ level: { ...m.level!, name: v } }); } })), floorField(m.level)]
        : [h('p', { class: 'hint' }, 'A tower, a keep with a cellar: add storeys, and switch between them at the top.')]),
      ...(guide ? [h('p', { class: 'hint' }, `The dashed outline is the floor of “${guide.name}”, so the storeys line up.`)] : []),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => void addStorey('above') }, 'Add above'), h('button', { type: 'button', onclick: () => void addStorey('below') }, 'Add below')),
      h('button', { type: 'button', title: 'Label every stair, ladder and trapdoor in the GM view: floor number, then a letter per flight (0A, 1A, 2A)', onclick: () => void numberStairs() }, 'Number the stairs'),
      h('p', { class: 'hint' }, m.level ? 'Stairs that line up on the storeys above and below share a letter.' : 'This map counts as floor 0.'),
      h('h3', {}, 'Fog of war'),
      ...fogControls(),
      h('p', { class: 'hint' }, 'Reveal rooms with the Reveal tool (G), or ask Claude.'),
      h('p', { class: 'hint' }, 'Select something on the map to edit it.'),
      h('button', { type: 'button', class: 'danger', onclick: () => void deleteMap() }, m.level ? 'Delete this storey' : 'Delete map'),
    ];
  }

  function renderPanel(): void {
    const m = map();
    selection = selection.filter((id) => m.objects.some((o) => o.id === id));
    if (props.contains(document.activeElement) && !focusField) return; // don't yank a field out from under the user
    const sel = selection.map(byId).filter((o): o is MapObject => Boolean(o));
    let kids: HTMLElement[];
    if (!sel.length) kids = mapFields();
    else if (sel.length === 1) {
      const o = sel[0]!;
      kids = [h('h3', {}, `${o.type[0]!.toUpperCase()}${o.type.slice(1)} `, h('code', {}, o.id)), ...objectFields(o)];
    } else {
      kids = [h('h3', {}, `${sel.length} selected`), h('p', { class: 'hint' }, sel.map((o) => o.id).join(', '))];
    }
    if (sel.length) kids.push(segments.selectionSave(sel.map((o) => o.id)));
    if (sel.length) kids.push(h('button', { type: 'button', class: 'danger', onclick: deleteSelection }, sel.length === 1 ? 'Delete' : `Delete ${sel.length}`));
    props.replaceChildren(...kids);
    if (focusField) {
      const el = props.querySelector<HTMLInputElement>(`[data-field="${focusField}"]`);
      if (el) {
        el.focus();
        el.select();
        focusField = null;
      }
    }
  }

  // ---------- wiring ----------

  ctx.onRender(() => {
    if (tool === 'reveal') renderTools(); // keep the fog switch and count current
    if (wantSelect && ctx.rev() >= wantSelect.rev) {
      selection = wantSelect.ids;
      wantSelect = null;
    }
    renderPanel();
    draw();
  });
  ctx.onView(draw);
  toggle?.addEventListener('click', () => setEditing(!editing));
  // Enter in a panel field commits it and hands the keyboard back to the map;
  // Escape puts the old value back. Either way, tool shortcuts work again.
  panel.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (e.key === 'Enter' && el instanceof HTMLInputElement) el.blur();
    else if (e.key === 'Escape') {
      el.value = el.defaultValue;
      el.blur();
      renderPanel();
    }
  });
  renderTools();
  renderPanel();
  setEditing(new URLSearchParams(location.search).get('edit') === '1');
  // The chat panel tells Claude what's selected ("this room").
  return { selection: () => (editing ? [...selection] : []), tool: () => (editing ? tool : null) };
}
