// The pure parts of heights in the browser: the 3D helpers (the draped ground,
// lattice cuts, sheer faces, rays, stairs and walls on it, floor UVs), the
// height fields, and the overlay's tints.
import type { SceneGrid, SceneHeights } from '@delve/table';
import { describe, expect, it } from 'vitest';
import { drapeLine, faceEdges, floorUv, groundAt, latticeSegment, latticeSplit, pieceAt, pieceFaces, stairRise, stairsUp, surfaceAt, surfaceHit, wallBase, zipEdges } from '../src/heights3d-logic.ts';
import { heightValue, parseHeight } from '../src/height-text.ts';
import { bandColor } from '../src/height-text.ts';

const sq = (x0: number, y0: number, x1: number, y1: number) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][], holes: [] });

/** A 10 ft ledge (2 up) along the north of a hall, a pit (2 down) in the middle: the plan's bands only (no draped pieces). */
const hs: SceneHeights = {
  bands: [
    { h: -2, polygons: [sq(6, 6, 10, 9)] },
    { h: 2, polygons: [sq(0, 0, 16, 3)] },
  ],
  base: [],
  edges: [{ points: [[0, 3], [16, 3]], closed: false, hi: 2, lo: 0, kind: 'cliff', run: 0 }],
};

/** A grid on the lattice (step 0.5) from post (i0, j0), heights from f(x, y), packed like core heightScene. */
function grid(i0: number, j0: number, cols: number, rows: number, f: (x: number, y: number) => number): SceneGrid {
  const z: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z.push(f((i0 + c) * 0.5, (j0 + r) * 0.5));
  const min = Math.min(...z);
  const max = Math.max(...z);
  const bytes = new Uint8Array(z.length * 2);
  z.forEach((v, k) => {
    const q = Math.round(((v - min) / (max - min || 1)) * 65535);
    bytes[k * 2] = q & 255;
    bytes[k * 2 + 1] = q >> 8;
  });
  return { i0, j0, cols, rows, min, max, z: Buffer.from(bytes).toString('base64') };
}

/**
 * Draped ground: a ramp east of x = 4 rising 1 per square from 0 to 2 (x 4 to 6),
 * a raised top at 2 from x = 6 to 10 with a cliff on its east side at x = 10
 * (the ground beyond at 0), and a pit at -2 from x 12 to 14.
 */
const draped: SceneHeights = {
  bands: [{ h: 2, polygons: [sq(6, 0, 10, 4)] }, { h: -2, polygons: [sq(12, 0, 14, 4)] }],
  base: [sq(0, 0, 4, 4), sq(10, 0, 12, 4), sq(14, 0, 16, 4)],
  edges: [],
  step: 0.5,
  pieces: [
    { polygons: [sq(4, 0, 10, 4)], h: 0, grid: grid(7, -1, 15, 11, (x) => Math.max(0, Math.min(2, x - 4))) },
    { polygons: [sq(12, 0, 14, 4)], h: -2 },
  ],
};
const at = (x: number, y: number) => surfaceAt(draped, x, y);

