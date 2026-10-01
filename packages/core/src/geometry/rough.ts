// Wall roughness from 1 (smooth) to 10 (caves): the floor's outline is cut into
// short steps and each point pushed in or out by smooth noise, so the floor,
// the walls and the hatching all follow the same rough edge. A map sets a level
// for everything, and a room, corridor or cutout can set its own; each point of
// the outline takes the level of the nearest one. Doors stay on straight wall.
import { FillRule, unionD, type PathsD } from 'clipper2-ts';
import { hashInts, hashString } from '../render/rng.ts';
import type { DelveMap, Door, Point } from '../schema.ts';
import { corridorOutline, corridorPath, roomsById } from './corridors.ts';
import { computeFloor, polygonsOf } from './floor.ts';
import { PRECISION, shapePath, toPath, type Polygon, type Ring } from './shapes.ts';
import { doorSegment } from './walls.ts';

/** How far (in squares) the edge may wander at each level, 1 to 10. */
export const ROUGHNESS_AMPLITUDE = [0, 0.03, 0.06, 0.1, 0.15, 0.22, 0.32, 0.45, 0.62, 0.85] as const;

export const amplitudeOf = (level: number | undefined): number => (level ? ROUGHNESS_AMPLITUDE[Math.max(1, Math.min(10, Math.round(level))) - 1]! : 0);

/** Smooth value noise in [-1, 1], the same at a point whichever ring asks. */
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const v = (a: number, b: number) => (hashInts(seed, a, b) / 0xffffffff) * 2 - 1;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Broad swells, lumps, smaller bulges and a little grit: at low levels only a gentle bow, at 10 a cave wall. */
function fbm(x: number, y: number, seed: number): number {
  return 0.4 * noise(x * 0.22, y * 0.22, seed) + 0.32 * noise(x * 0.55, y * 0.55, seed + 1) + 0.18 * noise(x * 1.3, y * 1.3, seed + 2) + 0.1 * noise(x * 3, y * 3, seed + 3);
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** Does the map ask for any roughness at all? */
export function hasRoughness(map: DelveMap): boolean {
  return Boolean(map.roughness && map.roughness > 1) || map.objects.some((o) => 'roughness' in o && o.roughness !== undefined && o.roughness > 1);
}

/** The level at a point of the outline: that of the nearest room, corridor or cutout edge with its own, else the map's. */
function levelAt(map: DelveMap): (p: Point) => number {
  const own: { level: number; segs: [Point, Point][] }[] = [];
  const rooms = roomsById(map);
  const ring = (path: { x: number; y: number }[]): [Point, Point][] => path.map((q, i) => [[q.x, q.y], [path[(i + 1) % path.length]!.x, path[(i + 1) % path.length]!.y]]);
  for (const o of map.objects) {
    if (o.type === 'room' || o.type === 'cutout') own.push({ level: o.roughness ?? map.roughness ?? 1, segs: ring(shapePath(o.shape)) });
    else if (o.type === 'corridor') {
      const path = corridorPath(o, rooms);
      if (path) own.push({ level: o.roughness ?? map.roughness ?? 1, segs: corridorOutline(path, o.width).flatMap(ring) });
    }
  }
  const uniform = own.every((x) => x.level === own[0]?.level);
  if (uniform) {
    const level = own[0]?.level ?? map.roughness ?? 1;
    return () => level;
  }
  return (p) => {
    let best = Infinity;
    let level = map.roughness ?? 1;
    for (const x of own) {
      for (const [a, b] of x.segs) {
        const d = distToSegment(p, a, b);
        if (d < best) {
          best = d;
          level = x.level;
        }
      }
    }
    return level;
  };
}

/**
 * The floor with rough edges, or null when the map has no roughness (then the
 * floor stays exactly as it is). Outward bumps are kept smaller than inward
 * ones, so rooms a square apart don't run into each other.
 */
export function roughFloor(map: DelveMap, floor: readonly Polygon[], seed: number): Polygon[] | null {
  if (!hasRoughness(map)) return null;
  const level = levelAt(map);
  const doors = map.objects.filter((o): o is Door => o.type === 'door').map(doorSegment);
  // no roughness right at a door, full roughness a square away
  const taper = (p: Point): number => {
    let d = Infinity;
    for (const [a, b] of doors) d = Math.min(d, distToSegment(p, a, b));
    const t = Math.max(0, Math.min(1, (d - 0.35) / 0.9));
    return t * t * (3 - 2 * t);
  };
  const rough = (ring: Ring, hole: boolean): Ring => {
    // which side of the ring is floor: inside an outer ring, outside a hole
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    const side = (hole ? -1 : 1) * (area > 0 ? 1 : -1);
    // cut into steps of a quarter square
    const pts: Point[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
      for (let s = 0; s < steps; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
    }
    return pts.map((p, i) => {
      const amp = amplitudeOf(level(p)) * taper(p);
      if (!amp) return p;
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const next = pts[(i + 1) % pts.length]!;
      const tx = next[0] - prev[0];
      const ty = next[1] - prev[1];
      const len = Math.hypot(tx, ty) || 1;
      // > 0: the rock juts into the floor; < 0: the floor bulges into the rock (kept smaller)
      let d = fbm(p[0], p[1], seed) * amp * 1.6;
      if (d < 0) d *= 0.6;
      return [p[0] + ((-ty * side) / len) * d, p[1] + ((tx * side) / len) * d] as Point;
    });
  };
  const paths: PathsD = floor.flatMap((poly) => [toPath(rough(poly.outer, false)), ...poly.holes.map((r) => toPath(rough(r, true)))]);
  // clean up any spot where a big bump crossed its own edge
  return polygonsOf(unionD(paths, [], FillRule.EvenOdd, PRECISION));
}

/** The most the floor can bulge out past its shapes on this map: fog of war widens what the players see by this much, so rough edges aren't clipped. */
export function maxBulge(map: DelveMap): number {
  let level = map.roughness ?? 0;
  for (const o of map.objects) if ('roughness' in o && o.roughness) level = Math.max(level, o.roughness);
  return amplitudeOf(level) * 1.6 * 0.6;
}

/** The floor as the renderer draws it: with its rough edges when the map asks for them (walls for line of sight follow these). */
export function drawnFloor(map: DelveMap): Polygon[] {
  const floor = computeFloor(map);
  return roughFloor(map, floor, map.seed ?? hashString(map.id)) ?? floor;
}
