// Pure helpers for the 3D view (no DOM, no WebGL), so they can be unit-tested.
// World axes: x = map x, z = map y (south is +z), y = up.
import type { Bounds, Point } from '@delve/core';

/** Each storey's floor height: storeys sorted bottom-up by order, `spread` apart, the lowest at 0. */
export function storeyHeights(storeys: readonly { id: string; order: number }[], spread: number): Map<string, number> {
  const sorted = [...storeys].sort((a, b) => a.order - b.order);
  return new Map(sorted.map((s, i) => [s.id, i * spread]));
}

/** Pixels per square for a floor picture: as sharp as `best`, but no more than `max` pixels on the long side. */
export function texturePpg(b: Bounds, max = 4000, best = 48): number {
  const side = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1);
  return Math.max(10, Math.min(best, Math.floor(max / side)));
}

/** A wall segment as a box lying along it: centre, length (padded by the thickness so corners close) and turn about the up axis. */
export function wallBox([a, b]: readonly [Point, Point], thickness: number): { x: number; z: number; length: number; angle: number } {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, length: Math.hypot(dx, dz) + thickness, angle: Math.atan2(-dz, dx) };
}

export function unionOf(list: readonly Bounds[]): Bounds | null {
  if (!list.length) return null;
  return {
    x0: Math.min(...list.map((b) => b.x0)),
    y0: Math.min(...list.map((b) => b.y0)),
    x1: Math.max(...list.map((b) => b.x1)),
    y1: Math.max(...list.map((b) => b.y1)),
  };
}

export function intersect(a: Bounds, b: Bounds): Bounds | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/** Where the camera starts: south-east of the building, above the top storey, looking at the middle of the stack. */
export function startView(b: Bounds, top: number): { position: [number, number, number]; target: [number, number, number] } {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.y0 + b.y1) / 2;
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0, 10);
  return { position: [cx + span * 0.8, top * 0.6 + span * 0.55, cz + span * 1.2], target: [cx, top / 2, cz] };
}
