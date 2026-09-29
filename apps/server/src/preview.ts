// The start page: saved maps with downloads, and the test dungeon in every
// style with a GM / players' view switch. A stand-in until the editor (phase 4).
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  describeMap,
  levelSiblings,
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
import { FONT_FILES } from './png.ts';
import { asView, exportName, render, RenderQueryError, ROLL20_PPG, sceneFor, sizeInSquares, type RenderQuery } from './render.ts';
import type { MapStore, MapSummary } from './store.ts';

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

/** Newest first, but the storeys of one place stay together, top storey first. */
function ordered(maps: MapSummary[]): MapSummary[] {
  const out: MapSummary[] = [];
  const done = new Set<string>();
  for (const m of maps) {
    if (done.has(m.id)) continue;
    const group = m.level ? levelSiblings(maps, m.id).reverse() : [m];
    for (const g of group) {
      done.add(g.id);
      out.push(g);
    }
  }
  return out;
}

function savedMaps(store: MapStore, loggedIn: boolean): string {
  const maps = ordered(store.list());
  if (!maps.length) {
    return `<p class="note">No saved maps yet. Create one with <code>POST /api/v1/maps</code> (see docs/API.md).</p>`;
  }
  const rows = maps
    .map((m) => {
      const base = `/api/v1/maps/${encodeURIComponent(m.id)}`;
      const storey = m.level ? ` <span class="tag" title="One storey of a multi-storey place">${esc(m.level.name)}</span>` : '';
      const del = loggedIn ? `\n    <button class="button danger" type="button" data-delete="${esc(m.id)}" data-name="${esc(m.level ? `${m.name} · ${m.level.name}` : m.name)}">Delete</button>` : '';
      return `<tr${m.level ? ' class="storey"' : ''}>
  <td><strong>${esc(m.name)}</strong>${storey}<br><code>${esc(m.id)}</code></td>
  <td class="num">${m.rev}</td><td class="num">${m.objects}</td>
  <td class="meta">${esc(m.updated.replace('T', ' ').slice(0, 16))}</td>
  <td class="links"><a class="button primary" href="/maps/${encodeURIComponent(m.id)}">Open live view</a>
    <a class="button" href="${base}/render.png?view=players">Roll20 PNG · players</a>
    <a class="button" href="${base}/render.png">PNG · GM</a> <a class="button" href="${base}/render.svg">SVG</a>
    <a class="button" href="${base}/export.ds" title="Open this map in Dungeon Scrawl">Dungeon Scrawl</a>
    <a class="button" href="${base}/describe">Text</a>${del}</td>
</tr>`;
    })
    .join('\n');
  const script = loggedIn
    ? `<script>
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete "' + b.dataset.name + '"? It disappears from Delve for everyone.')) return;
    const res = await fetch('/api/v1/maps/' + encodeURIComponent(b.dataset.delete), { method: 'DELETE' });
    if (!res.ok) { const body = await res.json().catch(() => ({})); alert('Deleting failed: ' + (body.error || res.status)); return; }
    b.closest('tr').remove();
  }));
</script>`
    : '';
  return `<div class="table"><table>
<thead><tr><th>Map</th><th class="num">Rev</th><th class="num">Objects</th><th>Updated (UTC)</th><th>Downloads</th></tr></thead>
<tbody>${rows}</tbody></table></div>${script}`;
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
  <span class="or">or</span>
  <label class="button" for="ds-file">Import Dungeon Scrawl file…</label>
  <input id="ds-file" type="file" accept=".ds" hidden>
  <label class="button" for="city-file" title="A city from Watabou's Medieval Fantasy City Generator: Menu → Export as → JSON">Import city (Watabou JSON)…</label>
  <input id="city-file" type="file" accept=".json,application/json" hidden>
  <label>1 square = <select id="city-feet"><option value="5">5 ft (true scale)</option><option value="10" selected>10 ft</option><option value="20">20 ft (overview)</option></select></label>
  <span id="import-status" class="note" role="status"></span>
</form>
<script>
  document.getElementById('city-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('import-status');
    status.textContent = 'Importing ' + file.name + '…';
    const name = file.name.replace(/\\.json$/i, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const feet = document.getElementById('city-feet').value;
    const res = await fetch('/api/v1/maps/import.city?feet=' + feet + '&name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { status.textContent = 'Import failed: ' + (body.error || res.status); e.target.value = ''; return; }
    location.href = '/maps/' + encodeURIComponent(body.id) + '?edit=1';
  });
</script>
<script>
  document.getElementById('ds-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('import-status');
    status.textContent = 'Importing ' + file.name + '…';
    const name = file.name.replace(/\\.ds$/i, '');
    const res = await fetch('/api/v1/maps/import.ds?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { status.textContent = 'Import failed: ' + (body.error || res.status); e.target.value = ''; return; }
    location.href = '/maps/' + encodeURIComponent(body.id) + '?edit=1';
  });
</script>`;
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
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  @font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }
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
  .button.danger { color: #B03A2E; border-color: color-mix(in srgb, #B03A2E 45%, var(--line)); background: transparent; cursor: pointer; font: inherit; font-weight: 500; font-size: .88rem; }
  .tag { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: .78rem; font-weight: 500; vertical-align: 1px; }
  tr.storey + tr.storey td:first-child { padding-left: 22px; }
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
  .newmap label.button { display: inline-block; color: var(--ink); font-size: .88rem; cursor: pointer; }
  .newmap .or { color: var(--muted); font-size: .85rem; align-self: center; }
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
    ${savedMaps(store, loggedIn)}
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
  const fonts = Object.entries(FONT_FILES).map(([served, path]) => [served, readFileSync(path)] as const);

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

  for (const [served, bytes] of fonts) {
    app.get(`/fonts/${served}`, async (_req, reply) =>
      reply.type('font/ttf').header('cache-control', 'public, max-age=86400').send(bytes),
    );
  }

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
