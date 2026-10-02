// The map editor: the tool rail, the context bar, the pickers, selection, drag
// previews, keyboard shortcuts and the inspector, laid out as in the design
// (docs/design/ui-v1/Delve Editor.dc.html). Every edit is sent as ops over the
// live socket; the map on screen only changes when the server's broadcast
// comes back, so the user and Claude always see the same thing.
import {
  ASSETS,
  assetInfo,
  categoryOf,
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
  NOTES_MAX,
  PRESETS,
  propBounds,
  propHidden,
  HIDDEN_ASSETS,
  propCentre,
  scatterAlong,
  shapeBounds,
  shapeFromDrag,
  SQUARE_SIZES,
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
import type { IconName } from '@delve/ui';
import type { ViewerCtx } from './ctx.ts';
import { btn, checkbox, field, h, iconBtn, iconEl, input, miniRange, range, seg, select, svgEl, textarea, type Kid } from './dom.ts';
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

type Tool = 'select' | 'pan' | 'room' | 'poly' | 'corridor' | 'door' | 'stairs' | 'cutout' | 'prop' | 'terrain' | 'label' | 'marker' | 'reveal' | 'image' | 'segment';

interface ToolInfo {
  id: Tool;
  name: string;
  /** The phone toolbar's short label. */
  short: string;
  key: string;
  icon: IconName;
  /** The tooltip's extra hint. */
  tip?: string;
}

/** The rail, in the design's groups and with its letters. Polygon lives under Room (shape 8, or O). */
const TOOL_GROUPS: ToolInfo[][] = [
  [
    { id: 'select', name: 'Select', short: 'Select', key: 'V', icon: 'select' },
    { id: 'pan', name: 'Pan', short: 'Pan', key: 'H', icon: 'pan', tip: 'or hold Space' },
  ],
  [
    { id: 'room', name: 'Room', short: 'Room', key: 'R', icon: 'room', tip: '1–8 change shape' },
    { id: 'corridor', name: 'Corridor', short: 'Corridor', key: 'C', icon: 'corridor' },
    { id: 'door', name: 'Door', short: 'Door', key: 'D', icon: 'door' },
    { id: 'stairs', name: 'Stairs', short: 'Stairs', key: 'S', icon: 'stairs' },
    { id: 'cutout', name: 'Pillar / cutout', short: 'Pillar', key: 'I', icon: 'pillar' },
  ],
  [
    { id: 'prop', name: 'Prop', short: 'Prop', key: 'P', icon: 'prop', tip: 'Q / E rotate' },
    { id: 'terrain', name: 'Terrain', short: 'Terrain', key: 'G', icon: 'terrain' },
    { id: 'label', name: 'Label', short: 'Label', key: 'T', icon: 'label' },
  ],
  [
    { id: 'marker', name: 'GM marker', short: 'Marker', key: 'M', icon: 'marker' },
    { id: 'reveal', name: 'Fog reveal', short: 'Fog', key: 'F', icon: 'fog' },
  ],
  [
    { id: 'image', name: 'Image upload', short: 'Image', key: 'U', icon: 'image' },
    { id: 'segment', name: 'Segment', short: 'Segment', key: 'B', icon: 'segment' },
  ],
];
const TOOLS = TOOL_GROUPS.flat();
const POLY: ToolInfo = { id: 'poly', name: 'Room', short: 'Room', key: 'O', icon: 'room' };
const infoOf = (t: Tool): ToolInfo => TOOLS.find((x) => x.id === t) ?? POLY;

const PROPS = ASSETS.filter((a) => a.kind === 'prop');
const TILES = ASSETS.filter((a) => a.kind === 'terrain');
const thumb = (id: string) => `/assets/props/${encodeURIComponent(id)}.svg`;
/** Turned by 15° steps, folded into 0…345. */
const turned = (deg: number) => (((Math.round(deg / 15) * 15) % 360) + 360) % 360;
const SHAPE_ICON: Record<DrawShape, IconName> = { rect: 'shape-rect', circle: 'shape-circle', oval: 'shape-oval', triangle: 'shape-triangle', hexagon: 'shape-hexagon', octagon: 'shape-octagon', freehand: 'shape-freehand' };
const TYPE_ICON: Record<MapObject['type'], IconName> = { room: 'room', corridor: 'corridor', cutout: 'pillar', door: 'door', stairs: 'stairs', label: 'label', prop: 'prop', terrain: 'terrain', marker: 'marker', image: 'image' };
const TYPE_NAME: Record<MapObject['type'], string> = { room: 'Room', corridor: 'Corridor', cutout: 'Pillar / cutout', door: 'Door', stairs: 'Stairs', label: 'Label', prop: 'Prop', terrain: 'Terrain', marker: 'GM marker', image: 'Image' };
const DOOR_NAME: Record<(typeof DOOR_STYLES)[number], string> = { normal: 'Door', double: 'Double', locked: 'Locked', secret: 'Secret', portcullis: 'Portcullis', archway: 'Archway' };
const DIRS: ['n' | 'e' | 's' | 'w', string][] = [['n', 'North'], ['e', 'East'], ['s', 'South'], ['w', 'West']];
const GLYPH = { discover: '?', interact: '!', trap: '' } as const;
/** 1 smooth … 10 caves, as words for the sliders. */
const roughWord = (v: number) => (v <= 1 ? 'smooth' : v <= 3 ? 'worn' : v <= 5 ? 'rough-hewn' : v <= 7 ? 'rough' : v <= 9 ? 'cave' : 'crumbling');

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
  /** Reveal tool: the unsnapped point (for clicking a room) and whether Shift was held (the other way round). */
  raw?: Point;
  invert?: boolean;
  /** Room and Pillar tools: Shift is down, so the shape keeps width and height equal. */
  regular?: boolean;
}

