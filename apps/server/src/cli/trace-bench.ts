// The picture tracer's benchmark: renders Delve maps (every style, several sizes,
// with and without the grid, clean, noisy and blurred), traces them the way the
// trace page does by default, and prints how close each comes to the right answer.
// npm run trace-bench -- [--set full|quick] [--legacy [--true-scale]] [--only <text>] [--out dir] [--city feyvale.png]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { analysePicture, buildScene, downscale, guessRoles, mainColours, resolveStyle, sceneToSvg, traceImage, tracedMap, type DelveMap } from '@delve/core';
import { decodePng } from '../png.ts';
import { benchCases, caseName, encodePng, renderCase, score, type BenchPicture, type Score } from './trace-bench-lib.ts';

const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'full' },
    legacy: { type: 'boolean', default: false },
    'true-scale': { type: 'boolean', default: false },
    only: { type: 'string' },
    out: { type: 'string' },
    city: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    timings: { type: 'boolean', default: false },
    sample: { type: 'string' },
    'sample-ppm': { type: 'string' },
    'sample-unit': { type: 'string' },
  },
});

interface Traced {
  map: DelveMap;
  pxPerSquare: number;
  origin: [number, number];
  ms: number;
}

/** The tracer as the page used it before the rework: 7 colours, guessed roles, 12 px per square unless told. */
function legacy(pic: BenchPicture): Traced {
  const t0 = performance.now();
  const found = mainColours(pic.rgba, 7, { space: 'rgb' });
  const roles = guessRoles(found);
  const s = values['true-scale'] ? pic.ppg : 12;
  const result = traceImage({ width: pic.width, height: pic.height, rgba: pic.rgba, colours: found.map((c) => c.colour), roles, pxPerSquare: s });
  const map = tracedMap(result, { id: 'map_bench', name: 'bench' });
  return { map, pxPerSquare: s, origin: [0, 0], ms: performance.now() - t0 };
}

/** The tracer as the page uses it now: analyse, take the guessed mode, roles and grid (or the wall-based guess), trace. */
function current(pic: BenchPicture): Traced {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const a = analysePicture(pic.rgba, pic.width, pic.height);
  timings.analyse = performance.now() - t0;
  const g = a.grid ?? (a.mode === 'dungeon' ? a.wallGrid : null);
  const fromGrid = g && (a.mode === 'dungeon' || values['true-scale']);
  const s = values['true-scale'] ? pic.ppg : fromGrid ? g.cell : (a.wallScale ?? 12);
  const origin: [number, number] = values['true-scale'] ? [(((-pic.origin[0] * pic.ppg) % pic.ppg) + pic.ppg) % pic.ppg, (((-pic.origin[1] * pic.ppg) % pic.ppg) + pic.ppg) % pic.ppg] : fromGrid ? g.offset : [0, 0];
  const result = traceImage({
    width: pic.width,
    height: pic.height,
    rgba: pic.rgba,
    colours: a.colours.map((c) => c.colour),
    roles: a.roles,
    space: a.space,
    mode: a.mode,
    pxPerSquare: s,
    origin,
    printedGrid: Boolean(a.grid),
    timings,
  });
  const map = tracedMap(result, { id: 'map_bench', name: 'bench' });
  if (values.timings) console.log(`  ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' · ')} ms`);
  if (values.verbose) console.log(`  mode ${a.mode} (${a.why}), grid ${a.grid ? `${a.grid.cell.toFixed(2)} px` : 'none'}, wall ${a.wallWidth} px, roles ${a.roles.join(',')}, ${JSON.stringify(result.counts)}`);
  return { map, pxPerSquare: s, origin: [-origin[0] / s, -origin[1] / s], ms: performance.now() - t0 };
}

const tracer = values.legacy ? legacy : current;

const cases = benchCases(values.set === 'quick' || values.set === 'perf' ? values.set : 'full').filter((c) => !values.only || caseName(c).includes(values.only));
const rows: { name: string; s: Score }[] = [];
if (values.out) mkdirSync(values.out, { recursive: true });
for (const c of cases) {
  const pic = await renderCase(c);
  if (values.out) writeFileSync(join(values.out, `${caseName(c).replace(/\//g, '_')}.png`), encodePng(pic.width, pic.height, pic.rgba));
  const t = tracer(pic);
  const s = score(pic, t.map, t, c.rooms, t.ms);
  if (values.out) writeFileSync(join(values.out, `${caseName(c).replace(/\//g, '_')}.trace.png`), await overlay(pic.rgba, pic.width, pic.height, t));
  rows.push({ name: caseName(c), s });
  console.log(line(caseName(c), s));
}

/**
 * The picture (faded) with what was traced over it: rooms a colour each (wall pieces
 * dark red, towers red), cutouts dashed, doors magenta, terrain by kind. `zoom` enlarges small pictures.
 */
