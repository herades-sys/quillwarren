// Pure editing logic (no DOM): snapping, hit-testing, handles, and turning
// drags into shapes and doors.
import {
  corridorOutline,
  corridorPath,
  doorSegment,
  markerRadius,
  onImage,
  pointInRing,
  pointInShape,
  roomsById,
  selectionBounds,
  shapeArea,
  tightBounds,
  wholeSquares,
  type Bounds,
  type DelveMap,
  type MapObject,
  type Point,
} from '@delve/core';
import { objectBounds } from './logic.ts';

export { pointInShape };

export const snap = (v: number, step: number): number => Math.round(v / step) * step;
export const snapPoint = (p: Point, step: number): Point => [snap(p[0], step), snap(p[1], step)];

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The object under p, small things first: doors, labels, props, stairs,
 * cutouts, corridors, then rooms (the smallest room wins when rooms overlap).
 * tol is the pick radius in squares (a few pixels at the current zoom).
 */
/**
 * Everything under p, topmost first: doors, then labels and props (last drawn first),
 * stairs and cutouts, corridors, then rooms and terrain areas, smallest first
 * (terrain before a room of the same size, since it's drawn over it).
 */
export function hitAll(map: DelveMap, p: Point, tol: number): string[] {
  const of = <T extends MapObject['type']>(t: T) => map.objects.filter((o): o is Extract<MapObject, { type: T }> => o.type === t);
  const out: string[] = [];
  // GM markers sit on top of everything
  for (const m of of('marker').reverse()) if (Math.hypot(m.at[0] - p[0], m.at[1] - p[1]) <= markerRadius(map.objects, m) + tol) out.push(m.id);
  for (const d of of('door')) {
    const [a, b] = doorSegment(d);
    if (distToSegment(p, a, b) <= Math.max(tol, 0.3)) out.push(d.id);
  }
  // uploaded pictures: the ones standing on top come before the props under them; floor ones rank with the areas below
  const pictures = of('image').filter((o) => onImage(o, p, tol));
  for (const im of [...pictures].reverse()) if (im.layer !== 'floor') out.push(im.id);
  for (const l of map.objects.filter((o) => o.type === 'label' || o.type === 'prop').reverse()) {
    const b = objectBounds(l, map);
    if (b && p[0] >= b.x0 - tol && p[0] <= b.x1 + tol && p[1] >= b.y0 - tol && p[1] <= b.y1 + tol) out.push(l.id);
  }
  for (const s of [...of('stairs'), ...of('cutout')]) if (pointInShape(s.shape, p)) out.push(s.id);
  const rooms = roomsById(map);
  for (const c of of('corridor')) {
    const path = corridorPath(c, rooms);
    if (!path) continue;
    const outline = corridorOutline(path, c.width).map((ring) => ring.map((q) => [q.x, q.y] as Point));
    if (outline.some((ring) => pointInRing(p, ring))) out.push(c.id);
  }
  // a click in a terrain's hole (a room inside a filled forest) doesn't hit the terrain
  const areas = [...of('terrain'), ...of('room')].filter((o) => pointInShape(o.shape, p) && !(o.type === 'terrain' && o.holes?.some((h) => pointInRing(p, h))));
  areas.sort((a, b) => shapeArea(a.shape) - shapeArea(b.shape) || (a.type === 'terrain' ? -1 : 0) - (b.type === 'terrain' ? -1 : 0));
  out.push(...areas.map((o) => o.id));
  // a floor picture goes before the first area bigger than it: a rug before its room, a backdrop after every room
  for (const im of pictures.filter((o) => o.layer === 'floor').sort((a, b) => a.w * a.h - b.w * b.h)) {
    const next = areas.find((o) => shapeArea(o.shape) > im.w * im.h);
    const at = next ? out.indexOf(next.id) : -1;
    if (at === -1) out.push(im.id);
    else out.splice(at, 0, im.id);
  }
  // open areas are never drawn, so they come last: a click in a room picks the room, a click on the open ground around it the open area
  const opens = of('opening').filter((o) => pointInShape(o.shape, p));
  opens.sort((a, b) => shapeArea(a.shape) - shapeArea(b.shape));
  out.push(...opens.map((o) => o.id));
  return out;
}

// ---------- resizing props and pictures by their corners ----------

/** Props scale from 25 % to 400 % (the inspector's Scale slider). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/** Something drawn as a w × h rectangle centred on `at`, turned clockwise by `rotation` degrees (a prop's footprint at its scale, a picture). */
export interface Turned {
  at: Point;
  w: number;
  h: number;
  rotation?: number;
}

/** The four corners of the turned rectangle: top-left, top-right, bottom-right, bottom-left before turning. */
export function corners(o: Turned): Point[] {
  const a = ((o.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const x = (sx! * o.w) / 2;
    const y = (sy! * o.h) / 2;
    const r = (v: number) => Math.round(v * 1e6) / 1e6;
    return [r(o.at[0] + x * c - y * s), r(o.at[1] + x * s + y * c)] as Point;
  });
}

