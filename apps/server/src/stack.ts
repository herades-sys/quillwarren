// The 3D view (/maps/:id/3d): all storeys of a place stacked like a cutaway
// model, with the stairs that connect them. The page is a shell; the script
// (/assets/stack.js, apps/web/src/stack.ts, with three.js) builds the scene
// from the storeys' maps and their floor PNGs.
import type { FastifyInstance } from 'fastify';
import { levelSiblings } from '@delve/core';
import type { AppInfo } from './app.ts';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(info: AppInfo, id: string, name: string, storeys: unknown[], view: 'gm' | 'players'): string {
  const initial = JSON.stringify({ id, name, storeys }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} in 3D · Delve</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root { --bar: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4; --accent: #2C6AA0; --accent-ink: #FFFFFF; --bad: #C0392B; --link: #D98E04; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bar: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; --link: #F0B429; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: auto 1fr; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--bar); }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  .brand { font: 400 1.35rem/1 "IM FELL English", Georgia, serif; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; gap: 7px; }
  .brand img { display: block; border-radius: 4px; }
  .title { font-weight: 600; }
  .muted { color: var(--muted); }
  .spacer { flex: 1; }
  .btn, select { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; text-decoration: none; cursor: pointer; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
  .seg button { border: 0; background: transparent; color: var(--ink); padding: 5px 11px; font: inherit; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  #main { display: grid; grid-template-columns: 270px 1fr; min-height: 0; }
  #side { border-right: 1px solid var(--line); padding: 12px 14px 20px; overflow-y: auto; display: grid; gap: 12px; align-content: start; }
  #side h3 { margin: 4px 0 0; font-size: .95rem; }
  .storey { display: flex; align-items: center; gap: 8px; }
  .storey label { flex: 1; display: flex; gap: 7px; align-items: center; cursor: pointer; }
  .storey a { font-size: 12.5px; color: var(--accent); }
  .slider { display: grid; gap: 3px; font-size: 13px; color: var(--muted); }
  .slider input { width: 100%; }
  .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
  #stairs ul { margin: 4px 0 0; padding-left: 18px; }
  #stairs li { margin: 2px 0; }
  .ok { color: var(--link); }
  .bad { color: var(--bad); }
  #stage { position: relative; min-width: 0; min-height: 0; background: #20242B; }
  #stage canvas { display: block; width: 100%; height: 100%; }
  #status { position: absolute; left: 12px; bottom: 12px; padding: 6px 10px; border-radius: 7px; background: rgba(25, 30, 36, .8); color: #E5E9ED; font-size: 13px; pointer-events: none; }
  #status[hidden] { display: none; }
  @media (max-width: 700px) { #main { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } #side { border-right: 0; border-bottom: 1px solid var(--line); max-height: 40vh; } }
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/assets/brand/mark.svg" alt="" width="22" height="22">Delve</a>
  <span class="title">${esc(name)}</span><span class="muted">in 3D</span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="View">
    <button data-view="gm" aria-pressed="${view === 'gm'}">GM view</button><button data-view="players" aria-pressed="${view === 'players'}">Players’ view</button>
  </div>
  <button class="btn" id="fit3d" title="Back to the starting view">Reset view</button>
  <button class="btn" id="snapshot" title="Download this view as a PNG">Save picture</button>
  <a class="btn primary" href="/maps/${encodeURIComponent(id)}">2D map</a>
</header>
<div id="main">
  <aside id="side" aria-label="3D view settings">
    <h3>Storeys</h3>
    <div id="storeys"></div>
    <label class="slider">Spread between storeys <input type="range" id="spread" min="2" max="30" step="0.5" value="12"></label>
    <label class="slider">Wall height <input type="range" id="walls" min="0" max="3" step="0.1" value="0.9"></label>
    <h3>Stairs</h3>
    <div id="stairs"><p class="hint">Loading…</p></div>
    <p class="hint">Drag to turn, right-drag or Shift-drag to pan, scroll to zoom. Double-click a floor to edit that storey.</p>
  </aside>
  <div id="stage"><div id="status">Loading the storeys…</div></div>
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/stack.js?v=${encodeURIComponent(info.version)}"></script>
</body>
</html>`;
}

export function registerStack(app: FastifyInstance, info: AppInfo, store: MapStore): void {
  app.get('/maps/:id/3d', async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = (req.query as { view?: string }).view === 'players' ? 'players' : 'gm';
    try {
      const { map } = store.get(id);
      const storeys = levelSiblings(store.list(), id)
        .reverse()
        .map((m) => ({ id: m.id, name: m.name, level: m.level }));
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(info, id, map.name, storeys, view));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Not found · Delve</title><p style="font-family:system-ui;margin:3rem">No map with id <code>${esc(id)}</code>. <a href="/">Back to Delve</a></p>`);
    }
  });
}