export async function overlay(rgba: Uint8Array, width: number, height: number, t: Traced, zoom = 1): Promise<Buffer> {
  const TERRAIN_FILL: Record<string, string> = { 'water-deep': 'rgba(40,110,220,0.45)', cobblestones: 'rgba(150,150,150,0.30)', grass: 'rgba(40,170,40,0.35)', dirt: 'rgba(200,150,40,0.40)', sand: 'rgba(230,200,100,0.40)' };
  const { svgToPng } = await import('../png.ts');
  const k0 = zoom;
  const px = ([x, y]: readonly number[]) => `${((x! - t.origin[0]) * t.pxPerSquare * k0).toFixed(1)} ${((y! - t.origin[1]) * t.pxPerSquare * k0).toFixed(1)}`;
  const ring = (r: readonly (readonly number[])[]) => `M${r.map(px).join('L')}Z`;
  const shapes: string[] = [];
  let k = 0;
  const sw = Math.max(1, zoom);
  for (const o of t.map.objects) {
    if (o.type === 'terrain' && 'poly' in o.shape) {
      const d = ring(o.shape.poly) + (o.holes ?? []).map(ring).join('');
      shapes.push(`<path d="${d}" fill="${TERRAIN_FILL[o.asset] ?? 'rgba(120,120,120,0.3)'}" fill-rule="evenodd" stroke="rgba(0,0,0,0.35)" stroke-width="${sw * 0.6}"/>`);
    }
  }
  for (const o of t.map.objects) {
    if (o.type !== 'room' && o.type !== 'cutout' && o.type !== 'door') continue;
    if (o.type === 'door') {
      const b = o.along === 'x' ? [o.at[0] + o.width, o.at[1]] : [o.at[0], o.at[1] + o.width];
      shapes.push(`<path d="M${px(o.at)}L${px(b)}" stroke="#e0409a" stroke-width="${sw * 5}"/>`);
      continue;
    }
    const d = 'poly' in o.shape ? ring(o.shape.poly) : 'circle' in o.shape ? null : ring([[o.shape.rect[0], o.shape.rect[1]], [o.shape.rect[0] + o.shape.rect[2], o.shape.rect[1]], [o.shape.rect[0] + o.shape.rect[2], o.shape.rect[1] + o.shape.rect[3]], [o.shape.rect[0], o.shape.rect[1] + o.shape.rect[3]]]);
    const hue = (k++ * 137) % 360;
    const fill = o.type === 'cutout' ? (o.fill === 'solid' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)') : o.name === 'Wall' ? 'rgba(120,0,0,0.7)' : o.name === 'Tower' ? 'rgba(230,0,0,0.75)' : `hsla(${hue},80%,50%,0.45)`;
    const stroke = o.type === 'cutout' ? '#d00' : o.name === 'Wall' || o.name === 'Tower' ? '#400' : `hsl(${hue},80%,30%)`;
    const dash = o.type === 'cutout' ? ' stroke-dasharray="6 4"' : '';
    if (d) shapes.push(`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);
    else if ('circle' in o.shape) {
      const [cx, cy, r] = o.shape.circle;
      const [x, y] = px([cx, cy]).split(' ').map(Number);
      shapes.push(`<circle cx="${x}" cy="${y}" r="${(r * t.pxPerSquare * k0).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    }
  }
  const { encodePng: enc } = await import('./trace-bench-lib.ts');
  const img = enc(width, height, rgba).toString('base64');
  const W = width * zoom;
  const H = height * zoom;
  return svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><image width="${W}" height="${H}" href="data:image/png;base64,${img}" opacity="0.55"/>${shapes.join('')}</svg>`);
}

/** The traced map as Delve draws it. */
async function renderMap(map: DelveMap, ppg: number): Promise<Buffer> {
  const { svgToPng } = await import('../png.ts');
  const { assets } = await import('../assets.ts');
  return svgToPng(sceneToSvg(buildScene(map, { view: 'gm', grid: false, assets: assets.body }, resolveStyle(map)), { ppg }));
}

function line(name: string, s: Score): string {
  return `${name.padEnd(44)} IoU ${s.iou.toFixed(3)}  scale ${(s.scaleErr * 100).toFixed(1).padStart(5)}%  rooms ${String(s.rooms).padStart(3)}/${String(s.trueRooms).padEnd(3)} onHalf ${(s.onHalf * 100).toFixed(0).padStart(3)}%  pts ${String(s.vertices).padStart(5)}  ${s.ms.toFixed(0).padStart(5)} ms`;
}

const mean = (f: (s: Score) => number, list = rows) => list.reduce((a, r) => a + f(r.s), 0) / Math.max(1, list.length);
const summary = (label: string, list: typeof rows) =>
  console.log(
    `${label.padEnd(26)} n ${String(list.length).padStart(3)}  IoU ${mean((s) => s.iou, list).toFixed(3)} (min ${Math.min(...list.map((r) => r.s.iou)).toFixed(3)})  scale ${(mean((s) => s.scaleErr, list) * 100).toFixed(1)}% (≤2%: ${list.filter((r) => r.s.scaleErr <= 0.02).length})  rooms right ${list.filter((r) => r.s.rooms === r.s.trueRooms).length}, off by ${mean((s) => Math.abs(s.rooms - s.trueRooms), list).toFixed(1)}  onHalf ${(mean((s) => s.onHalf, list) * 100).toFixed(0)}%  ${mean((s) => s.ms, list).toFixed(0)} ms`,
  );
console.log('');
summary('all', rows);
for (const style of new Set(cases.map((c) => c.style))) summary(`style ${style}`, rows.filter((r) => r.name.split('/')[1] === style));
for (const map of new Set(rows.map((r) => r.name.split('/')[0]!))) summary(`map ${map}`, rows.filter((r) => r.name.split('/')[0] === map));
summary('no grid', rows.filter((r) => r.name.includes('/nogrid')));
summary('noisy / blur', rows.filter((r) => /noisy|blur/.test(r.name)));

if (values.city) {
  const full = decodePng(readFileSync(values.city));
  const pic = downscale(full.rgba, full.width, full.height, 2000);
  // as the page does it: analyse (mode, colours, roles), then trace at the scale bar's 12 px per 10 ft square
  const t0 = performance.now();
  const a = analysePicture(pic.rgba, pic.width, pic.height);
  const trace = (roles: typeof a.roles) => traceImage({ width: pic.width, height: pic.height, rgba: pic.rgba, colours: a.colours.map((c) => c.colour), roles, space: a.space, mode: a.mode, pxPerSquare: 12 });
  const result = trace(a.roles);
  const ms = performance.now() - t0;
  console.log(`\ncity ${values.city}: ${pic.width}×${pic.height}, mode ${a.mode} (${a.why}), grid ${a.grid ? `${a.grid.cell.toFixed(1)} px` : 'none'}, roles ${a.roles.join(',')}, ${JSON.stringify(result.counts)}, ${ms.toFixed(0)} ms`);
  // the river is drawn in the shadow colour: the user gives it the role water
  const river = a.roles.map((r, i) => (i === 2 ? 'water' : r));
  console.log(`  with the third colour as water: ${JSON.stringify(trace(river).counts)}`);
}

// A painted city (no right answer): what was found, and overlays to look at.
// --sample picture.png --sample-ppm 2.18 (picture pixels per metre, from its scale bar) [--sample-unit "2 m"]
if (values.sample) {
  const full = decodePng(readFileSync(values.sample));
  const pic = downscale(full.rgba, full.width, full.height, 2000);
  const ppm = Number(values['sample-ppm'] ?? 2);
  const unit = values['sample-unit'] ?? '2 m';
  const metres = Number(unit.split(' ')[0]) * (unit.endsWith('ft') ? 0.3048 : 1);
  const s = (ppm / pic.factor) * metres;
  const name = basename(values.sample).replace(/\.\w+$/, '');
  const report = (label: string, counts: Record<string, number>, ms: number) =>
    console.log(`${label.padEnd(8)} ${name}: ${pic.width}×${pic.height}, ${s.toFixed(2)} px per ${unit} square — buildings ${counts.building ?? 0}, wall pieces ${counts.wall ?? 0}, towers ${counts.tower ?? 0}, water ${counts.water ?? 0}, grass ${counts.grass ?? 0}, fields ${counts.field ?? 0}, roads ${counts.road ?? 0} · ${ms.toFixed(0)} ms`);
  // before: the city tracer as it was (7 RGB colours, the old role guesses)
  let t0 = performance.now();
  const old = mainColours(pic.rgba, 7, { space: 'rgb' });
  const before = traceImage({ width: pic.width, height: pic.height, rgba: pic.rgba, colours: old.map((c) => c.colour), roles: guessRoles(old), pxPerSquare: s });
  report('before', before.counts, performance.now() - t0);
  // after: as the page does it now
  t0 = performance.now();
  const timings: Record<string, number> = {};
  const a = analysePicture(pic.rgba, pic.width, pic.height);
  timings.analyse = performance.now() - t0;
  const after = traceImage({ width: pic.width, height: pic.height, rgba: pic.rgba, colours: a.colours.map((c) => c.colour), roles: a.roles, space: a.space, mode: a.mode, painted: a.painted, ...(a.smoothed ? { smoothed: a.smoothed } : {}), pxPerSquare: s });
  const ms = performance.now() - t0;
  console.log(`         mode ${a.mode}${a.painted ? ' (painted)' : ''}: ${a.why}; texture ${a.texture.toFixed(2)}; roles ${a.roles.join(',')}; analysis ${timings.analyse!.toFixed(0)} ms`);
  report('after', after.counts, ms);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    for (const [label, result] of [['before', before], ['after', after]] as const) {
      const map = tracedMap(result, { id: 'map_sample', name, unit });
      const t: Traced = { map, pxPerSquare: s, origin: [0, 0], ms: 0 };
      writeFileSync(join(values.out, `${name}.${label}.overlay.png`), await overlay(pic.rgba as Uint8Array, pic.width, pic.height, t, pic.width < 1200 ? 2 : 1));
      writeFileSync(join(values.out, `${name}.${label}.map.png`), await renderMap(map, Math.max(4, Math.min(24, 1800 / Math.max(result.size[0], result.size[1])))));
      writeFileSync(join(values.out, `${name}.${label}.delve.json`), JSON.stringify(map));
    }
  }
}