describe('3D heights: the plan', () => {
  it("finds the plan's height under a point", () => {
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

describe('3D heights: the draped ground', () => {
  it('reads the ground inside a piece, on its ramp and below it', () => {
    expect(at(2, 2)).toBe(0); // the plain ground
    expect(at(4.5, 2)).toBeCloseTo(0.5, 3); // on the ramp
    expect(at(5.25, 1.75)).toBeCloseTo(1.25, 3); // between the posts
    expect(at(8, 2)).toBeCloseTo(2, 3); // on top
    expect(at(11, 2)).toBe(0); // below the cliff
    expect(at(13, 2)).toBe(-2); // in the pit
    expect(pieceAt(draped, 8, 2)).toBe(0);
    expect(pieceAt(draped, 8, 2, 0)).toBe(-1);
  });

  it('cuts triangles along the lattice into cells, sharing every point with the neighbour', () => {
    const a: [number, number][] = [[0.1, 0.2], [2.3, 0.4], [1.2, 1.9]];
    const b: [number, number][] = [[2.3, 0.4], [1.2, 1.9], [2.6, 2.2]];
    const parts = latticeSplit(a, 0.5);
    const area = (p: [number, number][]) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * q[1], 0)) / 2;
    expect(parts.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(a), 9);
    for (const p of parts) {
      const cx = Math.floor(Math.min(...p.map((q) => q[0])) / 0.5 + 1e-9);
      const cy = Math.floor(Math.min(...p.map((q) => q[1])) / 0.5 + 1e-9);
      expect(p.every(([x, y]) => x <= (cx + 1) * 0.5 + 1e-12 && y <= (cy + 1) * 0.5 + 1e-12)).toBe(true);
    }
    // the shared edge's points, as each triangle cut it and as the face along it would be cut
    const onEdge = (pts: [number, number][]) => {
      const keys = new Set<string>();
      for (const [x, y] of pts) if (Math.abs((y - 0.4) * (1.2 - 2.3) - (x - 2.3) * (1.9 - 0.4)) < 1e-9) keys.add(`${x},${y}`);
      return [...keys].sort();
    };
    const fromA = onEdge(parts.flat());
    expect(fromA.length).toBeGreaterThan(4);
    expect(onEdge(latticeSplit(b, 0.5).flat())).toEqual(fromA);
    expect(onEdge(latticeSegment([2.3, 0.4], [1.2, 1.9], 0.5))).toEqual(fromA);
  });

  it('makes sheer faces where a piece stands above its neighbour, and for a pit from the ground above it', () => {
    const faces = pieceFaces(draped);
    const along = (x: number) => faces.filter((f) => f.corners.every((c) => Math.abs(c[0] - x) < 1e-9));
    // nothing along the ramp's foot at x = 4 (it starts at 0 there)
    expect(along(4)).toEqual([]);
    // the cliff at x = 10: 2 high, sheer (each top corner straight above its foot)
    const cliff = along(10);
    expect(cliff.reduce((s, f) => s + Math.abs(f.corners[1][2] - f.corners[0][2]), 0)).toBeCloseTo(4, 6);
    for (const f of cliff) {
      expect(f.corners[0][1]).toBeCloseTo(2, 3);
      expect(f.corners[3][1]).toBeCloseTo(-0.02, 6);
      expect([f.corners[0][0], f.corners[0][2]]).toEqual([f.corners[3][0], f.corners[3][2]]);
    }
    // the pit's west wall, made for the plain ground: from 0 down to its floor
    const pit = along(12);
    expect(pit.length).toBeGreaterThan(0);
    for (const f of pit) {
      expect(f.corners[0][1]).toBe(0);
      expect(f.corners[3][1]).toBeCloseTo(-2.02, 6);
    }
  });

  it('roughens a face only back into the higher ground, its foot and top staying put', () => {
    for (const f of pieceFaces(draped)) {
      const [left, right] = faceEdges(f);
      const sides = [
        [left, 0, f.corners[0], f.corners[3]],
        [right, 1, f.corners[1], f.corners[2]],
      ] as const;
      for (const [edge, end, top, foot] of sides) {
        expect(edge[0]).toEqual(foot);
        expect(edge[edge.length - 1]).toEqual(top);
        const inward = f.inward[end];
        for (const p of edge) {
          const dx = p[0] - top[0];
          const dz = p[2] - top[2];
          expect(dx * inward[0] + dz * inward[1]).toBeGreaterThanOrEqual(-1e-12); // never out over the low side
          expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(0.35 + 1e-9);
          if (inward[0] === 0 && inward[1] === 0) expect(Math.hypot(dx, dz)).toBe(0); // corners stay put
        }
      }
      expect(zipEdges(left, right)).toHaveLength(left.length + right.length - 2);
    }
  });

  it('finds where a ray meets the ground: on the ramp, and on the plain ground', () => {
    const hit = surfaceHit([5, 6, -2], [0, -0.8, 0.6], at, [-2, 2])!;
    expect(hit).not.toBeNull();
    // the hit is on the ground: the ray's height there matches the ground's
    const t = (hit[1] + 2) / 0.6;
    expect(hit[1]).toBeCloseTo(1.75, 2);
    expect(6 - 0.8 * t).toBeCloseTo(at(hit[0], hit[1]), 2);
    expect(surfaceHit([2, 5, 2], [0, -1, 0], at, [-2, 2])).toEqual([2, 2]);
    expect(surfaceHit([2, 5, 2], [0, 1, 0], () => 0)).toBeNull();
  });

  it('lays lines over the ground, broken at sheer drops', () => {
    const line = drapeLine([3, 2], [11, 2], at, 0.25);
    expect(line.every(([x, y, z]) => Math.abs(y - 0.01 - at(x, z)) < 1e-9)).toBe(true);
    // no piece of it hangs across the cliff at x = 10
    for (let i = 0; i < line.length; i += 2) expect(line[i]![0] < 10 - 1e-9 && line[i + 1]![0] > 10 + 1e-9).toBe(false);
  });

  it('stands stairs and walls on the ground', () => {
    // up the cliff at x = 10: from the ground below (0) to the top (2)
    expect(stairRise(draped, { x0: 9, y0: 1, x1: 11, y1: 3 }, 'w')).toEqual({ base: 0, rise: 2 });
    expect(stairsUp(draped, { x0: 9, y0: 1, x1: 11, y1: 3 }, 'e')).toBe('w');
    expect(wallBase(draped, [13, 4], [12, 4])).toBe(-2);
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
