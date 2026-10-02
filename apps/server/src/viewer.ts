// The map page (/maps/:id, built in editor-page.ts) and its script (/assets/viewer.js, built
// from apps/web by esbuild). The first picture is rendered on the server, so
// it shows before the script loads; the script then takes over and follows
// changes over the WebSocket.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { levelSiblings, PRESETS, revealedBounds, sceneToSvg, type DelveMap } from '@delve/core';
import { currentAccount } from './accounts/http.ts';
import type { AppInfo } from './app.ts';
import type { ChatConfig } from './chat/route.ts';
import { editorPage } from './editor-page.ts';
import { htmlDocument, icon } from '@delve/ui';
import { canLogIn, isLoggedIn, type EditorAuth } from './login.ts';
import { asView, sceneFor } from './render.ts';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** release/web/<name> next to the bundle, or apps/web/dist/<name> in development. */
export function findScript(name: string): string | null {
  for (const rel of [`./web/${name}`, `../../web/dist/${name}`]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The players' screen (/maps/:id/screen): the players' view with fog of war,
 * full screen, following every change live. For a TV at the table or a
 * Discord screen share. The script is /assets/screen.js.
 */
/**
 * What a players' screen gets: the picture (built only from what the players
 * have seen) and where to frame it. Never the map itself.
 */
export function screenPayload(map: DelveMap, rev: number) {
  const scene = sceneFor(map, { view: 'players', fog: '1' });
  const fogged = Boolean(map.fog?.on);
  const seen = fogged ? revealedBounds(map) : null;
  const frame = fogged ? (seen ? { x0: seen.x0 - 2, y0: seen.y0 - 2, x1: seen.x1 + 2, y1: seen.y1 + 2 } : null) : scene.bounds;
  return {
    rev,
    name: map.name,
    background: scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '#EFEAE2',
    frame,
    hidden: fogged && !seen,
    svg: sceneToSvg(scene, { ppg: 20 }),
  };
}

function screenPage(info: AppInfo, id: string, rev: number, map: DelveMap): string {
  const { svg, ...rest } = screenPayload(map, rev);
  const initial = JSON.stringify({ id, ...rest }).replace(/</g, '\u003c');
  // The players' screen is for a TV or a screen share: only the map, on its own paper colour.
  const css = `<style>
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { background: ${rest.background}; }
  #stage, #canvas { position: absolute; inset: 0; }
  #canvas svg { width: 100%; height: 100%; display: block; }
  #full { position: absolute; right: 14px; bottom: 14px; background: var(--color-surface); box-shadow: var(--shadow-md); opacity: 0; transition: opacity .3s; }
  body:hover #full, #full:focus-visible { opacity: 1; }
  #note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); color: #5B5348; font-family: var(--font-display); font-style: italic; font-size: 1.8rem; text-align: center; pointer-events: none; }
</style>`;
  const body = `<div id="stage"><div id="canvas">${svg}</div></div>
<div id="note"${rest.hidden ? '' : ' hidden'}>The map is still hidden.</div>
<button class="btn btn-secondary" id="full" type="button" title="Full screen · F">${icon('fit', { size: 16 })}Full screen</button>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/screen.js?v=${encodeURIComponent(info.version)}"></script>`;
  return htmlDocument({ title: `${map.name} · Players’ screen`, body, extra: css });
}

export function registerViewer(app: FastifyInstance, info: AppInfo, store: MapStore, auth: EditorAuth, chat?: ChatConfig): void {
  app.get('/maps/:id/screen', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { rev, map } = store.get(id);
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(screenPage(info, id, rev, map));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).type('text/plain').send('no such map');
    }
  });

  // The players' screen fetches its picture here whenever the map changes.
  app.get('/api/v1/maps/:id/screen', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { rev, map } = store.get(id);
      return reply.header('cache-control', 'no-store').send(screenPayload(map, rev));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).send({ error: `no map with id "${id}"` });
    }
  });

  const scripts = new Map<string, string>();

  app.get('/maps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { view?: string; style?: string };
    try {
      const { rev, map } = store.get(id);
      const style = q.style && PRESETS[q.style] ? q.style : undefined;
      const user = currentAccount(auth, req)?.user;
      const opts = {
        view: asView(q.view),
        style,
        loggedIn: isLoggedIn(auth, req),
        passwordSet: canLogIn(auth) || auth.sessions.open,
        chatModel: chat ? (chat.model ?? 'sonnet') : null,
        levels: levelSiblings(store.list(), id).reverse(),
        account: user ? { name: user.name, role: user.role } : null,
      };
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(editorPage(info, id, rev, map, opts));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><meta charset="utf-8"><title>Not found · Delve</title><p style="font-family:system-ui;margin:3rem">No map with id <code>${esc(id)}</code>. <a href="/">Back to Delve</a></p>`);
    }
  });

  // viewer.js: the viewer and editor; stack.js: the 3D view (with three.js, so only that page loads it);
  // table-dice.js: the table's 3D dice, which table.js imports on the first roll; table3d.js: the 3D table view.
  for (const name of ['viewer.js', 'stack.js', 'screen.js', 'trace.js', 'trace-worker.js', 'table.js', 'table-dice.js', 'table3d.js']) {
    app.get(`/assets/${name}`, async (_req, reply) => {
      let script = scripts.get(name);
      if (script === undefined) {
        const file = findScript(name);
        if (!file) return reply.code(404).type('text/plain').send(`${name} not built: run npm run build:web`);
        scripts.set(name, (script = readFileSync(file, 'utf8')));
      }
      // Releases change ?v= with every version; a dev server is always "dev", so never cache there.
      const cache = info.version === 'dev' ? 'no-store' : 'public, max-age=300';
      return reply.type('text/javascript; charset=utf-8').header('cache-control', cache).send(script);
    });
  }
}
