// Trace a map picture (a city plan, a scanned dungeon) into a Delve map file.
// npm run trace -- <picture.png> <out.delve.json> [--feet 10] [--width-ft 2000 | --px-per-square 10]
//   [--colours 7] [--roles ignore,building,...] [--min wall=0.5,water=1] [--join] [--max 2000] [--render out.png] [--name "Old Town"]
// Without --roles it prints the main colours with a guessed role each, and traces with those guesses.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { buildScene, downscale, guessRoles, mainColours, resolveStyle, sceneToSvg, traceImage, tracedMap, TRACE_ROLES, type TraceRole } from '@delve/core';
import { decodePng, svgToPng } from '../png.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    feet: { type: 'string', default: '10' },
    'width-ft': { type: 'string' },
    'px-per-square': { type: 'string' },
    colours: { type: 'string', default: '7' },
    roles: { type: 'string' },
    max: { type: 'string', default: '2000' },
    render: { type: 'string' },
    min: { type: 'string' },
    join: { type: 'boolean', default: false },
    name: { type: 'string' },
  },
});
const [input, output] = positionals;
if (!input || !output || (!values['width-ft'] && !values['px-per-square'])) {
  console.error('usage: trace <picture.png> <out.delve.json> (--width-ft N | --px-per-square N) [--feet 10] [--colours 7] [--roles a,b,...] [--max 2000] [--render out.png] [--name ...]');
  process.exit(2);
}

const started = performance.now();
const full = decodePng(readFileSync(input));
const pic = downscale(full.rgba, full.width, full.height, Number(values.max));
const feet = Number(values.feet);
const pxPerSquare = values['px-per-square'] ? Number(values['px-per-square']) / pic.factor : (pic.width * feet) / Number(values['width-ft']);
const found = mainColours(pic.rgba, Number(values.colours));
const roles = values.roles ? (values.roles.split(',') as TraceRole[]) : guessRoles(found);
for (const r of roles) if (!TRACE_ROLES.includes(r)) throw new Error(`unknown role "${r}" (use ${TRACE_ROLES.join(', ')})`);
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
console.log(`${full.width}×${full.height} px, traced at ${pic.width}×${pic.height} (${pxPerSquare.toFixed(1)} px per ${feet} ft square)`);
found.forEach((c, i) => console.log(`  ${hex(c.colour)}  ${(c.share * 100).toFixed(1).padStart(5)}%  ${roles[i] ?? 'ignore'}`));
const minWidth = Object.fromEntries((values.min ?? '').split(',').filter(Boolean).map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])]));
const result = traceImage({ ...pic, colours: found.map((c) => c.colour), roles, pxPerSquare, minWidth, join: values.join });
const map = tracedMap(result, { id: `map_${randomBytes(6).toString('hex')}`, name: values.name ?? basename(input).replace(/\.\w+$/, ''), feetPerSquare: feet });
writeFileSync(output, JSON.stringify(map, null, 1));
console.log(`wrote ${output}: ${result.size[0]}×${result.size[1]} squares, ${JSON.stringify(result.counts)}, ${(performance.now() - started).toFixed(0)} ms`);
if (values.render) {
  const svg = sceneToSvg(buildScene(map, { view: 'gm' }, resolveStyle(map)), { ppg: 20 });
  writeFileSync(values.render, await svgToPng(svg));
  console.log(`wrote ${values.render}`);
}
