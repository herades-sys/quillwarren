// Rooms and pillars in other shapes: boxes to shapes, and freehand strokes to tidy polygons.
import { describe, expect, it } from 'vitest';
import { dragBox, freehandShape, OVAL_POINTS, shapeArea, shapeBounds, shapeFromBox, shapeFromDrag, validateMap, type Point, type Shape } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const polyOf = (s: Shape | null): Point[] => (s && 'poly' in s ? s.poly : []);

describe('shapeFromBox', () => {
  const box: [number, number, number, number] = [2, 4, 6, 4];

  it('keeps rect and circle as their own shapes', () => {
    expect(shapeFromBox('rect', box)).toEqual({ rect: [2, 4, 6, 4] });
    // a circle takes the shorter side, centred in the box
    expect(shapeFromBox('circle', box)).toEqual({ circle: [5, 6, 2] });
  });

  it('draws an oval of 40 points that fills the box', () => {
    const pts = polyOf(shapeFromBox('oval', box));
    expect(pts).toHaveLength(OVAL_POINTS);
    expect(pts[0]).toEqual([5, 4]); // starts at the top
    expect(shapeBounds({ poly: pts })).toEqual({ x0: 2, y0: 4, x1: 8, y1: 8 });
    expect(pts.flat().every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6)).toBe(true); // rounded to 0.01
    // close to the ellipse's area π·a·b
    expect(shapeArea({ poly: pts })).toBeCloseTo(Math.PI * 3 * 2, 0);
  });

  it('draws a triangle, a flat-topped hexagon and an octagon inside the box', () => {
    expect(polyOf(shapeFromBox('triangle', box))).toEqual([[5, 4], [8, 8], [2, 8]]);
    expect(polyOf(shapeFromBox('hexagon', [0, 0, 4, 4]))).toEqual([[1, 0], [3, 0], [4, 2], [3, 4], [1, 4], [0, 2]]);
    const oct = polyOf(shapeFromBox('octagon', [0, 0, 4, 4]));
    expect(oct).toHaveLength(8);
    expect(oct[0]).toEqual([1.17, 0]); // a regular octagon's corner cut: 4 / (2 + √2)
    expect(shapeBounds({ poly: oct })).toEqual({ x0: 0, y0: 0, x1: 4, y1: 4 });
  });

  it('makes shapes that a map accepts', () => {
    const map = testMap();
    const kinds = ['rect', 'circle', 'oval', 'triangle', 'hexagon', 'octagon'] as const;
    map.objects.push(...kinds.map((k, i) => ({ id: `z${i}`, type: 'room' as const, shape: shapeFromBox(k, [40 + i * 8, 0, 6, 4]) })));
    expect(() => validateMap(map)).not.toThrow();
  });
});

describe('dragBox and shapeFromDrag', () => {
  it('spans the drag either way round', () => {
    expect(dragBox([5, 5], [2, 7])).toEqual([2, 5, 3, 2]);
  });

  it('keeps width and height equal when regular, growing the way the drag goes', () => {
    expect(dragBox([5, 5], [2, 7], true)).toEqual([2, 5, 3, 3]);
    expect(dragBox([5, 5], [6, 1], true)).toEqual([5, 1, 4, 4]);
  });

  it('skips drags smaller than the snap, and always makes circles round', () => {
    expect(shapeFromDrag('hexagon', [0, 0], [3, 0.5])).toBeNull();
    expect(shapeFromDrag('rect', [0, 0], [3, 2])).toEqual({ rect: [0, 0, 3, 2] });
    expect(shapeFromDrag('rect', [0, 0], [3, 2], { regular: true })).toEqual({ rect: [0, 0, 3, 3] });
    expect(shapeFromDrag('circle', [0, 0], [4, 2])).toEqual({ circle: [2, 2, 2] });
  });
});

describe('freehandShape', () => {
  /** A wobbly hand-drawn loop around the 4×3 box at (1, 1). */
  const loop = (): Point[] => {
    const pts: Point[] = [];
    const corners: Point[] = [[1, 1], [5, 1], [5, 4], [1, 4]];
    for (let c = 0; c < 4; c++) {
      const a = corners[c]!;
      const b = corners[(c + 1) % 4]!;
      for (let t = 0; t < 1; t += 0.05) pts.push([a[0] + (b[0] - a[0]) * t + Math.sin(t * 40) * 0.04, a[1] + (b[1] - a[1]) * t + Math.cos(t * 30) * 0.04]);
    }
    return pts;
  };

  it('closes, simplifies and snaps a stroke to quarter squares', () => {
    const pts = polyOf(freehandShape(loop()));
    expect(pts.length).toBe(4);
    expect(new Set(pts.map((p) => p.join(',')))).toEqual(new Set(['1,1', '5,1', '5,4', '1,4']));
    expect(pts.flat().every((v) => Number.isInteger(v * 4))).toBe(true);
  });

  it('keeps a real curve as more corners', () => {
    const circle: Point[] = Array.from({ length: 120 }, (_, i) => [10 + 3 * Math.cos((i / 120) * 2 * Math.PI), 10 + 3 * Math.sin((i / 120) * 2 * Math.PI)]);
    const pts = polyOf(freehandShape(circle));
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(shapeArea({ poly: pts })).toBeGreaterThan(24);
    expect(shapeArea({ poly: pts })).toBeLessThan(30);
  });

  it('ignores strokes with fewer than 3 distinct points or next to no area', () => {
    expect(freehandShape([])).toBeNull();
    expect(freehandShape([[1, 1], [1, 1], [2, 2], [2, 2]])).toBeNull();
    expect(freehandShape([[0, 0], [3, 0], [0, 0]])).toBeNull(); // there and back: no area
    expect(freehandShape([[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]])).toBeNull(); // tiny
  });
});
