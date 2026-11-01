// Fixes from the security review before Quillwarren went open source: JSON in pages
// can't end its <script>, a map's style can't put markup into its pictures,
// unknown host names get 403, secrets in URLs stay out of the log, big
// WebSocket messages and uploads are refused before anything is read, and
// logging out only works from Quillwarren's own pages.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp, redactUrl, WS_MAX_PAYLOAD, type AppOptions } from '../src/app.ts';
import { Sessions } from '../src/auth.ts';
import { hostAllowed, hostName, parseAllowedHosts } from '../src/hosts.ts';
import { MapStore } from '../src/store.ts';

const TOKEN = 'security-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const session = `delve_session=${new Sessions(TOKEN).issue()}`;
const EVIL = '</script><img src=x onerror=alert(1)>';

let dir: string;
let store: MapStore;
let app: FastifyInstance;

async function build(extra: AppOptions = {}): Promise<FastifyInstance> {
  const built = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir, store, ...extra });
  await built.ready();
  return built;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delve-security-'));
  store = new MapStore(join(dir, 'delve.db'));
  app = await build();
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createMap(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { name, template: 'test-dungeon' } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

/** The JSON of a page's <script id="…" type="application/json"> block, read back the way the page's script reads it. */
function scriptJson(html: string, id: string): unknown {
  const m = new RegExp(`<script id="${id}" type="application/json">([^<]*)</script>`).exec(html);
  expect(m, `#${id} in the page`).not.toBeNull();
  return JSON.parse(m![1]!);
}

/** Every <script> the page opens is closed by its own </script>, and nothing else is: a name can't end one early. */
function scriptsIntact(html: string): void {
  expect(html).not.toContain(EVIL);
  expect((html.match(/<\/script>/g) ?? []).length).toBe((html.match(/<script\b/g) ?? []).length);
}

describe('JSON inside pages', () => {
  it('keeps a map named "</script>…" inside the JSON on the editor, viewer, 3D, handout and players’ screen pages', async () => {
    const id = await createMap(EVIL);
    for (const [url, cookie] of [
      [`/maps/${id}`, session],
      [`/maps/${id}?view=players`, undefined],
      [`/maps/${id}/3d`, undefined],
      [`/maps/${id}/handout`, session],
      [`/maps/${id}/screen`, undefined],
    ] as const) {
      const res = await app.inject({ url, headers: cookie ? { cookie } : {} });
      expect(res.statusCode, url).toBe(200);
      scriptsIntact(res.body);
      expect(JSON.stringify(scriptJson(res.body, 'delve-initial')), url).toContain(EVIL);
    }
  });

  it('keeps a game named "</script>…" inside the JSON on the 2D and 3D table', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: EVIL } });
    expect(made.statusCode).toBe(201);
    const gameId = made.json().id as string;
    for (const [url, id] of [
      [`/play/${gameId}`, 'table-initial'],
      [`/play/${gameId}/3d`, 'table3d-initial'],
    ] as const) {
      const res = await app.inject({ url, headers: { cookie: session } });
      expect(res.statusCode, url).toBe(200);
      scriptsIntact(res.body);
      expect((scriptJson(res.body, id) as { gameName: string }).gameName).toBe(EVIL);
    }
  });
});

