// Desktop mode (the Windows app's server): the gate (the launch secret, the
// Host check against DNS rebinding, the Origin check, no CORS), one local user
// without a login, the web-only pages, the chat settings, the configuration
// from the environment and where the data goes, and the real entry point
// (desktop/main.ts) as the app starts it: IPC "ready", the data folder, a clean
// shutdown. And what the app leaves out (`multiplayer: false`): Delve Table, the
// players' screen, Discord login, and the links to them and to accounts.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.ts';
import { localChatBackends } from '../src/chat/local-chat.ts';
import { desktopConfig } from '../src/desktop/config.ts';
import { DESKTOP_COOKIE, DESKTOP_HEADER, hostAllowed, originAllowed, registerDesktopGate, secretMatches } from '../src/desktop/gate.ts';
import { MapStore } from '../src/store.ts';

const SECRET = randomBytes(32).toString('base64url');
const PORT = 47_123;
const HOST = `127.0.0.1:${PORT}`;
const testMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as unknown;

function desktopApp(o: { dataDir?: string; port?: () => number } = {}): FastifyInstance {
  const store = new MapStore(':memory:');
  store.create(testMap, 'test');
  const app = buildApp(
    { version: 'test', started: 'now' },
    {
      store,
      singleUser: true,
      multiplayer: false,
      ...(o.dataDir ? { dataDir: o.dataDir } : {}),
      extend: (a) => registerDesktopGate(a, { secret: SECRET, port: o.port ?? (() => PORT) }),
      chatBackends: (ctx) => localChatBackends(ctx, { ...(o.dataDir ? { settingsFile: join(o.dataDir, 'chat-settings.json') } : {}), links: { models: '/models' } }),
    },
  );
  app.addHook('onClose', async () => store.close());
  return app;
}

const ok = { host: HOST, [DESKTOP_HEADER]: SECRET };

/** A page without its <style> blocks: what it shows and links to, not its CSS comments. */
const withoutStyles = (html: string): string => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

describe('the desktop gate, piece by piece', () => {
  it('compares the secret in constant time, and only the exact secret', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretMatches(SECRET, SECRET.slice(1))).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
  });

  it('takes only this server on loopback as Host, with its port (DNS rebinding sends another name)', () => {
    expect(hostAllowed('127.0.0.1:47123', 47123)).toBe(true);
    expect(hostAllowed('LOCALHOST:47123', 47123)).toBe(true);
    expect(hostAllowed('127.0.0.1:47124', 47123)).toBe(false);
    expect(hostAllowed('127.0.0.1', 47123)).toBe(false);
    expect(hostAllowed('evil.example:47123', 47123)).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.example:47123', 47123)).toBe(false);
    expect(hostAllowed('[::1]:47123', 47123)).toBe(false);
    expect(hostAllowed(undefined, 47123)).toBe(false);
    expect(hostAllowed('127.0.0.1:0', 0)).toBe(false); // before the server listens, nothing
  });

  it('takes no Origin, or this server’s own', () => {
    expect(originAllowed(undefined, HOST)).toBe(true);
    expect(originAllowed(`http://${HOST}`, HOST)).toBe(true);
    expect(originAllowed('http://evil.example', HOST)).toBe(false);
    expect(originAllowed('null', HOST)).toBe(false);
    expect(originAllowed(`http://localhost:${PORT}`, HOST)).toBe(false);
  });

  it('refuses a short or odd secret at start', () => {
    for (const secret of ['short', `${'a'.repeat(40)}!`, ''])
      expect(() => buildApp({ version: 't', started: 'now' }, { extend: (a) => registerDesktopGate(a, { secret, port: () => PORT }) })).toThrow(/at least 32/);
  });
});

