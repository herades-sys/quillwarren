// The start page: the map library (library.ts), new maps and imports, and the test dungeon in every
// style with a GM / players' view switch, in the shared look (@delve/ui).
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  describeMap,
  FORMAT,
  FORMAT_VERSION,
  PRESETS,
  SQUARE_SIZES,
  sceneToSvg,
  validateMap,
  type DelveMap,
  type Scene,
  type View,
} from '@delve/core';
import testMapJson from '../../../fixtures/test-map-4p.delve.json' with { type: 'json' };
import { editorSession, errorResponse, newMap } from './api.ts';
import type { AppInfo } from './app.ts';
import { currentAccount } from './accounts/http.ts';
import { htmlDocument, icon, themeSwitch, topBar } from '@delve/ui';
import { canLogIn, isLoggedIn, type EditorAuth } from './login.ts';
import { FONT_FILES } from './png.ts';
import { asView, exportName, render, RenderQueryError, ROLL20_PPG, sceneFor, sizeInSquares, type RenderQuery } from './render.ts';
import { LIBRARY_CSS, libraryHtml } from './library.ts';
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

interface Access {
  loggedIn: boolean;
  passwordSet: boolean;
  /** The admin or GM account behind the session (null for the shared password or a dev server). */
  account: { name: string; role: string } | null;
  /** Logged in with the shared password while there's no admin account yet. */
  bootstrap: boolean;
  /** Quillwarren Table is here (everywhere but the desktop app): the Play link. */
  table: boolean;
  /** One local user (the desktop app): no accounts, no logging in or out. */
  singleUser: boolean;
}

/** "AN" for Ana, "MV" for Mara Venn. */
const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? '?').slice(0, 2)).toUpperCase();
};

/** The right end of the top bar: Play, Admin, the theme, and who is logged in. */
function barEnd(a: Access): string {
  const play = a.table ? `<a class="btn btn-primary" href="/play" title="Quillwarren Table: your games, invite players, play">${icon('play', { size: 15 })}Play</a>` : '';
  const admin = a.account?.role === 'admin' ? `<a class="btn btn-plain lib-wide" href="/admin" title="Accounts, GMs and logins">${icon('admin', { size: 16 })}Admin</a>` : '';
  const ideas = a.loggedIn ? `<a class="btn btn-plain lib-wide lib-ideas" href="/feedback" title="Request a feature: ask for one, or report a problem">${icon('send', { size: 15 })}<span>Request a feature</span></a>` : '';
  const logout = `<form method="post" action="/logout" class="inline"><button class="btn btn-ghost" type="submit">Log out</button></form>`;
  let who: string;
  if (a.singleUser) who = '';
  else if (a.account) who = `<a class="lib-account" href="/account" title="Your account"><span class="avatar">${esc(initials(a.account.name))}</span>${esc(a.account.name)}</a>${logout}`;
  else if (a.loggedIn) who = logout;
  else who = a.passwordSet ? `<a class="btn btn-secondary" href="/login">${icon('lock', { size: 15 })}Log in to edit</a>` : `<span class="text-muted lib-wide" style="font-size:12px">Editing: set a password with <code>delve-passwd</code> on the container</span>`;
  return `${play}${ideas}${admin}<span class="vsep" style="margin:0 4px"></span>${themeSwitch()}${who}`;
}

const secureBanner = (): string => `<div class="notice notice-warning lib-secure" role="note">${icon('alert', { size: 16 })}
    <p><strong>Secure your login:</strong> create your admin account. It has its own password and a code from an authenticator app on your phone, and the shared editor password stops working.</p>
    <a class="btn btn-primary btn-sm" href="/account/setup">Create your admin account</a>
  </div>`;

