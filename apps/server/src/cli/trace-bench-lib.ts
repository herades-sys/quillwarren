// The picture tracer's benchmark: Delve maps rendered to PNG with the server's
// own renderer (so the right answer is known), traced back, and scored.
// Used by `npm run trace-bench` (cli/trace-bench.ts) and apps/server/test/trace-bench.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  buildScene,
  downscale,
  drawnFloor,
  PRESETS,
  resolveStyle,
  sceneToSvg,
  shapeFromBox,
  validateMap,
  type DelveMap,
  type MapObject,
  type Polygon,
} from '@delve/core';
import { assets } from '../assets.ts';
import { decodePng, svgToPng } from '../png.ts';

export const BENCH_STYLES = Object.keys(PRESETS);

const base = (id: string, name: string, objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap =>
  validateMap({ format: 'delve.map', version: 1, id, name, grid: { type: 'square', unit: '5 ft' }, seed: 77, objects, ...extra });

/** The maps, each with how many rooms (rooms, corridors, closets) a person would count in it. */
export function benchMaps(): { map: DelveMap; rooms: number }[] {
  const fixture = validateMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../../../fixtures/test-map-4p.delve.json', import.meta.url)), 'utf8')));
  const round = base('map_round', 'Round rooms', [
    { id: 'r1', type: 'room', shape: { circle: [7, 7, 4] }, label: '1' },
    { id: 'r2', type: 'room', shape: shapeFromBox('oval', [16, 2, 9, 6]), label: '2' },
    { id: 'r3', type: 'room', shape: shapeFromBox('octagon', [16, 12, 7, 7]), label: '3' },
    { id: 'c1', type: 'corridor', width: 1, path: [[10.5, 5.5], [16.5, 5.5]] },
    { id: 'c2', type: 'corridor', width: 1, path: [[7, 10.5], [7, 21.5], [19.5, 21.5], [19.5, 18.5]] },
    { id: 'c3', type: 'corridor', width: 2, path: [[20, 7.5], [20, 12.5]] },
    { id: 'd1', type: 'door', at: [19, 12], along: 'x', width: 2 },
  ]);
  const pillars = base('map_pillars', 'Pillared hall', [
    { id: 'r1', type: 'room', shape: { rect: [2, 2, 16, 12] }, label: '1' },
    { id: 'r2', type: 'room', shape: { rect: [21, 4, 6, 7] }, label: '2' },
    { id: 'c1', type: 'corridor', width: 2, path: [[18, 7], [21, 7]] },
    { id: 'p1', type: 'cutout', shape: { rect: [5, 5, 1, 1] } },
    { id: 'p2', type: 'cutout', shape: { rect: [14, 5, 1, 1] } },
    { id: 'p3', type: 'cutout', shape: { rect: [5, 10, 1, 1] } },
    { id: 'p4', type: 'cutout', shape: { rect: [14, 10, 1, 1] } },
    { id: 'p5', type: 'cutout', shape: { rect: [9, 7, 2, 2] }, fill: 'solid' },
    { id: 'p6', type: 'cutout', shape: { circle: [10, 4.5, 0.5] } },
    { id: 'p7', type: 'cutout', shape: { circle: [10, 11.5, 0.5] }, fill: 'solid' },
    { id: 'd1', type: 'door', at: [18, 6], along: 'y', width: 2 },
    { id: 'd2', type: 'door', at: [24, 11], along: 'x', width: 1 },
  ]);
  const cave = base(
    'map_cave',
    'Cave',
    [
      { id: 'r1', type: 'room', shape: { poly: [[2, 2], [10, 1], [14, 5], [12, 11], [6, 12], [1, 8]] } },
      { id: 'r2', type: 'room', shape: { poly: [[17, 4], [25, 3], [27, 9], [21, 14], [16, 10]] } },
      { id: 'c1', type: 'corridor', width: 2, path: [[13, 7], [17, 7]] },
      { id: 'r3', type: 'room', shape: { circle: [21, 19, 3] } },
      { id: 'c2', type: 'corridor', width: 1.5, path: [[21, 13], [21, 16.5]] },
    ],
    { roughness: 8 },
  );
  const water = base('map_water', 'Flooded halls', [
    { id: 'r1', type: 'room', shape: { rect: [1, 1, 14, 10] }, label: '1' },
    { id: 'r2', type: 'room', shape: { rect: [18, 2, 8, 8] }, label: '2' },
    { id: 'c1', type: 'corridor', width: 2, path: [[15, 6], [18, 6]] },
    { id: 't1', type: 'terrain', asset: 'water-deep', shape: { rect: [1, 5, 14, 3] } },
    { id: 't2', type: 'terrain', asset: 'water-shallow', shape: { circle: [22, 6, 2] } },
    { id: 'p1', type: 'cutout', shape: { rect: [4, 2, 2, 2] }, name: 'Pit' },
    { id: 'd1', type: 'door', at: [18, 5], along: 'y', width: 2 },
  ]);
  const odd = base('map_odd', 'Odd shapes', [
    { id: 'r1', type: 'room', shape: { poly: [[1, 1], [9, 1], [9, 4], [5, 4], [5, 10], [1, 10]] }, label: '1' },
    { id: 'r2', type: 'room', shape: shapeFromBox('triangle', [12, 1, 8, 7]), label: '2' },
    { id: 'r3', type: 'room', shape: shapeFromBox('hexagon', [12, 10, 8, 6]), label: '3' },
    { id: 'r4', type: 'room', shape: { rect: [1, 13, 2, 2] }, label: '4' },
    { id: 'c1', type: 'corridor', width: 1, path: [[5, 6], [12, 13]] },
    { id: 'c2', type: 'corridor', width: 1, path: [[2, 10], [2, 13]] },
    { id: 'c3', type: 'corridor', width: 1, path: [[9, 2.5], [15, 2.5]] },
    { id: 'd1', type: 'door', at: [1.5, 13], along: 'x', width: 1 },
  ]);
  // Two rooms behind one thin shared wall with a doorway, as Dungeon Scrawl and many hand-drawn maps have them.
  const shared = base('map_shared', 'Shared walls', [
    { id: 'r1', type: 'room', shape: { rect: [1, 1, 16, 10] } },
    { id: 'r2', type: 'room', shape: { rect: [1, 11, 7, 6] } },
    { id: 'w1', type: 'cutout', shape: { rect: [8.9, 1, 0.2, 4] }, fill: 'solid' },
    { id: 'w2', type: 'cutout', shape: { rect: [8.9, 6, 0.2, 5] }, fill: 'solid' },
    { id: 'w3', type: 'cutout', shape: { rect: [1, 10.9, 3, 0.2] }, fill: 'solid' },
    { id: 'w4', type: 'cutout', shape: { rect: [5, 10.9, 3, 0.2] }, fill: 'solid' },
    { id: 'd1', type: 'door', at: [9, 5], along: 'y', width: 1 },
  ]);
  return [
    { map: fixture, rooms: 11 },
    { map: round, rooms: 6 },
    { map: pillars, rooms: 3 },
    { map: cave, rooms: 5 },
    { map: water, rooms: 3 },
    { map: odd, rooms: 7 },
    { map: shared, rooms: 3 },
  ];
}

/** A big dungeon for timing: a 7 × 7 block of rooms on 60 × 60 squares, joined by corridors with doors. */
export function bigMap(): { map: DelveMap; rooms: number } {
  const objects: MapObject[] = [];
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const size = 8;
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const x = 1 + gx * size;
      const y = 1 + gy * size;
      const w = 4 + ((gx * 3 + gy) % 3);
      const h = 4 + ((gy * 5 + gx) % 3);
      objects.push({ id: id('r'), type: 'room', shape: (gx + gy) % 5 === 0 ? { circle: [x + 3, y + 3, 3] } : { rect: [x, y, w, h] }, label: String(n) });
      if (gx < 6) objects.push({ id: id('c'), type: 'corridor', width: 1, path: [[x + 2.5, y + 2.5], [x + size + 2.5, y + 2.5]] });
      if (gy < 6 && gx % 2 === 0) objects.push({ id: id('c'), type: 'corridor', width: 2, path: [[x + 2, y + 3], [x + 2, y + size + 3]] });
      if ((gx * gy) % 4 === 1) objects.push({ id: id('p'), type: 'cutout', shape: { rect: [x + 1, y + 1, 1, 1] } });
    }
  }
  return { map: base('map_big', 'Big dungeon', objects), rooms: objects.filter((o) => o.type === 'room' || o.type === 'corridor').length };
}

