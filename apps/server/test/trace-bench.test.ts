// The picture tracer against pictures with a known answer: Delve maps rendered
// by the server's own renderer (the benchmark's cases, see cli/trace-bench-lib.ts),
// traced the way the trace page does by default. `npm run trace-bench` runs the
// whole set and prints the table.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analysePicture, buildScene, coloursForMode, computeFloor, fromWatabou, resolveStyle, sceneToSvg, traceImage, tracedMap, type DelveMap } from '@delve/core';
import { decodePng, svgToPng } from '../src/png.ts';
import { benchMaps, rasterize, ringsOf, renderCase, score, type BenchCase } from '../src/cli/trace-bench-lib.ts';


/** Trace a rendered case as the page does: the analysis's mode, roles and grid. */
async function traced(c: Omit<BenchCase, 'rooms'> & { rooms?: number }) {
  const pic = await renderCase({ rooms: 0, ...c });
  const a = analysePicture(pic.rgba, pic.width, pic.height);
  const g = a.grid ?? a.wallGrid;
  const s = g ? g.cell : (a.wallScale ?? 12);
  const origin: [number, number] = g ? g.offset : [0, 0];
  const result = traceImage({ ...pic, colours: a.colours.map((x) => x.colour), roles: a.roles, space: a.space, mode: a.mode, pxPerSquare: s, origin, printedGrid: Boolean(a.grid) });
  const map = tracedMap(result, { id: 'map_bench', name: 'bench' });
  return { pic, a, result, map, score: score(pic, map, { pxPerSquare: s, origin: [-origin[0] / s, -origin[1] / s] }, c.rooms ?? 0, 0) };
}

const maps = Object.fromEntries(benchMaps().map((m) => [m.map.id, m]));
const pick = (id: string) => maps[id]!;

describe('tracing rendered dungeons (the benchmark, a fast subset)', () => {
  const cases: [string, string, string, number, Partial<BenchCase>][] = [
    ['the test dungeon, hatched', 'map_test4p', 'classic-hatching', 50, {}],
    ['the test dungeon, clean, small', 'map_test4p', 'clean', 30, {}],
    ['the test dungeon, blue, noisy', 'map_test4p', 'old-school-blue', 50, { variant: 'noisy' }],
    ['round rooms, a dot grid', 'map_round', 'print', 50, {}],
    ['pillars, room numbers', 'map_pillars', 'clean', 50, { view: 'gm' }],
    ['shared thin walls', 'map_shared', 'classic-hatching', 40, {}],
  ];
  for (const [name, id, style, ppg, more] of cases) {
    it(`${name}: floor IoU ≥ 0.95, grid scale within 2 %, rooms about right`, async () => {
      const m = pick(id);
      const t = await traced({ map: m.map, rooms: m.rooms, style, ppg, grid: true, view: 'players', variant: 'clean', ...more });
      expect(t.a.mode).toBe('dungeon');
      expect(t.a.grid).not.toBeNull();
      expect(t.score.iou).toBeGreaterThanOrEqual(0.95);
      expect(t.score.scaleErr).toBeLessThanOrEqual(0.02);
      expect(Math.abs(t.score.rooms - m.rooms)).toBeLessThanOrEqual(2);
    });
  }

  it('without a grid it still finds the floor, and the scale from the lattice the walls stand on', async () => {
    const m = pick('map_test4p');
    const t = await traced({ map: m.map, rooms: m.rooms, style: 'parchment', ppg: 50, grid: false, view: 'players', variant: 'clean' });
    expect(t.a.grid).toBeNull();
    expect(t.score.iou).toBeGreaterThanOrEqual(0.95);
    expect(t.a.wallGrid).not.toBeNull();
    expect(t.score.scaleErr).toBeLessThanOrEqual(0.02);
  });
});

describe('tracing a rendered city (city mode keeps its behaviour)', () => {
  it('finds the buildings of the Feyvale import drawn by Delve', async () => {
    const feyvale = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/watabou/feyvale.json', import.meta.url)), 'utf8'));
    const { map } = fromWatabou(feyvale, { id: 'map_feyvale_t', name: 'Feyvale', style: 'old-school-blue' });
    const city: DelveMap = { ...map, style: { preset: 'old-school-blue' } };
    const ppg = 8;
    const scene = buildScene(city, { view: 'players', grid: false }, resolveStyle(city));
    const pic = decodePng(await svgToPng(sceneToSvg(scene, { ppg })));
    // flat colours, so the city tracer's own colours and roles (white buildings on the blue ground)
    expect(analysePicture(pic.rgba, pic.width, pic.height).painted).toBe(false);
    const a = coloursForMode(pic.rgba, pic.width, pic.height, 'city');
    expect(a.space).toBe('rgb');
    const result = traceImage({ ...pic, colours: a.colours.map((x) => x.colour), roles: a.roles, space: a.space, mode: 'city', pxPerSquare: ppg });
    // the floor as Delve has it, against the traced buildings, both in picture pixels
    const truth = rasterize(ringsOf(computeFloor(city)).map((r) => r.map(([x, y]) => [(x - scene.bounds.x0) * ppg, (y - scene.bounds.y0) * ppg] as const)), pic.width, pic.height);
    const got = rasterize(ringsOf(computeFloor(tracedMap(result, { id: 'map_feyvale_u', name: 'F' }))).map((r) => r.map(([x, y]) => [x * ppg, y * ppg] as const)), pic.width, pic.height);
    let inter = 0;
    let union = 0;
    for (let i = 0; i < truth.length; i++) {
      inter += truth[i]! & got[i]!;
      union += truth[i]! | got[i]!;
    }
    expect(inter / union).toBeGreaterThan(0.85);
    const blocks = computeFloor(city).length;
    expect(result.counts.building).toBeGreaterThan(blocks * 0.8);
  });
});
