// Render a map file to PNG or SVG.
// npm run render -- <map.delve.json> <out.png|out.svg> [--ppg 70] [--view gm|players] [--style <preset>] [--no-grid]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildScene, resolveStyle, sceneToSvg, validateMap, type View } from '@delve/core';
import { pngSize, svgToPng } from '../png.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ppg: { type: 'string', default: '70' },
    view: { type: 'string', default: 'gm' },
    style: { type: 'string' },
    'no-grid': { type: 'boolean', default: false },
  },
});
const [input, output] = positionals;
if (!input || !output) {
  console.error('usage: render <map.delve.json> <out.png|out.svg> [--ppg 70] [--view gm|players] [--style <preset>] [--no-grid]');
  process.exit(2);
}

const map = validateMap(JSON.parse(readFileSync(input, 'utf8')));
if (values.style) map.style = { ...map.style, preset: values.style };
const started = performance.now();
const scene = buildScene(map, { view: values.view as View, grid: !values['no-grid'] }, resolveStyle(map));
const svg = sceneToSvg(scene, { ppg: Number(values.ppg) });
if (output.endsWith('.svg')) {
  writeFileSync(output, svg);
  console.log(`wrote ${output} (${(svg.length / 1024).toFixed(0)} KB)`);
} else {
  const png = svgToPng(svg);
  writeFileSync(output, png);
  const { width, height } = pngSize(png);
  console.log(`wrote ${output}: ${width}×${height} px, ${(png.length / 1024).toFixed(0)} KB, ${(performance.now() - started).toFixed(0)} ms`);
}