export type Variant = 'clean' | 'noisy' | 'blur';

export interface BenchCase {
  map: DelveMap;
  rooms: number;
  style: string;
  ppg: number;
  grid: boolean;
  /** gm shows room numbers (and secret door marks). */
  view: 'gm' | 'players';
  variant: Variant;
}

export interface BenchPicture {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Picture pixels per square after the tracer page's 2000 px limit. */
  ppg: number;
  /** The map square at picture pixel (0, 0). */
  origin: [number, number];
  /** The right answer: the drawn floor (rough walls included), in map squares. */
  floor: Polygon[];
}

export const caseName = (c: BenchCase): string => `${c.map.id.replace(/^map_/, '')}/${c.style}/${c.ppg}${c.grid ? '' : '/nogrid'}${c.view === 'gm' ? '/gm' : ''}${c.variant === 'clean' ? '' : `/${c.variant}`}`;

/** Deterministic noise for the picture variants. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A soft 3×3 blur, a small colour shift and grain, like a JPEG or a scan. */
function degrade(rgba: Uint8Array, w: number, h: number, variant: Variant): Uint8Array {
  if (variant === 'clean') return rgba;
  const out = new Uint8Array(rgba.length);
  const rand = rng(12345);
  const passes = variant === 'blur' ? 2 : 1;
  let src = rgba;
  for (let p = 0; p < passes; p++) {
    const dst = new Uint8Array(rgba.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let k = 0; k < 4; k++) {
          let s = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const wt = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
              s += src[(yy * w + xx) * 4 + k]! * wt;
              n += wt;
            }
          }
          dst[(y * w + x) * 4 + k] = Math.round(s / n);
        }
      }
    }
    src = dst;
  }
  const gain = [1.04, 0.98, 0.94];
  const shift = [-6, 3, 8];
  const grain = variant === 'noisy' ? 9 : 4;
  for (let i = 0; i < w * h; i++) {
    const n = (rand() + rand() + rand() - 1.5) * grain;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.max(0, Math.min(255, Math.round(src[i * 4 + k]! * gain[k]! + shift[k]! + n)));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The case drawn the way the tracer page receives it: rendered, degraded, shrunk to 2000 px at most. */
export async function renderCase(c: BenchCase, maxSide = 2000): Promise<BenchPicture> {
  const map: DelveMap = { ...c.map, style: { preset: c.style } };
  const style = resolveStyle(map);
  const scene = buildScene(map, { view: c.view, grid: c.grid, assets: assets.body, floorNumber: false }, style);
  const png = await svgToPng(sceneToSvg(scene, { ppg: c.ppg }));
  const full = decodePng(png);
  const rgba = degrade(full.rgba, full.width, full.height, c.variant);
  const pic = downscale(rgba, full.width, full.height, maxSide);
  return {
    width: pic.width,
    height: pic.height,
    rgba: pic.rgba as Uint8Array,
    ppg: c.ppg / pic.factor,
    origin: [scene.bounds.x0, scene.bounds.y0],
    floor: drawnFloor(map),
  };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** RGBA pixels as a PNG file (no filtering), so bench pictures can be opened in the trace page. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- scoring ----------

type Ring = readonly (readonly [number, number])[];

/** Pixel centres inside the rings (even-odd), as a mask; the rings are in picture pixels. */
export function rasterize(rings: Ring[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[i + 1]! - 0.5));
      for (let x = x0; x <= x1; x++) out[y * w + x] = out[y * w + x]! ^ 1;
    }
  }
  return out;
}

