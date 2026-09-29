import { describe, expect, it } from 'vitest';
import { intersect, startView, storeyHeights, texturePpg, unionOf, wallBox } from '../src/stack-logic.ts';

describe('3D view logic', () => {
  it('stacks storeys bottom-up by order, whatever the numbers are', () => {
    const h = storeyHeights([{ id: 'top', order: 5 }, { id: 'ground', order: 0 }, { id: 'cellar', order: -3 }], 7);
    expect([...h]).toEqual([['cellar', 0], ['ground', 7], ['top', 14]]);
  });

  it('keeps floor pictures sharp but inside the texture limit', () => {
    expect(texturePpg({ x0: 0, y0: 0, x1: 38, y1: 39 })).toBe(48);
    expect(texturePpg({ x0: 0, y0: 0, x1: 200, y1: 50 })).toBe(20);
    expect(texturePpg({ x0: 0, y0: 0, x1: 1000, y1: 5 })).toBe(10);
  });

  it('lays a wall box along its segment', () => {
    expect(wallBox([[0, 0], [4, 0]], 0.2)).toEqual({ x: 2, z: 0, length: 4.2, angle: -0 });
    const v = wallBox([[3, 1], [3, 5]], 0.2);
    expect([v.x, v.z, v.length]).toEqual([3, 3, 4.2]);
    expect(v.angle).toBeCloseTo(-Math.PI / 2);
  });

  it('works out overall bounds, overlaps and a starting camera', () => {
    const u = unionOf([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: -2, y0: 5, x1: 8, y1: 20 }]);
    expect(u).toEqual({ x0: -2, y0: 0, x1: 10, y1: 20 });
    expect(unionOf([])).toBeNull();
    expect(intersect({ x0: 0, y0: 0, x1: 4, y1: 4 }, { x0: 2, y0: 3, x1: 6, y1: 9 })).toEqual({ x0: 2, y0: 3, x1: 4, y1: 4 });
    expect(intersect({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 0, x1: 2, y1: 1 })).toBeNull();
    const v = startView(u!, 14);
    expect(v.target).toEqual([4, 7, 10]);
    expect(v.position[1]).toBeGreaterThan(14);
  });
});