/** Which corner (0–3, as corners() lists them) is within tol squares of p, if any. */
export function cornerAt(o: Turned, p: Point, tol: number): number | null {
  const cs = corners(o);
  const i = cs.findIndex((q) => Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol);
  return i < 0 ? null : i;
}

/** p in the rectangle's own frame: turned back about its centre. */
function local(o: Turned, p: Point): Point {
  const a = (-(o.rotation ?? 0) * Math.PI) / 180;
  const dx = p[0] - o.at[0];
  const dy = p[1] - o.at[1];
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

/** The greatest d with w and h both whole multiples of d (half squares count), or 0 if there is none to speak of. */
function commonStep(w: number, h: number): number {
  const a = Math.round(w * 2);
  const b = Math.round(h * 2);
  if (Math.abs(a - w * 2) > 1e-6 || Math.abs(b - h * 2) > 1e-6 || !a || !b) return 0;
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x / 2;
}

/**
 * The scale steps that keep a w × h prop's footprint on half squares: both its
 * sides whole multiples of ½ (a 1 × 1 barrel steps 50 %, a 2 × 2 table 25 %).
 * Footprints that aren't in half squares step by the longer side.
 */
export function scaleStep(w: number, h: number): number {
  const g = commonStep(w, h);
  return g ? 0.5 / g : 0.5 / Math.max(w, h);
}

/** A scale snapped to the steps (or to 1 % with `free`) and kept within 25–400 %. */
export function snapScale(raw: number, w: number, h: number, free = false): number {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (free) return Math.min(MAX_SCALE, Math.max(MIN_SCALE, r2(raw)));
  const t = scaleStep(w, h);
  let s = Math.round(raw / t) * t;
  if (s < MIN_SCALE - 1e-9) s = Math.ceil(MIN_SCALE / t - 1e-9) * t;
  if (s > MAX_SCALE + 1e-9) s = Math.floor(MAX_SCALE / t + 1e-9) * t;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 1e6) / 1e6));
}

/**
 * A prop's new scale when a corner of its footprint is dragged to p: uniform,
 * about its centre, by whichever side the pointer pulls further. `base` is the
 * asset's footprint at scale 1.
 */
export function scaleFromCorner(prop: { at: Point; rotation?: number; scale?: number }, base: { w: number; h: number }, p: Point, free = false): number {
  const [x, y] = local({ at: prop.at, w: base.w, h: base.h, rotation: prop.rotation }, p);
  const raw = Math.max((2 * Math.abs(x)) / base.w, (2 * Math.abs(y)) / base.h);
  return snapScale(raw, base.w, base.h, free);
}

/**
 * A picture's new size when a corner is dragged to p: about its centre, width
 * and height each to the pointer (half squares, or free with Alt); `keep`
 * (Shift) keeps its proportions.
 */
export function sizeFromCorner(img: Turned, p: Point, o: { free?: boolean; keep?: boolean } = {}): { w: number; h: number } {
  const [x, y] = local(img, p);
  const step = o.free ? 0.01 : 0.5;
  const min = o.free ? 0.05 : 0.5;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const fit = (v: number) => r2(Math.min(1000, Math.max(min, Math.round(v / step) * step)));
  const w = 2 * Math.abs(x);
  const h = 2 * Math.abs(y);
  if (!o.keep) return { w: fit(w), h: fit(h) };
  // proportions kept: the side the pointer pulls further sets the size
  const k = Math.max(w / img.w, h / img.h);
  const fw = fit(img.w * k);
  return { w: fw, h: Math.min(1000, Math.max(0.05, r2((fw * img.h) / img.w))) };
}

/** The size chip while resizing: "2 × 1 sq · 150 %" (the footprint as it lies, so a quarter turn swaps the sides). */
export function sizeText(w: number, h: number, rotation = 0, scale?: number): string {
  const q = Math.round((((rotation % 360) + 360) % 360) / 90) % 2 === 1 && Math.abs(rotation % 90) < 1e-9;
  const f = (v: number) => String(Math.round(v * 100) / 100);
  const [a, b] = q ? [h, w] : [w, h];
  return `${f(a)} × ${f(b)} sq${scale !== undefined ? ` · ${Math.round(scale * 100)} %` : ''}`;
}

// ---------- box selection ----------

const within = (b: Bounds, box: Bounds, eps = 1e-6): boolean => b.x0 >= box.x0 - eps && b.y0 >= box.y0 - eps && b.x1 <= box.x1 + eps && b.y1 <= box.y1 + eps;

/** The box a drag from a to b spans (any direction). */
export function boxOf(a: Point, b: Point): Bounds {
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}

/**
 * A box selection: every object whose bounds lie wholly inside the box (a door
 * is its line, without the pick padding). `keep` leaves some out, e.g. GM
 * markers in the players' view, where they aren't drawn.
 */
export function boxSelect(map: DelveMap, box: Bounds, keep: (o: MapObject) => boolean = () => true): string[] {
  return map.objects.filter((o) => {
    if (!keep(o)) return false;
    const b = tightBounds(o, map);
    return b !== null && within(b, box);
  }).map((o) => o.id);
}