export function initEditor(ctx: ViewerCtx): { selection(): string[]; tool(): string | null } {
  const rail = document.getElementById('rail')!;
  const ctxbar = document.getElementById('ctxbar')!;
  const flyout = document.getElementById('flyout')!;
  const props = document.getElementById('props')!;
  const panel = document.getElementById('panel')!;
  const tabInspector = document.getElementById('tab-inspector')!;
  const tabMap = document.getElementById('tab-map')!;
  const phonetools = document.getElementById('phonetools');
  const layer = svgEl('g', { class: 'ed' });
  ctx.overlay.appendChild(layer);

  let tool: Tool = 'select';
  let tab: 'inspector' | 'map' = 'inspector';
  let selection: string[] = [];
  let drag: Drag | null = null;
  let poly: Point[] = [];
  let hover: Point | null = null;
  let hoverRaw: Point | null = null;
  let hoverStep = 1;
  let corridorFrom: string | null = null;
  let spaceDown = false;
  /** A brush stroke with the Prop tool: the path so far, a seed so the preview and the result agree, and the snap step. */
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
    propCategory: 'all',
    propSearch: '',
    tile: TILES[0]?.id ?? '',
    tileSearch: '',
    markerKind: 'discover' as (typeof MARKER_KINDS)[number],
    brush: false,
    brushSpacing: 3,
    brushScatter: 0,
    roomShape: 'rect' as DrawShape,
    pillarShape: 'rect' as DrawShape,
    pillarFill: 'rock' as CutoutFill,
    fogMode: 'reveal' as 'reveal' | 'hide',
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
  const panning = () => tool === 'pan' || spaceDown;

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
        if (ctx.rev() >= rev) setSelection(select);
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
    active: () => tool === 'image',
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

  // ---------- selection and the panels' layout ----------

  /** On narrow screens the inspector is a drawer, on phones a sheet: both open with a selection. */
  function syncLayout(): void {
    const l = ctx.shell.layout();
    const open = selection.length > 0 || tab === 'map';
    if (l === 'narrow') ctx.shell.setDrawer(open);
    else ctx.shell.setDrawer(false);
    if (l === 'phone') {
      if (open) ctx.shell.setSheet('inspector');
      else if (document.body.classList.contains('sheet-inspector')) ctx.shell.setSheet(null);
    }
  }

  function setSelection(ids: string[]): void {
    selection = ids;
    if (ids.length && tab === 'map') setTab('inspector', false);
    syncLayout();
  }

  function setTab(t: 'inspector' | 'map', render = true): void {
    tab = t;
    tabInspector.setAttribute('aria-selected', String(t === 'inspector'));
    tabMap.setAttribute('aria-selected', String(t === 'map'));
    if (render) {
      renderPanel(true);
      syncLayout();
    }
  }

  // ---------- tools ----------

  function setTool(t: Tool): void {
    // a prop selected on the map becomes the one the Prop tool (and its brush) places
    const picked = selection.length === 1 ? byId(selection[0]!) : undefined;
    if (t === 'prop' && tool !== 'prop' && picked?.type === 'prop' && assetInfo(picked.asset)) {
      settings.prop = picked.asset;
      settings.propRotation = turned(picked.rotation ?? 0);
    }
    tool = t;
    poly = [];
    corridorFrom = null;
    stroke = null;
    sketch = null;
    if (t === 'segment') segments.activate();
    ctx.stage.dataset.tool = t;
    hideTip();
    renderTools();
    draw();
  }

  // ---------- pointer ----------

  function onDown(e: PointerEvent): void {
    if (e.button !== 0 || panning()) return;
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
          if (e.shiftKey) setSelection(selection.includes(hit) ? selection.filter((s) => s !== hit) : [...selection, hit]);
          else if (!selection.includes(hit)) setSelection([hit]);
          renderPanel();
          start('move', {}, p);
        } else if (!e.shiftKey && selection.length) {
          setSelection([]);
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
        if ((settings.brush || e.shiftKey) && assetInfo(settings.prop)) {
          // the brush: copies along the drag, placed when the button comes up
          stroke = { path: [propAt(p, step(e))], seed: Math.floor(Math.random() * 2 ** 31), step: step(e) };
          ctx.stage.setPointerCapture(e.pointerId);
        } else placeProp(p, step(e));
        break;
      case 'reveal':
        start('create', { raw: p, invert: e.shiftKey });
        break;
      case 'door':
        start('door');
        break;
      case 'poly':
        ctx.handled.add(e);
        if (closesPolygon(poly, ps, tol() * 2)) finishPoly();
        else if (!poly.length || ps[0] !== poly.at(-1)![0] || ps[1] !== poly.at(-1)![1]) poly.push(ps);
        renderTools();
        break;
      case 'corridor': {
        const hit = hitTest(map(), p, tol());
        if (hit && byId(hit)?.type === 'room') {
          ctx.handled.add(e);
          if (!corridorFrom) corridorFrom = hit;
          else if (hit !== corridorFrom) {
            connect(corridorFrom, hit);
            corridorFrom = null;
          }
          renderTools();
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
    if (drag || (tool !== 'select' && tool !== 'pan')) draw();
  }

  function onUp(e: PointerEvent): void {
    if (stroke) {
      ctx.handled.add(e);
      return finishStroke();
    }
    if (sketch) {
      ctx.handled.add(e);
      return finishSketch();
    }
    if (!drag) return;
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
              setSelection([next]);
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
          const hide = (settings.fogMode === 'hide') !== Boolean(d.invert);
          const area = rectFromDrag(d.start, d.cur, s);
          if (d.moved && area) {
            fogChange(hide ? { coverArea: { rect: area } } : { revealArea: { rect: area } });
          } else {
            // a click: show or hide the room or corridor under the pointer
            const hit = hitAll(m, d.raw ?? d.start, tol())
              .map(byId)
              .find((o) => o?.type === 'room' || o?.type === 'corridor');
            if (hit) fogChange(hide ? { cover: [hit.id] } : { reveal: [hit.id] });
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
    renderTools();
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

  /** Where the prop tool would put the chosen prop for pointer p: its footprint snapped to the grid around p. */
  function propAt(p: Point, s: number): Point {
    const b = propBounds({ asset: settings.prop, at: [0, 0], rotation: settings.propRotation });
    const corner: Point = [snap(p[0] - (b.x1 - b.x0) / 2, s), snap(p[1] - (b.y1 - b.y0) / 2, s)];
    return propCentre(settings.prop, corner, settings.propRotation);
  }

  function placeProp(p: Point, s: number): void {
    if (!assetInfo(settings.prop)) return ctx.toast('Pick a prop in the picker first.', 'info');
    const id = nextId(map(), 'i');
    const at = propAt(p, s);
    void apply([{ op: 'add', object: { id, type: 'prop', asset: settings.prop, at, ...(settings.propRotation ? { rotation: settings.propRotation } : {}) } }], [id]);
  }

  /**
   * Where a brush stroke puts its copies: without scatter they snap to the grid
   * like a click would, with scatter they stay where it put them. Never on top
   * of the same prop already there.
   */
  function brushSpots(): Placement[] {
    if (!stroke) return [];
    const avoid = map().objects.flatMap((o) => (o.type === 'prop' && o.asset === settings.prop ? [o.at] : []));
    const regular = settings.brushScatter === 0;
    const spots = scatterAlong(stroke.path, {
      spacing: settings.brushSpacing,
      placement: regular ? 'regular' : 'irregular',
      spread: (settings.brushScatter / 100) * 4,
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

  /** Q / E: turn the prop about to be placed, or the selected props and pictures, 15° (Shift: a quarter). */
  function turn(by: number): void {
    if (tool === 'segment') return segments.turn(by > 0 ? 90 : -90); // segments turn in quarters
    if (tool !== 'prop' && images.turn(by, tool === 'image', selection.map(byId))) return;
    const ps = selection.map(byId).filter((o): o is Extract<MapObject, { type: 'prop' }> => o?.type === 'prop');
    if (tool === 'prop' || !ps.length) {
      settings.propRotation = turned(settings.propRotation + by);
      renderTools();
      draw();
      return;
    }
    void apply(ps.map((o) => setRotation(o.id, (o.rotation ?? 0) + by)));
  }
  const setRotation = (id: string, deg: number): Op => (turned(deg) ? { op: 'update', id, set: { rotation: turned(deg) } } : { op: 'update', id, unset: ['rotation'] });

  /** Ctrl D: copies of the selection one square down and right, as one undo step. Corridors follow their rooms, so they aren't copied. */
  function duplicate(): void {
    const m = map();
    const src = selection.map(byId).filter((o): o is MapObject => Boolean(o) && o!.type !== 'corridor');
    if (!src.length) return ctx.toast(selection.length ? 'Corridors follow their rooms: copy the rooms and connect them.' : 'Select something to duplicate.', 'info');
    const count = new Map<string, number>();
    let label = Number(nextLabel(m));
    const copies = src.map((o) => {
      const prefix = /^[A-Za-z_-]+/.exec(o.id)?.[0] ?? 'o';
      const k = count.get(prefix) ?? 0;
      count.set(prefix, k + 1);
      const copy = { ...structuredClone(o), id: nextId(m, prefix, k) } as MapObject;
      if (copy.type === 'room' && /^\d+$/.test(copy.label ?? '')) copy.label = String(label++);
      return copy;
    });
    const ids = copies.map((c) => c.id);
    void apply([...copies.map((object): Op => ({ op: 'add', object })), { op: 'move', ids, dx: 1, dy: 1 }], ids);
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
    location.href = `/maps/${encodeURIComponent(body.id)}`;
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
    location.href = other ? `/maps/${encodeURIComponent(other.id)}` : '/';
  }

  function deleteSelection(): void {
    if (!selection.length) return;
    const ids = deletionSet(map(), selection);
    setSelection([]);
    void apply([{ op: 'delete', ids }]);
  }

  ctx.stage.addEventListener('pointerdown', onDown, { capture: true });
  ctx.stage.addEventListener('pointermove', onMove, { capture: true });
  ctx.stage.addEventListener('pointerup', onUp, { capture: true });
  ctx.stage.addEventListener('pointerleave', () => {
    hover = null;
    hoverRaw = null;
    draw();
  });
  ctx.stage.addEventListener(
    'dblclick',
    (e) => {
      if (tool === 'poly') {
        ctx.handled.add(e);
        finishPoly();
      } else if (tool !== 'select' && tool !== 'pan') ctx.handled.add(e);
    },
    { capture: true },
  );

  // ---------- keyboard ----------

  const typing = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest('input, select, textarea'));
  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
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
    if (mod && key === 'd') {
      e.preventDefault();
      duplicate();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        ctx.stage.classList.add('panning');
      }
      return;
    }
    if (e.shiftKey && (key === 'p' || key === 'g')) return; // the viewer's: view and grid
    if (key === 'q' || key === 'e') return turn((key === 'e' ? 1 : -1) * (e.shiftKey ? 90 : 15));
    if ((tool === 'room' || tool === 'poly' || tool === 'cutout') && /^[1-8]$/.test(e.key)) return pickShape(Number(e.key) - 1);
    const t = TOOLS.find((x) => x.key.toLowerCase() === key) ?? (key === 'o' ? POLY : undefined);
    if (t && !e.shiftKey) return setTool(t.id);
    if (e.key === 'Escape') {
      if (stroke) stroke = null;
      else if (sketch) sketch = null;
      else if (drag) drag = null;
      else if (poly.length) poly = [];
      else if (corridorFrom) corridorFrom = null;
      else if (segments.cancel(tool === 'segment')) {
        // a half-done segment save, a rename, or the segment about to be placed
      } else if (selection.length) setSelection([]);
      else setTool('select');
      renderTools();
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
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      ctx.stage.classList.remove('panning');
    }
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    ctx.stage.classList.remove('panning');
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
      // the size, in the design's selection chip: "9 × 9 sq"
      const text = `${b.x1 - b.x0} × ${b.y1 - b.y0} sq`;
      const fs = 11 * px;
      const w = (text.length * 6.4 + 14) * px;
      const x = (b.x0 + b.x1) / 2 - w / 2;
      const y = b.y1 + 6 * px;
      layer.appendChild(svgEl('rect', { x, y, width: w, height: 20 * px, rx: 4 * px, class: 'dim-bg' }));
      const label = svgEl('text', { x: x + w / 2, y: y + 14 * px, 'font-size': fs, 'text-anchor': 'middle', class: 'dim' });
      label.textContent = text;
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
    if (hover && !['select', 'pan', 'corridor', 'prop', 'image'].includes(tool) && !drag) {
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

  // ---------- the rail and its tooltip ----------

  const tip = h('div', { class: 'tooltip ed-tip', role: 'tooltip', hidden: true });
  document.body.appendChild(tip);
  let tipTimer = 0;
  let tipShown = false;
  function showTip(el: HTMLElement, t: ToolInfo | { name: string; key: string; tip?: string }): void {
    clearTimeout(tipTimer);
    const go = () => {
      tip.replaceChildren(h('span', {}, t.name), h('kbd', {}, t.key), ...(t.tip ? [h('span', { class: 'tooltip-hint' }, t.tip)] : []));
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      tip.style.left = `${r.right + 8}px`;
      tip.style.top = `${r.top + r.height / 2 - tip.offsetHeight / 2}px`;
      tipShown = true;
    };
    // after 400 ms, or at once while another is open
    if (tipShown) go();
    else tipTimer = window.setTimeout(go, 400);
  }
  function hideTip(): void {
    clearTimeout(tipTimer);
    tip.hidden = true;
    tipTimer = window.setTimeout(() => (tipShown = false), 300);
  }

  const railButtons = new Map<Tool, HTMLButtonElement>();
  function buildRail(): void {
    const kids: HTMLElement[] = [];
    TOOL_GROUPS.forEach((g, gi) => {
      if (gi) kids.push(h('span', { class: 'rail-sep' }));
      for (const t of g) {
        const b = h(
          'button',
          {
            type: 'button',
            class: 'tool',
            'aria-label': t.name,
            'aria-keyshortcuts': t.key,
            'aria-pressed': 'false',
            onclick: () => setTool(t.id),
            onpointerenter: () => showTip(b, t),
            onpointerleave: hideTip,
            onfocus: () => showTip(b, t),
            onblur: hideTip,
          },
          iconEl(t.icon, 20),
          h('span', { class: 'tool-key' }, t.key),
        );
        railButtons.set(t.id, b);
        kids.push(b);
      }
    });
    const gridBtn = h('button', { type: 'button', class: 'tool is-toggle', 'aria-label': 'Toggle grid', 'aria-pressed': String(ctx.grid()), onclick: () => (ctx.toggleGrid(), gridBtn.setAttribute('aria-pressed', String(ctx.grid()))) }, iconEl('grid', 19));
    gridBtn.addEventListener('pointerenter', () => showTip(gridBtn, { name: 'Grid', key: 'Shift G' }));
    gridBtn.addEventListener('pointerleave', hideTip);
    const keysBtn = h('button', { type: 'button', class: 'tool', 'aria-label': 'Keyboard shortcuts', onclick: () => ctx.shell.openShortcuts() }, iconEl('keyboard', 19));
    keysBtn.addEventListener('pointerenter', () => showTip(keysBtn, { name: 'Shortcuts', key: '?' }));
    keysBtn.addEventListener('pointerleave', hideTip);
    ctx.onRender(() => gridBtn.setAttribute('aria-pressed', String(ctx.grid())));
    rail.replaceChildren(...kids, h('span', { class: 'spacer' }), gridBtn, keysBtn);
    // arrow keys move along the rail
    rail.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = [...rail.querySelectorAll<HTMLButtonElement>('.tool')];
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]!.focus();
    });
    if (phonetools) {
      phonetools.replaceChildren(
        ...TOOLS.filter((t) => t.id !== 'pan').map((t) => {
          const b = h('button', { type: 'button', class: 'ed-phonetool', 'aria-label': t.name, 'aria-pressed': 'false', 'data-tool': t.id, onclick: () => setTool(t.id) }, iconEl(t.icon, 22), t.short);
          return b;
        }),
      );
    }
  }

  function syncRail(): void {
    const active = tool === 'poly' ? 'room' : tool;
    for (const [id, b] of railButtons) b.setAttribute('aria-pressed', String(id === active));
    phonetools?.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === active)));
  }

  // ---------- the context bar ----------

  /** A choice chip in the context bar. */
  const chip = (label: Kid, on: boolean, pick: () => void, o: { icon?: IconName; num?: string; title?: string; lead?: Node } = {}) =>
    h(
      'button',
      { type: 'button', class: 'ctxbar-opt', role: 'radio', 'aria-checked': String(on), title: o.title, onclick: pick },
      o.lead ?? null,
      o.icon ? iconEl(o.icon, 17) : null,
      label,
      o.num ? h('span', { class: 'ctxbar-num' }, o.num) : null,
    );
  const group = (label: string, ...kids: HTMLElement[]) => h('div', { role: 'radiogroup', 'aria-label': label, style: 'display:flex;gap:2px;align-items:center' }, ...kids);
  const keyHint = (k: string, t: string) => h('span', { class: 'ed-ctx-key' }, h('kbd', {}, k), t);
  const hint = (t: string) => h('span', { class: 'ed-ctx-hint' }, t);
  const ctxLabel = (t: string) => h('span', { class: 'ed-ctx-label' }, t);

  function pickShape(i: number): void {
    if (tool === 'cutout') {
      const s = SHAPE_CHOICES[i];
      if (s) settings.pillarShape = s[0];
      return renderTools();
    }
    if (i === 7) return setTool('poly');
    const s = SHAPE_CHOICES[i];
    if (!s) return;
    settings.roomShape = s[0];
    if (tool !== 'room') setTool('room');
    else renderTools();
  }

  function shapeChips(): HTMLElement {
    const current = tool === 'poly' ? 'polygon' : shapeOf(tool);
    const chips = SHAPE_CHOICES.map(([k, name], i) => chip(null, current === k, () => pickShape(i), { icon: SHAPE_ICON[k], num: String(i + 1), title: `${name[0]!.toUpperCase()}${name.slice(1)} · ${i + 1}` }));
    if (tool !== 'cutout') chips.push(chip(null, current === 'polygon', () => pickShape(7), { icon: 'polygon', num: '8', title: 'Polygon: click the corners · 8' }));
    return group('Shape', ...chips);
  }

  function ctxContent(): Kid[] {
    const m = map();
    switch (tool) {
      case 'select':
        return [hint('Click to select · Shift-click adds · drag to move'), keyHint('Del', 'delete'), keyHint('Ctrl D', 'duplicate')];
      case 'pan':
        return [hint('Drag to pan · scroll to zoom'), keyHint('Ctrl 0', 'fit'), keyHint('+ −', 'zoom')];
      case 'room':
        return [shapeChips(), shapeOf('room') === 'freehand' ? hint('Hold and draw the outline') : keyHint('Shift', 'square')];
      case 'poly':
        return [shapeChips(), hint(poly.length ? `${poly.length} corner${poly.length === 1 ? '' : 's'} · click the first one or press Enter` : 'Click the corners'), keyHint('Esc', 'cancel')];
      case 'cutout':
        return [
          shapeChips(),
          h('span', { class: 'vsep' }),
          group('Fill', ...FILL_CHOICES.map(([k, l]) => chip(k === 'rock' ? 'Rock' : 'Solid', settings.pillarFill === k, () => ((settings.pillarFill = k), renderTools()), { title: l }))),
        ];
      case 'corridor':
        return [
          hint(corridorFrom ? 'Now click the room to connect it to' : 'Click a room, then another'),
          h('span', { class: 'vsep' }),
          miniRange('Width', { value: settings.corridorWidth, min: 1, max: 6, step: 0.5, show: (v) => `${v} sq`, onChange: (v) => (settings.corridorWidth = v), onInput: (v) => (settings.corridorWidth = v) }),
          group('Doors', chip('Doors', settings.corridorDoors === 'both', () => ((settings.corridorDoors = 'both'), renderTools())), chip('Open', settings.corridorDoors === 'none', () => ((settings.corridorDoors = 'none'), renderTools()))),
          ...(corridorFrom ? [keyHint('Esc', 'cancel')] : []),
        ];
      case 'door':
        return [group('Door style', ...DOOR_STYLES.map((s) => chip(DOOR_NAME[s], settings.doorStyle === s, () => ((settings.doorStyle = s), renderTools())))), hint('Drag along a wall')];
      case 'stairs':
        return [ctxLabel('Up towards'), group('Up towards', ...DIRS.map(([d, l]) => chip(l, settings.stairsDir === d, () => ((settings.stairsDir = d), renderTools())))), hint('Drag along the flight')];
      case 'prop': {
        const out: Kid[] = [group('Mode', chip('Stamp', !settings.brush, () => ((settings.brush = false), renderTools()), { icon: 'prop' }), chip('Brush', settings.brush, () => ((settings.brush = true), renderTools()), { icon: 'brush' }))];
        if (settings.brush) {
          out.push(
            miniRange('Spacing', { value: settings.brushSpacing, min: 0.5, max: 10, step: 0.5, show: (v) => `${v} sq`, onChange: (v) => (settings.brushSpacing = v), onInput: (v) => (settings.brushSpacing = v) }),
            miniRange('Scatter', { value: settings.brushScatter, min: 0, max: 100, step: 5, show: (v) => `${v}%`, onChange: (v) => (settings.brushScatter = v), onInput: (v) => (settings.brushScatter = v) }),
          );
        } else out.push(keyHint('Shift', 'drag to paint'));
        return out;
      }
      case 'terrain': {
        const t = assetInfo(settings.tile);
        return [t ? h('span', { class: 'ctxbar-opt', 'aria-checked': 'true', style: 'cursor:default' }, h('span', { class: 'ed-swatch', style: `background-color:${t.tint ?? '#ccc'};background-image:url("${thumb(t.id)}")` }), t.name) : null, hint('Drag an area')];
      }
      case 'label':
        return [hint('Click to place text, then type it'), keyHint('Enter', 'commit'), keyHint('Esc', 'cancel')];
      case 'marker':
        return [
          group(
            'Marker',
            ...MARKER_KINDS.map((k) =>
              chip(MARKERS[k].name, settings.markerKind === k, () => ((settings.markerKind = k), renderTools()), {
                lead: h('span', { class: `ed-dot marker-${k}` }, k === 'trap' ? iconEl('skull', 12, 2) : GLYPH[k]),
              }),
            ),
          ),
          hint('Click to drop · the note opens'),
        ];
      case 'reveal': {
        const fog = m.fog;
        if (!fog?.on) return [hint('Fog of war is off: players see the whole map'), btn('Turn fog on', { kind: 'primary', icon: 'fog', onclick: () => fogChange({ on: true }) })];
        return [
          group('Fog', chip('Reveal', settings.fogMode === 'reveal', () => ((settings.fogMode = 'reveal'), renderTools()), { icon: 'eye' }), chip('Hide', settings.fogMode === 'hide', () => ((settings.fogMode = 'hide'), renderTools()), { icon: 'eye-off' })),
          btn('Reveal all', { icon: 'eye', onclick: () => fogChange({ revealAll: true }) }),
          btn('Hide all', { icon: 'fog', onclick: () => fogChange({ reset: true, on: true }) }),
          keyHint('Shift', 'the other way'),
        ];
      }
      case 'image':
        return [btn('Upload image', { icon: 'upload', onclick: () => flyout.querySelector<HTMLInputElement>('input[type="file"]')?.click() }), hint('or drop or paste a picture on the map')];
      case 'segment':
        return [hint(segments.mode() === 'place' ? 'Click to place the chosen segment' : segments.mode() === 'save' ? 'Drag a box around what to save' : 'Drag a box to fill with the segment'), keyHint('Q / E', 'turn')];
    }
  }

  function renderTools(): void {
    syncRail();
    const t = infoOf(tool);
    const content = ctxContent().filter((k): k is Node | string => Boolean(k));
    ctxbar.replaceChildren(h('span', { class: 'ctxbar-title' }, iconEl(t.icon, 16), t.name), h('span', { class: 'vsep' }), ...content);
    if (tool === 'room' || tool === 'cutout') ctxbar.title = drawHint(shapeOf(tool), tool === 'room' ? 'room' : 'pillar');
    else ctxbar.removeAttribute('title');
    renderFlyout();
  }

  // ---------- the pickers (props, terrain, images, segments) ----------

  function flyoutShell(title: string, count: string | null, body: HTMLElement[], foot?: HTMLElement): void {
    flyout.hidden = false;
    flyout.setAttribute('aria-label', `${title} picker`);
    flyout.replaceChildren(
      h('div', { class: 'ed-flyout-head' }, h('span', { class: 'ed-flyout-title' }, title), count ? h('span', { class: 'ed-flyout-count' }, count) : null, h('span', { class: 'spacer' }), iconBtn('x', 'Close the picker', () => setTool('select'), { size: 16 })),
      ...body,
      ...(foot ? [foot] : []),
    );
  }

  function assetButton(a: AssetInfo, pressed: boolean, on: () => void): HTMLElement {
    const pic =
      a.kind === 'terrain'
        ? h('span', { class: 'tile', style: `background-color:${a.tint ?? '#ccc'};background-image:url("${thumb(a.id)}")` })
        : h('img', { src: thumb(a.id), alt: '', loading: 'lazy' });
    const title = `${a.name}${a.kind === 'prop' ? ` · ${a.w}×${a.h}` : ''}${a.blocks === 'sight' ? ' · blocks sight' : a.blocks === 'movement' ? ' · blocks movement' : ''}${a.difficult ? ' · difficult' : ''}`;
    return h('button', { type: 'button', class: 'ed-asset', 'aria-pressed': String(pressed), title, onclick: on }, h('span', { class: 'ed-asset-pic' }, pic), h('span', { class: 'ed-asset-name' }, a.name));
  }

  function propPicker(): void {
    const grid = h('div', { class: 'ed-grid', role: 'listbox', 'aria-label': 'Props' });
    const count = h('span', { class: 'ed-flyout-count' });
    const fill = () => {
      const words = settings.propSearch.toLowerCase().split(/\s+/).filter(Boolean);
      const list = PROPS.filter(
        (a) =>
          (words.length ? true : settings.propCategory === 'all' || a.category === settings.propCategory) &&
          words.every((w) => a.id.includes(w) || a.name.toLowerCase().includes(w) || a.tags.some((t) => t.includes(w))),
      );
      count.textContent = `${list.length} of ${PROPS.length}`;
      grid.replaceChildren(...(list.length ? list.map((a) => assetButton(a, a.id === settings.prop, () => ((settings.prop = a.id), fill(), draw()))) : [h('p', { class: 'hint', style: 'grid-column:1/-1' }, 'Nothing matches.')]));
    };
    const cats = [{ id: 'all', name: 'All' }, ...CATEGORIES.filter((c) => c.id !== 'terrain' && PROPS.some((a) => a.category === c.id))];
    const chips = h(
      'div',
      { class: 'ed-chips', role: 'tablist', 'aria-label': 'Categories' },
      ...cats.map((c) => h('button', { type: 'button', class: 'ed-chip', role: 'tab', 'aria-selected': String(settings.propCategory === c.id), onclick: () => ((settings.propCategory = c.id), renderFlyout()) }, c.name)),
    );
    const search = input({ type: 'search', placeholder: 'Search props', value: settings.propSearch, 'aria-label': 'Search props', oninput: (e: Event) => ((settings.propSearch = (e.target as HTMLInputElement).value), fill()) });
    fill();
    flyoutShell('Props', null, [h('div', { class: 'ed-search' }, iconEl('search', 15), search), chips, h('div', { class: 'ed-flyout-body' }, grid)], h('div', { class: 'ed-flyout-foot' }, h('kbd', {}, 'Q'), h('kbd', {}, 'E'), `rotate · now ${settings.propRotation}°`));
    flyout.querySelector('.ed-flyout-head')!.insertBefore(count, flyout.querySelector('.ed-flyout-head .spacer'));
  }

  function tilePicker(): void {
    const grid = h('div', { class: 'ed-grid', role: 'listbox', 'aria-label': 'Terrain' });
    const fill = () => {
      const w = settings.tileSearch.toLowerCase();
      const list = TILES.filter((a) => !w || a.name.toLowerCase().includes(w) || a.id.includes(w));
      grid.replaceChildren(...list.map((a) => assetButton(a, a.id === settings.tile, () => ((settings.tile = a.id), fill(), renderTools()))));
    };
    fill();
    const search = input({ type: 'search', placeholder: 'Search terrain', value: settings.tileSearch, 'aria-label': 'Search terrain', oninput: (e: Event) => ((settings.tileSearch = (e.target as HTMLInputElement).value), fill()) });
    flyoutShell('Terrain', `${TILES.length}`, [h('div', { class: 'ed-search' }, iconEl('search', 15), search), h('div', { class: 'ed-flyout-body', style: 'padding-top:10px' }, grid)]);
  }

  function renderFlyout(): void {
    if (props.contains(document.activeElement)) {
      // keep focus where it is
    }
    if (flyout.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search') return;
    if (tool === 'prop') return propPicker();
    if (tool === 'terrain') return tilePicker();
    if (tool === 'image') return flyoutShell('Images', null, [h('div', { class: 'ed-flyout-body', style: 'padding-top:4px' }, images.picker())]);
    if (tool === 'segment') return flyoutShell('Segments', null, [h('div', { class: 'ed-flyout-body', style: 'padding-top:4px' }, ...segments.options())]);
    flyout.hidden = true;
    flyout.replaceChildren();
  }

  // ---------- the inspector ----------

  const text = (id: string, key: string, value: string | undefined, opts: { required?: boolean; area?: boolean; placeholder?: string; max?: number } = {}) => {
    const commit = (e: Event) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v === (value ?? '')) return;
      if (!v && opts.required) return renderPanel(true);
      void apply([v ? { op: 'update', id, set: { [key]: v } } : { op: 'update', id, unset: [key] }]);
    };
    return opts.area
      ? textarea(value ?? '', { rows: 4, 'data-field': key, onchange: commit, placeholder: opts.placeholder, maxlength: opts.max })
      : input({ value: value ?? '', 'data-field': key, onchange: commit, placeholder: opts.placeholder, maxlength: opts.max });
  };
  const number = (value: number | undefined, stepv: number, on: (v: number) => void, placeholder?: string) =>
    input({
      type: 'text',
      inputmode: 'decimal',
      value: value ?? '',
      placeholder,
      style: 'font-variant-numeric:tabular-nums',
      onchange: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value.replace(',', '.').trim();
        const v = Number(raw);
        if (raw !== '' && Number.isFinite(v)) on(Math.round(v / stepv) * stepv);
        else renderPanel(true);
      },
    });
  const two = (...kids: HTMLElement[]) => h('div', { class: 'ed-two' }, ...kids);
  /** The GM's notes on a room, corridor or terrain: never drawn; the GM reads them on Delve Table too. */
  const gmNotes = (o: MapObject) => field('GM note · only you see this', text(o.id, 'notes', o.notes, { area: true, max: NOTES_MAX, placeholder: 'A description, monsters, loot… Only you see this, here and on Delve Table.' }));

  /** A room, corridor or cutout's own wall roughness, or the map's. */
  function roughnessField(o: MapObject & { roughness?: number }): HTMLElement {
    const own = o.roughness;
    const shown = own ?? map().roughness ?? 1;
    const r = range('Roughness', {
      value: shown,
      min: 1,
      max: 10,
      step: 1,
      show: (v) => (own === undefined && v === shown ? `map · ${v}` : String(v)),
      keys: '1 smooth · 10 crumbling',
      onChange: (v) => void apply([{ op: 'update', id: o.id, set: { roughness: v } }]),
    });
    if (own !== undefined) r.append(btn('Use the map’s', { kind: 'ghost', size: 'sm', onclick: () => void apply([{ op: 'update', id: o.id, unset: ['roughness'] }]), attrs: { style: 'margin-top:4px;padding-left:0' } }));
    return r;
  }

  /** The Room tool's shapes, as a radio row: a room keeps its box and takes the new shape. */
  function shapeRow(o: MapObject & { shape: Shape }): HTMLElement {
    const s = o.shape;
    const b = shapeBounds(s);
    const kinds = SHAPE_CHOICES.filter(([k]) => k !== 'freehand');
    const current = 'rect' in s ? 'rect' : 'circle' in s ? 'circle' : null;
    return field(
      'Shape',
      h(
        'div',
        { class: 'ed-shapes', role: 'radiogroup', 'aria-label': 'Shape', style: `grid-template-columns:repeat(${kinds.length + 1},minmax(0,1fr))` },
        ...kinds.map(([k, name]) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(current === k),
              title: name,
              onclick: () => {
                const shape = shapeFromDrag(k as BoxShape, [b.x0, b.y0], [b.x1, b.y1], { regular: false, min: 0.5 });
                if (shape) void apply([{ op: 'update', id: o.id, set: { shape } }]);
              },
            },
            iconEl(SHAPE_ICON[k], 16),
          ),
        ),
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(current === null), title: 'Polygon or freehand (draw a new one)', disabled: true, style: current === null ? '' : 'opacity:.35' }, iconEl('polygon', 16)),
      ),
    );
  }

  function shapeFields(o: MapObject & { shape: Shape }): HTMLElement[] {
    const s = o.shape;
    if ('rect' in s) {
      const [x, y, w, hh] = s.rect;
      const set = (i: number) => (v: number) => {
        const rect = [...s.rect] as [number, number, number, number];
        rect[i] = v;
        if (rect[2] > 0 && rect[3] > 0) void apply([{ op: 'update', id: o.id, set: { shape: { rect } } }]);
      };
      return [two(field('X', number(x, 0.5, set(0)), { unit: 'sq' }), field('Y', number(y, 0.5, set(1)), { unit: 'sq' }), field('Width', number(w, 0.5, set(2)), { unit: 'sq' }), field('Height', number(hh, 0.5, set(3)), { unit: 'sq' }))];
    }
    if ('circle' in s) {
      const [cx, cy, r] = s.circle;
      const set = (i: number) => (v: number) => {
        const circle = [...s.circle] as [number, number, number];
        circle[i] = v;
        if (circle[2] > 0) void apply([{ op: 'update', id: o.id, set: { shape: { circle } } }]);
      };
      return [two(field('Centre X', number(cx, 0.5, set(0)), { unit: 'sq' }), field('Centre Y', number(cy, 0.5, set(1)), { unit: 'sq' }), field('Radius', number(r, 0.5, set(2)), { unit: 'sq' }))];
    }
    const b = shapeBounds(s);
    return [h('p', { class: 'hint' }, `A shape with ${s.poly.length} corners, ${b.x1 - b.x0} × ${b.y1 - b.y0} squares. Move it by dragging or with the arrow keys.`)];
  }

  const atFields = (o: MapObject & { at: Point }, label = '') => {
    const upd = (at: Point) => void apply([{ op: 'update', id: o.id, set: { at } }]);
    return two(field(`X${label}`, number(o.at[0], 0.5, (v) => upd([v, o.at[1]])), { unit: 'sq' }), field(`Y${label}`, number(o.at[1], 0.5, (v) => upd([o.at[0], v])), { unit: 'sq' }));
  };

  /** Options grouped by category, with the current one selected (kept even if it's not in the catalog). */
  function assetOptions(list: readonly AssetInfo[], current: string): HTMLElement[] {
    const groups = CATEGORIES.map((c) => ({ c, items: list.filter((a) => a.category === c.id) })).filter((g) => g.items.length);
    const out: HTMLElement[] = groups.map((g) => h('optgroup', { label: g.c.name }, ...g.items.map((a) => h('option', { value: a.id, selected: a.id === current }, a.name))));
    if (!list.some((a) => a.id === current)) out.unshift(h('option', { value: current, selected: true }, current));
    return out;
  }

  /** A stair's, ladder's or trapdoor's GM label (0A, -1C): set by "Number the stairs", editable by hand. */
  const stairLabelField = (o: MapObject & { label?: string }) => field('Label (floor, then flight letter)', text(o.id, 'label', o.label, { max: 8, placeholder: 'e.g. 0A' }));

  /** With fog on, a room's or corridor's place in it: revealed to the players or not. */
  function fogCheck(o: MapObject): HTMLElement | null {
    const fog = map().fog;
    if (!fog?.on || (o.type !== 'room' && o.type !== 'corridor')) return null;
    const shown = Boolean(fog.revealed?.includes(o.id));
    return checkbox('Revealed to players', shown, (on) => fogChange(on ? { reveal: [o.id] } : { cover: [o.id] }), { key: 'F' });
  }

  function objectFields(o: MapObject): HTMLElement[] {
    const id = o.id;
    const upd = (set: Record<string, unknown>) => void apply([{ op: 'update', id, set }]);
    const unset = (key: string) => void apply([{ op: 'update', id, unset: [key] }]);
    const out: HTMLElement[] = [];
    switch (o.type) {
      case 'room':
        out.push(two(field('Name', text(id, 'name', o.name, { placeholder: 'Chapter house' })), field('Number', text(id, 'label', o.label, { max: 8 }))));
        out.push(shapeRow(o));
        out.push(...shapeFields(o), roughnessField(o));
        break;
      case 'cutout':
        out.push(
          field('Name', text(id, 'name', o.name)),
          field('Fill', seg(`fill-${id}`, FILL_CHOICES.map(([k]) => [k, k === 'rock' ? 'Like the rock' : 'Solid'] as [CutoutFill, string]), o.fill ?? 'rock', (v) => (v === 'solid' ? upd({ fill: 'solid' }) : unset('fill')), 'ed-seg-full')),
          ...shapeFields(o),
          roughnessField(o),
        );
        break;
      case 'stairs':
        out.push(
          field('Name', text(id, 'name', o.name)),
          field('Up towards', select(DIRS.map(([d, l]) => [d, l]), o.direction, (v) => upd({ direction: v }))),
          stairLabelField(o),
          ...shapeFields(o),
        );
        break;
      case 'corridor':
        out.push(
          field('Name', text(id, 'name', o.name)),
          field('Width', number(o.width, 0.5, (v) => v > 0 && upd({ width: v })), { unit: 'sq' }),
          roughnessField(o),
          h('p', { class: 'hint' }, `Connects ${o.from ?? '?'} and ${o.to ?? '?'}. ${o.path ? `Custom path, ${o.path.length} points.` : 'Routed automatically; it follows its rooms.'}`),
        );
        if (o.path && o.from && o.to) out.push(btn('Route automatically', { icon: 'corridor', onclick: () => unset('path') }));
        break;
      case 'door':
        out.push(
          field('Style', select(DOOR_STYLES.map((s) => [s, DOOR_NAME[s]]), o.style ?? 'normal', (v) => upd({ style: v }))),
          two(field('Width', number(o.width, 0.5, (v) => v > 0 && upd({ width: v })), { unit: 'sq' }), field('Runs', select([['x', 'Across'], ['y', 'Down']], o.along, (v) => upd({ along: v })))),
          atFields(o),
          checkbox('Open', Boolean(o.open), (on) => (on ? upd({ open: true }) : unset('open'))),
        );
        break;
      case 'label':
        out.push(
          field('Text', text(id, 'text', o.text, { required: true })),
          field('Size', number(o.size, 0.1, (v) => (v > 0 ? upd({ size: v }) : unset('size')), 'default'), { unit: 'sq' }),
          atFields(o),
        );
        break;
      case 'prop': {
        const info = assetInfo(o.asset);
        const rot = turned(o.rotation ?? 0);
        out.push(
          field('Prop', select(assetOptions(PROPS, o.asset), o.asset, (v) => upd({ asset: v }))),
          h('p', { class: 'hint' }, info ? `${info.w}×${info.h} squares · ${info.blocks === 'none' ? 'walk over it' : info.blocks === 'movement' ? 'blocks movement' : 'blocks sight'}` : `Unknown asset "${o.asset}".`),
          atFields(o, ' (centre)'),
          range('Rotation', { value: rot, min: 0, max: 345, step: 15, show: (v) => `${v}°`, keys: 'Q / E', onChange: (v) => void apply([setRotation(id, v)]) }),
          range('Scale', { value: Math.round((o.scale ?? 1) * 100), min: 25, max: 400, step: 5, show: (v) => `${v}%`, onChange: (v) => (v === 100 ? unset('scale') : upd({ scale: v / 100 })) }),
          ...(isConnector(o) ? [stairLabelField(o)] : []),
          // GM symbols are never drawn for players; anything else can be hidden (traps are by default)
          ...(categoryOf(o.asset)?.gmOnly
            ? []
            : [
                checkbox('Hidden from players', propHidden(o), (on) => (on === HIDDEN_ASSETS.has(o.asset) ? unset('gmOnly') : upd({ gmOnly: on }))),
                ...(propHidden(o) ? [h('p', { class: 'hint' }, 'Only in the GM view: players don’t see it on their screen, on Delve Table or in their exports. Untick it once they find it.')] : []),
              ]),
          field('GM note · only you see this', text(id, 'notes', o.notes, { area: true })),
        );
        break;
      }
      case 'terrain':
        out.push(field('Name', text(id, 'name', o.name)), field('Terrain', select(assetOptions(TILES, o.asset), o.asset, (v) => upd({ asset: v }))), ...shapeFields(o));
        break;
      case 'marker':
        out.push(
          field('Kind', seg(`kind-${id}`, MARKER_KINDS.map((k) => [k, MARKERS[k].name] as [typeof k, string]), o.kind, (v) => upd({ kind: v }), 'ed-seg-full')),
          // the note may be empty, but it is never unset
          field('Note · only you see this', textarea(o.text, { rows: 4, maxlength: 2000, 'data-field': 'text', onchange: (e: Event) => { const v = (e.target as HTMLTextAreaElement).value; if (v !== o.text) upd({ text: v }); } })),
          checkbox('Done: strike it through', Boolean(o.done), (on) => (on ? upd({ done: true }) : unset('done')), { key: 'Shift-click' }),
          atFields(o),
        );
        break;
      case 'image':
        out.push(field('Name', text(id, 'name', o.name)), ...images.fields(o));
        break;
    }
    const fc = fogCheck(o);
    if (fc) out.push(fc);
    if (o.type === 'room' || o.type === 'corridor' || o.type === 'terrain') out.push(gmNotes(o));
    return out;
  }

  /** Name, kind and storey above the fields, as in the design. */
  function objectHead(o: MapObject): HTMLElement {
    const m = map();
    const storey = m.level ? ` · storey ${floorText(m.level.order)}` : '';
    const title =
      o.type === 'label' ? o.text : o.type === 'marker' ? MARKERS[o.kind].name : o.type === 'prop' ? (o.name ?? assetInfo(o.asset)?.name ?? o.asset) : (o.name ?? (o.type === 'room' && o.label ? `Room ${o.label}` : TYPE_NAME[o.type]));
    const badge =
      o.type === 'room' && o.label && o.label.length <= 3
        ? h('span', { class: 'ed-obj-badge' }, o.label)
        : o.type === 'marker'
          ? h('span', { class: `marker marker-${o.kind}`, style: 'width:34px;height:34px' }, o.kind === 'trap' ? iconEl('skull', 18, 2) : GLYPH[o.kind])
          : h('span', { class: 'ed-obj-badge' }, iconEl(TYPE_ICON[o.type], 18));
    return h('div', { class: 'ed-obj-head' }, badge, h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ed-obj-kicker' }, `${TYPE_NAME[o.type]}${storey}`), h('div', { class: 'ed-obj-name' }, title)), h('code', { class: 'text-faint', style: 'font-size:11px;padding-top:3px' }, o.id));
  }

  function inspectorPane(): HTMLElement {
    const sel = selection.map(byId).filter((o): o is MapObject => Boolean(o));
    if (!sel.length) {
      return h(
        'div',
        { class: 'ed-empty' },
        iconEl('select', 22),
        h('div', { class: 'ed-empty-title' }, 'Nothing selected'),
        h('p', { class: 'hint', style: 'margin:0;color:var(--color-text-muted);line-height:1.5' }, 'Click a room, door or prop with Select (V) to edit it here. Shift-click adds to the selection.'),
        btn('Map settings', { kind: 'ghost', icon: 'settings', onclick: () => setTab('map'), attrs: { style: 'padding-left:0' } }),
      );
    }
    const kids: HTMLElement[] = [];
    if (sel.length === 1) kids.push(objectHead(sel[0]!), ...objectFields(sel[0]!));
    else {
      kids.push(
        h('div', { class: 'ed-obj-head' }, h('span', { class: 'ed-obj-badge numeral' }, String(sel.length)), h('div', {}, h('div', { class: 'ed-obj-kicker' }, 'Selection'), h('div', { class: 'ed-obj-name' }, `${sel.length} things`))),
        h('p', { class: 'hint' }, sel.map((o) => `${TYPE_NAME[o.type]} ${o.id}`).join(', ')),
      );
    }
    kids.push(
      h(
        'div',
        { class: 'ed-acts' },
        btn('Duplicate', { icon: 'copy', keyHint: 'Ctrl D', onclick: duplicate }),
        btn(sel.length === 1 ? 'Delete' : `Delete ${sel.length}`, { kind: 'danger', icon: 'trash', keyHint: 'Del', onclick: deleteSelection }),
      ),
    );
    kids.push(segments.selectionSave(sel.map((o) => o.id)));
    return h('div', { class: 'ed-pane' }, ...kids);
  }

  // ---------- map settings ----------

  /** A small picture of a style: its paper, floor, walls and hatching. */
  function presetSwatch(key: string): SVGElement {
    const s = PRESETS[key]!;
    const g = svgEl('svg', { viewBox: '0 0 60 40', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' });
    g.append(svgEl('rect', { x: 0, y: 0, width: 60, height: 40, fill: s.background }));
    if (s.hatching) for (let i = -4; i < 16; i++) g.append(svgEl('line', { x1: i * 5, y1: 40, x2: i * 5 + 12, y2: 0, stroke: s.hatching.color, 'stroke-width': 0.6, opacity: 0.45 }));
    g.append(svgEl('rect', { x: 15, y: 10, width: 30, height: 20, fill: s.floor.color, 'fill-opacity': s.floor.opacity ?? 1, stroke: s.walls.color, 'stroke-width': Math.max(1, s.walls.width * 6) }));
    if (s.grid.style === 'lines') for (const x of [25, 35]) g.append(svgEl('line', { x1: x, y1: 10, x2: x, y2: 30, stroke: s.grid.color, 'stroke-width': 0.5, opacity: s.grid.opacity }));
    return g;
  }

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

  function mapPane(): HTMLElement {
    const m = map();
    const style = m.style ?? { preset: 'classic-hatching' };
    const setMap = (set: Record<string, unknown>) => void apply([{ op: 'update_map', set }]);
    const overrides = (style.overrides ?? {}) as Record<string, unknown>;
    const gridStyle = (overrides['grid.style'] as string | undefined) ?? PRESETS[style.preset]?.grid.style ?? 'lines';
    const setGridStyle = (v: string) => {
      const next: Record<string, unknown> = { ...overrides, 'grid.style': v };
      if (v === PRESETS[style.preset]?.grid.style) delete next['grid.style'];
      setMap({ style: { preset: style.preset, ...(Object.keys(next).length ? { overrides: next } : {}) } });
    };
    const units = [...SQUARE_SIZES];
    const unit = m.grid.unit ?? '5 ft';
    const fog = m.fog;
    const n = fog?.revealed?.length ?? 0;
    const section = (title: string, ...kids: Kid[]) => h('div', { class: 'ed-section' }, h('span', { class: 'section-label' }, title), ...kids);
    return h(
      'div',
      { class: 'ed-pane ed-pane-map' },
      field('Name', input({ value: m.name, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== m.name) setMap({ name: v }); } })),
      section(
        'Style preset',
        h(
          'div',
          { class: 'ed-presets', role: 'radiogroup', 'aria-label': 'Style preset' },
          ...Object.entries(PRESETS).map(([k, s]) => h('button', { type: 'button', class: 'ed-preset', role: 'radio', 'aria-checked': String(k === style.preset), onclick: () => k !== style.preset && setMap({ style: { preset: k } }) }, presetSwatch(k), s.name)),
        ),
      ),
      section(
        'Grid',
        checkbox('Show the grid', ctx.grid(), () => ctx.toggleGrid(), { key: 'Shift G' }),
        two(
          field('Square', select([...units.map((u) => [u, u] as [string, string]), ...(units.includes(unit) ? [] : [[unit, unit] as [string, string]])], unit, (v) => setMap({ grid: { ...m.grid, unit: v } }))),
          field('Snap', seg('snap', [['1', '1 sq'], ['0.5', '½ sq']], String(settings.snap) as '1' | '0.5', (v) => ((settings.snap = Number(v)), renderPanel(true)), 'ed-seg-full')),
        ),
        field('Lines', seg('grid-style', [['lines', 'Lines'], ['dots', 'Dots'], ['none', 'None']], gridStyle as 'lines', setGridStyle, 'ed-seg-full')),
        h('p', { class: 'hint' }, 'Hold Alt for half squares while drawing.'),
      ),
      h(
        'div',
        {},
        range('Wall roughness', {
          value: m.roughness ?? 1,
          min: 1,
          max: 10,
          step: 1,
          show: (v) => (m.roughness === undefined && v === 1 ? 'style' : `${v} · ${roughWord(v)}`),
          onChange: (v) => setMap({ roughness: v }),
        }),
        m.roughness !== undefined ? btn('Back to the style’s walls', { kind: 'ghost', size: 'sm', onclick: () => void apply([{ op: 'update_map', unset: ['roughness'] }]), attrs: { style: 'margin-top:4px;padding-left:0' } }) : null,
      ),
      h(
        'div',
        { class: 'ed-two', style: 'align-items:end' },
        field('Seed', number(m.seed, 1, (v) => Number.isInteger(v) && setMap({ seed: v }))),
        btn('Reroll', { icon: 'rotate', title: 'New random hatching and wall wobble', onclick: () => setMap({ seed: Math.floor(Math.random() * 2 ** 31) }) }),
      ),
      section(
        'Storeys',
        ...(m.level
          ? [
              two(
                field('This storey', input({ value: m.level.name, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== m.level!.name) setMap({ level: { ...m.level!, name: v } }); } })),
                field(
                  'Floor',
                  number(m.level.order, 1, (v) => {
                    if (!Number.isInteger(v) || v === m.level!.order) return renderPanel(true);
                    const clash = ctx.storeys().find((s) => s.id !== ctx.mapId && s.level?.order === v);
                    if (clash) ctx.toast(`“${clash.level?.name ?? clash.name}” is floor ${floorText(v)} too. Give each storey its own number.`);
                    setMap({ level: { ...m.level!, order: v } });
                  }),
                ),
              ),
            ]
          : [h('p', { class: 'hint' }, 'A tower, a keep with a cellar: add storeys, and switch between them bottom left.')]),
        guide ? h('p', { class: 'hint' }, `The dashed outline is the floor of “${guide.name}”, so the storeys line up.`) : null,
        h('div', { class: 'ed-row' }, btn('Add above', { icon: 'plus', size: 'sm', onclick: () => void addStorey('above') }), btn('Add below', { icon: 'plus', size: 'sm', onclick: () => void addStorey('below') }), btn('Number the stairs', { icon: 'stairs', size: 'sm', title: 'Label every stair, ladder and trapdoor in the GM view: floor, then a letter per flight (0A, 1A, 2A)', onclick: () => void numberStairs() })),
      ),
      section(
        'Fog of war',
        checkbox('Players only see what you reveal', Boolean(fog?.on), (on) => fogChange({ on })),
        h('p', { class: 'hint' }, fog?.on ? `${n} room${n === 1 ? '' : 's'} and corridor${n === 1 ? '' : 's'} revealed. The GM view shows the rest dimmed. Reveal more with Fog (F), or ask Claude.` : 'Off: players see the whole map.'),
        fog?.on ? h('div', { class: 'ed-row' }, btn('Reveal all', { icon: 'eye', size: 'sm', onclick: () => fogChange({ revealAll: true }) }), btn('Hide all', { icon: 'eye-off', size: 'sm', onclick: () => fogChange({ reset: true, on: true }) })) : null,
      ),
      btn(m.level ? 'Delete this storey' : 'Delete map', { kind: 'danger', icon: 'trash', onclick: () => void deleteMap(), attrs: { style: 'align-self:flex-start' } }),
    );
  }

  function renderPanel(force = false): void {
    const m = map();
    selection = selection.filter((id) => m.objects.some((o) => o.id === id));
    if (!force && props.contains(document.activeElement) && !focusField) return; // don't yank a field out from under the user
    const scroll = props.scrollTop;
    props.replaceChildren(tab === 'map' ? mapPane() : inspectorPane());
    props.scrollTop = scroll;
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
    if (tool === 'reveal' || tool === 'segment') renderTools(); // keep the fog switch and segment state current
    if (wantSelect && ctx.rev() >= wantSelect.rev) {
      setSelection(wantSelect.ids);
      wantSelect = null;
    }
    renderPanel();
    draw();
  });
  ctx.onView(draw);
  tabInspector.addEventListener('click', () => setTab('inspector'));
  tabMap.addEventListener('click', () => setTab('map'));
  document.getElementById('panel-close')?.addEventListener('click', () => {
    tab = 'inspector';
    setSelection([]);
    setTab('inspector');
    ctx.shell.setDrawer(false);
    ctx.shell.setSheet(null);
    draw();
  });
  ctx.shell.onAction('map-settings', () => setTab('map'));
  ctx.shell.onLayout(() => syncLayout());
  document.getElementById('undo')?.addEventListener('click', () => void ctx.history('undo').catch((e: Error) => ctx.toast(e.message)));
  document.getElementById('redo')?.addEventListener('click', () => void ctx.history('redo').catch((e: Error) => ctx.toast(e.message)));
  ctx.shell.setStoreys(ctx.storeys(), { canAdd: true, onAdd: (p) => void addStorey(p) });
  // Enter in a panel field commits it and hands the keyboard back to the map;
  // Escape puts the old value back. Either way, tool shortcuts work again.
  panel.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (e.key === 'Enter' && el instanceof HTMLInputElement) el.blur();
    else if (e.key === 'Escape') {
      el.value = el.defaultValue;
      el.blur();
      renderPanel(true);
    }
  });
  buildRail();
  ctx.stage.dataset.tool = tool;
  renderTools();
  renderPanel();
  // The chat panel tells Claude what's selected ("this room").
  return { selection: () => [...selection], tool: () => tool };
}
