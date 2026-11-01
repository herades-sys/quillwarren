// resvg's layer limit (docs/API.md, "resvg's layer limit"): a picture a square or two thin
// with something reaching far past it made resvg panic, which aborts the whole
// server. One GET did it: a handout fitted to a 37 × 2 crop off the map
// (/api/v1/maps/<id>/handout.png?paper=fit&orientation=landscape&dpi=50&crop=80,-1,117,1).
// Covered here: png.ts drawing such a picture on a bigger canvas and cutting it
// back out (the same pixels), Quillwarren Table pages cut to their frame, and the
// stress run (thin-pictures-stress.ts) in a child process, so a panic shows up
// as a failed test instead of silently killing the test runner.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { handoutSvg, type DelveMap, type MapObject } from '@delve/core';
import type { Page } from '@delve/table';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, PictureTooBigError, pngSize, roomFor, svgToPng } from '../src/png.ts';
import { visionSvg } from '../src/table/vision-render.ts';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/**
 * How two PNGs of the same size differ: the largest difference of a channel, and
 * the share of channel values that differ at all. Drawn further from the canvas's
 * corner, resvg puts the odd anti-aliased edge pixel a few levels lighter or
 * darker; a picture moved by a pixel or drawn at another scale differs everywhere.
 */
function pixelDiff(a: Buffer, b: Buffer): { most: number; share: number } {
  const pa = decodePng(a);
  const pb = decodePng(b);
  expect([pa.width, pa.height]).toEqual([pb.width, pb.height]);
  let most = 0;
  let differ = 0;
  for (let i = 0; i < pa.rgba.length; i++) {
    const d = Math.abs(pa.rgba[i]! - pb.rgba[i]!);
    most = Math.max(most, d);
    if (d) differ++;
  }
  return { most, share: differ / pa.rgba.length };
}
const same = (d: { most: number; share: number }) => {
  expect(d.most).toBeLessThanOrEqual(8);
  expect(d.share).toBeLessThan(0.001);
};

describe('resvg layer limit (png.ts roomFor)', () => {
  it('leaves pictures alone whose content stays within twice their size', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>';
    expect(roomFor(svg, box(0, 0, 20, 10))).toBeNull();
    expect(roomFor(svg, box(-9, -4, 29, 14))).toBeNull(); // 290 × 140 px with the picture: under 2 × 200 and 2 × 100
    expect(roomFor(svg, undefined)).toBeNull();
    // not one of ours (no px size): drawn as it is
    expect(roomFor('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"></svg>', box(-500, 0, 10, 10))).toBeNull();
  });

  it('gives a thin picture with something far off it a canvas around all of it, at the same scale', () => {
    // 40 squares × 1 at 70 px, with a tree reaching 14 squares above it (a Quillwarren Table page one square high)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2800" height="70" viewBox="20 9 40 1"><rect x="20" y="9" width="40" height="1"/></svg>';
    const room = roomFor(svg, box(19.5, -5, 41, 15))!;
    expect(room).not.toBeNull();
    expect(room.width).toBe(2800);
    expect(room.height).toBe(70);
    // the picture's top-left is 14 squares (980 px) and the slack down from the canvas's
    expect(room.y).toBe(980 + 4);
    expect(room.x).toBe(35 + 4);
    const tag = /<svg[^>]*>/.exec(room.svg)![0];
    const [w, h] = [Number(/ width="(\d+)"/.exec(tag)![1]), Number(/ height="(\d+)"/.exec(tag)![1])];
    const vb = / viewBox="([^"]+)"/.exec(tag)![1]!.split(' ').map(Number);
    expect(w / vb[2]!).toBeCloseTo(70, 9);
    expect(h / vb[3]!).toBeCloseTo(70, 9);
    expect(room.svg.endsWith('<rect x="20" y="9" width="40" height="1"/></svg>')).toBe(true);
  });

  it('refuses a canvas past the render limits rather than drawing it', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 1 1"></svg>';
    expect(() => roomFor(svg, box(-200, -200, 400, 400))).toThrow(PictureTooBigError);
  });

  it('draws a picture on its bigger canvas pixel for pixel as it would be drawn on its own', async () => {
    // something plain far off the picture (no layer of its own, so resvg draws it either way without panicking)
    const far = (d: string) => `<path d="${d}" fill="red"/></svg>`;
    const scene =
      '<svg xmlns="http://www.w3.org/2000/svg" width="433" height="61" viewBox="2.5 1 31 4.37">' +
      '<rect x="2.5" y="1" width="31" height="4.37" fill="#e8d5a8"/>' +
      '<circle cx="9" cy="3" r="1.7" fill="#2e1f11" fill-opacity="0.35"/>' +
      '<path d="M3 1.5 L33 4.9" stroke="#6b4520" stroke-width="0.12" opacity="0.6"/>' +
      '<text x="20" y="4" font-size="1.4">Quillwarren</text></svg>';
    const plain = await svgToPng(scene);
    const moved = await svgToPng(scene.replace('</svg>', far('M-40 2h1v1h-1z'))); // 600 px left of a picture 433 px wide
    expect(roomFor(scene.replace('</svg>', far('M-40 2h1v1h-1z')), box(-40, 1, 73.5, 4.37))).not.toBeNull();
    expect(pngSize(moved)).toEqual({ width: 433, height: 61 });
    expect(pixelDiff(plain, moved)).toEqual({ most: 0, share: 0 });
    // a handout sheet: its px size is rounded each way, so the sheet is centred in it (preserveAspectRatio)
    const map: DelveMap = { format: 'delve.map', version: 1, id: 'sheet', name: 'Sheet', grid: { type: 'square' }, seed: 3, objects: [{ id: 'r1', type: 'room', shape: { rect: [0, 0, 9, 2] } }] };
    const sheet = handoutSvg(map, { paper: 'fit', dpi: 50 }).svg;
    expect(roomFor(sheet.replace(/<\/svg>$/, far('M-500 -300h10v10h-10z')), box(-500, -300, 700, 500))).not.toBeNull();
    same(pixelDiff(await svgToPng(sheet), await svgToPng(sheet.replace(/<\/svg>$/, far('M-500 -300h10v10h-10z')))));
    // see-through on a see-through picture: resvg's pixels are premultiplied, the PNG's are not
    const glass =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 4 2"><circle cx="1" cy="1" r="0.8" fill="#ff8000" fill-opacity="0.3"/>' +
      '<rect x="2.2" y="0.2" width="1.5" height="1.5" fill="#3366cc" opacity="0.7"/></svg>';
    same(pixelDiff(await svgToPng(glass), await svgToPng(glass.replace('</svg>', far('M-30 1h1v1h-1z')))));
  });

  it('writes PNGs that read back the same', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) % 256);
    const back = decodePng(encodePng(3, 2, rgba));
    expect([back.width, back.height]).toEqual([3, 2]);
    expect([...back.rgba]).toEqual([...rgba]);
  });
});

