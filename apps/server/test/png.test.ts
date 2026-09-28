import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildScene, sceneToSvg, validateMap } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { pngSize, svgToPng } from '../src/png.ts';

const map = validateMap(
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')),
);

describe('svgToPng', () => {
  it('renders the test dungeon at Roll20 size (70 px per square)', async () => {
    const scene = buildScene(map);
    const png = await svgToPng(sceneToSvg(scene, { ppg: 70 }));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngSize(png)).toEqual({
      width: (scene.bounds.x1 - scene.bounds.x0) * 70,
      height: (scene.bounds.y1 - scene.bounds.y0) * 70,
    });
  });

  it('renders the same bytes every time', async () => {
    const svg = sceneToSvg(buildScene(map), { ppg: 20 });
    expect((await svgToPng(svg)).equals(await svgToPng(svg))).toBe(true);
  });
});
