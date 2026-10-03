// Keeping props off each other (core placement.ts): what counts as an obstacle,
// the footprints and the overlap tolerance, the brush's skipped spots (seeded,
// so the same stroke gives the same copies), the props a new one stands on, the
// nearest free spot, and the report for props added in one go.
import { describe, expect, it } from 'vitest';
import {
  blockingProps,
  freeSpot,
  groupVariants,
  isObstacle,
  keepClear,
  modularAt,
  OVERLAP_TOLERANCE,
  overlapReport,
  propsOverlap,
  scatterAlong,
  type MapObject,
  type Point,
  type Prop,
} from '../src/index.ts';

const prop = (id: string, asset: string, at: Point, more: Partial<Prop> = {}): Prop => ({ id, type: 'prop', asset, at, ...more });
const placed = (asset: string, at: Point, more: { rotation?: number; scale?: number } = {}) => ({ asset, at, ...more });

describe('obstacles', () => {
  it('are trees (saplings too) and props that block movement or sight and stand up: boulders, walls, columns, tables', () => {
    for (const id of ['c-oak-a', 'tree', 'c-sapling-a', 'boulder', 'c-boulder-a', 'c-wall-2', 'c-column-standing', 'table-round', 'rubble']) expect(isObstacle(id), id).toBe(true);
    // floor props, other props you walk over, GM symbols, terrain tiles and unknown assets are not
    for (const id of ['c-persian-red-a', 'c-leaf-pile-a', 'mushrooms', 'candles', 'ferns', 'trap', 'c-ground-grass-short', 'no-such-prop']) expect(isObstacle(id), id).toBe(false);
  });
});

describe('overlap and its tolerance', () => {
  it('lets round footprints touch and reach a quarter square into each other, not more', () => {
    expect(OVERLAP_TOLERANCE).toBe(0.25);
    // two 2×2 pines (discs of radius 1)
    expect(propsOverlap(placed('c-pine-a', [0, 0]), placed('c-pine-a', [2, 0]))).toBe(false);
    expect(propsOverlap(placed('c-pine-a', [0, 0]), placed('c-pine-a', [1.8, 0]))).toBe(false);
    expect(propsOverlap(placed('c-pine-a', [0, 0]), placed('c-pine-a', [1.7, 0]))).toBe(true);
    // square footprints are discs, so turning a tree changes nothing
    expect(propsOverlap(placed('c-pine-a', [0, 0], { rotation: 45 }), placed('c-pine-a', [1.8, 0], { rotation: 30 }))).toBe(false);
    // a 3×3 oak and a 1×1 boulder: radii 1.5 and 0.5
    expect(propsOverlap(placed('c-oak-a', [0, 0]), placed('c-boulder-a', [1.8, 0]))).toBe(false);
    expect(propsOverlap(placed('c-oak-a', [0, 0]), placed('c-boulder-a', [1.7, 0]))).toBe(true);
    expect(propsOverlap(placed('c-oak-a', [0, 0]), placed('c-boulder-a', [0.5, 0.5]))).toBe(true);
  });

  it('allows less for small props: a quarter of the smaller one’s shorter side', () => {
    // a half-size boulder (radius 0.25) by a whole one (0.5): at most 0.125 deep
    expect(propsOverlap(placed('c-boulder-a', [0, 0], { scale: 0.5 }), placed('c-boulder-a', [0.65, 0]))).toBe(false);
    expect(propsOverlap(placed('c-boulder-a', [0, 0], { scale: 0.5 }), placed('c-boulder-a', [0.6, 0]))).toBe(true);
  });

  it('compares long props by their turned rectangle', () => {
    // two straight ruin walls end to end, and one crossing them
    expect(propsOverlap(placed('c-wall-2', [1, 0.5]), placed('c-wall-2', [3, 0.5]))).toBe(false);
    expect(propsOverlap(placed('c-wall-2', [1, 0.5]), placed('c-wall-2', [1, 0.5], { rotation: 90 }))).toBe(true);
    // a boulder against the wall's side, and one pushed into it
    expect(propsOverlap(placed('c-wall-2', [1, 0.5]), placed('c-boulder-a', [1, 1.5]))).toBe(false);
    expect(propsOverlap(placed('c-wall-2', [1, 0.5]), placed('c-boulder-a', [1, 1.2]))).toBe(true);
    // a 3×1 fallen column turned 45°: its corner clears a boulder its square box would hit
    expect(propsOverlap(placed('c-column-fallen', [0, 0], { rotation: 45 }), placed('c-boulder-a', [1.2, -1.2]))).toBe(false);
    expect(propsOverlap(placed('c-column-fallen', [0, 0], { rotation: 45 }), placed('c-boulder-a', [0.8, 0.8]))).toBe(true);
  });
});