describe('Quillwarren Table pages', () => {
  it('are cut to the page before drawing (core cropScene), like the render route', () => {
    const objects: MapObject[] = [
      { id: 'r1', type: 'room', shape: { rect: [0, 0, 60, 40] } },
      { id: 's1', type: 'stairs', shape: { rect: [28, 30, 2, 3] }, direction: 'n' },
      { id: 'h1', type: 'height', shape: { rect: [5, 20, 30, 10] }, height: 10 },
    ];
    const map: DelveMap = { format: 'delve.map', version: 1, id: 'strip', name: 'Strip', grid: { type: 'square' }, seed: 1, objects };
    const page = (origin: [number, number], width: number, height: number): Page => ({ id: 'p1', name: 'Strip', origin, width, height, cellPx: 70, cellUnit: '5 ft', showGrid: false, background: { kind: 'delve', mapId: 'strip' } });
    const input = (p: Page) => ({ gameId: 'g1', page: p, map, mapRev: 1, view: 'gm' as const, explored: { version: 0, polys: [] } });
    const strip = visionSvg(input(page([10, 2], 40, 1)));
    const whole = visionSvg(input(page([0, 0], 60, 40)));
    expect(strip.length).toBeLessThan(whole.length / 10);
    // the stairs and the height, many squares below the strip, are left out (their clips are empty)
    expect(strip).toMatch(/<clipPath id="clip-stairs-s1"><path d=""/);
    expect(strip).not.toContain('data-layer="height-tone:h1"');
  });
});

describe('thin pictures', () => {
  it('draws the handout strip that killed the server, thin sheets, frames and Table pages without resvg panicking', () => {
    const script = resolve(import.meta.dirname, 'thin-pictures-stress.ts');
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 240_000 });
    const lines = run.stdout.trim().split('\n');
    // a panic aborts the child (SIGABRT): name the picture it died on
    expect(run.signal, `resvg died on "${lines.at(-1)}": ${run.stderr.slice(-500)}`).toBeNull();
    expect(run.status, run.stderr.slice(-1000)).toBe(0);
    expect(lines.at(-1)).toMatch(/^ok \d+ pictures/);
    expect(Number(/^ok (\d+)/.exec(lines.at(-1)!)![1])).toBe(117);
  }, 300_000);
});
