// A terrain area is its shape minus its holes: a forest filled around a
// dungeon leaves the rooms out as holes, so the grass never covers the floor.
import { differenceD, FillRule, type PathsD } from 'clipper2-ts';
import type { Terrain } from '../schema.ts';
import { polygonsOf } from './floor.ts';
import { fromPath, PRECISION, shapePath, type Polygon } from './shapes.ts';

/** The area a terrain covers, as flat Clipper paths (outer rings and holes). */
export function terrainArea(t: Pick<Terrain, 'shape' | 'holes'>): PathsD {
  const outer = [shapePath(t.shape)];
  // shapePath turns every ring the same way round, so overlapping holes still cut
  return t.holes?.length ? differenceD(outer, t.holes.map((ring) => shapePath({ poly: ring })), FillRule.NonZero, PRECISION) : outer;
}

/** The same area as polygons with holes, for drawing. Without holes it is just the shape's outline, exactly as before holes existed. */
export function terrainPolygons(t: Pick<Terrain, 'shape' | 'holes'>): Polygon[] {
  return t.holes?.length ? polygonsOf(terrainArea(t)) : [{ outer: fromPath(shapePath(t.shape)), holes: [] }];
}
