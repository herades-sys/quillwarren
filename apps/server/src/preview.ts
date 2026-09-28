// The start page: saved maps with downloads, and the test dungeon in every
// style with a GM / players' view switch. A stand-in until the editor (phase 4).
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  describeMap,
  FORMAT,
  FORMAT_VERSION,
  PRESETS,
  sceneToSvg,
  validateMap,
  type DelveMap,
  type Scene,
  type View,
} from '@delve/core';
import testMapJson from '../../../fixtures/test-map-4p.delve.json' with { type: 'json' };
import { editorSession, errorResponse, newMap } from './api.ts';
import type { AppInfo } from './app.ts';
import { isLoggedIn, type EditorAuth } from './login.ts';
import { LABEL_FONT_FILE } from './png.ts';
import { asView, exportName, render, RenderQueryError, ROLL20_PPG, sceneFor, sizeInSquares, type RenderQuery } from './render.ts';
import type { MapStore } from './store.ts';

const TEST_MAP: DelveMap = validateMap(structuredClone(testMapJson));

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const scenes = new Map<string, Scene>();
function testScene(preset: string, view: View): Scene {
  const key = `${preset}|${view}`;
  let s = scenes.get(key);
  if (!s) scenes.set(key, (s = sceneFor(TEST_MAP, { style: preset, view })));
  return s;
}

