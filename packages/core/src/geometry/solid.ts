// Solid cutouts (fill "solid"): pillars, wall blocks and standing stones drawn
// filled with the wall colour instead of showing the rock (or, in "clean", a
// white hole). The fill is the floor the cutout took away: its part of the
// rooms and corridors that isn't floor. With rough walls the edge around it
// moves, so the cutout is grown by the deepest dent first and only the pieces
// that touch it are kept.
import { areaPathsD, differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathsD } from 'clipper2-ts';
import type { Cutout, DelveMap } from '../schema.ts';
import { floorParts, polygonsOf } from './floor.ts';
import { amplitudeOf, hasRoughness } from './rough.ts';
import { PRECISION, shapePath, toPath, type Polygon } from './shapes.ts';

/** How far rough walls can push the rock into the floor (see roughFloor: up to 1.6 × the amplitude). */
function deepestDent(map: DelveMap): number {
  if (!hasRoughness(map)) return 0;
  let level = map.roughness ?? 0;
  for (const o of map.objects) if ('roughness' in o && o.roughness) level = Math.max(level, o.roughness);
  return amplitudeOf(level) * 1.6 + 0.02;
}

/**
 * The area to fill for the map's solid cutouts. floor is the floor as drawn
 * (rough, and cut to what's seen with fog); seen limits the fill the same way.
 */
export function solidCutouts(map: DelveMap, floor: readonly Polygon[], seen: PathsD | null = null): Polygon[] {
  const solid = map.objects.filter((o): o is Cutout => o.type === 'cutout' && o.fill === 'solid');
  if (!solid.length) return [];
  const shapes = solid.map((c) => shapePath(c.shape));
  const dent = deepestDent(map);
  const grown = dent ? inflatePathsD(shapes, dent, JoinType.Round, EndType.Polygon, 2, PRECISION) : shapes;
  const { add } = floorParts(map);
  const flat = floor.flatMap((p) => [p.outer, ...p.holes].map(toPath));
  let region = differenceD(intersectD(grown, add, FillRule.NonZero, PRECISION), flat, FillRule.NonZero, PRECISION);
  if (seen) region = intersectD(region, seen, FillRule.NonZero, PRECISION);
  const pieces = polygonsOf(region);
  // grown, it may reach into a rock pit nearby: keep only the pieces a solid cutout is part of
  return dent ? pieces.filter((p) => Math.abs(areaPathsD(intersectD([toPath(p.outer)], shapes, FillRule.NonZero, PRECISION))) > 1e-6) : pieces;
}
