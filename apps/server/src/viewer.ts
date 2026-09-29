// The live viewer page (/maps/:id) and its script (/assets/viewer.js, built
// from apps/web by esbuild). The first picture is rendered on the server, so
// it shows before the script loads; the script then takes over and follows
// changes over the WebSocket.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { PRESETS, sceneToSvg, type DelveMap } from '@delve/core';
import type { AppInfo } from './app.ts';
import { isLoggedIn, type EditorAuth } from './login.ts';
import { asView, sceneFor } from './render.ts';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** release/web/viewer.js next to the bundle, or apps/web/dist/viewer.js in development. */
function findScript(): string | null {
  for (const rel of ['./web/viewer.js', '../../web/dist/viewer.js']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return null;
}

interface PageOpts {
  view: 'gm' | 'players';
  style: string | undefined;
  loggedIn: boolean;
  passwordSet: boolean;
}

function page(info: AppInfo, id: string, rev: number, map: DelveMap, o: PageOpts): string {
  const { view, style } = o;
  const scene = sceneFor(map, { view, style });
  const bg = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '#EFEAE2';
  const initial = JSON.stringify({ id, rev, map, edit: { loggedIn: o.loggedIn, passwordSet: o.passwordSet } }).replace(/</g, '\\u003c');
  const editControl = o.loggedIn
    ? `<button class="btn" id="edit-toggle" aria-pressed="false" title="Edit this map">Edit</button>`
    : `<a class="btn" href="/login?next=${encodeURIComponent(`/maps/${id}?edit=1`)}">Log in to edit</a>`;
  const options = [`<option value="">Map style (${esc(map.style?.preset ?? 'classic-hatching')})</option>`]
    .concat(Object.entries(PRESETS).map(([k, s]) => `<option value="${esc(k)}"${k === style ? ' selected' : ''}>${esc(s.name)}</option>`))
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(map.name)} · Delve</title>
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  @font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }
  :root { --bar: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4; --accent: #2C6AA0; --accent-ink: #FFFFFF; --live: #2E9E5B; --warn: #C98A12; --bad: #C0392B; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bar: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: auto 1fr; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--bar); }
  #main { display: grid; grid-template-columns: 1fr; min-height: 0; }
  body.editing #main { grid-template-columns: 1fr 300px; }
  #panel { border-left: 1px solid var(--line); background: var(--bar); overflow-y: auto; padding: 12px 14px 20px; display: grid; gap: 14px; align-content: start; }
  #panel[hidden] { display: none; }
  #panel h3 { margin: 0; font-size: .95rem; display: flex; gap: 8px; align-items: baseline; }
  #panel code { font: 12px ui-monospace, Consolas, monospace; color: var(--muted); }
  .toolgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .toolgrid button, #panel .row button, #panel > div > button, #props button { font: inherit; text-align: left; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--ink); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .toolgrid button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  kbd { font: 11px ui-monospace, Consolas, monospace; opacity: .7; }
  .opts { display: grid; gap: 6px; }
  .opts label, .field { display: grid; gap: 3px; font-size: 13px; color: var(--muted); }
  .opts label { grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
  .field > span { font-size: 12px; }
  #panel input[type="text"], #panel input[type="number"], #panel select, #panel textarea { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; width: 100%; }
  #panel textarea { resize: vertical; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .row { display: flex; gap: 6px; }
  #props { display: grid; gap: 10px; }
  #props .danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); justify-content: center; }
  .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
  #toast { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); max-width: min(560px, 90%); padding: 8px 12px; border-radius: 8px; background: var(--bad); color: #fff; font-size: 13px; z-index: 3; }
  #toast[data-kind="info"] { background: var(--accent); color: var(--accent-ink); }
  #toast[hidden] { display: none; }
  #overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  #stage[data-tool]:not([data-tool=""]):not([data-tool="select"]) { cursor: crosshair; }
  .ed .sel { fill: none; stroke: #3B9BFF; stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .from { fill: rgba(59, 155, 255, .12); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost { fill: rgba(59, 155, 255, .14); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost-door { stroke: #3B9BFF; stroke-width: 6px; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .ed .ghost-line { fill: rgba(59, 155, 255, .10); stroke: #3B9BFF; stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .start { fill: #3B9BFF; }
  .ed .handle { fill: #FFFFFF; stroke: #3B9BFF; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .cross { stroke: #3B9BFF; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .dim { fill: #3B9BFF; font-family: system-ui, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 3px; vector-effect: non-scaling-stroke; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--bar); }
  .brand { font: 400 1.35rem/1 "IM FELL English", Georgia, serif; color: var(--ink); text-decoration: none; }
  .title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  #map-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
  #map-rev, .muted { color: var(--muted); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
  .seg button { border: 0; background: transparent; color: var(--ink); padding: 5px 11px; font: inherit; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  select, .btn { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; text-decoration: none; cursor: pointer; }
  .btn.primary, .btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button:focus-visible, select:focus-visible, .btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .conn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  #conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
  #conn-dot[data-state="live"] { background: var(--live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 25%, transparent); }
  #conn-dot[data-state="offline"], #conn-dot[data-state="deleted"] { background: var(--bad); }
  #stage { position: relative; overflow: hidden; touch-action: none; cursor: grab; background: ${bg}; }
  #stage.dragging { cursor: grabbing; }
  #canvas { position: absolute; inset: 0; }
  #canvas svg { width: 100%; height: 100%; display: block; }
  #activity { position: absolute; left: 12px; bottom: 12px; padding: 6px 10px; border-radius: 7px; background: color-mix(in srgb, var(--bar) 88%, transparent); border: 1px solid var(--line); color: var(--ink); font-size: 13px; pointer-events: none; }
  .hl-focus { fill: rgba(255, 170, 0, .14); stroke: #FFAA00; stroke-width: 3px; vector-effect: non-scaling-stroke; animation: pulse 1.1s ease-in-out 3; }
  .hl-change { fill: rgba(59, 155, 255, .12); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; animation: fade 1.6s ease-out forwards; }
  @keyframes pulse { 50% { stroke-opacity: .25; fill-opacity: .05; } }
  @keyframes fade { to { stroke-opacity: 0; fill-opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .hl-focus, .hl-change { animation: none; } }
</style>
</head>
<body>
<header>
  <a class="brand" href="/">Delve</a>
  <div class="title"><span id="map-name">${esc(map.name)}</span><span id="map-rev">rev ${rev}</span></div>
  <span class="conn"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="View">
    <button data-view="gm" aria-pressed="${view === 'gm'}">GM view</button><button data-view="players" aria-pressed="${view === 'players'}">Players’ view</button>
  </div>
  <label class="muted" for="style-select">Style</label>
  <select id="style-select">${options}</select>
  <button class="btn" id="fit" title="Fit the map (F or double-click)">Fit</button>
  <a class="btn primary" id="png-link" href="/api/v1/maps/${encodeURIComponent(id)}/render.png?view=${view}">PNG for Roll20</a>
  ${editControl}
</header>
<div id="main">
  <div id="stage">
    <div id="canvas">${sceneToSvg(scene, { ppg: 20 })}</div>
    <svg id="overlay" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" viewBox="${scene.bounds.x0} ${scene.bounds.y0} ${scene.bounds.x1 - scene.bounds.x0} ${scene.bounds.y1 - scene.bounds.y0}"></svg>
    <div id="activity">Waiting for changes</div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="panel" hidden aria-label="Editor">
    <div id="tools"></div>
    <div id="props"></div>
  </aside>
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/viewer.js?v=${encodeURIComponent(info.version)}"></script>
</body>
</html>`;
}

export function registerViewer(app: FastifyInstance, info: AppInfo, store: MapStore, auth: EditorAuth): void {
  let script: string | null = null;

  app.get('/maps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { view?: string; style?: string };
    try {
      const { rev, map } = store.get(id);
      const style = q.style && PRESETS[q.style] ? q.style : undefined;
      const opts = { view: asView(q.view), style, loggedIn: isLoggedIn(auth, req), passwordSet: Boolean(auth.passwordHash) || auth.sessions.open };
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(info, id, rev, map, opts));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><meta charset="utf-8"><title>Not found · Delve</title><p style="font-family:system-ui;margin:3rem">No map with id <code>${esc(id)}</code>. <a href="/">Back to Delve</a></p>`);
    }
  });

  app.get('/assets/viewer.js', async (_req, reply) => {
    if (script === null) {
      const file = findScript();
      if (!file) return reply.code(404).type('text/plain').send('viewer script not built: run npm run build:web');
      script = readFileSync(file, 'utf8');
    }
    // Releases change ?v= with every version; a dev server is always "dev", so never cache there.
    const cache = info.version === 'dev' ? 'no-store' : 'public, max-age=300';
    return reply.type('text/javascript; charset=utf-8').header('cache-control', cache).send(script);
  });
}