export const ringsOf = (polys: readonly Polygon[]): Ring[] => polys.flatMap((p) => [p.outer, ...p.holes]);

export interface Score {
  iou: number;
  /** |traced px per square - true| / true. */
  scaleErr: number;
  rooms: number;
  trueRooms: number;
  /** Share of room outline points on a half-square point of the traced map's own grid. */
  onHalf: number;
  vertices: number;
  ms: number;
}

/**
 * Compares a traced map with the right answer. `pxPerSquare` and `origin` place the
 * traced map's squares on the picture: picture px = (square - origin) × pxPerSquare.
 */
export function score(pic: BenchPicture, traced: DelveMap, placed: { pxPerSquare: number; origin: [number, number] }, trueRooms: number, ms: number): Score {
  const { width: w, height: h } = pic;
  const truthRings = ringsOf(pic.floor).map((r) => r.map(([x, y]) => [(x - pic.origin[0]) * pic.ppg, (y - pic.origin[1]) * pic.ppg] as const));
  const tracedRings = ringsOf(drawnFloor(traced)).map((r) => r.map(([x, y]) => [(x - placed.origin[0]) * placed.pxPerSquare, (y - placed.origin[1]) * placed.pxPerSquare] as const));
  const a = rasterize(truthRings, w, h);
  const b = rasterize(tracedRings, w, h);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    inter += a[i]! & b[i]!;
    union += a[i]! | b[i]!;
  }
  let pts = 0;
  let half = 0;
  for (const o of traced.objects) {
    if (o.type !== 'room' && o.type !== 'cutout') continue;
    const poly = 'poly' in o.shape ? o.shape.poly : 'rect' in o.shape ? [[o.shape.rect[0], o.shape.rect[1]]] : [];
    for (const [x, y] of poly as [number, number][]) {
      pts++;
      if (Math.abs(x * 2 - Math.round(x * 2)) < 0.1 && Math.abs(y * 2 - Math.round(y * 2)) < 0.1) half++;
    }
  }
  return {
    iou: union ? inter / union : 1,
    scaleErr: Math.abs(placed.pxPerSquare - pic.ppg) / pic.ppg,
    rooms: traced.objects.filter((o) => o.type === 'room' && o.name !== 'Wall').length + traced.objects.filter((o) => o.type === 'corridor').length,
    trueRooms,
    onHalf: pts ? half / pts : 0,
    vertices: pts,
    ms,
  };
}