/** What a box adds up to: with Shift or Ctrl it adds to the selection (in map order, no repeats), otherwise it replaces it. */
export function mergeSelection(current: readonly string[], ids: readonly string[], additive: boolean): string[] {
  if (!additive) return [...ids];
  const out = [...current];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** A plain click toggles with Shift or Ctrl, and otherwise picks just that object. */
export function clickSelection(current: readonly string[], hit: string | null, additive: boolean): string[] {
  if (!hit) return additive ? [...current] : [];
  if (!additive) return [hit];
  return current.includes(hit) ? current.filter((s) => s !== hit) : [...current, hit];
}

/**
 * Does a press here count as empty ground, where a drag draws a box? Yes when
 * nothing is under the pointer, or only open areas that aren't selected (they
 * are invisible until selected, so they mustn't swallow the drag; a click
 * still selects one).
 */
export function pressesGround(map: DelveMap, hits: readonly string[], selection: readonly string[]): boolean {
  const types = new Map(map.objects.map((o) => [o.id, o.type]));
  return hits.every((id) => types.get(id) === 'opening' && !selection.includes(id));
}

/**
 * What dragging on empty ground does in the Select tool: a mouse or pen draws a
 * box; one finger pans the map, unless the context bar's Box mode is on (two
 * fingers always pinch and pan, see the editor).
 */
export function groundDrag(pointerType: string, touchBox: boolean): 'box' | 'pan' {
  return pointerType === 'touch' && !touchBox ? 'pan' : 'box';
}

/** "Crop to selection": the selection's bounds plus `margin` squares, out to whole squares; null with nothing selected. */
export function cropToSelection(map: DelveMap, ids: readonly string[], margin = 1): Bounds | null {
  const b = selectionBounds(map, ids);
  return b ? wholeSquares({ x0: b.x0 - margin, y0: b.y0 - margin, x1: b.x1 + margin, y1: b.y1 + margin }) : null;
}

export function hitTest(map: DelveMap, p: Point, tol: number): string | null {
  return hitAll(map, p, tol)[0] ?? null;
}

/** Clicking again on the selected object picks the next one under the pointer (a room under its terrain, a chest under a rug). */
export function nextHit(hits: readonly string[], current: string | undefined): string | null {
  if (!hits.length) return null;
  const i = current ? hits.indexOf(current) : -1;
  return hits[(i + 1) % hits.length]!;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(b: Bounds, h: Handle): Point {
  const x = h.includes('w') ? b.x0 : h.includes('e') ? b.x1 : (b.x0 + b.x1) / 2;
  const y = h.includes('n') ? b.y0 : h.includes('s') ? b.y1 : (b.y0 + b.y1) / 2;
  return [x, y];
}

export function handleAt(b: Bounds, p: Point, tol: number): Handle | null {
  for (const h of HANDLES) {
    const q = handlePoint(b, h);
    if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol) return h;
  }
  return null;
}

/** Drag a handle to p (already snapped). Edges can't cross; the result is at least `min` squares each way. */
export function resizeBounds(b: Bounds, h: Handle, p: Point, min = 1): Bounds {
  const r = { ...b };
  if (h.includes('w')) r.x0 = Math.min(p[0], b.x1 - min);
  if (h.includes('e')) r.x1 = Math.max(p[0], b.x0 + min);
  if (h.includes('n')) r.y0 = Math.min(p[1], b.y1 - min);
  if (h.includes('s')) r.y1 = Math.max(p[1], b.y0 + min);
  return r;
}

/** The rectangle spanned by a drag from a to b, or null if it's smaller than min either way. */
export function rectFromDrag(a: Point, b: Point, min = 1): [number, number, number, number] | null {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  return w >= min && h >= min ? [x, y, w, h] : null;
}

/** A door along whichever axis the drag mostly follows, or null if it's shorter than min. */
export function doorFromDrag(a: Point, b: Point, min = 0.5): { at: Point; along: 'x' | 'y'; width: number } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.abs(dx) >= Math.abs(dy)) {
    return Math.abs(dx) >= min ? { at: [Math.min(a[0], b[0]), a[1]], along: 'x', width: Math.abs(dx) } : null;
  }
  return Math.abs(dy) >= min ? { at: [a[0], Math.min(a[1], b[1])], along: 'y', width: Math.abs(dy) } : null;
}

/** Clicking back on the first point (within tol) closes a polygon of 3 or more points. */
export function closesPolygon(points: readonly Point[], p: Point, tol: number): boolean {
  return points.length >= 3 && Math.hypot(p[0] - points[0]![0], p[1] - points[0]![1]) <= tol;
}

/** Rect-shaped objects get resize handles. */
export function rectOf(o: MapObject | undefined): [number, number, number, number] | null {
  if (!o || !('shape' in o) || !('rect' in o.shape)) return null;
  return o.shape.rect;
}

/** Deleting rooms also deletes the corridors attached to them (they'd be left dangling otherwise). */
export function deletionSet(map: DelveMap, ids: readonly string[]): string[] {
  const out = new Set(ids);
  for (const o of map.objects) if (o.type === 'corridor' && ((o.from && out.has(o.from)) || (o.to && out.has(o.to)))) out.add(o.id);
  return [...out];
}
