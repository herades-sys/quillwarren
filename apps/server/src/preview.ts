// The start page: the test dungeon in every style, GM or players' view, with
// SVG and Roll20-ready PNG downloads. A stand-in until the editor (phase 4).
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  buildScene,
  describeMap,
  FORMAT,
  FORMAT_VERSION,
  PRESETS,
  resolveStyle,
  sceneToSvg,
  validateMap,
  type DelveMap,
  type Scene,
  type View,
} from '@delve/core';
import testMapJson from '../../../fixtures/test-map-4p.delve.json' with { type: 'json' };
import { LABEL_FONT_FILE, svgToPng } from './png.ts';
import type { AppInfo } from './app.ts';

const TEST_MAP: DelveMap = validateMap(structuredClone(testMapJson));
const ROLL20_PPG = 70;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const asView = (v: unknown): View => (v === 'players' ? 'players' : 'gm');

function mapWithStyle(preset: string): DelveMap {
  return { ...TEST_MAP, style: { ...TEST_MAP.style, preset } };
}

const scenes = new Map<string, Scene>();
function sceneFor(preset: string, view: View, grid = true): Scene {
  const key = `${preset}|${view}|${grid}`;
  let s = scenes.get(key);
  if (!s) {
    const map = mapWithStyle(preset);
    s = buildScene(map, { view, grid }, resolveStyle(map));
    scenes.set(key, s);
  }
  return s;
}

function size(scene: Scene): { w: number; h: number } {
  return { w: scene.bounds.x1 - scene.bounds.x0, h: scene.bounds.y1 - scene.bounds.y0 };
}

function fileName(preset: string, view: View, scene: Scene, ext: string): string {
  const { w, h } = size(scene);
  return `${slug(TEST_MAP.name)}_${preset}_${view}_${w}x${h}.${ext}`;
}

function page(info: AppInfo, view: View): string {
  const cards = Object.entries(PRESETS)
    .map(([preset, style]) => {
      const scene = sceneFor(preset, view);
      const { w, h } = size(scene);
      const svg = sceneToSvg(scene, { ppg: 12, idPrefix: `${preset}-` });
      const q = `?view=${view}`;
      return `<article class="card">
  <header><h3>${esc(style.name)}</h3><code>${esc(preset)}</code></header>
  <div class="map">${svg}</div>
  <footer>
    <a class="button primary" href="/preview/${preset}.png${q}" download="${esc(fileName(preset, view, scene, 'png'))}">PNG for Roll20</a>
    <a class="button" href="/preview/${preset}.svg${q}" download="${esc(fileName(preset, view, scene, 'svg'))}">SVG</a>
    <span class="meta">${w}×${h} squares · ${w * ROLL20_PPG}×${h * ROLL20_PPG} px</span>
  </footer>
</article>`;
    })
    .join('\n');

  const toggle = (['gm', 'players'] as const)
    .map(
      (v) =>
        `<a href="/?view=${v}" class="seg${v === view ? ' on' : ''}"${v === view ? ' aria-current="page"' : ''}>${v === 'gm' ? 'GM view' : 'Players’ view'}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delve</title>
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root {
    --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4;
    --accent: #2C6AA0; --accent-ink: #FFFFFF; --code: #EAEEF2;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A;
            --accent: #6FA6D8; --accent-ink: #0C1520; --code: #131820; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, "Segoe UI", sans-serif; }
  .page { max-width: 1320px; margin: 0 auto; padding: 28px 20px 64px; display: grid; gap: 28px; }
  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
  h1 { font: 400 2.6rem/1 "IM FELL English", Georgia, serif; margin: 0; }
  h2 { font: 400 1.6rem/1.2 "IM FELL English", Georgia, serif; margin: 0; }
  h3 { font-size: 1rem; margin: 0; }
  .status { color: var(--muted); font-size: .88rem; display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .status code { font-size: .82rem; }
  code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  code { background: var(--code); padding: 1px 6px; border-radius: 4px; font-size: .85em; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
  .bar p { margin: 4px 0 0; color: var(--muted); max-width: 70ch; }
  .segmented { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--surface); }
  .seg { padding: 7px 14px; color: var(--ink); text-decoration: none; font-weight: 500; }
  .seg + .seg { border-left: 1px solid var(--line); }
  .seg.on { background: var(--accent); color: var(--accent-ink); }
  .seg:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: grid; grid-template-rows: auto 1fr auto; }
  .card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 12px 14px; }
  .map svg { display: block; width: 100%; height: auto; }
  .card footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line); }
  .button { display: inline-block; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; font-weight: 500; font-size: .9rem; }
  .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .meta { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; }
  section { display: grid; gap: 12px; }
  pre { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font-size: .84rem; line-height: 1.6; }
  .note { color: var(--muted); font-size: .88rem; margin: 0; }
</style>
</head>
<body>
<main class="page">
  <div class="top">
    <h1>Delve</h1>
    <div class="status">
      <span>Release <code>${esc(info.version)}</code></span>
      <span>Started ${esc(info.started)}</span>
      <span><code>${FORMAT} v${FORMAT_VERSION}</code></span>
      <a href="/health">/health</a>
    </div>
  </div>

  <div class="bar">
    <div>
      <h2>${esc(TEST_MAP.name)}</h2>
      <p>The test dungeon in every style. The GM view shows room numbers and secret doors. The players’ view hides both and walls the secret door shut. PNGs come out at Roll20’s 70 px per square with edges on whole squares, so Roll20’s grid lines up.</p>
    </div>
    <nav class="segmented" aria-label="View">${toggle}</nav>
  </div>

  <div class="grid">
${cards}
  </div>

  <section>
    <h2>What the API sees</h2>
    <pre>${esc(describeMap(TEST_MAP))}</pre>
    <p class="note">Preview page from phase 2. Saving maps, the API and live editing come in phases 3–5.</p>
  </section>
</main>
</body>
</html>`;
}

export function registerPreview(app: FastifyInstance, info: AppInfo): void {
  const font = readFileSync(LABEL_FONT_FILE);

  app.get('/', async (req, reply) => {
    const view = asView((req.query as { view?: string }).view);
    return reply.type('text/html; charset=utf-8').send(page(info, view));
  });

  app.get('/fonts/im-fell-english.ttf', async (_req, reply) =>
    reply.type('font/ttf').header('cache-control', 'public, max-age=86400').send(font),
  );

  app.get('/preview/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const m = /^([a-z0-9-]+)\.(svg|png)$/.exec(file);
    if (!m || !PRESETS[m[1]!]) {
      return reply.code(404).send({ error: `no preview "${file}"; try one of ${Object.keys(PRESETS).map((p) => `${p}.png`).join(', ')}` });
    }
    const [, preset, ext] = m as unknown as [string, string, 'svg' | 'png'];
    const q = req.query as { view?: string; ppg?: string; grid?: string };
    const view = asView(q.view);
    const scene = sceneFor(preset, view, q.grid !== '0');
    const ppg = q.ppg === undefined ? ROLL20_PPG : Number(q.ppg);
    if (!Number.isInteger(ppg) || ppg < 10 || ppg > 300) {
      return reply.code(400).send({ error: 'ppg must be a whole number from 10 to 300' });
    }
    const svg = sceneToSvg(scene, { ppg });
    const disposition = `inline; filename="${fileName(preset, view, scene, ext)}"`;
    if (ext === 'svg') return reply.type('image/svg+xml').header('content-disposition', disposition).send(svg);
    const png = await svgToPng(svg);
    return reply.type('image/png').header('content-disposition', disposition).send(png);
  });
}
