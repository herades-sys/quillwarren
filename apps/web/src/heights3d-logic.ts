// Pure helpers for raised and sunken ground in the 3D views (the editor's stack
// and Delve Table's): the height of the draped ground anywhere, how high a wall,
// a door or a mini stands, cutting the ground's triangles along the height
// lattice, the sheer faces between pieces, where a ray meets the ground, and
// the floor picture's UVs. No DOM, no WebGL, no @delve/core (the table's bundle
// doesn't carry it), so they can be unit-tested.
// World axes as in stack-logic.ts: x = map x, z = map y (south +z), y = up; one
// unit is one square, heights included (core heightScene converts them).
import type { SceneHeights, ScenePiece, ScenePolygon } from '@delve/table';

export type Vec3 = [number, number, number];
type Pt = [number, number];
type Box = { x0: number; y0: number; x1: number; y1: number };

const inRing = (ring: readonly (readonly [number, number])[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (p: ScenePolygon, x: number, y: number): boolean => inRing(p.outer, x, y) && !p.holes.some((hole) => inRing(hole, x, y));

/** The plan's height (squares) at a map point: the band it lies in, else 0. Which end of a flight is up goes by this, like the 2D arrow. */
export function groundAt(h: SceneHeights | null | undefined, x: number, y: number): number {
  if (!h) return 0;
  for (const band of h.bands) {
    for (const p of band.polygons) if (inPolygon(p, x, y)) return band.h;
  }
  return 0;
}

// ---------- the draped ground ----------

const grids = new WeakMap<object, Float32Array>();
const boxes = new WeakMap<object, Box>();

/** A grid's heights (squares), decoded once. */
export function gridHeights(g: NonNullable<ScenePiece['grid']>): Float32Array {
  let z = grids.get(g);
  if (z) return z;
  const bin = typeof atob === 'function' ? atob(g.z) : '';
  z = new Float32Array(g.cols * g.rows);
  const span = g.max - g.min;
  for (let k = 0; k < z.length; k++) z[k] = g.min + ((bin.charCodeAt(k * 2) | (bin.charCodeAt(k * 2 + 1) << 8)) / 65535) * span;
  grids.set(g, z);
  return z;
}

function pieceBox(p: ScenePiece): Box {
  let b = boxes.get(p);
  if (b) return b;
  b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const poly of p.polygons) {
    for (const [x, y] of poly.outer) {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
    }
  }
  boxes.set(p, b);
  return b;
}

/** A piece's height (squares) at a point: from its grid (bilinear between the posts), else its one height. Points a little outside it carry on. */
export function pieceHeight(h: SceneHeights, p: ScenePiece, x: number, y: number): number {
  const g = p.grid;
  const step = h.step ?? 1;
  if (!g) return p.h;
  const gx = x / step - g.i0;
  const gy = y / step - g.j0;
  if (gx < 0 || gy < 0 || gx > g.cols - 1 || gy > g.rows - 1) return p.h;
  const z = gridHeights(g);
  const c = Math.min(g.cols - 2, Math.floor(gx));
  const r = Math.min(g.rows - 2, Math.floor(gy));
  const fx = gx - c;
  const fy = gy - r;
  const k = r * g.cols + c;
  const top = z[k]! + (z[k + 1]! - z[k]!) * fx;
  const bottom = z[k + g.cols]! + (z[k + g.cols + 1]! - z[k + g.cols]!) * fx;
  return top + (bottom - top) * fy;
}

/** The piece of the draped ground at a point, or -1 (the plain ground at 0). */
export function pieceAt(h: SceneHeights | null | undefined, x: number, y: number, not = -1): number {
  const list = h?.pieces;
  if (!list) return -1;
  for (let i = 0; i < list.length; i++) {
    if (i === not) continue;
    const p = list[i]!;
    const b = pieceBox(p);
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    if (p.polygons.some((poly) => inPolygon(poly, x, y))) return i;
  }
  return -1;
}

/** The ground's height (squares) at a map point, as the 3D views drape it: hills and ramps included. */
export function surfaceAt(h: SceneHeights | null | undefined, x: number, y: number): number {
  if (!h) return 0;
  if (!h.pieces) return groundAt(h, x, y);
  const i = pieceAt(h, x, y);
  return i < 0 ? 0 : pieceHeight(h, h.pieces[i]!, x, y);
}

/** The lowest and highest the ground goes. */
export function surfaceRange(h: SceneHeights | null | undefined): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const p of h?.pieces ?? []) {
    lo = Math.min(lo, p.h, p.grid?.min ?? p.h);
    hi = Math.max(hi, p.h, p.grid?.max ?? p.h);
  }
  for (const b of h?.bands ?? []) {
    lo = Math.min(lo, b.h);
    hi = Math.max(hi, b.h);
  }
  return [lo, hi];
}