/** New map: the dialog (a name, a style, a start), and the imports. */
function newMapDialog(): string {
  const styles = Object.entries(PRESETS).map(([k, s]) => `<option value="${esc(k)}">${esc(s.name)}</option>`).join('');
  const squares = SQUARE_SIZES.map((u) => `<option value="${esc(u)}"${u === '5 ft' ? ' selected' : ''}>${esc(u)}</option>`).join('');
  const chev = icon('chevron-down', { size: 14 });
  return `<div class="dialog-backdrop" id="new-map" hidden><div class="dialog lib-dialog" role="dialog" aria-modal="true" aria-labelledby="new-map-title">
  <div class="dialog-head"><div class="dialog-title" id="new-map-title">New map</div><button class="btn btn-icon" type="button" data-close aria-label="Close">${icon('x', { size: 17 })}</button></div>
  <form method="post" action="/maps/new" class="stack" style="gap:12px">
    <div class="field"><label for="nm-name">Name</label><input class="input input-lg" id="nm-name" name="name" required maxlength="200" placeholder="e.g. Goblin warren"></div>
    <div class="lib-two">
      <div class="field"><label for="nm-style">Style</label><div class="select"><select class="input" id="nm-style" name="style">${styles}</select>${chev}</div></div>
      <div class="field"><label for="nm-template">Start from</label><div class="select"><select class="input" id="nm-template" name="template"><option value="empty">An empty map</option><option value="test-dungeon">The test dungeon</option></select>${chev}</div></div>
      <div class="field" title="What one grid square stands for"><label for="nm-unit">1 square =</label><div class="select"><select name="unit" class="input" id="nm-unit">${squares}</select>${chev}</div></div>
    </div>
    <div class="dialog-actions" style="margin-top:0"><button class="btn btn-secondary" type="button" data-close>Cancel<span class="key">Esc</span></button><button class="btn btn-primary" type="submit">${icon('plus', { size: 15 })}Create map</button></div>
  </form>
  <div class="lib-imports">
    <span class="section-label">Or bring one in</span>
    <div class="row" style="gap:6px">
      <label class="btn btn-secondary btn-sm" for="ds-file">${icon('upload', { size: 14 })}Dungeon Scrawl file…</label>
      <input id="ds-file" type="file" accept=".ds" hidden>
      <label class="btn btn-secondary btn-sm" for="city-file" title="A city from Watabou's Medieval Fantasy City Generator: Menu → Export as → JSON">${icon('upload', { size: 14 })}Watabou city (JSON)…</label>
      <input id="city-file" type="file" accept=".json,application/json" hidden>
      <a class="btn btn-secondary btn-sm" href="/import/image" title="A city plan or dungeon picture with flat colours, traced into a map">${icon('image', { size: 14 })}Trace a picture…</a>
    </div>
    <div class="field lib-feet" title="For the city import: how much of the city one square covers"><label for="city-unit">City import: 1 square =</label><div class="select"><select class="input" id="city-unit"><option value="5 ft">5 ft (true scale)</option><option value="10 ft" selected>10 ft</option><option value="20 ft">20 ft (overview)</option><option value="1.5 m">1.5 m (true scale)</option><option value="3 m">3 m</option><option value="6 m">6 m (overview)</option></select>${chev}</div></div>
    <span id="import-status" class="field-hint" role="status"></span>
  </div>
</div></div>
<script>
  (() => {
    const dlg = document.getElementById('new-map');
    const show = () => { dlg.hidden = false; document.getElementById('nm-name').focus(); };
    const hide = () => { dlg.hidden = true; };
    document.querySelectorAll('[data-new-map]').forEach((b) => b.addEventListener('click', show));
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) hide(); });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dlg.hidden) hide();
      else if ((e.key === 'n' || e.key === 'N') && dlg.hidden && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea')) { e.preventDefault(); show(); }
    });
  })();
  document.getElementById('city-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('import-status');
    status.textContent = 'Importing ' + file.name + '…';
    const name = file.name.replace(/\\.json$/i, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const unit = document.getElementById('city-unit').value;
    const res = await fetch('/api/v1/maps/import.city?unit=' + encodeURIComponent(unit) + '&name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { status.textContent = 'Import failed: ' + (body.error || res.status); e.target.value = ''; return; }
    location.href = '/maps/' + encodeURIComponent(body.id);
  });
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
    location.href = '/maps/' + encodeURIComponent(body.id);
  });
</script>`;
}

