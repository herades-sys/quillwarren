// The pure parts of heights in the browser: the 3D helpers (ground, walls, faces,
// stairs between heights, floor UVs), the height fields, and the overlay's tints.
import type { SceneHeights } from '@delve/table';
import { describe, expect, it } from 'vitest';
import { edgeQuads, floorUv, groundAt, quadPositions, stairRise, stairsUp, wallBase } from '../src/heights3d-logic.ts';
import { heightValue, parseHeight } from '../src/height-text.ts';
import { bandColor } from '../src/height-text.ts';

const sq = (x0: number, y0: number, x1: number, y1: number) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][], holes: [] });

/** A 10 ft ledge (2 up) along the north of a hall, a pit (2 down) in the middle. */
const hs: SceneHeights = {
  bands: [
    { h: -2, polygons: [sq(6, 6, 10, 9)] },
    { h: 2, polygons: [sq(0, 0, 16, 3)] },
  ],
  base: [],
  edges: [
    { points: [[0, 3], [16, 3]], closed: false, hi: 2, lo: 0, kind: 'cliff', run: 0 },
    { points: [[0, 3], [16, 3]], closed: false, hi: 2, lo: 0, kind: 'rock', run: 1 },
  ],
};

describe('3D heights', () => {
  it('finds the ground under a point', () => {
    expect(groundAt(hs, 5, 1)).toBe(2);
    expect(groundAt(hs, 8, 7)).toBe(-2);
    expect(groundAt(hs, 3, 5)).toBe(0);
    expect(groundAt(null, 5, 1)).toBe(0);
  });

  it('stands walls on the ground beside them', () => {
    expect(wallBase(hs, [0, 0], [16, 0])).toBe(2); // the hall's north wall, along the ledge
    expect(wallBase(hs, [0, 5], [0, 9])).toBe(0);
    expect(wallBase(hs, [6, 9], [10, 9])).toBe(-2); // a wall along the pit's edge, with the pit on one side
    expect(wallBase(undefined, [0, 0], [1, 0])).toBe(0);
  });

  it('makes sheer faces for cliffs and leaning ones for rock and slopes', () => {
    const [cliff] = edgeQuads(hs.edges[0]!);
    expect(cliff).toEqual([
      [0, 2, 3],
      [16, 2, 3],
      [16, 0, 3],
      [0, 0, 3],
    ]);
    // walking east the low side is south (+z): the rock face's foot is a square further south
    const [rock] = edgeQuads(hs.edges[1]!);
    expect(rock![2]).toEqual([16, 0, 4]);
    expect(rock![3]).toEqual([0, 0, 4]);
    expect(quadPositions([cliff!]).length).toBe(18);
    // a closed ring's corners meet
    const ring = edgeQuads({ points: [[0, 0], [4, 0], [4, 4], [0, 4]], closed: true, hi: 0, lo: -2, kind: 'slope', run: 1 });
    expect(ring).toHaveLength(4);
    expect(ring[0]![2]).toEqual(ring[1]![3]);
  });

  it('runs stairs between two heights from the low end to the high one', () => {
    expect(stairRise(hs, { x0: 12, y0: 2, x1: 14, y1: 5 }, 'n')).toEqual({ base: 0, rise: 2 });
    expect(stairRise(hs, { x0: 7, y0: 5, x1: 9, y1: 7 }, 'n')).toEqual({ base: -2, rise: 2 });
    expect(stairRise(hs, { x0: 1, y0: 4, x1: 3, y1: 5 }, 'e')).toBeNull();
    // drawn the wrong way round, they still climb toward the ledge
    expect(stairsUp(hs, { x0: 12, y0: 2, x1: 14, y1: 5 }, 's')).toBe('n');
    expect(stairsUp(null, { x0: 12, y0: 2, x1: 14, y1: 5 }, 's')).toBe('s');
  });

  it('maps the floor picture by position', () => {
    expect(floorUv(0, 0, { x0: 0, y0: 0, x1: 10, y1: 20 })).toEqual([0, 1]);
    expect(floorUv(10, 20, { x0: 0, y0: 0, x1: 10, y1: 20 })).toEqual([1, 0]);
  });
});

describe('height fields and the overlay', () => {
  it('reads heights as typed and shows them signed', () => {
    expect(parseHeight('+10')).toBe(10);
    expect(parseHeight('−5 ft')).toBe(-5);
    expect(parseHeight('7,5')).toBe(7.5);
    expect(parseHeight('high')).toBeNull();
    expect(parseHeight('')).toBeNull();
    expect(heightValue(10)).toBe('+10');
    expect(heightValue(-5)).toBe('−5');
    expect(heightValue(0)).toBe('0');
  });

  it('tints by height: none at the floor, warm up, cool down, deeper with height', () => {
    const unit = { size: 5, name: 'ft' };
    expect(bandColor(0, unit)).toBeNull();
    expect(bandColor(5, unit)).not.toBe(bandColor(20, unit));
    expect(bandColor(-5, unit)).toMatch(/^#[0-9a-f]{6}$/);
    expect(bandColor(100, unit)).toBe('#e8590c');
  });
});
