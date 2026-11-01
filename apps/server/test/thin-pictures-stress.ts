// The PNG stress run for thin pictures (thin-pictures.test.ts runs it as a child
// process: a resvg panic aborts the whole process, so in the test runner itself
// it would kill the run without a word). resvg panics (geom.rs fit_to_rect,
// `unwrap` on `None`) when a group it draws on a layer of its own (opacity,
// clip-path, filter) lies wholly outside twice the picture's width and height
// from its top-left corner, or when such a group reaches past that limit and
// holds another one (docs/API.md, "resvg's layer limit"). Thin pictures make the limit tight.
// Draws, through the server's own code: the handout strip that killed the
// server (a sheet fitted to a 37 × 2 crop far off the map), fitted and paper
// sheets cut to thin strips on and off the map, the render route's thin frames,
// Quillwarren Table pages one or two squares thin (vision-render.ts) as the GM and as
// players, and all of these hugging a tree 18 squares across and a faded picture
// 30 × 20 (what the page shows is cut to it, but such things reach far past it).
// Prints one line per picture before drawing it, so a crash names its case;
// STRESS_FROM=n skips the first n (to find every case that dies).
import type { DelveMap, MapObject } from '@delve/core';
import { nothingExplored, type Explored, type Page } from '@delve/table';
import { addImageSource, svgToPng } from '../src/png.ts';
import { render, renderHandout } from '../src/render.ts';
import { VisionPictures } from '../src/table/vision-render.ts';

let seed = 9001;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/** The "Layered MAP" case: only its seed, name and unit matter, the crop misses everything on it. */
const layered: DelveMap = {
  format: 'delve.map',
  version: 1,
  id: 'thin-layered',
  name: 'Layered MAP',
  grid: { type: 'square', unit: '1 m' },
  seed: 248053257,
  objects: [{ id: 'r1', type: 'room', shape: { rect: [2, 2, 36, 20] } }],
};

const PICTURE = `${'a'.repeat(64)}.png`;

/** 80 × 45 squares of what draws as clipped or see-through groups: height tones and edges, stairs, terrain fades, a faded picture, big trees. */
function busy(s: number): DelveMap {
  const objects: MapObject[] = [
    { id: 't1', type: 'terrain', asset: 'c-ground-grass-short', shape: { rect: [0, 0, 80, 45] } },
    { id: 't2', type: 'terrain', asset: 'c-water-shallow', shape: { circle: [45, 30, 8] }, fadeWidth: 3 },
    { id: 't3', type: 'terrain', asset: 'c-ground-dirt', shape: { poly: [[0, 20], [80, 18], [80, 22], [0, 24]] } },
    { id: 'r1', type: 'room', shape: { rect: [2, 2, 20, 12] } },
    { id: 'r2', type: 'room', shape: { rect: [30, 20, 30, 20] } },
    { id: 's1', type: 'stairs', shape: { rect: [28, 9, 2, 2] }, direction: 'n' },
    { id: 's2', type: 'stairs', shape: { rect: [52, 36, 2, 3] }, direction: 's' },
    { id: 'h1', type: 'height', shape: { rect: [0, 0, 16, 3] }, height: 10 },
    { id: 'h2', type: 'height', shape: { circle: [50, 30, 6] }, height: 5, edge: 'slope' },
    { id: 'h3', type: 'height', shape: { rect: [62, 5, 10, 8] }, height: 20, edge: 'rock' },
    { id: 'i1', type: 'image', src: PICTURE, at: [70, 30], w: 6, h: 4, opacity: 0.6, rotation: 30 },
    { id: 'p1', type: 'prop', asset: 'c-oak-a', at: [40, 3], scale: 3 },
    { id: 'p2', type: 'prop', asset: 'c-oak-b', at: [10, 30], scale: 2 },
    { id: 'p3', type: 'prop', asset: 'table-round', at: [12, 8] },
    { id: 'l1', type: 'label', text: 'The long hall', at: [45, 25] },
  ];
  return { format: 'delve.map', version: 1, id: `thin-busy-${s}`, name: 'Thin busy', grid: { type: 'square' }, seed: s, objects, fog: { on: true, revealed: ['r1'] } };
}

/** A tree 18 squares across (y -6 to 12, x 31 to 49) and a faded, turned picture 30 × 20 over heights and stairs. */
const grove: DelveMap = {
  format: 'delve.map',
  version: 1,
  id: 'thin-grove',
  name: 'Thin grove',
  grid: { type: 'square' },
  seed: 3,
  objects: [
    { id: 't1', type: 'terrain', asset: 'c-ground-grass-short', shape: { rect: [0, 0, 80, 45] } },
    { id: 'r1', type: 'room', shape: { rect: [2, 12, 70, 20] } },
    { id: 'h1', type: 'height', shape: { rect: [0, 10, 80, 30] }, height: 10 },
    { id: 'h2', type: 'height', shape: { rect: [20, 0, 40, 9] }, height: 5, edge: 'slope' },
    { id: 's1', type: 'stairs', shape: { rect: [30, 8, 2, 2] }, direction: 'n' },
    { id: 'p1', type: 'prop', asset: 'c-oak-a', at: [40, 3], scale: 6 },
    { id: 'i1', type: 'image', src: PICTURE, at: [40, 20], w: 30, h: 20, opacity: 0.6, rotation: 30 },
  ],
};