/** Where a point of the floor lies on the floor picture covering `box` (the picture's top, y0, is v = 1). */
export function floorUv(x: number, y: number, box: Box): [number, number] {
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
  if (!h || !(h.pieces?.length || h.bands.length)) return 0;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const left = surfaceAt(h, mx + nx * 0.08, my + ny * 0.08);
  const right = surfaceAt(h, mx - nx * 0.08, my - ny * 0.08);
  if (left && right) return Math.max(left, right);
  return left || right;
}

// ---------- cutting along the lattice ----------

/**
 * Where the line `axis` = v crosses the segment a–b. Always worked out from the
 * end with the smaller coordinate, so the two triangles sharing an edge (and the
 * face along a piece's outline) get the very same point.
 */
function cross(a: Pt, b: Pt, axis: 0 | 1, v: number): Pt {
  const [p, q] = a[axis] < b[axis] || (a[axis] === b[axis] && a[1 - axis]! <= b[1 - axis]!) ? [a, b] : [b, a];
  const t = (v - p[axis]) / (q[axis] - p[axis]);
  const o = p[1 - axis]! + (q[1 - axis]! - p[1 - axis]!) * t;
  return axis === 0 ? [v, o] : [o, v];
}

/**
 * A convex polygon cut to the slab v0 <= `axis` <= v1. Every crossing comes
 * straight from the polygon's own edge (not from an earlier cut), so slabs side
 * by side, and the face along an outline, share their points exactly.
 */
function slab(poly: readonly Pt[], axis: 0 | 1, v0: number, v1: number): Pt[] {
  const out: Pt[] = [];
  const push = (p: Pt) => {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a[axis] >= v0 && a[axis] <= v1) push(a);
    const cs: Pt[] = [];
    for (const v of [v0, v1]) if ((a[axis] - v) * (b[axis] - v) < 0) cs.push(cross(a, b, axis, v));
    if (cs.length === 2 && Math.abs(cs[1]![axis] - a[axis]) < Math.abs(cs[0]![axis] - a[axis])) cs.reverse();
    cs.forEach(push);
  }
  if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

const area2 = (poly: readonly Pt[]): number => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
};

/** A convex polygon cut into the lattice's cells (rows first, then columns), as convex pieces. */
export function latticeSplit(poly: readonly Pt[], step: number): Pt[][] {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const out: Pt[][] = [];
  for (let j = Math.floor(y0 / step); j * step < y1; j++) {
    const strip = slab(poly, 1, j * step, (j + 1) * step);
    if (strip.length < 3) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const p of strip) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
    }
    for (let i = Math.floor(x0 / step); i * step < x1; i++) {
      const cell = slab(strip, 0, i * step, (i + 1) * step);
      if (cell.length >= 3 && Math.abs(area2(cell)) > 1e-12) out.push(cell);
    }
  }
  return out;
}

/** A segment cut where it crosses the lattice lines (rows first, then columns, the way latticeSplit cuts triangles), as its points in order. */
export function latticeSegment(a: Pt, b: Pt, step: number): Pt[] {
  const rows: Pt[] = [a];
  const [ya, yb] = [a[1], b[1]];
  const js: number[] = [];
  for (let j = Math.floor(Math.min(ya, yb) / step) + 1; j * step < Math.max(ya, yb); j++) js.push(j * step);
  if (yb < ya) js.reverse();
  for (const v of js) if (v !== ya && v !== yb) rows.push(cross(a, b, 1, v));
  rows.push(b);
  const out: Pt[] = [a];
  for (let k = 0; k + 1 < rows.length; k++) {
    const p = rows[k]!;
    const q = rows[k + 1]!;
    const is: number[] = [];
    for (let i = Math.floor(Math.min(p[0], q[0]) / step) + 1; i * step < Math.max(p[0], q[0]); i++) is.push(i * step);
    if (q[0] < p[0]) is.reverse();
    for (const v of is) if (v !== p[0] && v !== q[0]) out.push(cross(p, q, 0, v));
    out.push(q);
  }
  return out;
}

