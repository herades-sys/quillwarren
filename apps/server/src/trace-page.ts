// The picture tracer (/import/image): a map picture (a city plan, a scanned
// dungeon) becomes a new map. All the work happens in the browser
// (/assets/trace.js, tracing in /assets/trace-worker.js); the server serves the
// page and receives the finished map through POST /api/v1/maps.
import type { FastifyInstance } from 'fastify';
import { PRESETS, SQUARE_SIZES } from '@delve/core';
import { htmlDocument, themeSwitch, topBar } from '@delve/ui';
import type { AppInfo } from './app.ts';
import { isLoggedIn, type EditorAuth } from './login.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


const PAGE_CSS = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  .note { color: var(--color-text-muted); font-size: var(--text-sm); margin: 0; line-height: 1.5; }
  .bad { color: var(--color-danger) !important; }
  code { background: var(--color-surface-2); padding: 1px 5px; border-radius: 4px; font-size: .85em; }
  .btn[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); border-color: color-mix(in srgb, var(--color-accent) 55%, transparent); }
  #work input[type="number"], #work input:not([type]), #work input[type="text"], #work select { font: inherit; font-size: var(--text-md); color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); padding: 3px 8px; min-height: 30px; }
  #work input:hover, #work select:hover { border-color: var(--color-text-muted); }
  #work input:focus-visible, #work select:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
  #work input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--color-accent); }
  input[type="number"] { width: 5.5rem; }
  #drop { margin: 40px auto; width: min(720px, calc(100% - 32px)); padding: 40px 28px; border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1.5px var(--color-border-strong); background: var(--color-surface); display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
  #drop p { margin: 0; max-width: 62ch; }
  #drop .display-md { margin: 0; }
  #work { flex: 1; display: grid; grid-template-columns: 1fr 360px; min-height: 0; }
  .stage { display: grid; grid-template-rows: auto 1fr; min-height: 0; min-width: 0; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px; background: var(--color-surface); box-shadow: inset 0 -1px 0 var(--color-border); }
  .toolbar .sep { width: 1px; height: 20px; background: var(--color-border-strong); margin: 0 4px; }
  .toolbar .btn { height: var(--control-sm); padding: 0 10px; font-size: var(--text-sm); }
  #viewport { position: relative; overflow: hidden; background: var(--color-bg); touch-action: none; cursor: grab; min-height: 320px; }
  #viewport[data-tool="measure"], #viewport[data-tool="crop"], #viewport[data-tool="lines"] { cursor: crosshair; }
  #content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #pic, #overlay { position: absolute; left: 0; top: 0; image-rendering: auto; }
  #result svg { display: block; }
  #overlay { overflow: visible; pointer-events: none; }
  #overlay path, #overlay rect, #overlay line { vector-effect: non-scaling-stroke; }
  .o-building { fill: rgba(214, 120, 42, .30); stroke: #D6782A; stroke-width: 1.4; }
  .o-room { fill: rgba(214, 120, 42, .28); stroke: #C2611F; stroke-width: 1.6; }
  .o-corridor { fill: rgba(200, 160, 40, .30); stroke: #A88412; stroke-width: 1.4; stroke-dasharray: 5 3; }
  .o-wall { fill: rgba(176, 58, 46, .55); stroke: #B03A2E; stroke-width: 1.4; }
  .o-tower { fill: rgba(220, 40, 40, .60); stroke: #8C1C1C; stroke-width: 1.4; }
  .o-door { stroke: #E0409A; stroke-width: 4; stroke-linecap: round; }
  .o-gridline { fill: none; stroke: rgba(224, 64, 154, .7); stroke-width: 1.5; }
  .o-cutout { fill: rgba(255, 255, 255, .45); stroke: #D6782A; stroke-width: 1.2; stroke-dasharray: 4 3; }
  .o-terrain { fill: rgba(90, 90, 90, .25); stroke: rgba(60, 60, 60, .6); stroke-width: 1; }
  .o-water-deep { fill: rgba(40, 110, 200, .38); stroke: #2A6EC8; }
  .o-grass { fill: rgba(60, 150, 60, .35); stroke: #3C963C; }
  .o-dirt { fill: rgba(140, 100, 50, .35); stroke: #8C6432; }
  .o-cobblestones { fill: rgba(120, 110, 150, .30); stroke: #786E96; }
  .o-sand { fill: rgba(220, 190, 110, .45); stroke: #C8A050; }
  .o-grid { fill: none; stroke: rgba(79, 64, 166, .35); stroke-width: 1; }
  .o-outside { fill: rgba(0, 0, 0, .45); fill-rule: evenodd; }
  .o-crop { fill: none; stroke: #FFFFFF; stroke-width: 1.5; stroke-dasharray: 6 4; }
  .o-measure { stroke: #E0409A; stroke-width: 2.5; }
  .o-measure-end { fill: #E0409A; }
  aside { background: var(--color-surface); box-shadow: inset 1px 0 0 var(--color-border); overflow-y: auto; padding: 14px 16px 28px; display: flex; flex-direction: column; gap: 20px; }
  aside section { display: flex; flex-direction: column; gap: 8px; }
  aside h2 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--color-text-muted); margin: 0; font-weight: 400; }
  label.inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--text-md); }
  .colour { display: grid; grid-template-columns: 28px 3.2rem 1fr; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; }
  .colour select { width: 100%; }
  .swatch { width: 28px; height: 22px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .share { font-size: var(--text-sm); color: var(--color-text-muted); font-variant-numeric: tabular-nums; text-align: right; }
  .colour.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: color-mix(in srgb, var(--color-accent) 35%, transparent); } to { background: transparent; } }
  .seg { width: fit-content; flex-wrap: wrap; }
  .scale-from[hidden], [data-for][hidden] { display: none !important; }
  .opts { display: grid; gap: 8px; }
  #status { min-height: 1.4em; }
  #counts { font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--text-xs); color: var(--color-text-muted); }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; }
  @media (max-width: 860px) {
    #work { grid-template-columns: 1fr; grid-template-rows: 60vh auto; }
    aside { box-shadow: inset 0 1px 0 var(--color-border); }
  }
`;

function page(info: AppInfo, loggedIn: boolean): string {
  const initial = JSON.stringify({
    version: info.version,
    loggedIn,
    presets: Object.entries(PRESETS).map(([id, s]) => ({ id, name: s.name })),
  }).replace(/</g, '\\u003c');
  const colourCounts = [4, 5, 6, 7, 8, 10, 12, 14, 16].map((k) => `<option value="${k}"${k === 8 ? ' selected' : ''}>${k}</option>`).join('');
  const squareOptions = SQUARE_SIZES.map((u) => `<option value="${esc(u)}"${u === '5 ft' ? ' selected' : ''}>${esc(u)}</option>`).join('');
  const body = `${topBar({ crumbs: [{ href: '/', text: 'Library' }], title: 'Trace a picture', end: themeSwitch() })}
<div id="drop">
  <h1 class="display-md">Trace a map picture</h1>
  <p class="note">A dungeon or battle map, or a city plan (generated, drawn or painted), becomes a map you can edit and export to Dungeon Scrawl.</p>
  <label class="btn btn-primary">Choose a picture…<input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden></label>
  <p>Or drop a PNG, JPG or WebP anywhere on this page, or paste one.</p>
  <p class="note">Dungeon and battle maps: the floor inside the wall lines becomes rooms and corridors, the printed grid sets the scale, doors are found. City plans: houses, the city wall with its towers, water, streets, gardens and fields; painted maps are smoothed first. Numbers, labels and a legend are left out as well as possible; cropping helps. The picture never leaves your browser; only the finished map is saved.</p>
  ${loggedIn ? '' : '<p class="note bad">You are not logged in: you can try the tracing, but creating the map needs the <a href="/login?next=/import/image">editor login</a>.</p>'}
</div>

<div id="work" hidden>
  <section class="stage" aria-label="Picture">
    <div class="toolbar">
      <button class="btn btn-secondary" type="button" data-mode="picture" aria-pressed="true">Picture + outlines</button>
      <button class="btn btn-secondary" type="button" data-mode="result">Finished map</button>
      <span class="sep"></span>
      <button class="btn btn-secondary" type="button" data-tool="pan" title="Drag to move around, click to find a colour in the list">Move / pick</button>
      <button class="btn btn-secondary" type="button" data-tool="measure" title="Click both ends of the scale bar">Measure</button>
      <button class="btn btn-secondary" type="button" data-tool="lines" title="Click two grid lines, then say how many squares apart they are">Grid lines</button>
      <button class="btn btn-secondary" type="button" data-tool="crop" title="Drag a box: only that part is traced">Crop</button>
      <button class="btn btn-secondary" type="button" id="crop-clear" disabled>Clear crop</button>
      <span class="sep"></span>
      <label class="inline"><input id="show-grid" type="checkbox" checked> Squares</label>
      <button class="btn btn-secondary" type="button" id="fit">Fit</button>
      <label class="btn btn-secondary">Another picture…<input id="file2" type="file" accept="image/*" hidden></label>
    </div>
    <div id="viewport" data-tool="pan">
      <div id="content"><canvas id="pic"></canvas><svg id="overlay" xmlns="http://www.w3.org/2000/svg"></svg><div id="result" hidden></div></div>
    </div>
  </section>

  <aside>
    <section>
      <p id="status" class="note" role="status"></p>
      <p id="counts" class="note"></p>
      <div class="legend" id="legend"></div>
    </section>

    <section>
      <h2>Kind of map</h2>
      <div class="seg" role="radiogroup" aria-label="Kind of map">
        <label class="seg-opt"><input type="radio" name="kind" value="dungeon" checked> Dungeon or battle map</label>
        <label class="seg-opt"><input type="radio" name="kind" value="city"> City plan</label>
      </div>
      <label class="inline" title="Brush strokes, shaded roofs and textures are smoothed before the colours are found"><input id="painted" type="checkbox"> Painted or textured (smooth it first)</label>
      <p id="kind-note" class="note"></p>
    </section>

    <section>
      <h2>Scale</h2>
      <label class="inline">1 square = <select id="unit">${squareOptions}</select></label>
      <div class="seg" role="radiogroup" aria-label="Scale from">
        <label class="seg-opt"><input type="radio" name="scale-from" value="grid" checked> Grid</label>
        <label class="seg-opt"><input type="radio" name="scale-from" value="bar"> Scale bar</label>
        <label class="seg-opt"><input type="radio" name="scale-from" value="width"> Width</label>
      </div>
      <div id="from-grid" class="scale-from">
        <p id="grid-note" class="note"></p>
        <label class="inline">A grid cell is <input id="cell" type="number" min="3" step="any"> px, and <input id="cell-squares" type="number" min="0.25" step="any" value="1"> square(s)</label>
        <label class="inline">or click <b>Grid lines</b> on two lines <input id="lines-count" type="number" min="1" step="1" value="5"> squares apart</label>
      </div>
      <div id="from-bar" class="scale-from" hidden>
        <label class="inline">Use <b>Measure</b> on the scale bar: it is <input id="measure-len" type="number" min="0" step="any" placeholder="100"> <select id="measure-unit"><option value="m">m</option><option value="ft">ft</option></select> long</label>
      </div>
      <div id="from-width" class="scale-from" hidden>
        <label class="inline">The whole picture is <input id="width-len" type="number" min="1" step="any"> <select id="width-unit"><option value="ft">ft</option><option value="m">m</option></select> wide</label>
      </div>
      <p id="scale-readout" class="note"></p>
    </section>

    <section>
      <h2>Colours</h2>
      <p class="note">The picture's main colours. Say what each one is. Click the picture to find a spot's colour here.</p>
      <div id="colours"></div>
      <label class="inline">Look for <select id="k">${colourCounts}</select> colours <button class="btn btn-secondary" type="button" id="recolour">Find again</button></label>
    </section>

    <section>
      <h2>Clean-up</h2>
      <div data-for="dungeon" class="opts">
        <label class="inline"><input id="split" type="checkbox" checked> Split the floor into rooms and corridors</label>
        <label class="inline"><input id="snap" type="checkbox" checked> Straight walls onto the half-square grid</label>
      </div>
      <div data-for="city" class="opts">
        <label class="inline" data-for="flat"><input id="grid" type="checkbox" checked> Remove a printed grid</label>
        <label class="inline"><input id="fill" type="checkbox" checked> Fill small holes in buildings (text)</label>
        <label class="inline"><input id="join" type="checkbox"> Join touching buildings into blocks</label>
        <label class="inline" data-for="painted"><input id="regular" type="checkbox" checked> Square up houses</label>
        <div id="min-widths" data-for="flat" style="display:grid;gap:6px"></div>
      </div>
      <label class="inline">Drop pieces smaller than <input id="min-area" type="number" min="0" max="50" step="0.1" value="0.3"> squares</label>
    </section>

    <section>
      <h2>Map</h2>
      <label class="inline">Name <input id="name" maxlength="200" style="flex:1"></label>
      <label class="inline">Style <select id="style"></select></label>
      <div><button class="btn btn-primary" type="button" id="create" disabled>Create map</button></div>
      <p class="note">${loggedIn ? 'It opens in the editor, where you can fix anything the tracing got wrong.' : 'Creating the map needs the <a href="/login?next=/import/image">editor login</a>.'}</p>
    </section>
  </aside>
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/trace.js?v=${esc(encodeURIComponent(info.version))}"></script>
`;
  return htmlDocument({ title: 'Trace a picture', body, extra: `<style>${PAGE_CSS}</style>` });
}

export function registerTracePage(app: FastifyInstance, info: AppInfo, auth: EditorAuth): void {
  app.get('/import/image', async (req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(info, isLoggedIn(auth, req))),
  );
}
