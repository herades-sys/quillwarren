// Open ends: places where the band outside the walls (hatching, shading and the
// drop shadow) is left out, so a way out of the map reads as open ground
// instead of being walled in by rock. Two kinds:
// - an archway on the floor's outer edge (floor on one side, nothing beyond)
//   gets a channel straight out through the band, as wide as its gap, with
//   softly rounded corners: the same look fog's `beyond` gives a revealed edge;
// - an opening object, drawn by hand, clears exactly its shape.
import { areaPathsD, EndType, FillRule, inflatePathsD, intersectD, JoinType, unionD, type PathD, type PathsD } from 'clipper2-ts';
import { openingsOf } from '../geometry/openings.ts';
import { PRECISION, shapePath } from '../geometry/shapes.ts';
import { doorSegment } from '../geometry/walls.ts';
import type { DelveMap, Door, Point } from '../schema.ts';
import { insidePaths } from './hatching.ts';

/** How far past the band an open end reaches, and how round its corners are. */
const PAST = 0.5;
const SOFT = 0.15;

export interface OuterArchway {
  door: Door;
  /** The way out: a unit vector from the floor across the gap. */
  out: Point;
}

const rectPath = (pts: Point[]): PathD => pts.map(([x, y]) => ({ x, y }));

function strip(d: Door, out: Point, from: number, to: number): PathD {
  const [a, b] = doorSegment(d);
  const at = (p: Point, k: number): Point => [p[0] + out[0] * k, p[1] + out[1] * k];
  return rectPath([at(a, from), at(b, from), at(b, to), at(a, to)]);
}

/**
 * Archways on the floor's outer edge (`flat`: the floor as Clipper paths):
 * floor on exactly one side of the gap, and no floor within `reach` squares
 * beyond it. Archways between two rooms, or across a corridor mouth, have
 * floor on both sides and are left alone.
 */
export function outerArchways(map: DelveMap, flat: PathsD, reach: number): OuterArchway[] {
  const out: OuterArchway[] = [];
  for (const d of map.objects) {
    if (d.type !== 'door' || d.style !== 'archway') continue;
    const [a, b] = doorSegment(d);
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n: Point = d.along === 'x' ? [0, 1] : [1, 0];
    const k = 0.05;
    const plus = insidePaths(flat, mid[0] + n[0] * k, mid[1] + n[1] * k);
    const minus = insidePaths(flat, mid[0] - n[0] * k, mid[1] - n[1] * k);
    if (plus === minus) continue; // floor on both sides (an inner archway) or on neither (not on a wall)
    const dir: Point = plus ? [n[0] ? -n[0] : 0, n[1] ? -n[1] : 0] : n;
    // nothing beyond: another room within reach keeps its band
    const beyond = intersectD([strip(d, dir, 0.02, reach + PAST)], flat, FillRule.NonZero, PRECISION);
    if (Math.abs(areaPathsD(beyond)) > 1e-6) continue;
    out.push({ door: d, out: dir });
  }
  return out;
}

/** The open ends in front of outer archways: a strip as wide as the gap, out past the band, its corners rounded. */
export function archwayEnds(map: DelveMap, flat: PathsD, reach: number): PathsD {
  const list = outerArchways(map, flat, reach);
  if (!list.length) return [];
  const strips = list.map(({ door, out }) => strip(door, out, 0, reach + PAST));
  return inflatePathsD(unionD(strips, [], FillRule.NonZero, PRECISION), SOFT, JoinType.Round, EndType.Polygon, 2, PRECISION);
}

/**
 * Everything the band outside the walls leaves out: the archways' open ends
 * and the opening objects, as one union (positive orientation, so it can be
 * subtracted under NonZero). Empty for most maps.
 */
export function openAreas(map: DelveMap, flat: PathsD, reach: number): PathsD {
  const hasArch = map.objects.some((o) => o.type === 'door' && o.style === 'archway');
  const openings = openingsOf(map);
  if (!hasArch && !openings.length) return [];
  const parts: PathsD = [...(hasArch ? archwayEnds(map, flat, reach) : []), ...openings.map((o) => shapePath(o.shape))];
  return parts.length ? unionD(parts, [], FillRule.NonZero, PRECISION) : [];
}
