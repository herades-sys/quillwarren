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
  for (let i = Math.floor(b.x0 / s); i <= Math.ceil(b.x1 / s); i++) {
    for (let j = Math.floor(b.y0 / s); j <= Math.ceil(b.y1 / s); j++) {
      const r = rng(hashInts(seed, i, j));
      const cx = (i + r()) * s;
      const cy = (j + r()) * s;
      if (!insidePaths(band, cx, cy)) continue;
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