// ---------- faces between pieces ----------

/** A sheer face: its corners (top a, top b, bottom b, bottom a), how far along the outline each end is (for the rock texture), and the way into the higher ground at each end. */
export interface Face {
  corners: [Vec3, Vec3, Vec3, Vec3];
  u: [number, number];
  inward: [Pt, Pt];
}

/**
 * The sheer faces along the pieces' outlines: wherever a piece stands higher
 * than the ground beside it (another piece, or the plain ground at 0), a face
 * from its edge down to that ground, a hair deeper so no seam shows. Each face
 * is made once, by the higher side.
 */
export function pieceFaces(h: SceneHeights): Face[] {
  const list = h.pieces ?? [];
  const step = h.step ?? 1;
  const gridded = list.some((q) => q.grid);
  const out: Face[] = [];
  list.forEach((piece, i) => {
    for (const poly of piece.polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        const n = ring.length;
        // each side's way out of the piece
        const outs: Pt[] = [];
        for (let s = 0; s < n; s++) {
          const a = ring[s]!;
          const b = ring[(s + 1) % n]!;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = -(b[1] - a[1]) / len;
          const ny = (b[0] - a[0]) / len;
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          const sign = piece.polygons.some((q) => inPolygon(q, mx + nx * 0.01, my + ny * 0.01)) ? -1 : 1;
          outs.push([nx * sign, ny * sign]);
        }
        // the outline cut where the lattice crosses (so faces meet the ground's corners), else every half square, with what lies beyond each bit
        const bits: { p: Pt; q: Pt; s: number; nb: number }[] = [];
        for (let s = 0; s < n; s++) {
          const a = ring[s]! as Pt;
          const b = ring[(s + 1) % n]! as Pt;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-9) continue;
          const [ox, oy] = outs[s]!;
          const parts = Math.max(1, Math.ceil(len / 0.5));
          const pts = gridded ? latticeSegment(a, b, step) : Array.from({ length: parts + 1 }, (_, k): Pt => (k === 0 ? a : k === parts ? b : [a[0] + ((b[0] - a[0]) * k) / parts, a[1] + ((b[1] - a[1]) * k) / parts]));
          for (let k = 0; k + 1 < pts.length; k++) {
            const p = pts[k]!;
            const q = pts[k + 1]!;
            bits.push({ p, q, s, nb: pieceAt(h, (p[0] + q[0]) / 2 + ox * 0.02, (p[1] + q[1]) / 2 + oy * 0.02, i) });
          }
        }
        // the way out at a joint between two bits: along their side, round a corner the mean of both;
        // none where what lies beyond changes, so faces that meet there (other pieces' too) stay closed
        const joint = (x: (typeof bits)[number], y: (typeof bits)[number]): Pt => {
          if (x.nb !== y.nb) return [0, 0];
          const u = outs[x.s]!;
          const v = outs[y.s]!;
          if (x.s === y.s) return u;
          const l = Math.hypot(u[0] + v[0], u[1] + v[1]) || 1;
          return [(u[0] + v[0]) / l, (u[1] + v[1]) / l];
        };
        let along = 0;
        bits.forEach((bit, k) => {
          const { p, q, nb } = bit;
          const before = joint(bits[(k + bits.length - 1) % bits.length]!, bit);
          const after = joint(bit, bits[(k + 1) % bits.length]!);
          const other = (x: number, y: number) => (nb < 0 ? 0 : pieceHeight(h, list[nb]!, x, y));
          const mine = [pieceHeight(h, piece, p[0], p[1]), pieceHeight(h, piece, q[0], q[1])];
          const theirs = [other(p[0], p[1]), other(q[0], q[1])];
          const dl = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const face = (top: number[], low: number[], sign: number) => {
            // a hair deeper than the low ground, so no seam shows; never above the top
            const bottom = [Math.min(top[0]!, low[0]! - 0.02), Math.min(top[1]!, low[1]! - 0.02)];
            if (top[0]! - bottom[0]! <= 0.03 && top[1]! - bottom[1]! <= 0.03) return;
            out.push({
              corners: [[p[0], top[0]!, p[1]], [q[0], top[1]!, q[1]], [q[0], bottom[1]!, q[1]], [p[0], bottom[0]!, p[1]]],
              u: [along, along + dl],
              inward: [[before[0] * sign + 0, before[1] * sign + 0], [after[0] * sign + 0, after[1] * sign + 0]],
            });
          };
          // the higher side makes the face: this piece (bulging into it), or for a sunken piece the plain ground beside it
          face(mine, theirs, -1);
          if (nb < 0) face(theirs, mine, 1);
          along += dl;
        });
      }
    }
  });
  return out;
}