/** The standard set: every map in every style at 50 px, the test dungeon across sizes and with and without the grid, plus noisy, blurred and numbered pictures. */
export function benchCases(set: 'full' | 'quick' | 'perf' = 'full'): BenchCase[] {
  const maps = benchMaps();
  const cases: BenchCase[] = [];
  const add = (m: (typeof maps)[number], style: string, ppg: number, more: Partial<BenchCase> = {}) =>
    cases.push({ map: m.map, rooms: m.rooms, style, ppg, grid: true, view: 'players', variant: 'clean', ...more });
  if (set === 'perf') {
    // about 2000 × 2000 pixels, as big as the trace page traces
    const big = bigMap();
    for (const s of ['classic-hatching', 'clean']) add(big, s, 33, { view: 'gm' });
    return cases;
  }
  const quickStyles = ['classic-hatching', 'clean', 'old-school-blue'];
  for (const m of maps) for (const s of set === 'quick' ? quickStyles : BENCH_STYLES) add(m, s, 50);
  if (set === 'quick') return cases;
  const dungeon = maps[0]!;
  for (const s of BENCH_STYLES) {
    for (const ppg of [30, 70, 100]) add(dungeon, s, ppg);
    add(dungeon, s, 50, { grid: false });
    add(dungeon, s, 50, { view: 'gm' });
    add(dungeon, s, 50, { variant: 'noisy' });
    add(dungeon, s, 40, { variant: 'blur' });
  }
  for (const m of maps.slice(1)) {
    add(m, 'classic-hatching', 35, { variant: 'noisy', view: 'gm' });
    add(m, 'clean', 80, { grid: false });
  }
  return cases;
}
