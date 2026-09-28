import { areaPathsD, FillRule, unionD, xorD } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  autoRoute,
  computeFloor,
  computeWalls,
  corridorOutline,
  corridorPath,
  floorArea,
  floorPaths,
  segmentLength,
  type Corridor,
  type DelveMap,
  type Segment,
} from '../src/index.ts';
import { dungeonScrawlMap, testMap } from './fixtures.ts';

describe('floor', () => {
  it('matches the Dungeon Scrawl original square for square', () => {
    // DS stores pixels at 36 px per square and insets every vertex by 0.01 px;
    // the .ds dungeon sits at (+9, +2) squares from ours.
    const rings = dungeonScrawlMap().polygons.flat(1);
    const ds = rings.map((ring) =>
      ring.map(([x, y]) => ({ x: Math.round((x! / 36 - 9) * 2) / 2, y: Math.round((y! / 36 - 2) * 2) / 2 })),
    );
    const theirs = unionD(ds, [], FillRule.EvenOdd, 6);
    const ours = floorPaths(testMap());
    expect(Math.abs(areaPathsD(theirs))).toBe(296);
    expect(Math.abs(areaPathsD(xorD(ours, theirs, FillRule.NonZero, 6)))).toBeLessThan(1e-9);
  });

  it('is one outline with the four pillars as holes', () => {
    const floor = computeFloor(testMap());
    expect(floor).toHaveLength(1);
    expect(floor[0]!.holes).toHaveLength(4);
    expect(floorArea(testMap())).toBe(296);
  });
});

describe('corridors', () => {
  it('uses square joins and butt ends on an L-shaped path', () => {
    const out = corridorOutline(
      [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
      2,
    );
    expect(Math.abs(areaPathsD(out))).toBe(14); // 5×2 leg + 2×2 leg below the corner
  });

  it('routes straight when rooms line up and as an L when they do not', () => {
    const a = { x0: 0, y0: 0, x1: 4, y1: 4 };
    // overlap is x 1..4; a 2-wide corridor snaps to whole squares (x 2..4)
    expect(autoRoute(a, { x0: 1, y0: 8, x1: 5, y1: 12 }, 2)).toEqual([
      [3, 4],
      [3, 8],
    ]);
    expect(autoRoute(a, { x0: 10, y0: 10, x1: 14, y1: 14 }, 1)).toEqual([
      [4, 2.5],
      [12.5, 2.5],
      [12.5, 10],
    ]);
    expect(autoRoute(a, { x0: 2, y0: 2, x1: 6, y1: 6 }, 1)).toBeNull(); // overlapping rooms
  });

  it('follows a room that moves when it has no path of its own', () => {
    const base = testMap();
    const { map } = applyOps(base, [
      { op: 'add', object: { id: 'r7', type: 'room', shape: { rect: [0, 25, 5, 5] }, label: '7' } },
      { op: 'add', object: { id: 'c6', type: 'corridor', from: 'r7', to: 'r1', width: 1 } },
    ]);
    const rooms = new Map(map.objects.filter((o) => o.type === 'room').map((r) => [r.id, r]));
    const c6 = map.objects.find((o) => o.id === 'c6') as Corridor;
    expect(corridorPath(c6, rooms as never)).toEqual([
      [5, 27.5],
      [7, 27.5],
    ]);
    const after = applyOps(map, [{ op: 'move', ids: ['r7'], dx: 0, dy: 1 }]).map;
    const rooms2 = new Map(after.objects.filter((o) => o.type === 'room').map((r) => [r.id, r]));
    expect(corridorPath(c6, rooms2 as never)).toEqual([
      [5, 28.5],
      [7, 28.5],
    ]);
    // and the floor grew by exactly the new room plus a 2×1 corridor
    expect(floorArea(after)).toBe(floorArea(base) + 25 + 2);
  });
});

describe('walls', () => {
  const total = (segs: Segment[]): number => segs.reduce((s, x) => s + segmentLength(x), 0);
  const without = (map: DelveMap, id: string): DelveMap => ({ ...map, objects: map.objects.filter((o) => o.id !== id) });

  it('opens a gap where a door sits on the outer wall', () => {
    const map = testMap();
    const walls = computeWalls(map);
    // d5 sits on the entrance hall's south wall (y = 31) from x 9 to 11
    expect(total(computeWalls(without(map, 'd5'))) - total(walls)).toBe(2);
    const onSouth = walls.filter(([a, b]) => a[1] === 31 && b[1] === 31);
    const covered = (x: number) => onSouth.some(([a, b]) => x > Math.min(a[0], b[0]) && x < Math.max(a[0], b[0]));
    expect(covered(8)).toBe(true);
    expect(covered(10)).toBe(false);
    expect(covered(12)).toBe(true);
  });

  it('leaves walls alone for a door across a corridor mouth', () => {
    const map = testMap();
    expect(total(computeWalls(without(map, 'd1')))).toBe(total(computeWalls(map)));
  });

  it('keeps the pillars walled all round', () => {
    const walls = computeWalls(testMap());
    const pillar = walls.filter(([a, b]) => [a, b].every(([x, y]) => x >= 6 && x <= 7 && y >= 3 && y <= 4));
    expect(total(pillar)).toBe(4);
  });
});
