// Pure editing logic (no DOM): snapping, hit-testing, handles, and turning
// drags into shapes and doors.
import {
  corridorOutline,
  corridorPath,
  doorSegment,
  MARKER_RADIUS,
  onImage,
  roomsById,
  shapeArea,
  type Bounds,
  type DelveMap,
  type MapObject,
  type Point,
  type Shape,
} from '@delve/core';
import { objectBounds } from './logic.ts';

export const snap = (v: number, step: number): number => Math.round(v / step) * step;
export const snapPoint = (p: Point, step: number): Point => [snap(p[0], step), snap(p[1], step)];

function pointInRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInShape(shape: Shape, p: Point): boolean {
  if ('rect' in shape) {
    const [x, y, w, h] = shape.rect;
    return p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
  }
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle;
    return Math.hypot(p[0] - cx, p[1] - cy) <= r;
  }
  return pointInRing(p, shape.poly);
}

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
  for (const m of of('marker').reverse()) if (Math.hypot(m.at[0] - p[0], m.at[1] - p[1]) <= MARKER_RADIUS + tol) out.push(m.id);
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
  return out;
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
