// The 3D view (/maps/:id/3d): all storeys of a place stacked like a cutaway
// model, with the stairs that connect them. The page is a shell; the script
// (/assets/stack.js, apps/web/src/stack.ts, with three.js) builds the scene
// from the storeys' maps and their floor PNGs.
import type { FastifyInstance } from 'fastify';
import { levelSiblings } from '@delve/core';
import { htmlDocument, icon, jsonForScript, themeSwitch, topBar } from '@delve/ui';
import type { AppInfo } from './app.ts';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


const PAGE_CSS = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  .stk-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 280px 1fr; }
  .stk-side { background: var(--color-surface); box-shadow: inset -1px 0 0 var(--color-border); padding: 14px 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .stk-side .section-label { margin-top: 4px; }
  .storey { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .storey label { flex: 1; display: flex; gap: 9px; align-items: center; cursor: pointer; }
  .storey input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--color-accent); }
  .storey a { font-size: var(--text-sm); color: var(--color-accent-text); }
  .hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
  #stairs ul { margin: 2px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
  .ok { color: var(--color-text); }
  .ok::marker { color: var(--marker-discover); }
  .bad { color: var(--color-danger); }
  #stage { position: relative; min-width: 0; min-height: 0; background: #20242B; }
  #stage canvas { display: block; width: 100%; height: 100%; }
  #status { position: absolute; left: 12px; bottom: 12px; padding: 7px 12px; border-radius: 10px; background: var(--color-surface-2); color: var(--color-text); box-shadow: var(--shadow-lg); font-size: var(--text-md); pointer-events: none; }
  @media (max-width: 760px) {
    .stk-main { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .stk-side { box-shadow: inset 0 -1px 0 var(--color-border); max-height: 40vh; }
    .stk-wide { display: none !important; }
  }
`;

function page(info: AppInfo, id: string, name: string, storeys: unknown[], view: 'gm' | 'players'): string {
  const initial = jsonForScript({ id, name, storeys });
  const enc = encodeURIComponent(id);
  const end = `<div class="seg seg-ground" role="group" aria-label="View">
    <button class="seg-opt" type="button" data-view="gm" aria-pressed="${view === 'gm'}">${icon('eye', { size: 16 })}GM view</button><button class="seg-opt" type="button" data-view="players" aria-pressed="${view === 'players'}">${icon('eye-off', { size: 16 })}Players</button>
  </div>
  <span class="vsep stk-wide" style="margin:0 4px"></span>
  <button class="btn btn-plain stk-wide" type="button" id="fit3d" title="Back to the starting view">${icon('fit', { size: 16 })}Reset view</button>
  <button class="btn btn-secondary stk-wide" type="button" id="snapshot" title="Download this view as a PNG">${icon('download', { size: 16 })}Save picture</button>
  <a class="btn btn-primary" href="/maps/${enc}">${icon('layers', { size: 16 })}2D map</a>
  ${themeSwitch()}`;
  const body = `${topBar({ crumbs: [{ href: '/', text: 'Library' }, { href: `/maps/${enc}`, text: name }], title: '3D view', end })}
<div class="stk-main">
  <aside class="stk-side" aria-label="3D view settings">
    <span class="section-label">Storeys</span>
    <div id="storeys"></div>
    <div><div class="range-head"><label for="spread">Spread between storeys</label></div><input class="range" type="range" id="spread" min="2" max="30" step="0.5" value="12"></div>
    <div><div class="range-head"><label for="walls">Wall height</label></div><input class="range" type="range" id="walls" min="0" max="3" step="0.1" value="0.9"></div>
    <span class="section-label">Stairs</span>
    <div id="stairs"><p class="hint">Loading…</p></div>
    <p class="hint">Drag to turn, right-drag or Shift-drag to pan, scroll to zoom. Double-click a floor to edit that storey.</p>
  </aside>
  <div id="stage"><div id="status">Loading the storeys…</div></div>
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/stack.js?v=${encodeURIComponent(info.version)}"></script>`;
  return htmlDocument({ title: `${name} in 3D`, body, extra: `<style>${PAGE_CSS}</style>` });
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
