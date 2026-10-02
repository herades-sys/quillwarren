// Trace a map picture (a dungeon or battle map, a city plan, painted or flat) into a Delve map file.
// npm run trace -- <picture.png> <out.delve.json> [--mode dungeon|city] [--painted | --flat] [--unit "5 ft"]
//   [--px-per-square N | --ppm N (picture pixels per metre, from a scale bar) | --width N (picture width in the unit's ft or m) | --width-ft N]
//   [--colours 8] [--roles ignore,building,...] [--min wall=0.5,water=1] [--join] [--max 2000] [--render out.png] [--name "Old Town"]
// It looks at the picture first (kind of map, painted or flat, grid, colours with a guessed role each) and prints
// what it found. Dungeon pictures with a printed grid need no scale: one grid cell is one square.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analysePicture,
  buildScene,
  coloursForMode,
  downscale,
  metresPerSquare,
  parseSquareUnit,
  resolveStyle,
  sceneToSvg,
  squareUnit,
  traceImage,
  tracedMap,
  TRACE_ROLES,
  type TraceMode,
  type TraceRole,
} from '@delve/core';
import { decodePng, svgToPng } from '../png.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: 'string' },
    painted: { type: 'boolean' },
    flat: { type: 'boolean' },
    unit: { type: 'string' },
    feet: { type: 'string' },
    'px-per-square': { type: 'string' },
    ppm: { type: 'string' },
    width: { type: 'string' },
    'width-ft': { type: 'string' },
    colours: { type: 'string' },
    roles: { type: 'string' },
    max: { type: 'string', default: '2000' },
    render: { type: 'string' },
    min: { type: 'string' },
    join: { type: 'boolean', default: false },
    name: { type: 'string' },
  },
});
const [input, output] = positionals;
if (!input || !output) {
  console.error(
    'usage: trace <picture.png> <out.delve.json> [--mode dungeon|city] [--painted|--flat] [--unit "5 ft"] [--px-per-square N | --ppm N | --width N | --width-ft N] [--colours 8] [--roles a,b,...] [--min wall=0.5] [--join] [--max 2000] [--render out.png] [--name ...]',
  );
  process.exit(2);
}

const started = performance.now();
const full = decodePng(readFileSync(input));
const pic = downscale(full.rgba, full.width, full.height, Number(values.max));
const mode = values.mode as TraceMode | undefined;
if (mode && mode !== 'dungeon' && mode !== 'city') throw new Error('--mode is dungeon or city');
const a = analysePicture(pic.rgba, pic.width, pic.height, { ...(mode ? { mode } : {}), ...(values.painted ? { painted: true } : values.flat ? { painted: false } : {}) });
const own = values.colours ? coloursForMode(pic.rgba, pic.width, pic.height, a.mode, { k: Number(values.colours), painted: a.painted, ...(a.smoothed ? { smoothed: a.smoothed } : {}), ...(a.grid ? { cell: a.grid.cell } : {}) }) : a;
const unit = squareUnit(values.unit ?? (values.feet ? `${values.feet} ft` : a.mode === 'dungeon' ? '5 ft' : '2 m'));
const m = metresPerSquare(parseSquareUnit(unit));
const u = parseSquareUnit(unit);
// the scale: given, from a scale bar (pixels per metre), the picture's width, or the grid
const pxPerSquare = values['px-per-square']
  ? Number(values['px-per-square']) / pic.factor
  : values.ppm
    ? (Number(values.ppm) / pic.factor) * m
    : values.width
      ? (pic.width / (Number(values.width) * (u.name === 'm' ? 1 : 0.3048))) * m
      : values['width-ft']
        ? (pic.width / (Number(values['width-ft']) * 0.3048)) * m
        : (a.grid ?? (a.mode === 'dungeon' ? a.wallGrid : null))
          ? (a.grid ?? a.wallGrid)!.cell
          : null;
if (!pxPerSquare) {
  console.error('no grid found in the picture: give the scale with --px-per-square, --ppm (from a scale bar) or --width');
  process.exit(2);
}
const lattice = a.grid ?? (a.mode === 'dungeon' ? a.wallGrid : null);
const fromGrid = !values['px-per-square'] && !values.ppm && !values.width && !values['width-ft'] && Boolean(lattice);
const roles = values.roles ? (values.roles.split(',') as TraceRole[]) : own.roles;
for (const r of roles) if (!TRACE_ROLES.includes(r)) throw new Error(`unknown role "${r}" (use ${TRACE_ROLES.join(', ')})`);
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
console.log(`${full.width}×${full.height} px, traced at ${pic.width}×${pic.height}`);
console.log(`${a.mode === 'dungeon' ? 'dungeon or battle map' : 'city plan'}${a.painted ? ', painted (smoothed first)' : ''}: ${a.why}`);
console.log(a.grid ? `grid: ${a.grid.cell.toFixed(2)} px per cell, lines at ${a.grid.offset.map((v) => v.toFixed(1)).join(', ')}` : a.wallGrid ? `no grid printed; the walls stand on squares of ${a.wallGrid.cell.toFixed(2)} px` : 'no grid found');
console.log(`scale: ${pxPerSquare.toFixed(2)} px per ${unit} square${fromGrid ? ' (one grid cell)' : ''}`);
own.colours.forEach((c, i) => console.log(`  ${hex(c.colour)}  ${(c.share * 100).toFixed(1).padStart(5)}%  ${roles[i] ?? 'ignore'}`));
const minWidth = Object.fromEntries((values.min ?? '').split(',').filter(Boolean).map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])]));
const result = traceImage({
  ...pic,
  colours: own.colours.map((c) => c.colour),
  roles,
  space: own.space,
  mode: a.mode,
  painted: a.painted,
  ...(a.smoothed ? { smoothed: a.smoothed } : {}),
  pxPerSquare,
  ...(fromGrid ? { origin: lattice!.offset, printedGrid: Boolean(a.grid) } : {}),
  minWidth,
  join: values.join,
});
const map = tracedMap(result, { id: `map_${randomBytes(6).toString('hex')}`, name: values.name ?? basename(input).replace(/\.\w+$/, ''), unit });
writeFileSync(output, JSON.stringify(map, null, 1));
console.log(`wrote ${output}: ${result.size[0]}×${result.size[1]} squares, ${JSON.stringify(result.counts)}, ${(performance.now() - started).toFixed(0)} ms`);
if (values.render) {
  const svg = sceneToSvg(buildScene(map, { view: 'gm' }, resolveStyle(map)), { ppg: 20 });
  writeFileSync(values.render, await svgToPng(svg));
  console.log(`wrote ${values.render}`);
}