describe('a brush stroke kept clear', () => {
  const map: MapObject[] = [prop('i1', 'c-oak-a', [5, 0]), prop('i2', 'c-persian-red-a', [10, 0]), prop('i3', 'mushrooms', [15, 0])];
  const row = (asset: string, step = 1) => Array.from({ length: Math.floor(20 / step) + 1 }, (_, k) => placed(asset, [k * step, 0]));

  it('skips spots on a tree, keeps spots on a rug or mushrooms, and copies that only touch', () => {
    const { kept, skipped } = keepClear(map, row('c-boulder-a'));
    // the oak (radius 1.5) and a boulder (0.5) overlap more than a quarter square closer than 1.75
    expect(kept.map((c) => c.at[0])).toEqual([0, 1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(skipped).toBe(3);
  });

  it('skips a copy that would stand on an earlier copy of the same stroke', () => {
    const { kept, skipped } = keepClear([], row('c-boulder-a', 0.5));
    expect(kept.map((c) => c.at[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(skipped).toBe(20);
  });

  it('keeps every copy that doesn’t block (they go anywhere)', () => {
    expect(keepClear(map, row('mushrooms', 0.5)).skipped).toBe(0);
    expect(keepClear(map, row('c-leaf-pile-a', 0.5)).skipped).toBe(0);
  });

  it('gives the same forest for the same seed, and another for another', () => {
    const path: Point[] = [[0, 0], [30, 0], [30, 12], [0, 12]];
    const forest = (seed: number) => {
      const spots = scatterAlong(path, { spacing: 2.5, placement: 'irregular', spread: 1, seed, variants: groupVariants('c-oak-a') });
      return keepClear(map, spots.map((s) => placed(s.asset!, s.at, { rotation: s.rotation, scale: s.scale })));
    };
    const a = forest(7);
    expect(forest(7)).toEqual(a);
    expect(a.skipped).toBeGreaterThan(0);
    expect(a.kept.length).toBeGreaterThan(10);
    expect(forest(8).kept).not.toEqual(a.kept);
    // nothing kept overlaps the oak already there or another kept tree
    const all = [...a.kept, placed('c-oak-a', [5, 0])];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(propsOverlap(all[i]!, all[j]!)).toBe(false);
  });
});

describe('what a new prop stands on, and where it would be free', () => {
  const map: MapObject[] = [
    prop('i1', 'c-oak-a', [5, 5]),
    prop('i2', 'c-boulder-mossy', [7.5, 5]),
    prop('i3', 'c-persian-red-a', [2, 5]),
    prop('i4', 'table-round', [2, 5]),
  ];

  it('names the obstacles it overlaps, in map order, and nothing for props that go anywhere', () => {
    expect(blockingProps(map, { asset: 'c-boulder-a', at: [6.5, 5] }).map((p) => p.id)).toEqual(['i1', 'i2']);
    expect(blockingProps(map, { asset: 'c-boulder-a', at: [5, 1] })).toEqual([]);
    // a table on a rug, a candle on a table, a leaf pile under a tree
    expect(blockingProps(map, { asset: 'table-round', at: [2, 6] }).map((p) => p.id)).toEqual(['i4']);
    expect(blockingProps(map.slice(0, 3), { asset: 'table-round', at: [2, 5] })).toEqual([]);
    expect(blockingProps(map, { asset: 'candles', at: [2, 5] })).toEqual([]);
    expect(blockingProps(map, { asset: 'c-leaf-pile-a', at: [5, 5] })).toEqual([]);
    // itself (same id) doesn't count
    expect(blockingProps(map, { id: 'i1', asset: 'c-oak-a', at: [5, 5] })).toEqual([]);
  });

  it('finds the nearest free spot in half squares, the same every time', () => {
    const boulder = { asset: 'c-boulder-a', at: [5, 5] as Point };
    const free = freeSpot(map, boulder)!;
    expect(free).toEqual(freeSpot(map, boulder));
    expect(blockingProps(map, { ...boulder, at: free })).toEqual([]);
    expect(free.every((v) => Number.isInteger(v * 2))).toBe(true);
    // the oak reaches 1.75 out for a boulder: the nearest clear half-square steps are 1.8 away, the first of them clockwise from north
    expect(free).toEqual([6, 3.5]);
    expect(freeSpot(map, { asset: 'c-boulder-a', at: [5, 5] }, 1)).toBeNull();
  });

  it('keeps a modular wall piece on whole squares', () => {
    const wall = { asset: 'c-wall-2', at: modularAt({ asset: 'c-wall-2', at: [5, 5.5] }) };
    const free = freeSpot(map, wall)!;
    expect(modularAt({ ...wall, at: free })).toEqual(free);
    expect(blockingProps(map, { ...wall, at: free })).toEqual([]);
  });

  it('reports props added in one go that stand on obstacles, a pair of new ones at the later one', () => {
    const after: MapObject[] = [...map, prop('i5', 'c-boulder-a', [6, 5]), prop('i6', 'c-pine-a', [6.5, 5.5]), prop('i7', 'candles', [5, 5]), prop('i8', 'c-boulder-a', [12, 12])];
    expect(overlapReport(after, ['i5', 'i6', 'i7', 'i8'])).toEqual([
      { id: 'i5', on: ['i1'] },
      { id: 'i6', on: ['i1', 'i2', 'i5'] },
    ]);
    expect(overlapReport(after, [])).toEqual([]);
  });
});
