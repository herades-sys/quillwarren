import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { hashPassword, readCookie, Sessions, verifyPassword } from '../src/auth.ts';

const TOKEN = 'api-token';
const PASSWORD = 'correct horse battery';
const HASH = hashPassword(PASSWORD);

describe('passwords and sessions', () => {
  it('verifies scrypt hashes and nothing else', () => {
    expect(HASH).toMatch(/^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
    expect(HASH).not.toContain('$'); // safe in a systemd EnvironmentFile
    expect(verifyPassword(PASSWORD, HASH)).toBe(true);
    expect(verifyPassword('wrong', HASH)).toBe(false);
    expect(verifyPassword(PASSWORD, undefined)).toBe(false);
    expect(verifyPassword(PASSWORD, 'plain-text')).toBe(false);
  });

  it('signs sessions that expire and resist tampering', () => {
    const s = new Sessions(TOKEN);
    const v = s.issue(1_000);
    expect(s.valid(v, 2_000)).toBe(true);
    expect(s.valid(v, 1_000 + 31 * 86_400_000)).toBe(false); // expired
    expect(s.valid(v.replace(/\.(\d)/, '.9$1'), 2_000)).toBe(false); // edited expiry
    expect(new Sessions('other-token').valid(v, 2_000)).toBe(false); // token rotated
    expect(new Sessions(undefined).enabled).toBe(false);
  });
});

describe('editor login', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, passwordHash: HASH });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const login = async (password: string, next = '/maps/x?edit=1') =>
    app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password, next }).toString(),
    });
  const cookieOf = (res: Awaited<ReturnType<typeof login>>) => {
    const header = String(res.headers['set-cookie']);
    return `delve_session=${readCookie(header.split(';')[0], 'delve_session')}`;
  };

  it('logs in with the right password and sends you back where you were', async () => {
    expect((await app.inject({ url: '/login' })).body).toContain('type="password"');
    expect((await login('nope')).statusCode).toBe(401);
    const ok = await login(PASSWORD);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/maps/x?edit=1');
    expect(String(ok.headers['set-cookie'])).toMatch(/delve_session=v1\.\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
    const session = await app.inject({ url: '/api/v1/session', headers: { cookie: cookieOf(ok) } });
    expect(session.json()).toEqual({ loggedIn: true, passwordSet: true });
  });

  it('never redirects off-site after login', async () => {
    expect((await login(PASSWORD, '//evil.example/steal')).headers.location).toBe('/');
    expect((await login(PASSWORD, 'https://evil.example')).headers.location).toBe('/');
  });

  it('blocks a sixth try after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await login('nope');
    expect((await login(PASSWORD)).statusCode).toBe(429);
  });

  it('lets a logged-in editor change maps, but only from the same origin', async () => {
    const cookie = cookieOf(await login(PASSWORD));
    const host = 'delve.test:8790';
    const create = (origin?: string) =>
      app.inject({ method: 'POST', url: '/api/v1/maps', headers: { cookie, host, ...(origin ? { origin } : {}) }, payload: { name: 'Mine' } });
    expect((await create(`http://${host}`)).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(201); // same-origin fetches may omit Origin on some paths
    expect((await create('http://evil.example')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps', payload: {} })).statusCode).toBe(401);
  });

  it('creates maps from the start page form and opens them in the editor', async () => {
    const cookie = cookieOf(await login(PASSWORD));
    const res = await app.inject({
      method: 'POST',
      url: '/maps/new',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Goblin+warren&style=clean&template=empty',
    });
    expect(res.statusCode).toBe(303);
    const id = /^\/maps\/(map_[0-9a-f]+)\?edit=1$/.exec(String(res.headers.location))![1]!;
    expect((await app.inject({ url: `/api/v1/maps/${id}` })).json().map).toMatchObject({ name: 'Goblin warren', style: { preset: 'clean' } });
    const page = await app.inject({ url: `/maps/${id}`, headers: { cookie } });
    expect(page.body).toContain('id="rail"');
    expect(page.body).toContain('"loggedIn":true');
    const anon = await app.inject({ url: `/maps/${id}` });
    expect(anon.body).toContain('Log in to edit');
    expect(anon.body).not.toContain('id="rail"');
    expect((await app.inject({ method: 'POST', url: '/maps/new', payload: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(401);
  });

  it('accepts editor ops over the WebSocket with the session cookie', async () => {
    const cookie = cookieOf(await login(PASSWORD));
    const created = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name: 'WS' } });
    const { id } = created.json();
    const got: unknown[] = [];
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${id}/live`, { headers: { cookie } }, {
      onInit: (s: WebSocket) => s.on('message', (m) => got.push(JSON.parse(String(m)))),
    });
    ws.send(JSON.stringify({ type: 'ops', ref: 1, ops: [{ op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } } }] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContainEqual({ type: 'ack', rev: 2, ref: 1 });
    ws.terminate();
  });

  it('logs out', async () => {
    const res = await app.inject({ method: 'POST', url: '/logout' });
    expect(res.statusCode).toBe(303);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });
});

describe('development open-edit mode', () => {
  it('treats every browser as logged in', async () => {
    const app = buildApp({ version: 't', started: 'now' }, { openEdit: true });
    expect((await app.inject({ url: '/api/v1/session' })).json()).toEqual({ loggedIn: true, passwordSet: false });
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps', payload: { name: 'Dev' } })).statusCode).toBe(201);
    await app.close();
  });
});