describe('desktop mode', () => {
  let app: FastifyInstance;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'delve-desktop-'));
    app = desktopApp({ dataDir: dir });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers nobody without the launch secret', async () => {
    for (const headers of [{ host: HOST }, { host: HOST, [DESKTOP_HEADER]: 'x'.repeat(43) }, { host: HOST, cookie: `${DESKTOP_COOKIE}=${'y'.repeat(43)}` }]) {
      for (const url of ['/', '/health', '/maps/map_test4p', '/api/v1/maps', '/assets/delve-ui.css', '/models']) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.body).not.toContain('Test dungeon');
      }
    }
    const post = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { host: HOST, 'content-type': 'application/json' }, payload: '{"name":"x"}' });
    expect(post.statusCode).toBe(401);
  });

  it('answers the window: the secret as a header or as its cookie', async () => {
    expect((await app.inject({ method: 'GET', url: '/health', headers: ok })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health', headers: { host: HOST, cookie: `other=1; ${DESKTOP_COOKIE}=${SECRET}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health', headers: { host: `localhost:${PORT}`, [DESKTOP_HEADER]: SECRET } })).statusCode).toBe(200);
  });

  it('refuses another Host even with the secret (DNS rebinding), and other origins', async () => {
    for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:1', '192.168.1.5:47123', '']) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/maps', headers: { host, [DESKTOP_HEADER]: SECRET } })).statusCode, host).toBe(403);
    }
    const cross = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { ...ok, origin: 'https://evil.example', 'content-type': 'application/json' }, payload: '{"name":"x"}' });
    expect(cross.statusCode).toBe(403);
  });

  it('sends no CORS headers, and keeps pages out of frames', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/maps', headers: { ...ok, origin: `http://${HOST}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/v1/maps', headers: { host: HOST, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(401);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is one local user: no login, and the editor can change maps without a token', async () => {
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/session', headers: ok })).body)).toMatchObject({ loggedIn: true });
    const made = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { ...ok, origin: `http://${HOST}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Desk' }) });
    expect(made.statusCode).toBe(201);
    const page = await app.inject({ method: 'GET', url: '/maps/map_test4p', headers: ok });
    expect(page.body).toContain('id="rail"'); // the editor, not the viewer
    expect(page.body).not.toContain('id="login-link"');
    // the API token's way in stays shut: there is none
    const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { ...ok, authorization: 'Bearer anything', 'content-type': 'application/json' }, payload: '{}' });
    expect(mcp.statusCode).toBe(404);
  });

  it('sends the web server’s login and admin pages back to the library', async () => {
    for (const url of ['/login', '/login?next=/x', '/admin', '/account', '/account/setup?token=x']) {
      const res = await app.inject({ method: 'GET', url, headers: ok });
      expect(res.statusCode, url).toBe(303);
      expect(res.headers.location).toBe('/');
    }
    expect((await app.inject({ method: 'POST', url: '/login', headers: ok, payload: {} })).statusCode).toBe(404);
    const fb = await app.inject({ method: 'GET', url: '/feedback', headers: ok });
    expect(fb.statusCode).toBe(200);
    expect(fb.body).toContain('Copy logs');
  });

  it('offers the chat as none or a local model, never Claude, under its own name', async () => {
    const page = (await app.inject({ method: 'GET', url: '/maps/map_test4p', headers: ok })).body;
    expect(page).toContain('id="chat-settings"');
    expect(page).toContain('data-assistant="Assistant"');
    expect(page).toContain('Ask Assistant to change the map');
    expect(page).not.toMatch(/Chat with Claude|>Claude</);
    const initial = JSON.parse(/<script id="delve-initial" type="application\/json">(.*?)<\/script>/s.exec(page)![1]!) as { chat: unknown };
    expect(initial.chat).toEqual({ enabled: true, model: '', backend: 'none', backends: ['none', 'local'], name: 'Assistant' });

    const chat = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/chat', headers: ok })).body);
    expect(chat).toEqual({ enabled: false, backend: 'none', backends: ['none', 'local'], name: 'Assistant', ok: false });
    const off = await app.inject({ method: 'POST', url: '/api/v1/maps/map_test4p/chat', headers: { ...ok, 'content-type': 'application/json' }, payload: JSON.stringify({ message: 'hi' }) });
    expect(off.statusCode).toBe(503);
    expect(off.body).toContain('chat settings');

    const bad = await app.inject({ method: 'PUT', url: '/api/v1/chat/settings', headers: { ...ok, 'content-type': 'application/json' }, payload: JSON.stringify({ backend: 'claude' }) });
    expect(bad.statusCode).toBe(400);
    const badUrl = await app.inject({ method: 'PUT', url: '/api/v1/chat/settings', headers: { ...ok, 'content-type': 'application/json' }, payload: JSON.stringify({ backend: 'local', local: { url: 'file:///etc/passwd', model: 'm' } }) });
    expect(badUrl.statusCode).toBe(400);
    const set = await app.inject({ method: 'PUT', url: '/api/v1/chat/settings', headers: { ...ok, 'content-type': 'application/json' }, payload: JSON.stringify({ backend: 'local', local: { url: 'http://127.0.0.1:9/v1', model: 'qwen3:8b' } }) });
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body)).toMatchObject({ backend: 'local', local: { source: 'server', url: 'http://127.0.0.1:9/v1', model: 'qwen3:8b' }, links: { models: '/models' } });
    // kept in the data folder
    expect(JSON.parse(readFileSync(join(dir, 'chat-settings.json'), 'utf8'))).toMatchObject({ backend: 'local' });
    const status = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/chat', headers: ok })).body);
    expect(status).toMatchObject({ enabled: true, backend: 'local', ok: false, model: 'qwen3:8b' });
    expect(status.error).toMatch(/nothing answers/);
  });

  it('keeps the map data in the data folder', () => {
    for (const f of ['accounts.db', 'chat-settings.json']) expect(existsSync(join(dir, f)), f).toBe(true);
  });

  it('has no Delve Table, players’ screen or Discord login: nothing registered, so 404s', async () => {
    const gets = [
      '/play',
      '/play/g_abcdefgh',
      '/play/g_abcdefgh/3d',
      '/play/g_abcdefgh/leave',
      '/play/join/x',
      '/api/v1/games',
      '/api/v1/games/g_abcdefgh/notebook',
      '/api/v1/games/g_abcdefgh/invites',
      '/api/v1/games/g_abcdefgh/pages/p1/background.png',
      '/api/v1/games/g_abcdefgh/pages/p1/scene3d.json',
      '/maps/map_test4p/screen',
      '/api/v1/maps/map_test4p/screen',
      '/auth/discord',
      '/auth/discord?next=%2Fplay',
      '/auth/discord/callback?code=x&state=y',
      '/auth/logout',
      '/assets/table.js',
      '/assets/table-dice.js',
      '/assets/table3d.js',
      '/assets/screen.js',
    ];
    for (const url of gets) expect((await app.inject({ method: 'GET', url, headers: ok })).statusCode, url).toBe(404);
    const post = { ...ok, origin: `http://${HOST}`, 'content-type': 'application/json' };
    for (const url of ['/api/v1/games', '/play/new', '/play/join/x', '/auth/logout']) {
      expect((await app.inject({ method: 'POST', url, headers: post, payload: '{"name":"x"}' })).statusCode, url).toBe(404);
    }
    expect(app.printRoutes({ commonPrefix: false })).not.toMatch(/games|play|screen|discord|leave|invite/);
    // the editor's own pages stay
    for (const url of ['/maps/map_test4p/3d', '/maps/map_test4p/handout', '/import/image', '/assets/viewer.js', '/assets/stack.js']) {
      expect((await app.inject({ method: 'GET', url, headers: ok })).statusCode, url).not.toBe(404);
    }
  });

  it('makes no Delve Table files in the data folder', () => {
    for (const f of ['table.db', 'table-assets']) expect(existsSync(join(dir, f)), f).toBe(false);
  });

  it('links to none of it from the start page: no Play, Admin, Account or log-out, no admin set-up banner', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: ok });
    expect(res.statusCode).toBe(200);
    const shown = withoutStyles(res.body);
    for (const gone of ['href="/play"', 'Delve Table', 'href="/admin"', 'href="/account', 'action="/logout"', 'Log out', 'Log in', 'class="notice notice-warning lib-secure"', 'Create your admin account', 'Discord']) {
      expect(shown, gone).not.toContain(gone);
    }
    // "Request a feature" stays and leads to the desktop app's own page
    expect(res.body).toContain('href="/feedback"');
    expect(res.body).toContain('data-new-map');
  });

  it('shows no players’ screen button in the editor, but keeps the view toggle, exports and the handout', async () => {
    const page = (await app.inject({ method: 'GET', url: '/maps/map_test4p', headers: ok })).body;
    const shown = withoutStyles(page); // the shared layout CSS keeps its comments, as on the web
    expect(shown).not.toContain('id="screen-link"');
    expect(shown).not.toContain('/screen');
    expect(shown).not.toMatch(/players’ screen|players' screen/i);
    expect(shown).not.toContain('Delve Table');
    // the GM / players view toggle (top bar and phone), the exports (players' too) and the parchment handout
    expect(page).toContain('name="view" value="players"');
    expect(page).toContain('name="view-phone" value="players"');
    expect(page).toContain('id="export-btn"');
    expect(page).toContain('id="png-link" href="/api/v1/maps/map_test4p/render.png?view=gm"');
    expect(page).toContain('id="view-handout" href="/maps/map_test4p/handout"');
    expect(page).toContain('href="/maps/map_test4p/3d"');
    expect(page).toContain('data-crop="png-players"');
    // the web's grouped top bar, its view group without the players' screen, and the context strip docked above the canvas
    expect([...page.matchAll(/<div class="ed-group[^"]*"(?: role="group" aria-label="([^"]+)")?/g)].map((m) => m[1] ?? 'status and panels')).toEqual(['Editing', 'View', 'Export', 'status and panels']);
    const view = /aria-label="View">([\s\S]*?)<div class="ed-top-end">/.exec(page)![1]!;
    expect(view).toContain('name="view" value="players"');
    expect(view).toContain('id="view-3d"');
    expect(view).not.toContain('id="screen-link"');
    expect(page).toMatch(/<div class="ed-main">\s*<div class="ed-ctx-dock" id="ctx-dock">/);
    expect(page).not.toContain('id="storeys"');
    const players =(await app.inject({ method: 'GET', url: '/maps/map_test4p?view=players', headers: ok })).body;
    expect(players).toContain('id="png-link" href="/api/v1/maps/map_test4p/render.png?view=players"');
    expect((await app.inject({ method: 'GET', url: '/api/v1/maps/map_test4p/render.png?view=players', headers: ok })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/maps/map_test4p/handout.svg', headers: ok })).statusCode).toBe(200);
    // the editor's script hears it too, for its hints
    const initial = JSON.parse(/<script id="delve-initial" type="application\/json">(.*?)<\/script>/s.exec(page)![1]!) as { multiplayer?: boolean };
    expect(initial.multiplayer).toBe(false);
  });
});

describe('desktop mode leaves Delve Table’s files alone', () => {
  it('never opens or deletes a table.db or table-assets already in the data folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-desktop-old-'));
    try {
      writeFileSync(join(dir, 'table.db'), 'an older table database');
      mkdirSync(join(dir, 'table-assets'));
      writeFileSync(join(dir, 'table-assets', 'a.png'), 'x');
      const app = desktopApp({ dataDir: dir });
      await app.ready();
      expect((await app.inject({ method: 'GET', url: '/play', headers: ok })).statusCode).toBe(404);
      await app.close();
      expect(readFileSync(join(dir, 'table.db'), 'utf8')).toBe('an older table database');
      expect(readFileSync(join(dir, 'table-assets', 'a.png'), 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('multiplayer: false without the desktop gate', () => {
  it('still takes feature requests: the form works without Delve Table behind it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-noplay-'));
    const app = buildApp({ version: 'test', started: 'now' }, { multiplayer: false, openEdit: true, dataDir: dir });
    try {
      await app.ready();
      const form = await app.inject({ method: 'GET', url: '/feedback?from=%2Fmaps%2Fx' });
      expect(form.statusCode).toBe(200);
      expect(form.body).toContain('name="title"');
      expect(form.body).not.toContain('Delve Table');
      const sent = await app.inject({
        method: 'POST',
        url: '/feedback',
        headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ kind: 'idea', title: 'More doors', description: 'Round ones', from: '/maps/x', website: '' }).toString(),
      });
      expect(sent.statusCode).toBe(303);
      expect(readFileSync(join(dir, 'feature-requests.txt'), 'utf8')).toContain('More doors');
      expect((await app.inject({ method: 'GET', url: '/play' })).statusCode).toBe(404);
      expect(existsSync(join(dir, 'table.db'))).toBe(false);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('desktop mode over a real socket (WebSocket upgrades too)', () => {
  let app: FastifyInstance;
  let port = 0;
  beforeAll(async () => {
    app = desktopApp({ port: () => port });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    app.server.closeAllConnections();
    await app.close();
  });

  const connect = (headers: Record<string, string>) =>
    new Promise<string>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/maps/map_test4p/live`, { headers });
      ws.on('message', (m) => {
        done(`message ${String(m).slice(0, 20)}`);
        ws.terminate();
      });
      // the server closes a refused upgrade itself (else app.close() below would hang)
      ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
      ws.on('error', (e) => done(`error ${e.message}`));
    });

  it('lets the window’s socket in, and nobody else’s', async () => {
    expect(await connect({ [DESKTOP_HEADER]: SECRET, origin: `http://127.0.0.1:${port}` })).toMatch(/^message/);
    expect(await connect({ cookie: `${DESKTOP_COOKIE}=${SECRET}` })).toMatch(/^message/);
    expect(await connect({})).toBe('refused 401');
    expect(await connect({ [DESKTOP_HEADER]: SECRET, origin: 'https://evil.example' })).toBe('refused 403');
    expect(await connect({ [DESKTOP_HEADER]: SECRET, host: `rebound.example:${port}` })).toBe('refused 403');
  });

  it('refuses the players’ screen’s live mode (?screen=1), and keeps the editor’s', async () => {
    const got = await new Promise<{ first: string; code: number }>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/maps/map_test4p/live?screen=1`, { headers: { [DESKTOP_HEADER]: SECRET } });
      let first = '';
      ws.on('message', (m) => (first ||= String(m)));
      ws.on('close', (code) => done({ first, code }));
      ws.on('error', () => {});
    });
    expect(JSON.parse(got.first)).toMatchObject({ type: 'error' });
    expect(got.first).not.toContain('"rev"');
    expect(got.code).toBe(4404);
    // the editor's save path (LiveHub) is the same socket without ?screen=1
    expect(await connect({ [DESKTOP_HEADER]: SECRET })).toMatch(/^message \{"type":"hello"/);
  });

  it('answers fetch from another port’s page with nothing it can read', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/maps`, { headers: { origin: 'http://127.0.0.1:1' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('desktopConfig', () => {
  const base = { DELVE_DESKTOP_SECRET: SECRET, DELVE_DATA: '/home/u/AppData/Roaming/Delve/data' };

  it('needs the secret and an absolute data folder, and never falls back to the web server’s', () => {
    expect(() => desktopConfig({})).toThrow(/DELVE_DESKTOP_SECRET/);
    expect(() => desktopConfig({ DELVE_DESKTOP_SECRET: 'short', DELVE_DATA: '/x' })).toThrow(/DELVE_DESKTOP_SECRET/);
    expect(() => desktopConfig({ DELVE_DESKTOP_SECRET: SECRET })).toThrow(/DELVE_DATA/);
    expect(() => desktopConfig({ DELVE_DESKTOP_SECRET: SECRET, DELVE_DATA: './data' })).toThrow(/absolute/);
    expect(() => desktopConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('puts logs beside the data and models in their own folder, any free port by default', () => {
    const c = desktopConfig(base, '/home/u');
    expect(c).toMatchObject({ dataDir: base.DELVE_DATA, port: 0, version: 'desktop' });
    expect(c.logDir).toBe(join(base.DELVE_DATA, '..', 'logs'));
    expect(c.modelsDir).toBe(join(base.DELVE_DATA, 'models'));
    expect(c.ollamaModels).toBe(join('/home/u', '.ollama', 'models'));
    expect(c.llamaServer).toBeUndefined();
    const d = desktopConfig({ ...base, PORT: '51000', DELVE_LOG_DIR: '/l', DELVE_MODELS_DIR: '/m', DELVE_LLAMA_SERVER: '/r/llama-server.exe', OLLAMA_MODELS: '/o', DELVE_VERSION: '0.1.0' });
    expect(d).toMatchObject({ port: 51000, logDir: '/l', modelsDir: '/m', llamaServer: '/r/llama-server.exe', ollamaModels: '/o', version: '0.1.0' });
  });
});

describe('the desktop server as the app starts it (desktop/main.ts)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function start(env: Record<string, string>) {
    const child = fork(resolve(import.meta.dirname, '../src/desktop/main.ts'), [], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    const ready = new Promise<number>((done, fail) => {
      child.on('message', (m: { type?: string; port?: number }) => m.type === 'ready' && done(m.port!));
      child.on('exit', (code) => fail(new Error(`exited ${code}: ${out.slice(-800)}`)));
    });
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    return { child, ready, exited, output: () => out };
  }

  it('starts on 127.0.0.1, keeps its data where the app says, and stops cleanly when asked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delve-desk-main-'));
    dirs.push(root);
    const data = join(root, 'Roaming', 'Delve', 'data');
    const s = start({ DELVE_DESKTOP_SECRET: SECRET, DELVE_DATA: data, DELVE_MODELS_DIR: join(root, 'Local', 'Delve', 'models'), DELVE_VERSION: '0.1.0-test', OLLAMA_MODELS: join(root, 'no-ollama') });
    const port = await s.ready;
    expect(port).toBeGreaterThan(0);
    const h = { [DESKTOP_HEADER]: SECRET };
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(401);
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: h })).json()) as { version: string };
    expect(health.version).toBe('0.1.0-test');
    const made = await fetch(`http://127.0.0.1:${port}/api/v1/maps`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'On disk' }) });
    expect(made.status).toBe(201);
    const rt = (await (await fetch(`http://127.0.0.1:${port}/api/v1/runtime`, { headers: h })).json()) as { runtime: { state: string; bundled: boolean }; folder: string };
    expect(rt.runtime).toMatchObject({ state: 'unavailable', bundled: false });
    expect(rt.folder).toBe(join(root, 'Local', 'Delve', 'models'));
    // no players here: the entry turns Delve Table, the players' screen and Discord off
    for (const url of ['/play', '/api/v1/games', '/maps/map_x/screen', '/auth/discord']) expect((await fetch(`http://127.0.0.1:${port}${url}`, { headers: h })).status, url).toBe(404);
    // the server listens on loopback only
    expect(s.output()).toContain('127.0.0.1');
    s.child.send({ type: 'shutdown' });
    expect(await s.exited).toBe(0);
    expect(existsSync(join(data, 'delve.db'))).toBe(true);
    expect(existsSync(join(data, 'table.db'))).toBe(false);
    expect(existsSync(join(data, 'table-assets'))).toBe(false);
    expect(existsSync(join(root, 'Roaming', 'Delve', 'logs'))).toBe(true);
    // the map is in the database file, so it survives a restart
    const again = start({ DELVE_DESKTOP_SECRET: SECRET, DELVE_DATA: data, OLLAMA_MODELS: join(root, 'no-ollama') });
    const port2 = await again.ready;
    const maps = (await (await fetch(`http://127.0.0.1:${port2}/api/v1/maps`, { headers: h })).json()) as { maps: { name: string }[] };
    expect(maps.maps.map((m) => m.name)).toContain('On disk');
    again.child.disconnect(); // the app went away: the server goes too
    expect(await again.exited).toBe(0);
  }, 60_000);

  it('takes another port when the one it was given is busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delve-desk-port-'));
    dirs.push(root);
    const blocker = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const s = start({ DELVE_DESKTOP_SECRET: SECRET, DELVE_DATA: join(root, 'data'), PORT: String(busy), OLLAMA_MODELS: join(root, 'no-ollama') });
      const port = await s.ready;
      expect(port).not.toBe(busy);
      expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: { [DESKTOP_HEADER]: SECRET } })).status).toBe(200);
      s.child.send({ type: 'shutdown' });
      expect(await s.exited).toBe(0);
    } finally {
      blocker.close();
    }
  }, 60_000);

  it('refuses to start outside the app (no secret)', async () => {
    const s = start({ DELVE_DATA: join(tmpdir(), 'never') });
    await expect(s.ready).rejects.toThrow(/DELVE_DESKTOP_SECRET/);
  });
});