function savedMaps(store: MapStore): string {
  const maps = store.list();
  if (!maps.length) {
    return `<p class="note">No saved maps yet. Create one with <code>POST /api/v1/maps</code> (see docs/API.md).</p>`;
  }
  const rows = maps
    .map((m) => {
      const base = `/api/v1/maps/${encodeURIComponent(m.id)}`;
      return `<tr>
  <td><strong>${esc(m.name)}</strong><br><code>${esc(m.id)}</code></td>
  <td class="num">${m.rev}</td><td class="num">${m.objects}</td>
  <td class="meta">${esc(m.updated.replace('T', ' ').slice(0, 16))}</td>
  <td class="links"><a class="button primary" href="/maps/${encodeURIComponent(m.id)}">Open live view</a>
    <a class="button" href="${base}/render.png?view=players">Roll20 PNG · players</a>
    <a class="button" href="${base}/render.png">PNG · GM</a> <a class="button" href="${base}/render.svg">SVG</a>
    <a class="button" href="${base}/describe">Text</a></td>
</tr>`;
    })
    .join('\n');
  return `<div class="table"><table>
<thead><tr><th>Map</th><th class="num">Rev</th><th class="num">Objects</th><th>Updated (UTC)</th><th>Downloads</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function accountBar(loggedIn: boolean, passwordSet: boolean): string {
  if (loggedIn) return `<form method="post" action="/logout" class="inline"><button class="button" type="submit">Log out</button></form>`;
  return passwordSet ? `<a class="button" href="/login">Log in to edit</a>` : `<span class="note">Editing: set a password with <code>delve-passwd</code> on the container</span>`;
}

function newMapForm(): string {
  const styles = Object.entries(PRESETS).map(([k, s]) => `<option value="${esc(k)}">${esc(s.name)}</option>`).join('');
  return `<form method="post" action="/maps/new" class="newmap">
  <label>Name <input name="name" required maxlength="200" placeholder="e.g. Goblin warren"></label>
  <label>Style <select name="style">${styles}</select></label>
  <label>Start from <select name="template"><option value="empty">an empty map</option><option value="test-dungeon">the test dungeon</option></select></label>
  <button class="button primary" type="submit">New map</button>
</form>`;
}

function page(info: AppInfo, view: View, store: MapStore, loggedIn: boolean, passwordSet: boolean): string {
  const cards = Object.entries(PRESETS)
    .map(([preset, style]) => {
      const scene = testScene(preset, view);
      const { w, h } = sizeInSquares(scene);
      const svg = sceneToSvg(scene, { ppg: 12, idPrefix: `${preset}-` });
      const q = `?view=${view}`;
      return `<article class="card">
  <header><h3>${esc(style.name)}</h3><code>${esc(preset)}</code></header>
  <div class="map">${svg}</div>
  <footer>
    <a class="button primary" href="/preview/${preset}.png${q}" download="${esc(exportName(TEST_MAP, preset, view, scene, 'png'))}">PNG for Roll20</a>
    <a class="button" href="/preview/${preset}.svg${q}" download="${esc(exportName(TEST_MAP, preset, view, scene, 'svg'))}">SVG</a>
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
  .page { max-width: 1320px; margin: 0 auto; padding: 28px 20px 64px; display: grid; gap: 32px; }
  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
  h1 { font: 400 2.6rem/1 "IM FELL English", Georgia, serif; margin: 0; }
  h2 { font: 400 1.6rem/1.2 "IM FELL English", Georgia, serif; margin: 0; }
  h3 { font-size: 1rem; margin: 0; }
  .status { color: var(--muted); font-size: .88rem; display: flex; flex-wrap: wrap; gap: 6px 14px; }
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
  .button { display: inline-block; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; font-weight: 500; font-size: .88rem; white-space: nowrap; }
  .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .meta { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; }
  section { display: grid; gap: 12px; }
  .table { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .links { display: flex; flex-wrap: wrap; gap: 6px; }
  pre { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font-size: .84rem; line-height: 1.6; }
  .note { color: var(--muted); font-size: .9rem; margin: 0; }
  .spacer { flex: 1; }
  form.inline { display: inline; margin: 0; }
  button.button { font: inherit; cursor: pointer; background: transparent; }
  button.button.primary { background: var(--accent); }
  .newmap { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .newmap label { display: grid; gap: 4px; font-size: .82rem; color: var(--muted); }
  .newmap input, .newmap select { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; min-width: 12rem; }
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
      <a href="/health">/health</a> <a href="/api/v1/maps">/api/v1/maps</a>
    </div>
    <span class="spacer"></span>
    ${accountBar(loggedIn, passwordSet)}
  </div>

  <section>
    <h2>Saved maps</h2>
    ${loggedIn ? newMapForm() : ''}
    ${savedMaps(store)}
  </section>

  <section>
    <div class="bar">
      <div>
        <h2>Style preview: ${esc(TEST_MAP.name)}</h2>
        <p>The GM view shows room numbers and secret doors. The players’ view hides both and walls the secret door shut. PNGs come out at Roll20’s 70 px per square with edges on whole squares, so Roll20’s grid lines up.</p>
      </div>
      <nav class="segmented" aria-label="View">${toggle}</nav>
    </div>
    <div class="grid">
${cards}
    </div>
  </section>

  <section>
    <h2>What the API sees</h2>
    <pre>${esc(describeMap(TEST_MAP))}</pre>
    <p class="note">The map editor with live updates comes in phases 4–5.</p>
  </section>
</main>
</body>
</html>`;
}

export function registerPreview(app: FastifyInstance, info: AppInfo, store: MapStore, auth: EditorAuth): void {
  const font = readFileSync(LABEL_FONT_FILE);

  app.get('/', async (req, reply) => {
    const view = asView((req.query as { view?: string }).view);
    const html = page(info, view, store, isLoggedIn(auth, req), Boolean(auth.passwordHash) || auth.sessions.open);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  // The start page's "New map" form (logged-in editors only).
  app.post('/maps/new', async (req, reply) => {
    if (!editorSession(auth.sessions, req)) return reply.code(401).type('text/plain').send('log in to create maps');
    const body = (req.body ?? {}) as { name?: unknown; style?: unknown; template?: unknown };
    try {
      const change = store.create(newMap(body), 'editor');
      return reply.redirect(`/maps/${encodeURIComponent(change.mapId)}?edit=1`, 303);
    } catch (e) {
      const { status, body: err } = errorResponse(e);
      return reply.code(status).type('text/plain').send(err.error);
    }
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
    try {
      const out = await render(TEST_MAP, { ...(req.query as RenderQuery), style: m[1]! }, m[2] as 'svg' | 'png');
      return reply.type(out.type).header('content-disposition', `inline; filename="${out.name}"`).send(out.body);
    } catch (e) {
      if (e instanceof RenderQueryError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
