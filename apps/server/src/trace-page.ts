// The picture tracer (/import/image): a map picture (a city plan, a scanned
// dungeon) becomes a new map. All the work happens in the browser
// (/assets/trace.js, tracing in /assets/trace-worker.js); the server serves the
// page and receives the finished map through POST /api/v1/maps.
import type { FastifyInstance } from 'fastify';
import { PRESETS } from '@delve/core';
import type { AppInfo } from './app.ts';
import { isLoggedIn, type EditorAuth } from './login.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(info: AppInfo, loggedIn: boolean): string {
  const initial = JSON.stringify({
    version: info.version,
    loggedIn,
    presets: Object.entries(PRESETS).map(([id, s]) => ({ id, name: s.name })),
  }).replace(/</g, '\\u003c');
  const colourCounts = [4, 5, 6, 7, 8, 10, 12].map((k) => `<option value="${k}"${k === 7 ? ' selected' : ''}>${k}</option>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace a picture · Delve</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root {
    --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4;
    --accent: #2C6AA0; --accent-ink: #FFFFFF; --code: #EAEEF2; --bad: #B03A2E; --stage: #E4E8EC;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A;
            --accent: #6FA6D8; --accent-ink: #0C1520; --code: #131820; --bad: #F08A7E; --stage: #0B0E11; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; display: grid; grid-template-rows: auto 1fr; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--surface); }
  header a { color: var(--accent); text-decoration: none; }
  h1 { font: 400 1.7rem/1.1 "IM FELL English", Georgia, serif; margin: 0; }
  h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0; }
  .note { color: var(--muted); font-size: .86rem; margin: 0; }
  .bad { color: var(--bad) !important; }
  code { font-family: ui-monospace, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: .85em; }
  .button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink); background: var(--surface); font: inherit; font-weight: 500; font-size: .88rem; cursor: pointer; white-space: nowrap; }
  .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .button:disabled { opacity: .5; cursor: default; }
  .button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input, select { font: inherit; font-size: .88rem; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 4px 7px; }
  input[type="number"] { width: 5.5rem; }
  #drop { margin: 32px auto; max-width: 720px; padding: 40px 28px; border: 2px dashed var(--line); border-radius: 14px; background: var(--surface); display: grid; gap: 14px; justify-items: start; }
  #drop p { margin: 0; max-width: 62ch; }
  #work { display: grid; grid-template-columns: 1fr 360px; min-height: 0; }
  #work[hidden], #drop[hidden] { display: none; }
  .stage { display: grid; grid-template-rows: auto 1fr; min-height: 0; min-width: 0; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
  .toolbar .sep { width: 1px; align-self: stretch; background: var(--line); margin: 0 4px; }
  #viewport { position: relative; overflow: hidden; background: var(--stage); touch-action: none; cursor: grab; min-height: 320px; }
  #viewport[data-tool="measure"], #viewport[data-tool="crop"] { cursor: crosshair; }
  #content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #pic, #overlay { position: absolute; left: 0; top: 0; image-rendering: auto; }
  #pic[hidden] { display: none; }
  #result[hidden] { display: none; }
  #result svg { display: block; }
  #overlay { overflow: visible; pointer-events: none; }
  #overlay path, #overlay rect, #overlay line { vector-effect: non-scaling-stroke; }
  .o-building { fill: rgba(214, 120, 42, .30); stroke: #D6782A; stroke-width: 1.4; }
  .o-wall { fill: rgba(176, 58, 46, .55); stroke: #B03A2E; stroke-width: 1.4; }
  .o-cutout { fill: rgba(255, 255, 255, .45); stroke: #D6782A; stroke-width: 1.2; stroke-dasharray: 4 3; }
  .o-terrain { fill: rgba(90, 90, 90, .25); stroke: rgba(60, 60, 60, .6); stroke-width: 1; }
  .o-water-deep { fill: rgba(40, 110, 200, .38); stroke: #2A6EC8; }
  .o-grass { fill: rgba(60, 150, 60, .35); stroke: #3C963C; }
  .o-dirt { fill: rgba(140, 100, 50, .35); stroke: #8C6432; }
  .o-cobblestones { fill: rgba(120, 110, 150, .30); stroke: #786E96; }
  .o-sand { fill: rgba(220, 190, 110, .45); stroke: #C8A050; }
  .o-grid { fill: none; stroke: rgba(44, 106, 160, .35); stroke-width: 1; }
  .o-outside { fill: rgba(0, 0, 0, .45); fill-rule: evenodd; }
  .o-crop { fill: none; stroke: #FFFFFF; stroke-width: 1.5; stroke-dasharray: 6 4; }
  .o-measure { stroke: #E0409A; stroke-width: 2.5; }
  .o-measure-end { fill: #E0409A; }
  aside { border-left: 1px solid var(--line); background: var(--surface); overflow-y: auto; padding: 14px 16px 28px; display: grid; gap: 20px; align-content: start; }
  aside section { display: grid; gap: 8px; }
  label.inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: .88rem; }
  .colour { display: grid; grid-template-columns: 28px 3.2rem 1fr; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; }
  .colour select { width: 100%; }
  .swatch { width: 28px; height: 22px; border-radius: 4px; border: 1px solid var(--line); }
  .share { font-size: .82rem; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
  .colour.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: color-mix(in srgb, var(--accent) 35%, transparent); } to { background: transparent; } }
  #status { min-height: 1.4em; }
  #counts { font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .8rem; color: var(--muted); }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; }
  @media (max-width: 860px) {
    #work { grid-template-columns: 1fr; grid-template-rows: 60vh auto; }
    aside { border-left: 0; border-top: 1px solid var(--line); }
  }
</style>
</head>
<body>
<header>
  <a href="/">← Delve</a>
  <h1>Trace a map picture</h1>
  <span class="note">A city plan or dungeon picture with flat colours becomes a map you can edit and export to Dungeon Scrawl.</span>
</header>

<div id="drop">
  <label class="button primary">Choose a picture…<input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden></label>
  <p>Or drop a PNG or JPG anywhere on this page, or paste one.</p>
  <p class="note">Works best with flat colours: a city from Watabou's generator, a map drawn with solid rooms, a clean scan. Labels, a compass or a printed grid are cleaned up as well as possible. If the generator can hide them before you export, the result is cleaner. The picture never leaves your browser; only the finished map is saved.</p>
  ${loggedIn ? '' : '<p class="note bad">You are not logged in: you can try the tracing, but creating the map needs the <a href="/login?next=/import/image">editor login</a>.</p>'}
</div>

<div id="work" hidden>
  <section class="stage" aria-label="Picture">
    <div class="toolbar">
      <button class="button" type="button" data-mode="picture" aria-pressed="true">Picture + outlines</button>
      <button class="button" type="button" data-mode="result">Finished map</button>
      <span class="sep"></span>
      <button class="button" type="button" data-tool="pan" title="Drag to move around, click to find a colour in the list">Move / pick</button>
      <button class="button" type="button" data-tool="measure" title="Click both ends of the scale bar">Measure</button>
      <button class="button" type="button" data-tool="crop" title="Drag a box: only that part is traced">Crop</button>
      <button class="button" type="button" id="crop-clear" disabled>Clear crop</button>
      <span class="sep"></span>
      <button class="button" type="button" id="fit">Fit</button>
      <label class="button">Another picture…<input id="file2" type="file" accept="image/*" hidden></label>
    </div>
    <div id="viewport" data-tool="pan">
      <div id="content"><canvas id="pic"></canvas><svg id="overlay" xmlns="http://www.w3.org/2000/svg"></svg><div id="result" hidden></div></div>
    </div>
  </section>

  <aside>
    <section>
      <p id="status" class="note" role="status"></p>
      <p id="counts" class="note"></p>
      <div class="legend"><span><i style="background:rgba(214,120,42,.55)"></i>building</span><span><i style="background:rgba(176,58,46,.7)"></i>wall</span><span><i style="background:rgba(40,110,200,.5)"></i>water</span><span><i style="background:rgba(60,150,60,.5)"></i>grass</span><span><i style="background:rgba(120,110,150,.5)"></i>road</span><span><i style="background:rgba(140,100,50,.5)"></i>field</span></div>
    </section>

    <section>
      <h2>Colours</h2>
      <p class="note">The picture's main colours. Say what each one is. Click the picture to find a spot's colour here.</p>
      <div id="colours"></div>
      <label class="inline">Look for <select id="k">${colourCounts}</select> colours <button class="button" type="button" id="recolour">Find again</button></label>
    </section>

    <section>
      <h2>Scale</h2>
      <label class="inline">1 square = <select id="feet"><option value="5">5 ft</option><option value="10" selected>10 ft</option><option value="20">20 ft</option></select></label>
      <label class="inline">The whole picture is <input id="width-ft" type="number" min="1" step="any"> ft wide</label>
      <label class="inline">or use <b>Measure</b> on a scale bar: it is <input id="measure-len" type="number" min="0" step="any" placeholder="100"> <select id="measure-unit"><option value="m">m</option><option value="ft">ft</option></select> long</label>
      <p id="scale-readout" class="note"></p>
    </section>

    <section>
      <h2>Clean-up</h2>
      <label class="inline"><input id="grid" type="checkbox" checked> Remove a printed grid</label>
      <label class="inline"><input id="fill" type="checkbox" checked> Fill small holes in buildings (text)</label>
      <label class="inline"><input id="join" type="checkbox"> Join touching buildings into blocks</label>
      <label class="inline">Drop pieces smaller than <input id="min-area" type="number" min="0" max="50" step="0.1" value="0.3"> squares</label>
      <div id="min-widths" style="display:grid;gap:6px"></div>
    </section>

    <section>
      <h2>Map</h2>
      <label class="inline">Name <input id="name" maxlength="200" style="flex:1"></label>
      <label class="inline">Style <select id="style"></select></label>
      <div><button class="button primary" type="button" id="create" disabled>Create map</button></div>
      <p class="note">${loggedIn ? 'It opens in the editor, where you can fix anything the tracing got wrong.' : 'Creating the map needs the <a href="/login?next=/import/image">editor login</a>.'}</p>
    </section>
  </aside>
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/trace.js?v=${esc(encodeURIComponent(info.version))}"></script>
</body>
</html>`;
}

export function registerTracePage(app: FastifyInstance, info: AppInfo, auth: EditorAuth): void {
  app.get('/import/image', async (req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(info, isLoggedIn(auth, req))),
  );
}
