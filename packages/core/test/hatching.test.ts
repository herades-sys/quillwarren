// Hatching on big maps: the fast inside test agrees with the plain one point for
// point, and a city of 700 houses builds its classic scene in well under the
// minutes it used to take (which froze the server and the editor).
import { describe, expect, it } from 'vitest';
import { buildScene, resolveStyle, validateMap, type DelveMap } from '../src/index.ts';
import { floorPaths } from '../src/geometry/floor.ts';
import { insidePaths, insideTester, outsideBand } from '../src/render/hatching.ts';
import { rng } from '../src/render/rng.ts';
import { testMap } from './fixtures.ts';

/** Houses spread over 285 × 175 squares, like a Watabou city: seeded, so every run is the same. */
function city(houses: number): DelveMap {
  const r = rng(7);
  const objects = Array.from({ length: houses }, (_, i) => ({
    id: `r${i + 1}`,
    type: 'room' as const,
    shape: { rect: [Math.floor(r() * 280), Math.floor(r() * 170), 2 + Math.floor(r() * 5), 2 + Math.floor(r() * 4)] as [number, number, number, number] },
  }));
  return validateMap({ ...testMap(), name: 'City', objects });
}

describe('hatching on big maps', () => {
  it('tests points exactly like insidePaths, also right on the edges', () => {
    const map = city(60);
    const band = outsideBand(floorPaths(map), 1.2);
    const test = insideTester(band, 2);
    const r = rng(11);
    const points: [number, number][] = Array.from({ length: 20000 }, () => [r() * 290 - 2, r() * 180 - 2]);
    // points on and within a hair of the band's edges, where the fast test hands over to Clipper
    for (const ring of band.slice(0, 40)) for (const p of ring) points.push([p.x, p.y], [p.x + 0.004, p.y - 0.003]);
    for (const [x, y] of points) expect(test.inside(x, y), `${x}, ${y}`).toBe(insidePaths(band, x, y));
  });

  it('builds a 700-house city in the classic style in seconds, not minutes', () => {
    const map = city(700);
    const t = performance.now();
    const scene = buildScene({ ...map, style: { preset: 'classic-hatching' } }, { view: 'players' }, resolveStyle({ ...map, style: { preset: 'classic-hatching' } }));
    const ms = performance.now() - t;
    const hatching = scene.layers.find((l) => l.name === 'hatching');
    expect(hatching && hatching.kind === 'stroke' ? hatching.lines.length : 0).toBeGreaterThan(100000);
    expect(ms).toBeLessThan(5000); // about half a second on the dev container; it was about five minutes
  });
});
