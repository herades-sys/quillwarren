// Pure helpers for raised and sunken ground in the 3D views (the editor's stack
// and Delve Table's): where the ground is, how high a wall or a mini stands, the
// faces between heights, and the floor picture's UVs. No DOM, no WebGL, no
// @delve/core (the table's bundle doesn't carry it), so they can be unit-tested.
// World axes as in stack-logic.ts: x = map x, z = map y (south +z), y = up; one
// unit is one square, heights included (core heightScene converts them).
import type { SceneHeights } from '@delve/table';

export type Vec3 = [number, number, number];
export type Edge3 = SceneHeights['edges'][number];

const inRing = (ring: readonly (readonly [number, number])[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** The ground's height (squares) at a map point: the band it lies in, else 0. */
export function groundAt(h: SceneHeights | null | undefined, x: number, y: number): number {
  if (!h) return 0;
  for (const band of h.bands) {
    for (const p of band.polygons) if (inRing(p.outer, x, y) && !p.holes.some((hole) => inRing(hole, x, y))) return band.h;
  }
  return 0;
}

/** Where a point of the floor lies on the floor picture covering `box` (the picture's top, y0, is v = 1). */
export function floorUv(x: number, y: number, box: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
  const w = box.x1 - box.x0 || 1;
  const d = box.y1 - box.y0 || 1;
  return [(x - box.x0) / w, 1 - (y - box.y0) / d];
}

/**
 * The height a wall stands on: the ground beside it on whichever side is raised
 * or sunken (a wall has floor on one side and nothing on the other, which reads
 * as 0), the higher of the two when both are.
 */
export function wallBase(h: SceneHeights | null | undefined, a: readonly [number, number], b: readonly [number, number]): number {
  if (!h || !h.bands.length) return 0;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const left = groundAt(h, mx + nx * 0.08, my + ny * 0.08);
  const right = groundAt(h, mx - nx * 0.08, my - ny * 0.08);
  if (left && right) return Math.max(left, right);
  return left || right;
}

/**
 * The faces between heights, as quads of four corners (two triangles: 0 1 2, 0 2 3).
 * Cliffs and steps stand straight from the low ground to the high; slopes and
 * rock faces lean out over the low side, `run` squares, down to the low ground.
 */
export function edgeQuads(e: Edge3): Vec3[][] {
  const pts = e.points;
  const n = pts.length;
  if (n < 2) return [];
  const segs = e.closed ? n : n - 1;
  const normal = (i: number): [number, number] => {
    const a = pts[i % n]!;
    const b = pts[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  // the foot's corners: each point pushed out along the mean of its segments' normals, so the faces meet
  const foot = (i: number): [number, number] => {
    const p = pts[i]!;
    if (!(e.run > 0)) return [p[0], p[1]];
    const before = i > 0 ? normal(i - 1) : e.closed ? normal(n - 1) : null;
    const after = i < segs ? normal(i) : e.closed ? normal(0) : null;
    let nx = (before?.[0] ?? 0) + (after?.[0] ?? 0);
    let ny = (before?.[1] ?? 0) + (after?.[1] ?? 0);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // keep the face's width at corners, but not without end
    const cos = before && after ? Math.max(0.5, nx * after[0] + ny * after[1]) : 1;
    return [p[0] + (nx * e.run) / cos, p[1] + (ny * e.run) / cos];
  };
  const out: Vec3[][] = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const j = (i + 1) % n;
    const b = pts[j]!;
    const fa = foot(i);
    const fb = foot(j);
    out.push([
      [a[0], e.hi, a[1]],
      [b[0], e.hi, b[1]],
      [fb[0], e.lo, fb[1]],
      [fa[0], e.lo, fa[1]],
    ]);
  }
  return out;
}

/** Quads as a flat triangle list (x, y, z per corner), for a BufferGeometry. */
export function quadPositions(quads: readonly Vec3[][]): Float32Array {
  const out = new Float32Array(quads.length * 18);
  quads.forEach((q, k) => {
    const order = [0, 1, 2, 0, 2, 3];
    order.forEach((c, m) => out.set(q[c]!, k * 18 + m * 3));
  });
  return out;
}

/**
 * A flight of stairs between two heights: where it starts and how far it
 * rises, along the way it goes up (null when both ends are on level ground).
 */
export function stairRise(h: SceneHeights | null | undefined, box: { x0: number; y0: number; x1: number; y1: number }, direction: 'n' | 'e' | 's' | 'w'): { base: number; rise: number } | null {
  if (!h || !h.bands.length) return null;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const ix = Math.min(0.25, (box.x1 - box.x0) / 4);
  const iy = Math.min(0.25, (box.y1 - box.y0) / 4);
  const ends: Record<'n' | 'e' | 's' | 'w', [number, number]> = { n: [cx, box.y0 + iy], s: [cx, box.y1 - iy], w: [box.x0 + ix, cy], e: [box.x1 - ix, cy] };
  const back = { n: 's', s: 'n', e: 'w', w: 'e' } as const;
  const top = groundAt(h, ...ends[direction]);
  const bottom = groundAt(h, ...ends[back[direction]]);
  if (Math.abs(top - bottom) < 1e-9) return bottom ? { base: bottom, rise: 0 } : null;
  return { base: Math.min(top, bottom), rise: Math.abs(top - bottom) };
}

/** The way a flight really goes up: toward its higher end when its ends lie at different heights, else as drawn. */
export function stairsUp(h: SceneHeights | null | undefined, box: { x0: number; y0: number; x1: number; y1: number }, direction: 'n' | 'e' | 's' | 'w'): 'n' | 'e' | 's' | 'w' {
  if (!h || !h.bands.length) return direction;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const ix = Math.min(0.25, (box.x1 - box.x0) / 4);
  const iy = Math.min(0.25, (box.y1 - box.y0) / 4);
  const ns = groundAt(h, cx, box.y0 + iy) - groundAt(h, cx, box.y1 - iy);
  const we = groundAt(h, box.x0 + ix, cy) - groundAt(h, box.x1 - ix, cy);
  if (Math.abs(ns) < 1e-9 && Math.abs(we) < 1e-9) return direction;
  return Math.abs(ns) >= Math.abs(we) ? (ns > 0 ? 'n' : 's') : we > 0 ? 'w' : 'e';
}