const PAGE_CSS = `
  .lib-page { max-width: 1320px; gap: var(--space-10); }
  .lib-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; }
  .lib-head h1 { margin: 2px 0 0; }
  .lib-head .lead { margin: 8px 0 0; font-size: 14.5px; }
  .lib-secure { align-items: center; flex-wrap: wrap; }
  .lib-secure p { margin: 0; flex: 1; min-width: 240px; }
  .lib-account { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; color: var(--color-text); text-decoration: none; font-size: var(--text-md); }
  .lib-account:hover { color: var(--color-accent-text); }
  form.inline { display: inline; margin: 0; }
  .lib-dialog { width: min(520px, 100%); gap: 16px; }
  .lib-imports { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; box-shadow: inset 0 1px 0 var(--color-border); }
  .lib-feet { max-width: 260px; }
  .lib-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .lib-styles-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .lib-styles-head p { margin: 6px 0 0; color: var(--color-text-muted); max-width: 70ch; }
  .lib-seg a.seg-opt { text-decoration: none; }
  .lib-styles { display: flex; flex-direction: column; gap: var(--space-5); }
  .lib-style-grid { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); }
  .lib-style { padding: 0; gap: 0; overflow: hidden; }
  .lib-style header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 12px 14px; }
  .lib-style header h3 { margin: 0; font-family: var(--font-display); font-weight: 400; font-size: 18px; }
  .lib-style header code { font-size: var(--text-xs); color: var(--color-text-faint); }
  .lib-style .map { background: var(--canvas-parchment); }
  .lib-style .map svg { display: block; width: 100%; height: auto; }
  .lib-style footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 14px 12px; box-shadow: inset 0 1px 0 var(--color-border); }
  .lib-style .meta { color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .lib-api summary { cursor: pointer; font-family: var(--font-display); font-size: var(--display-sm); }
  .lib-api pre { margin: 12px 0 0; padding: 14px 16px; overflow-x: auto; font-size: 12.5px; line-height: 1.6; border-radius: 10px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .lib-foot { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--color-text-faint); font-size: var(--text-sm); padding-top: var(--space-5); box-shadow: inset 0 1px 0 var(--color-border); }
  .lib-foot a { color: var(--color-text-muted); }
  .lib-foot code { font-size: var(--text-xs); }
  @media (max-width: 900px) { .lib-ideas > span { display: none; } }
  @media (max-width: 640px) { .lib-wide { display: none !important; } .lib-account { font-size: 0; gap: 0; } .lib-two { grid-template-columns: 1fr; } .topbar .crumb-title, .topbar-brand + .vsep { display: none; } .lib-grid .new-tile { display: none; } }
`;

