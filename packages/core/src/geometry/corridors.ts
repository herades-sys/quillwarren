// Corridors: a centerline path with a width. Without an explicit path the
// corridor is routed between its two rooms, from their current positions, so
// it follows whenever a room moves.
import { EndType, inflatePathsD, JoinType, type PathsD } from 'clipper2-ts';
import type { Corridor, DelveMap, Point, Room } from '../schema.ts';
import { PRECISION, shapeBounds, toPath, type Bounds } from './shapes.ts';

/** Centre for a corridor of width w whose edges land on whole squares. */
function snapCenter(c: number, w: number): number {
  return Math.round(c - w / 2) + w / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

/**
 * Route between two room bounds: straight when their extents overlap by at
 * least the corridor width on one axis, otherwise an L (leave A sideways at its
 * centre height, turn, enter B from above or below). Null if the rooms overlap.
 */
export function autoRoute(a: Bounds, b: Bounds, w: number): Point[] | null {
  const ox0 = Math.max(a.x0, b.x0);
  const ox1 = Math.min(a.x1, b.x1);
  if (ox1 - ox0 >= w) {
    const x = clamp(snapCenter((ox0 + ox1) / 2, w), ox0 + w / 2, ox1 - w / 2);
    if (a.y1 <= b.y0) return [[x, a.y1], [x, b.y0]];
    if (b.y1 <= a.y0) return [[x, a.y0], [x, b.y1]];
    return null;
  }
  const oy0 = Math.max(a.y0, b.y0);
  const oy1 = Math.min(a.y1, b.y1);
  if (oy1 - oy0 >= w) {
    const y = clamp(snapCenter((oy0 + oy1) / 2, w), oy0 + w / 2, oy1 - w / 2);
    if (a.x1 <= b.x0) return [[a.x1, y], [b.x0, y]];
    if (b.x1 <= a.x0) return [[a.x0, y], [b.x1, y]];
    return null;
  }
  const acx = (a.x0 + a.x1) / 2;
  const acy = (a.y0 + a.y1) / 2;
  const bcx = (b.x0 + b.x1) / 2;
  const bcy = (b.y0 + b.y1) / 2;
  const y = clamp(snapCenter(acy, w), a.y0 + w / 2, a.y1 - w / 2);
  const x = clamp(snapCenter(bcx, w), b.x0 + w / 2, b.x1 - w / 2);
  const startX = bcx >= acx ? a.x1 : a.x0;
  const endY = bcy >= acy ? b.y0 : b.y1;
  return [
    [startX, y],
    [x, y],
    [x, endY],
  ];
}

export function roomsById(map: DelveMap): Map<string, Room> {
  const rooms = new Map<string, Room>();
  for (const o of map.objects) if (o.type === 'room') rooms.set(o.id, o);
  return rooms;
}

/** The corridor's centerline: its own path, or the auto-route between its rooms. */
export function corridorPath(c: Corridor, rooms: ReadonlyMap<string, Room>): Point[] | null {
  if (c.path) return c.path;
  const a = c.from ? rooms.get(c.from) : undefined;
  const b = c.to ? rooms.get(c.to) : undefined;
  if (!a || !b) return null;
  return autoRoute(shapeBounds(a.shape), shapeBounds(b.shape), c.width);
}

/** Area covered by a corridor path: butt ends, square (miter) joins. */
export function corridorOutline(path: readonly Point[], width: number): PathsD {
  return inflatePathsD([toPath(path)], width / 2, JoinType.Miter, EndType.Butt, 2, PRECISION);
}

export function pathLength(path: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
  }
  return len;
}

/** Bounds of a corridor's area: its centerline grown by half the width. */
export function corridorBounds(path: readonly Point[], width: number): Bounds {
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  const h = width / 2;
  return { x0: Math.min(...xs) - h, y0: Math.min(...ys) - h, x1: Math.max(...xs) + h, y1: Math.max(...ys) + h };
}
