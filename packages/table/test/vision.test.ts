// The line-of-sight geometry: visibility polygons among walls (closed rooms,
// doorways, pillars, collinear and touching walls, a viewer on a wall), circles,
// the polygon algebra, and how fast it is on a page of a few hundred walls.
import { describe, expect, it } from 'vitest';
import {
  anyPointIn,
  area,
  circle,
  difference,
  inflate,
  intersect,
  pointIn,
  rectSamples,
  ringArea,
  ringPoly,
  segmentStrips,
  simplify,
  union,
  visibilityPolygon,
  withWalls,
  type Box,
  type Poly,
  type Pt,
  type Seg,
} from '../src/index.ts';

/** The four walls of a rectangle. */
const room = (x0: number, y0: number, x1: number, y1: number): Seg[] => [
  [[x0, y0], [x1, y0]],
  [[x1, y0], [x1, y1]],
  [[x1, y1], [x0, y1]],
  [[x0, y1], [x0, y0]],
];
const BOX: Box = { x0: -50, y0: -50, x1: 50, y1: 50 };
const sees = (ring: Pt[], p: Pt) => pointIn(ringPoly(ring), p);
function square(x0: number, y0: number, x1: number, y1: number): Poly[] {
  const outer: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return [{ outer: ringArea(outer) < 0 ? outer.reverse() : outer, holes: [] }];
}