const hash01 = (i: number, j: number, seed: number): number => {
  let x = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ seed;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1). */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v = (i: number, j: number) => hash01(i, j, seed);
  const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Rock faces are cut into rows at these heights (squares), the same for every face, so neighbours share their points. */
export const FACE_ROW = 0.4;

/**
 * A face's two upright edges as points from foot to top: the ends exactly on
 * the ground's edges, and between them (at every FACE_ROW of height) it bulges
 * back into the higher ground, never out over the low side, by up to a third
 * of a square on tall faces, by noise keyed to the place so neighbours agree.
 */
export function faceEdges(f: Face): [Vec3[], Vec3[]] {
  const [ta, tb, bb, ba] = f.corners;
  const edge = (top: Vec3, foot: Vec3, inward: Pt): Vec3[] => {
    const tall = top[1] - foot[1];
    const out: Vec3[] = [foot];
    if (tall > 1e-6) {
      const depth = Math.min(0.35, 0.05 + 0.05 * tall);
      for (let k = Math.floor(foot[1] / FACE_ROW) + 1; k * FACE_ROW < top[1] - 1e-6; k++) {
        const y = k * FACE_ROW;
        if (y <= foot[1] + 1e-6) continue;
        const t = (y - foot[1]) / tall;
        const n = noise2((top[0] + top[2] * 0.73) / 0.9, y / 0.7, 5) * 0.75 + noise2((top[0] - top[2] * 0.41) / 0.35, y / 0.3, 9) * 0.25;
        const d = depth * Math.sin(Math.PI * t) * (0.25 + n);
        out.push([top[0] + inward[0] * d, y, top[2] + inward[1] * d]);
      }
    }
    out.push(top);
    return out;
  };
  return [edge(ta, ba, f.inward[0]), edge(tb, bb, f.inward[1])];
}

/** Triangles (as corner triples) between two upright edges, zipped up from the foot. */
export function zipEdges(left: readonly Vec3[], right: readonly Vec3[]): [Vec3, Vec3, Vec3][] {
  const out: [Vec3, Vec3, Vec3][] = [];
  let i = 0;
  let j = 0;
  while (i < left.length - 1 || j < right.length - 1) {
    if (j === right.length - 1 || (i < left.length - 1 && left[i + 1]![1] <= right[j + 1]![1])) {
      out.push([left[i]!, left[i + 1]!, right[j]!]);
      i++;
    } else {
      out.push([left[i]!, right[j + 1]!, right[j]!]);
      j++;
    }
  }
  return out;
}

// ---------- rays, lines and stairs on the ground ----------

/**
 * Where a ray meets the draped ground, as map [x, y]: marched between the
 * highest and lowest the ground goes, then narrowed down. Null if it never
 * comes down to the ground.
 */
export function surfaceHit(origin: Vec3, dir: Vec3, heightAt: (x: number, y: number) => number, range: [number, number] = [0, 0]): Pt | null {
  const [lo, hi] = range;
  const dy = dir[1];
  if (!(dy < -1e-9)) return null;
  const tTop = Math.max(0, (hi + 0.01 - origin[1]) / dy);
  const tBottom = (lo - 0.01 - origin[1]) / dy;
  if (!(tBottom > 0)) return null;
  const above = (t: number) => origin[1] + dy * t - heightAt(origin[0] + dir[0] * t, origin[2] + dir[2] * t);
  if (hi - lo < 1e-6) {
    const t = (lo - origin[1]) / dy;
    return [origin[0] + dir[0] * t, origin[2] + dir[2] * t];
  }
  // steps of about a tenth of a square along the ground
  const flat = Math.hypot(dir[0], dir[2]) * (tBottom - tTop);
  const n = Math.min(4000, Math.max(16, Math.ceil(flat / 0.1)));
  let prev = tTop;
  if (above(prev) <= 0) return [origin[0] + dir[0] * prev, origin[2] + dir[2] * prev];
  for (let k = 1; k <= n; k++) {
    const t = tTop + ((tBottom - tTop) * k) / n;
    if (above(t) <= 0) {
      let a = prev;
      let b = t;
      for (let it = 0; it < 30; it++) {
        const m = (a + b) / 2;
        if (above(m) > 0) a = m;
        else b = m;
      }
      return [origin[0] + dir[0] * b, origin[2] + dir[2] * b];
    }
    prev = t;
  }
  return null;
}

