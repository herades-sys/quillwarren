// Classic hatching: clusters of short parallel strokes in a band outside the
// walls. Cluster centres sit on a jittered lattice keyed by (seed, i, j), so
// an edit only changes the clusters near it and the rest never move.
import {
  differenceD,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  pointInPolygonD,
  PointInPolygonResult,
  type PathsD,
} from 'clipper2-ts';
import { PRECISION } from '../geometry/shapes.ts';
import type { Point } from '../schema.ts';
import { hashInts, rng } from './rng.ts';
import type { HatchStyle } from './style.ts';

/** The area outside the floor but within `width` squares of it. */
export function outsideBand(floor: PathsD, width: number): PathsD {
  if (width <= 0 || floor.length === 0) return [];
  const grown = inflatePathsD(floor, width, JoinType.Round, EndType.Polygon, 2, PRECISION);
  return differenceD(grown, floor, FillRule.NonZero, PRECISION);
}

export function insidePaths(paths: PathsD, x: number, y: number): boolean {
  let inside = false;
  for (const ring of paths) {
    if (pointInPolygonD({ x, y }, ring) !== PointInPolygonResult.IsOutside) inside = !inside;
  }
  return inside;
}

/**
 * Is (x, y) inside the ring, by ray casting on the ring as it is: 1 inside, 0
 * outside, -1 within a hair of an edge, where Clipper decides (it rounds to
 * its grid, so on and near the edge its answer is the one to keep).
 */
function ringSide(ring: PathsD[number], x: number, y: number): number {
  const eps2 = NEAR_EDGE * NEAR_EDGE;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + t * dx - x;
    const ey = a.y + t * dy - y;
    if (ex * ex + ey * ey < eps2) return -1;
    if (a.y > y !== b.y > y && x < (dx * (y - a.y)) / dy + a.x) inside = !inside;
  }
  return inside ? 1 : 0;
}

/** How close to an edge a point must be for Clipper to decide (squares; well above its rounding). */
const NEAR_EDGE = 0.02;

/**
 * insidePaths for many points over the same paths: the rings are put into a
 * coarse grid by their bounding boxes once, so each point only tests the few
 * rings that can hold it. A ring whose box misses the point is outside anyway,
 * so the answers are the same as insidePaths, point for point. On a city of
 * 700 buildings this took hatching from minutes to well under a second.
 */
export function insideTester(paths: PathsD, cell: number): { inside: (x: number, y: number) => boolean; near: (x0: number, y0: number, x1: number, y1: number) => boolean } {
  // boxes grown by NEAR_EDGE: Clipper rounds a point a hair outside a box onto its edge and counts it as inside
  const boxes = paths.map((ring) => boundsOf([ring])).map((b) => ({ x0: b.x0 - NEAR_EDGE, y0: b.y0 - NEAR_EDGE, x1: b.x1 + NEAR_EDGE, y1: b.y1 + NEAR_EDGE }));
  const buckets = new Map<number, number[]>();
  // a number per bucket (grid coordinates stay far below 2^20 squares / cell)
  const key = (gx: number, gy: number) => (gx + 1048576) * 2097152 + (gy + 1048576);
  boxes.forEach((b, k) => {
    if (!Number.isFinite(b.x0)) return;
    for (let gx = Math.floor(b.x0 / cell); gx <= Math.floor(b.x1 / cell); gx++) {
      for (let gy = Math.floor(b.y0 / cell); gy <= Math.floor(b.y1 / cell); gy++) {
        const list = buckets.get(key(gx, gy));
        if (list) list.push(k);
        else buckets.set(key(gx, gy), [k]);
      }
    }
  });
  return {
    inside: (x, y) => {
      const list = buckets.get(key(Math.floor(x / cell), Math.floor(y / cell)));
      if (!list) return false;
      let inside = false;
      for (const k of list) {
        const b = boxes[k]!;
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
        const side = ringSide(paths[k]!, x, y);
        if (side === 1 || (side === -1 && pointInPolygonD({ x, y }, paths[k]!) !== PointInPolygonResult.IsOutside)) inside = !inside;
      }
      return inside;
    },
    // is any ring's bucket touching this box? (false: no point in it can be inside)
    near: (x0, y0, x1, y1) => {
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
        for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) if (buckets.has(key(gx, gy))) return true;
      }
      return false;
    },
  };
}

function boundsOf(paths: PathsD): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of paths) {
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Stroke segments for the hatch band. Clusters are centred inside the band and
 * may spill past its outer edge (an irregular edge looks hand-drawn); the
 * caller clips them to "outside the floor" so none cross into a room.
 */
export function hatchStrokes(band: PathsD, h: HatchStyle, seed: number): Point[][] {
  if (!band.length) return [];
  const b = boundsOf(band);
  const s = h.spacing;
  const lines: Point[][] = [];
  const n = h.strokesPerCluster;
  // buckets of a few squares: big enough that most points find one list, small enough to keep the lists short
  const test = insideTester(band, Math.max(2, s * 8));
  for (let i = Math.floor(b.x0 / s); i <= Math.ceil(b.x1 / s); i++) {
    for (let j = Math.floor(b.y0 / s); j <= Math.ceil(b.y1 / s); j++) {
      // a cluster centre lies in its lattice cell; with no ring near the cell it can't be in the band
      if (!test.near(i * s, j * s, (i + 1) * s, (j + 1) * s)) continue;
      const r = rng(hashInts(seed, i, j));
      const cx = (i + r()) * s;
      const cy = (j + r()) * s;
      if (!test.inside(cx, cy)) continue;
      const angle = r() * Math.PI;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const len = h.length * (0.8 + 0.4 * r());
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * h.gap + (r() - 0.5) * h.gap * 0.35;
        const l = len * (0.8 + 0.35 * r());
        const shift = (r() - 0.5) * 0.15 * len;
        const px = cx - uy * off + ux * shift;
        const py = cy + ux * off + uy * shift;
        lines.push([
          [px - (ux * l) / 2, py - (uy * l) / 2],
          [px + (ux * l) / 2, py + (uy * l) / 2],
        ]);
      }
    }
  }
  return lines;
}