describe("a map's style overrides", () => {
  const BAD = 'red"/><script>alert(1)</script>';

  it('refuses one that is not a colour, over REST and the socket', async () => {
    const id = await createMap('Crypt');
    const set = { style: { preset: 'classic-hatching', overrides: { walls: { color: BAD } } } };
    const res = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: bearer, payload: { ops: [{ op: 'update_map', set }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('style.overrides.walls.color: must be a colour like "#2F4A33"');
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${id}/live?token=${TOKEN}`);
    const answer = new Promise<Record<string, unknown>>((ok) => ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'error') ok(m); }));
    ws.send(JSON.stringify({ type: 'ops', ref: 7, ops: [{ op: 'update_map', set }] }));
    expect(String((await answer).error)).toContain('style.overrides.walls.color');
    ws.terminate();
  });

  it('draws a map saved with a bad one anyway with the value escaped: render.svg, the editor and the players’ screen', async () => {
    const id = await createMap('Old map');
    // straight into the database, as a map saved before the check could hold it
    const doc = { ...store.get(id).map, style: { preset: 'classic-hatching', overrides: { 'walls.color': BAD, 'doors.fill': BAD, background: 'red;}</style><script>alert(2)</script>' } } };
    const db = new DatabaseSync(join(dir, 'delve.db'));
    db.prepare('UPDATE maps SET doc = ? WHERE id = ?').run(JSON.stringify(doc), id);
    db.close();
    const svg = await app.inject({ url: `/api/v1/maps/${id}/render.svg` });
    expect(svg.statusCode).toBe(200);
    expect(svg.body).not.toContain('<script');
    expect(svg.body).toContain('stroke="red&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    for (const url of [`/maps/${id}`, `/maps/${id}/screen`]) {
      const page = await app.inject({ url, headers: { cookie: session } });
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).not.toContain('<script>alert');
    }
    // the screen's CSS only ever gets a real colour
    expect((await app.inject({ url: `/maps/${id}/screen` })).body).toContain('body { background: #EFEAE2; }');
    // and an edit that leaves the style alone still works on such a map
    const edit = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: bearer, payload: { ops: [{ op: 'update_map', set: { name: 'Renamed' } }] } });
    expect(edit.statusCode).toBe(200);
  });
});

describe('host names', () => {
  it('reads the host name out of a Host header', () => {
    expect(hostName('Evil.Example:8790')).toBe('evil.example');
    expect(hostName('delve.lan.')).toBe('delve.lan');
    expect(hostName('[::1]:8790')).toBe('[::1]');
    expect(hostName('a b')).toBeNull();
    expect(parseAllowedHosts(' Maps.Example.org, *.example.net ,,')).toEqual(['maps.example.org', '*.example.net']);
    expect(hostAllowed(undefined, { allowed: [] })).toBe(true);
    expect(hostAllowed('[not-an-address]', { allowed: [] })).toBe(false);
  });

  it('answers IP addresses, localhost, home-network names, the public name and DELVE_ALLOWED_HOSTS, and refuses other names with 403', async () => {
    await app.close();
    app = await build({ publicUrl: 'https://delve.example.com', allowedHosts: parseAllowedHosts('maps.example.org, *.example.net') });
    const ok = [
      '192.168.1.9:8790',
      '127.0.0.1',
      '[::1]:8790',
      '[fe80::1]',
      'localhost:8790',
      'delve',
      'ct126:8790',
      'delve.local',
      'nas.lan',
      'delve.home.arpa',
      'delve.internal',
      'delve.fritz.box',
      'delve.example.com',
      'maps.example.org',
      'a.example.net',
      'example.net',
    ];
    for (const host of ok) expect((await app.inject({ url: '/health', headers: { host } })).statusCode, host).toBe(200);
    for (const host of ['evil.example:8790', 'evil.example', 'delve.example.com.evil.net', 'localhost.evil.net', 'example.org', '192.168.1.9.nip.io', 'notexample.net']) {
      const res = await app.inject({ url: '/api/v1/maps', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toContain('does not answer to that host name');
    }
    // pages, writes, the release health check's 127.0.0.1 and unknown paths too
    expect((await app.inject({ url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { ...bearer, host: 'evil.example' }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/nothing-here', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/health', headers: { host: '127.0.0.1:8790' } })).statusCode).toBe(200);
    // the tunnel: cloudflared on loopback with Cloudflare's header, whatever name it was given
    expect((await app.inject({ url: '/health', headers: { host: 'other.example', 'cf-connecting-ip': '203.0.113.9' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/health', headers: { host: 'other.example', 'cf-connecting-ip': '203.0.113.9' }, remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    // and the WebSockets
    const id = await createMap('Crypt');
    await expect(app.injectWS(`/api/v1/maps/${id}/live`, { headers: { host: 'evil.example:8790' } })).rejects.toThrow('Unexpected server response: 403');
  });
});

describe('the request log', () => {
  it('masks tokens in query strings and invite tokens in paths', () => {
    expect(redactUrl('/api/v1/maps/m1/live?token=secret')).toBe('/api/v1/maps/m1/live?token=***');
    expect(redactUrl('/account/setup?token=abc_DEF-123')).toBe('/account/setup?token=***');
    expect(redactUrl('/auth/discord/callback?code=c0de&state=s7')).toBe('/auth/discord/callback?code=***&state=***');
    expect(redactUrl('/play/join/eyJnIjoiZzEifQ.c2lnbmF0dXJl')).toBe('/play/join/***');
    expect(redactUrl('/play/join/eyJnIjoiZzEifQ.c2ln?x=1')).toBe('/play/join/***?x=1');
    expect(redactUrl('/auth/discord?next=%2Fplay%2Fjoin%2FeyJnIjoiZzEifQ.c2ln')).toBe('/auth/discord?next=%2Fplay%2Fjoin%2F***');
    expect(redactUrl('/auth/discord?next=/play/join/eyJn.c2ln&x=1')).toBe('/auth/discord?next=/play/join/***&x=1');
    expect(redactUrl('/play/g1')).toBe('/play/g1');
  });
});

describe('WebSocket limits', () => {
  /** The close code of a socket, once it closes. */
  const closed = (ws: WebSocket) => new Promise<number>((ok) => ws.on('close', (code) => ok(code)));

  it('closes a map socket whose message is bigger than a REST write may be', async () => {
    const id = await createMap('Crypt');
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${id}/live?token=${TOKEN}`);
    const done = closed(ws);
    ws.send(`{"type":"ping","pad":"${'x'.repeat(WS_MAX_PAYLOAD)}"}`);
    expect(await done).toBe(1009); // message too big
  });

  it('does not even parse a big message on a read-only map socket', async () => {
    const id = await createMap('Crypt');
    const got: Record<string, unknown>[] = [];
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${id}/live`, {}, { onInit: (s: WebSocket) => s.on('message', (raw) => got.push(JSON.parse(String(raw)))) });
    const ops = [{ op: 'update_map', set: { name: 'x'.repeat(2000) } }];
    ws.send(JSON.stringify({ type: 'ops', ref: 1, ops }));
    ws.send(JSON.stringify({ type: 'ping' }));
    while (!got.some((m) => m.type === 'pong')) await new Promise((ok) => setTimeout(ok, 5));
    const error = got.find((m) => m.type === 'error')!;
    expect(error.error).toContain('this connection is read-only');
    expect(error.ref).toBeUndefined(); // refused unread: no ref to echo
    ws.terminate();
  });
});

describe('big uploads check the login first', () => {
  it('answers an anonymous 11 MB table picture with 401 before reading it (not 413)', async () => {
    const gameId = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: 'Crypt' } })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/assets`, headers: { 'content-type': 'image/png' }, payload: Buffer.alloc(11 * 1024 * 1024) });
    expect(res.statusCode).toBe(401);
  });

  it('answers an anonymous 21 MB .ds or city import with 401 before reading it', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024);
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps/import.ds', headers: { 'content-type': 'application/octet-stream' }, payload: big })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps/import.city', headers: { 'content-type': 'application/octet-stream' }, payload: big })).statusCode).toBe(401);
  });
});

describe('logging out', () => {
  it('works only from Quillwarren’s own pages', async () => {
    const cross = await app.inject({ method: 'POST', url: '/logout', headers: { cookie: session, host: 'delve.lan', origin: 'http://evil.example' } });
    expect(cross.statusCode).toBe(403);
    expect(cross.headers['set-cookie']).toBeUndefined();
    const own = await app.inject({ method: 'POST', url: '/logout', headers: { cookie: session, host: 'delve.lan', origin: 'http://delve.lan' } });
    expect(own.statusCode).toBe(303);
    expect(String(own.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