/** A straight line on the map laid over the ground: points every `step` squares, broken where the ground drops sheer (more than `jump`). Pairs of points for LineSegments. */
export function drapeLine(a: Pt, b: Pt, heightAt: (x: number, y: number) => number, step: number, lift = 0.01, jump = 0.4): Vec3[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / step));
  const out: Vec3[] = [];
  let prev: Vec3 | null = null;
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n;
    const y = a[1] + ((b[1] - a[1]) * k) / n;
    const p: Vec3 = [x, heightAt(x, y) + lift, y];
    if (prev && Math.abs(p[1] - prev[1]) <= jump) out.push(prev, p);
    prev = p;
  }
  return out;
}

/**
 * A flight of stairs between two heights: where it starts and how far it
 * rises, along the way it goes up (null when both ends are on level ground at 0).
 * The ends stand on the draped ground.
 */
export function stairRise(h: SceneHeights | null | undefined, box: Box, direction: 'n' | 'e' | 's' | 'w'): { base: number; rise: number } | null {
  if (!h || !(h.bands.length || h.pieces?.length)) return null;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const ix = Math.min(0.25, (box.x1 - box.x0) / 4);
  const iy = Math.min(0.25, (box.y1 - box.y0) / 4);
  const ends: Record<'n' | 'e' | 's' | 'w', [number, number]> = { n: [cx, box.y0 + iy], s: [cx, box.y1 - iy], w: [box.x0 + ix, cy], e: [box.x1 - ix, cy] };
  const back = { n: 's', s: 'n', e: 'w', w: 'e' } as const;
  const top = surfaceAt(h, ...ends[direction]);
  const bottom = surfaceAt(h, ...ends[back[direction]]);
  if (Math.abs(top - bottom) < 0.05) return Math.abs(bottom) > 1e-9 ? { base: Math.min(top, bottom), rise: 0 } : null;
  return { base: Math.min(top, bottom), rise: Math.abs(top - bottom) };
}

/** The way a flight really goes up: toward its higher end (the plan's heights, else the ground's) when its ends lie at different heights, else as drawn. */
export function stairsUp(h: SceneHeights | null | undefined, box: Box, direction: 'n' | 'e' | 's' | 'w'): 'n' | 'e' | 's' | 'w' {
  if (!h || !(h.bands.length || h.pieces?.length)) return direction;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const ix = Math.min(0.25, (box.x1 - box.x0) / 4);
  const iy = Math.min(0.25, (box.y1 - box.y0) / 4);
  for (const at of [groundAt, surfaceAt]) {
    const ns = at(h, cx, box.y0 + iy) - at(h, cx, box.y1 - iy);
    const we = at(h, box.x0 + ix, cy) - at(h, box.x1 - ix, cy);
    if (Math.abs(ns) < 0.05 && Math.abs(we) < 0.05) continue;
    return Math.abs(ns) >= Math.abs(we) ? (ns > 0 ? 'n' : 's') : we > 0 ? 'w' : 'e';
  }
  return direction;
}

/** The pieces' outlines and the base as polygon lists to mesh: [polygons, piece index or -1 for the base]. */
export function surfaceParts(h: SceneHeights): { polygons: ScenePolygon[]; piece: number }[] {
  const out: { polygons: ScenePolygon[]; piece: number }[] = [];
  if (h.base.length) out.push({ polygons: h.base, piece: -1 });
  (h.pieces ?? []).forEach((p, i) => out.push({ polygons: p.polygons, piece: i }));
  return out;
}
