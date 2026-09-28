// Pure editing logic (no DOM): snapping, hit-testing, handles, and turning
// drags into shapes and doors.
import {
  corridorOutline,
  corridorPath,
  doorSegment,
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
export function hitTest(map: DelveMap, p: Point, tol: number): string | null {
  const of = <T extends MapObject['type']>(t: T) => map.objects.filter((o): o is Extract<MapObject, { type: T }> => o.type === t);
  for (const d of of('door')) {
    const [a, b] = doorSegment(d);
    if (distToSegment(p, a, b) <= Math.max(tol, 0.3)) return d.id;
  }
  for (const l of [...of('label'), ...of('prop')]) {
    const b = objectBounds(l, map);
    if (b && p[0] >= b.x0 - tol && p[0] <= b.x1 + tol && p[1] >= b.y0 - tol && p[1] <= b.y1 + tol) return l.id;
  }
  for (const s of [...of('stairs'), ...of('cutout')]) if (pointInShape(s.shape, p)) return s.id;
  const rooms = roomsById(map);
  for (const c of of('corridor')) {
    const path = corridorPath(c, rooms);
    if (!path) continue;
    const outline = corridorOutline(path, c.width).map((ring) => ring.map((q) => [q.x, q.y] as Point));
    if (outline.some((ring) => pointInRing(p, ring))) return c.id;
  }
  const hits = of('room').filter((r) => pointInShape(r.shape, p));
  hits.sort((a, b) => shapeArea(a.shape) - shapeArea(b.shape));
  return hits[0]?.id ?? null;
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