describe('visibilityPolygon', () => {
  it('sees exactly a closed room from inside it', () => {
    const ring = visibilityPolygon([3, 4], room(0, 0, 10, 8), BOX);
    expect(ringArea(ring)).toBeGreaterThan(0);
    expect(Math.abs(ringArea(ring))).toBeCloseTo(80, 3);
    expect(ring.length).toBe(4);
    expect(sees(ring, [9.9, 7.9])).toBe(true);
    expect(sees(ring, [10.1, 4])).toBe(false);
    expect(sees(ring, [-0.1, 4])).toBe(false);
  });

  it('is bounded by the box when there are no walls, and empty from outside it', () => {
    expect(Math.abs(ringArea(visibilityPolygon([0, 0], [], { x0: -2, y0: -3, x1: 4, y1: 5 })))).toBeCloseTo(48, 6);
    expect(visibilityPolygon([10, 10], [], { x0: -2, y0: -3, x1: 4, y1: 5 })).toEqual([]);
  });

  it('looks through a doorway into the next room, but not round its corners', () => {
    // two 10×10 rooms side by side; the shared wall x = 10 has a gap from y = 4 to 6
    const walls: Seg[] = [
      [[0, 0], [20, 0]],
      [[20, 0], [20, 10]],
      [[20, 10], [0, 10]],
      [[0, 10], [0, 0]],
      [[10, 0], [10, 4]],
      [[10, 6], [10, 10]],
    ];
    const ring = visibilityPolygon([5, 5], walls, BOX);
    expect(sees(ring, [15, 5])).toBe(true); // straight through
    expect(sees(ring, [19.5, 5.5])).toBe(true);
    expect(sees(ring, [12, 1])).toBe(false); // round the corner
    expect(sees(ring, [12, 9])).toBe(false);
    expect(sees(ring, [19, 1])).toBe(false);
    // the cone widens linearly: at x = 20 it spans 5 ± 1 * (15/5)
    expect(sees(ring, [19.9, 7.8])).toBe(true);
    expect(sees(ring, [19.9, 8.2])).toBe(false);
    // shut the door: the room is closed again
    const shut = visibilityPolygon([5, 5], [...walls, [[10, 4], [10, 6]]], BOX);
    expect(Math.abs(ringArea(shut))).toBeCloseTo(100, 3);
    expect(sees(shut, [15, 5])).toBe(false);
  });

  it('casts shadows behind pillars', () => {
    const walls = [...room(0, 0, 20, 20), ...room(9, 4, 11, 6)];
    const ring = visibilityPolygon([10, 15], walls, BOX);
    expect(sees(ring, [10, 2])).toBe(false); // right behind the pillar
    expect(sees(ring, [10, 3.9])).toBe(false);
    expect(sees(ring, [10, 6.5])).toBe(true); // in front of it
    expect(sees(ring, [5, 2])).toBe(true); // beside the shadow
    expect(sees(ring, [10, 5])).toBe(false); // inside the pillar
    // the shadow's edge runs from the eye past the pillar's corner (11, 6): at y = 1 it's at x = 10 + 14/9
    expect(sees(ring, [10 + 14 / 9 + 0.05, 1])).toBe(true);
    expect(sees(ring, [10 + 14 / 9 - 0.05, 1])).toBe(false);
  });

  it('has no crack where collinear walls meet end to end, even looking straight at the joint', () => {
    // the back wall comes in 4 collinear pieces; the eye looks exactly at the joints
    const walls: Seg[] = [
      [[0, 10], [2.5, 10]],
      [[2.5, 10], [5, 10]],
      [[5, 10], [7.5, 10]],
      [[7.5, 10], [10, 10]],
      [[10, 10], [10, 0]],
      [[10, 0], [0, 0]],
      [[0, 0], [0, 10]],
    ];
    for (const eye of [[5, 5], [2.5, 2], [7.5, 9.99]] as Pt[]) {
      const ring = visibilityPolygon(eye, walls, BOX);
      expect(Math.abs(ringArea(ring))).toBeCloseTo(100, 3);
      for (const x of [2.5, 5, 7.5]) expect(sees(ring, [x, 10.5])).toBe(false);
    }
  });

  it('has no crack at corners and T-junctions', () => {
    // an L of two walls meeting at (5, 5), eye looking straight at the corner from outside the L
    const corner: Seg[] = [
      [[0, 5], [5, 5]],
      [[5, 5], [5, 0]],
    ];
    const ring = visibilityPolygon([10, 10], corner, BOX);
    expect(sees(ring, [4, 4])).toBe(false); // behind the corner, on the line through it
    expect(sees(ring, [4.9, 4.9])).toBe(false);
    expect(sees(ring, [6, 6])).toBe(true);
    // a T: a wall ending on another wall's middle
    const t: Seg[] = [
      [[0, 5], [10, 5]],
      [[5, 5], [5, 10]],
    ];
    const ring2 = visibilityPolygon([2, 8], t, BOX);
    expect(sees(ring2, [8, 8])).toBe(false); // the stem hides the other side
    expect(sees(ring2, [2, 2])).toBe(false); // the top hides the far side
    expect(sees(ring2, [4.5, 6])).toBe(true);
  });

  it('hides nothing behind a wall seen edge-on, and sees one side only from on a wall', () => {
    // a wall along y = 5 from x = 5 to 10; the eye is on its line
    const wall: Seg[] = [[[5, 5], [10, 5]]];
    const ring = visibilityPolygon([0, 5], wall, BOX);
    expect(sees(ring, [12, 5.01])).toBe(true);
    expect(sees(ring, [12, 4.99])).toBe(true);
    expect(sees(ring, [7, 6])).toBe(true);
    // standing exactly on a wall between two rooms: one room, never both
    const walls = [...room(0, 0, 20, 10), [[10, 0], [10, 10]] as Seg];
    const on = visibilityPolygon([10, 5], walls, BOX);
    const left = sees(on, [5, 5]);
    const right = sees(on, [15, 5]);
    expect(left !== right).toBe(true);
    expect(Math.abs(ringArea(on))).toBeCloseTo(100, 1);
    // and from a wall's corner
    const corner = visibilityPolygon([10, 10], walls, BOX);
    expect(sees(corner, [5, 5]) && sees(corner, [15, 5])).toBe(false);
  });

  it('stops at the nearest wall when walls overlap or cross', () => {
    const walls: Seg[] = [
      ...room(0, 0, 10, 10),
      [[2, 7], [8, 7]],
      [[3, 7], [6, 7]], // drawn twice, partly
      [[5, 6], [5, 9]], // crossing it
    ];
    const ring = visibilityPolygon([5, 2], walls, BOX);
    expect(sees(ring, [5.2, 6.9])).toBe(true);
    expect(sees(ring, [5, 7.5])).toBe(false);
    expect(sees(ring, [4, 8])).toBe(false);
  });

  it('stays fast: 300 walls and 6 viewers well under 20 ms', () => {
    // a 10×6 grid of 6×6 rooms with door gaps: 300 wall segments (+ the outer frame)
    const walls: Seg[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 6; j++) {
        const x = i * 6;
        const y = j * 6;
        walls.push([[x, y], [x + 2.5, y]], [[x + 3.5, y], [x + 6, y]], [[x, y], [x, y + 2.5]], [[x, y + 3.5], [x, y + 6]]);
        walls.push([[x + 2, y + 2], [x + 3, y + 2]]); // a bit of rubble in each room
      }
    }
    expect(walls.length).toBe(300);
    const box: Box = { x0: -2, y0: -2, x1: 62, y1: 38 };
    const eyes: Pt[] = [[3, 3], [27, 15], [45, 33], [9.5, 20], [51, 3], [33.2, 27.7]];
    // warm up the JIT once, then time a full round (polygons, union)
    const round = () => union(...eyes.map((e) => ringPoly(visibilityPolygon(e, walls, box))));
    round();
    // the best of a few rounds, so other test files running alongside don't count
    let ms = Infinity;
    let seen: Poly[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      seen = round();
      ms = Math.min(ms, performance.now() - t0);
    }
    console.log(`vision: 300 walls × 6 viewers + union: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
    expect(area(seen)).toBeGreaterThan(36 * 6);
  });
});

describe('polygon algebra', () => {
  it('unions, intersects and subtracts, with holes', () => {
    const a = square(0, 0, 4, 4);
    const b = square(2, 2, 6, 6);
    expect(area(union(a, b))).toBeCloseTo(28, 6);
    expect(area(intersect(a, b))).toBeCloseTo(4, 6);
    expect(area(difference(a, b))).toBeCloseTo(12, 6);
    const ring = difference(square(0, 0, 10, 10), square(4, 4, 6, 6));
    expect(ring).toHaveLength(1);
    expect(ring[0]!.holes).toHaveLength(1);
    expect(pointIn(ring, [5, 5])).toBe(false);
    expect(pointIn(ring, [1, 1])).toBe(true);
    // a hole survives a round trip through another union
    expect(area(union(ring, square(20, 20, 21, 21)))).toBeCloseTo(97, 6);
    expect(intersect([], a)).toEqual([]);
    expect(union()).toEqual([]);
  });

  it('makes circles that lie just inside the real one', () => {
    const c = circle([3, 4], 5);
    expect(Math.abs(ringArea(c))).toBeLessThan(Math.PI * 25);
    expect(Math.abs(ringArea(c))).toBeGreaterThan(Math.PI * 25 * 0.99);
    expect(c.every(([x, y]) => Math.abs(Math.hypot(x - 3, y - 4) - 5) < 1e-9)).toBe(true);
    expect(circle([0, 0], 0)).toEqual([]);
  });

  it('simplifies and rounds without losing area', () => {
    const many = ringPoly(circle([0, 0], 20));
    const s = simplify(many, 0.05, 2);
    expect(s[0]!.outer.length).toBeLessThan(many[0]!.outer.length);
    expect(Math.abs(area(s) - area(many))).toBeLessThan(0.05 * 2 * Math.PI * 20);
    expect(s[0]!.outer.every(([x, y]) => Math.round(x * 100) / 100 === x && Math.round(y * 100) / 100 === y)).toBe(true);
    expect(area(inflate(square(0, 0, 2, 2), 1))).toBeCloseTo(4 + 8 + Math.PI, 1);
  });

  it('samples footprints inside their edges, so touching a region is not overlapping it', () => {
    const seen = square(0, 0, 5, 5);
    expect(anyPointIn(seen, rectSamples(5, 2, 1, 1))).toBe(false); // right next to it
    expect(anyPointIn(seen, rectSamples(4.85, 2, 1, 1))).toBe(false); // 0.15 over the edge
    expect(anyPointIn(seen, rectSamples(4.5, 2, 1, 1))).toBe(true);
    expect(anyPointIn(seen, rectSamples(6, 2, 1, 1, 45))).toBe(false);
    expect(anyPointIn(seen, rectSamples(-0.3, -0.3, 1, 1, 45))).toBe(true);
  });

  it('adds the drawn walls at the edge of a region, and only those', () => {
    const walls: Seg[] = [...room(0, 0, 10, 10), [[30, 0], [30, 10]]];
    const strips = segmentStrips(walls, 0.15);
    const inside = square(0, 0, 10, 10);
    const drawn = withWalls(inside, strips, 0.2);
    expect(pointIn(drawn, [10.1, 5])).toBe(true); // the wall's far half
    expect(pointIn(drawn, [10.3, 5])).toBe(false); // not the rock beyond
    expect(pointIn(drawn, [30, 5])).toBe(false); // a wall far away
    expect(area(drawn)).toBeLessThan(100 + 4 * 10.3 * 0.15 + 1);
  });
});
