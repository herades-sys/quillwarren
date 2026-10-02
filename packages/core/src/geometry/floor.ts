// Floor = union(rooms + corridors) minus union(cutouts).
import {
  areaPathsD,
  booleanOpDWithPolyTree,
  ClipType,
  differenceD,
  FillRule,
  PolyTreeD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts';
import type { DelveMap } from '../schema.ts';
import { corridorOutline, corridorPath, roomsById } from './corridors.ts';
import { fromPath, PRECISION, shapePath, type Polygon, type Ring } from './shapes.ts';

/** Raw outlines that add to and cut from the floor. */
export function floorParts(map: DelveMap): { add: PathsD; cut: PathsD } {
  const rooms = roomsById(map);
  const add: PathsD = [];
  const cut: PathsD = [];
  for (const o of map.objects) {
    if (o.type === 'room') add.push(shapePath(o.shape));
    else if (o.type === 'cutout') cut.push(shapePath(o.shape));
    else if (o.type === 'corridor') {
      const path = corridorPath(o, rooms);
      if (path) add.push(...corridorOutline(path, o.width));
    }
  }
  return { add, cut };
}

/** Floor as flat Clipper paths (outer rings and holes mixed), for area and boolean checks. */
export function floorPaths(map: DelveMap): PathsD {
  const { add, cut } = floorParts(map);
  return differenceD(add, cut, FillRule.NonZero, PRECISION);
}

export function floorArea(map: DelveMap): number {
  return Math.abs(areaPathsD(floorPaths(map)));
}

function collect(node: PolyPathD, out: Polygon[]): void {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i);
    const holes: Ring[] = [];
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j);
      if (hole.poly) holes.push(tidyRing(fromPath(hole.poly)));
      collect(hole, out); // islands inside a hole
    }
    if (outer.poly) out.push({ outer: tidyRing(fromPath(outer.poly)), holes });
  }
}

/**
 * Clean-up: where a corridor crosses a slanted or curved wall, Clipper can put
 * two points a few millionths apart; such a sliver of an edge would give the
 * wall line a kink, so the second one goes. (Floors of whole and half squares
 * never have them, so their outlines stay exactly as they were.)
 */
function tidyRing(ring: Ring): Ring {
  const close = (a: Ring[number], b: Ring[number]) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
  if (ring.length < 4 || !ring.some((p, k) => close(p, ring[(k + 1) % ring.length]!))) return ring;
  const out = ring.filter((p, k) => k === 0 || !close(p, ring[k - 1]!));
  while (out.length > 3 && close(out[0]!, out.at(-1)!)) out.pop();
  return out;
}

/** Floor as polygons with holes: what renderers and wall tracing use. */
export function computeFloor(map: DelveMap): Polygon[] {
  const { add, cut } = floorParts(map);
  return polygonsOf(add, cut);
}

/** Polygons with holes for `add` minus `cut` (NonZero), via Clipper's PolyTree. */
export function polygonsOf(add: PathsD, cut: PathsD = []): Polygon[] {
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Difference, add, cut, tree, FillRule.NonZero, PRECISION);
  const out: Polygon[] = [];
  collect(tree, out);
  return out;
}