function page(info: AppInfo, view: View, store: MapStore, access: Access): string {
  const { loggedIn } = access;
  const maps = store.list();
  const cards = Object.entries(PRESETS)
    .map(([preset, style]) => {
      const scene = testScene(preset, view);
      const { w, h } = sizeInSquares(scene);
      const svg = sceneToSvg(scene, { ppg: 12, idPrefix: `${preset}-` });
      const q = `?view=${view}`;
      return `<article class="card elev-sm lib-style">
  <header><h3>${esc(style.name)}</h3><code>${esc(preset)}</code></header>
  <div class="map">${svg}</div>
  <footer>
    <a class="btn btn-primary btn-sm" href="/preview/${preset}.png${q}" download="${esc(exportName(TEST_MAP, preset, view, scene, 'png'))}">PNG for Roll20</a>
    <a class="btn btn-secondary btn-sm" href="/preview/${preset}.svg${q}" download="${esc(exportName(TEST_MAP, preset, view, scene, 'svg'))}">SVG</a>
    <span class="meta">${w}×${h} squares · ${w * ROLL20_PPG}×${h * ROLL20_PPG} px</span>
  </footer>
</article>`;
    })
    .join('\n');

  const toggle = (['gm', 'players'] as const)
    .map((v) => `<a href="/?view=${v}" class="seg-opt${v === view ? ' is-on' : ''}"${v === view ? ' aria-current="page"' : ''}>${v === 'gm' ? 'GM view' : 'Players’ view'}</a>`)
    .join('');
  const count = maps.length;

  const body = `${topBar({ title: 'Library', end: barEnd(access) })}
<main class="page lib-page">
  ${access.bootstrap ? secureBanner() : ''}
  <section class="stack" style="gap:var(--space-6)">
    <div class="lib-head">
      <div><span class="kicker">Quillwarren · ${count} map${count === 1 ? '' : 's'}</span><h1 class="display-xl">Library</h1>
      <p class="lead">Your dungeons, towers and towns. Open one to edit it live, with Claude if you like; players see only what you reveal.</p></div>
      ${loggedIn ? `<div class="row"><button class="btn btn-primary btn-lg" type="button" data-new-map>${icon('plus', { size: 16 })}New map<span class="key">N</span></button></div>` : ''}
    </div>
    ${libraryHtml(maps, loggedIn, { newTile: loggedIn })}
  </section>
  ${loggedIn ? newMapDialog() : ''}

  <section class="lib-styles">
    <div class="lib-styles-head">
      <div>
        <h2 class="display-md">Map styles</h2>
        <p>${esc(TEST_MAP.name)} in every style. The GM view shows room numbers and secret doors; the players’ view hides both and walls the secret door shut. PNGs come out at Roll20’s 70 px per square with edges on whole squares, so Roll20’s grid lines up.</p>
      </div>
      <nav class="seg lib-seg" aria-label="View">${toggle}</nav>
    </div>
    <div class="lib-style-grid">
${cards}
    </div>
  </section>

  <details class="panel lib-api">
    <summary>What the API sees</summary>
    <pre>${esc(describeMap(TEST_MAP))}</pre>
  </details>

  <footer class="lib-foot">
    <span>Release <code>${esc(info.version)}</code></span>
    <span>Started ${esc(info.started)}</span>
    <span><code>${FORMAT} v${FORMAT_VERSION}</code></span>
    <a href="/health">/health</a><a href="/api/v1/maps">/api/v1/maps</a><a href="/ui">Style guide</a><a href="/feedback">Request a feature</a>
  </footer>
</main>`;
  return htmlDocument({ title: 'Quillwarren', body, extra: `<style>${PAGE_CSS}${LIBRARY_CSS}</style>` });
}

/** `o` (the desktop app): multiplayer false leaves out the Play link, singleUser the account, admin and log-out links and the admin set-up banner. */
export function registerPreview(app: FastifyInstance, info: AppInfo, store: MapStore, auth: EditorAuth, o: { multiplayer?: boolean; singleUser?: boolean } = {}): void {
  const fonts = Object.entries(FONT_FILES).map(([served, path]) => [served, readFileSync(path)] as const);
  const singleUser = Boolean(o.singleUser);

  app.get('/', async (req, reply) => {
    const view = asView((req.query as { view?: string }).view);
    const loggedIn = isLoggedIn(auth, req);
    const account = singleUser ? null : (currentAccount(auth, req)?.user ?? null);
    const html = page(info, view, store, {
      loggedIn,
      passwordSet: canLogIn(auth) || auth.sessions.open,
      account,
      bootstrap: !singleUser && loggedIn && !account && !auth.sessions.legacyOff && !auth.sessions.open,
      table: o.multiplayer !== false,
      singleUser,
    });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  // The start page's "New map" form (logged-in editors only).
  app.post('/maps/new', async (req, reply) => {
    if (!editorSession(auth.sessions, req)) return reply.code(401).type('text/plain').send('log in to create maps');
    const body = (req.body ?? {}) as { name?: unknown; style?: unknown; template?: unknown; unit?: unknown };
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