type Box = { x0: number; y0: number; x1: number; y1: number };
/** A strip 1 or 2 squares thin, either way round, somewhere on or well off the map. */
function strip(): Box {
  const long = int(6, 60);
  const thin = int(1, 2);
  const across = rand() < 0.6;
  const x0 = int(-40, 110);
  const y0 = int(-20, 60);
  return across ? { x0, y0, x1: x0 + long, y1: y0 + thin } : { x0, y0, x1: x0 + thin, y1: y0 + long };
}
const q = (b: Box) => `${b.x0},${b.y0},${b.x1},${b.y1}`;

const cases: { label: string; run: () => Promise<Buffer> }[] = [];
const add = (label: string, run: () => Promise<Buffer | string>) => cases.push({ label, run: async () => Buffer.from(await run()) });

add('handout fit landscape dpi 50 crop 80,-1,117,1 (Layered MAP)', async () => (await renderHandout(layered, { paper: 'fit', orientation: 'landscape', dpi: '50', crop: '80,-1,117,1' }, 'png')).body);
for (let k = 0; k < 48; k++) {
  const map = busy(int(1, 1e9));
  const b = strip();
  const paper = k % 4 === 3 ? pick(['a4', 'a3', 'letter']) : 'fit';
  const orientation = pick(['auto', 'portrait', 'landscape']);
  const dpi = String(pick([50, 72, 96]));
  const revealed = rand() < 0.3 ? '1' : '0';
  add(`handout ${paper} ${orientation} dpi ${dpi}${revealed === '1' ? ' fog' : ''} seed ${map.seed} crop ${q(b)}`, async () => (await renderHandout(map, { paper, orientation, dpi, crop: q(b), revealed }, 'png')).body);
}
for (let k = 0; k < 16; k++) {
  const map = busy(int(1, 1e9));
  const b = strip();
  const view = pick(['gm', 'players']);
  const ppg = String(pick([10, 20, 70, 140]));
  add(`render ${view} ppg ${ppg} frame ${q(b)}`, async () => (await render(map, { view, fog: '1', grid: '0', ppg, frame: q(b) }, 'png')).body);
}
const pictures = new VisionPictures();
for (let k = 0; k < 24; k++) {
  const map = busy(int(1, 1e9));
  const b = strip();
  const view = k % 2 ? 'players' : 'gm';
  const page: Page = { id: `pg${k}`, name: 'Strip', origin: [b.x0, b.y0], width: b.x1 - b.x0, height: b.y1 - b.y0, cellPx: pick([8, 35, 70, 140]), cellUnit: '5 ft', showGrid: false, background: { kind: 'delve', mapId: map.id } };
  // players: nothing explored, everything, or a patch around the strip's middle
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const explored: Explored = pick<Explored>([
    nothingExplored(1),
    { version: 2, all: true, polys: [] },
    { version: 3, polys: [{ outer: [[cx - 6, cy - 6], [cx + 6, cy - 6], [cx + 6, cy + 6], [cx - 6, cy + 6]], holes: [] }] },
  ]);
  const seen = view === 'players' ? ` explored ${explored.all ? 'all' : explored.polys.length ? 'patch' : 'none'}` : '';
  add(`table page ${view} ${page.cellPx} px ${q(b)}${seen}`, () => pictures.png({ gameId: 'g1', page, map, mapRev: k, view, explored }));
}

// strips beside the big tree and across the big picture (each of these killed the server before png.ts roomFor)
const beside: [number, number, number, number][] = [
  [49, -5, 50, 12],
  [50, -5, 51, 12],
  [29, -5, 30, 12],
  [20, 9, 60, 10],
  [10, 30, 70, 31],
  [55, 5, 56, 40],
  [24, 24, 25, 60],
];
for (const [x0, y0, x1, y1] of beside) {
  const b = { x0, y0, x1, y1 };
  add(`grove handout fit ${q(b)}`, async () => (await renderHandout(grove, { paper: 'fit', dpi: '50', crop: q(b) }, 'png')).body);
  add(`grove render players ${q(b)}`, async () => (await render(grove, { view: 'players', grid: '0', ppg: '70', frame: q(b) }, 'png')).body);
  for (const view of ['gm', 'players'] as const) {
    const page: Page = { id: `grove-${q(b)}-${view}`, name: 'Strip', origin: [x0, y0], width: x1 - x0, height: y1 - y0, cellPx: 70, cellUnit: '5 ft', showGrid: false, background: { kind: 'delve', mapId: grove.id } };
    const explored: Explored = { version: 1, polys: [{ outer: [[x0 - 3, y0 - 3], [x1 + 3, y0 - 3], [x1 + 3, y1 + 3], [x0 - 3, y1 + 3]], holes: [] }] };
    add(`grove table page ${view} ${q(b)}`, () => pictures.png({ gameId: 'g2', page, map: grove, mapRev: 1, view, explored }));
  }
}

// the faded pictures: any small PNG
const tile = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#a33"/></svg>');
addImageSource((src) => (src === PICTURE ? tile : null));

const t0 = Date.now();
const from = Number(process.env.STRESS_FROM ?? 0);
let count = 0;
for (const [i, c] of cases.entries()) {
  if (i < from) continue;
  console.log(`${i} ${c.label}`);
  const png = await c.run();
  if (png.length < 60) throw new Error(`${c.label}: no picture`);
  count++;
}
console.log(`ok ${count} pictures in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
