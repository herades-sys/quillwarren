// Quillwarren Table's Discord login against a fake Discord (a small Fastify server):
// the OAuth round trip, state and next checks, error pages, account seats on a
// second device, requireDiscord, co-GMs, logout, and that no Discord or account
// id ever reaches the table.
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp, type AppOptions } from '../src/app.ts';
import type { DiscordConfig } from '../src/table/discord.ts';

const TOKEN = 'discord-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const HOST = 'table.lan';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const AVATAR_A = '0123456789abcdef0123456789abcdef';
const AVATAR_B = 'fedcba9876543210fedcba9876543210';

type Msg = Record<string, any>;
interface FakeUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

// ---------- the fake Discord ----------

const users: Record<string, FakeUser> = {
  alice: { id: '80351110224678912', username: 'alice_d', global_name: 'Alice', avatar: AVATAR_A },
  bob: { id: '80351110224678913', username: 'bob_d', global_name: null, avatar: null },
  cogm: { id: '99999999999999999', username: 'cogm', global_name: 'Co GM', avatar: null },
};
const calls = { token: [] as Record<string, string>[], avatars: [] as string[] };
let fake: FastifyInstance;
let fakeUrl = '';

beforeAll(async () => {
  fake = Fastify();
  fake.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  // codes look like "<user>.<n>"; "nobody.1" is one Discord doesn't know
  fake.post('/oauth2/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    calls.token.push(b);
    if (b.client_id !== 'cid' || b.client_secret !== 'csecret' || b.grant_type !== 'authorization_code') return reply.code(401).send({ error: 'invalid_client' });
    if (!users[String(b.code).split('.')[0]!]) return reply.code(400).send({ error: 'invalid_grant' });
    return { access_token: `at-${b.code}`, token_type: 'Bearer', expires_in: 604800, refresh_token: 'rt-secret', scope: 'identify' };
  });
  fake.get('/users/@me', async (req, reply) => {
    const m = /^Bearer at-([a-z]+)\./.exec(req.headers.authorization ?? '');
    const u = m ? users[m[1]!] : undefined;
    if (!u) return reply.code(401).send({ message: '401: Unauthorized' });
    return { ...u, discriminator: '0', email: 'not-asked-for@example.com' };
  });
  fake.get('/avatars/:id/:file', async (req, reply) => {
    calls.avatars.push(req.url);
    return reply.type('image/png').send(PNG);
  });
  await fake.listen({ port: 0, host: '127.0.0.1' });
  fakeUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await fake.close();
});

// ---------- the app ----------

let dir: string;
let app: FastifyInstance;

async function build(discord: Partial<DiscordConfig> | null = {}, extra: AppOptions = {}): Promise<FastifyInstance> {
  const opts: AppOptions = { token: TOKEN, dataDir: dir, ...extra };
  if (discord) opts.discord = { clientId: 'cid', clientSecret: 'csecret', api: fakeUrl, cdn: fakeUrl, ...discord };
  const built = buildApp({ version: 'test', started: 'now' }, opts);
  await built.ready();
  return built;
}

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), 'delve-discord-'));
  calls.token.length = 0;
  calls.avatars.length = 0;
  app = await build();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookiesOf = (res: LightMyRequestResponse): string[] => {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h.map(String) : [String(h)];
};
const cookieNamed = (res: LightMyRequestResponse, name: string): string | undefined => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
const pair = (c: string | undefined): string => String(c).split(';')[0]!;

/** GET /auth/discord: the Discord URL it sends the browser to, and the state cookie. */
async function start(next?: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ url: `/auth/discord${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`, headers: { host: HOST, ...headers } });
  expect(res.statusCode).toBe(302);
  const to = new URL(String(res.headers.location));
  return { res, to, state: to.searchParams.get('state') ?? '', cookie: pair(cookieNamed(res, 'delve_discord_state')) };
}

/** The whole login as Discord user `who`: returns the account cookie and where it went. */
let codeNo = 0;
async function login(who: string, next?: string): Promise<{ cookie: string; location: string; res: LightMyRequestResponse }> {
  const s = await start(next);
  const res = await app.inject({ url: `/auth/discord/callback?code=${who}.${++codeNo}&state=${s.state}`, headers: { host: HOST, cookie: s.cookie } });
  expect(res.statusCode).toBe(303);
  return { cookie: pair(cookieNamed(res, 'delve_account')), location: String(res.headers.location), res };
}

async function createGame(name = 'Crypt night'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function invite(gameId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: {} });
  expect(res.statusCode).toBe(201);
  return String(res.json().url).split('/play/join/')[1]!;
}

const joinForm = (token: string, name: string, cookie = '') =>
  app.inject({
    method: 'POST',
    url: `/play/join/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: HOST, ...(cookie ? { cookie } : {}) },
    payload: new URLSearchParams({ name }).toString(),
  });

/** Open the live channel and return the first message (hello, or the error before a 4401). */
async function hello(gameId: string, cookie: string, query = ''): Promise<Msg> {
  let got: (m: Msg) => void = () => {};
  const first = new Promise<Msg>((ok) => (got = ok));
  const ws: WebSocket = await app.injectWS(`/api/v1/games/${gameId}/live${query}`, { headers: cookie ? { cookie } : {} }, {
    onInit: (s: WebSocket) => s.once('message', (raw) => got(JSON.parse(String(raw)) as Msg)),
  });
  const m = await first;
  ws.terminate();
  return m;
}

/** The close code of a live channel opened with these headers. */
async function closeCode(gameId: string, headers: Record<string, string>): Promise<number> {
  let closed: (c: number) => void = () => {};
  const closing = new Promise<number>((ok) => (closed = ok));
  await app.injectWS(`/api/v1/games/${gameId}/live`, { headers }, { onInit: (s: WebSocket) => s.on('close', (c) => closed(c)) });
  return closing;
}

const gmHello = (gameId: string) => hello(gameId, '', `?token=${TOKEN}`);

// ---------- tests ----------

describe('the OAuth round trip', () => {
  it('sends the browser to Discord with a signed state, swaps the code and starts an account session', async () => {
    const s = await start('/play/game_x');
    expect(`${s.to.origin}${s.to.pathname}`).toBe(`${fakeUrl}/oauth2/authorize`);
    expect(Object.fromEntries(s.to.searchParams)).toEqual({
      client_id: 'cid',
      response_type: 'code',
      scope: 'identify',
      redirect_uri: `http://${HOST}/auth/discord/callback`,
      state: expect.stringMatching(/^[\w-]{24}$/),
      prompt: 'none',
    });
    expect(cookieNamed(s.res, 'delve_discord_state')).toMatch(/^delve_discord_state=[\w-]+\.[\w-]{43}; Path=\/auth\/discord; HttpOnly; SameSite=Lax; Max-Age=600$/);

    const res = await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${s.state}`, headers: { host: HOST, cookie: s.cookie } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/play/game_x');
    expect(calls.token).toEqual([{ client_id: 'cid', client_secret: 'csecret', grant_type: 'authorization_code', code: 'alice.1', redirect_uri: `http://${HOST}/auth/discord/callback` }]);
    expect(cookieNamed(res, 'delve_account')).toMatch(/^delve_account=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(cookieNamed(res, 'delve_discord_state')).toContain('Max-Age=0');
    expect(calls.avatars).toEqual([`/avatars/${users.alice!.id}/${AVATAR_A}.png?size=128`]);

    const play = await app.inject({ url: '/play', headers: { cookie: pair(cookieNamed(res, 'delve_account')) } });
    expect(play.body).toContain('Logged in with Discord as <strong>Alice</strong>');
    expect(play.body).not.toContain('Log in with Discord');
    // the same avatar isn't fetched again
    await login('alice');
    expect(calls.avatars).toHaveLength(1);
  });

  it('uses the default Discord address and DELVE_PUBLIC_URL for the redirect', async () => {
    await app.close();
    app = await build({ api: undefined, publicUrl: 'https://table.example' });
    // from another address, first over to the public one, so the state cookie lands there
    const lan = await app.inject({ url: '/auth/discord?next=/play/abc', headers: { host: '192.168.1.9:8790' } });
    expect(lan.statusCode).toBe(302);
    expect(lan.headers.location).toBe('https://table.example/auth/discord?next=%2Fplay%2Fabc');
    expect(cookieNamed(lan, 'delve_discord_state')).toBeUndefined();
    const s = await start('/play', { host: 'table.example' });
    expect(`${s.to.origin}${s.to.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(s.to.searchParams.get('redirect_uri')).toBe('https://table.example/auth/discord/callback');
    expect(cookieNamed(s.res, 'delve_discord_state')).toMatch(/; Secure$/);
  });

  it('refuses a missing, forged, mismatched, reused or expired state', async () => {
    const stale = (res: LightMyRequestResponse) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Login expired');
      expect(cookieNamed(res, 'delve_account')).toBeUndefined();
    };
    const s = await start();
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${s.state}`, headers: { host: HOST } }));
    const [payload, mac] = s.cookie.split('=')[1]!.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'x'.repeat(24), e: Date.now() + 1e6, n: '/play', r: 'http://evil.example/cb' })).toString('base64url');
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${'x'.repeat(24)}`, headers: { host: HOST, cookie: `delve_discord_state=${forged}.${mac}` } }));
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${payload}`, headers: { host: HOST, cookie: s.cookie } }));
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${s.state.slice(1)}x`, headers: { host: HOST, cookie: s.cookie } }));
    expect(calls.token).toHaveLength(0);

    const ok = await app.inject({ url: `/auth/discord/callback?code=alice.1&state=${s.state}`, headers: { host: HOST, cookie: s.cookie } });
    expect(ok.statusCode).toBe(303);
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.2&state=${s.state}`, headers: { host: HOST, cookie: s.cookie } }));

    const late = await start();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    stale(await app.inject({ url: `/auth/discord/callback?code=alice.3&state=${late.state}`, headers: { host: HOST, cookie: late.cookie } }));
    expect(calls.token).toHaveLength(1);
  });

  it('only goes back to paths on this site', async () => {
    for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', 'play', '/a b', '/\tx', '/%0d', '']) {
      const { location } = await login('bob', bad);
      expect(location, bad).toBe(bad === '/%0d' ? '/%0d' : '/play');
    }
    expect((await login('bob')).location).toBe('/play');
    expect((await login('bob', '/play/join/abc.def?x=1')).location).toBe('/play/join/abc.def?x=1');
  });

  it('shows a friendly page when the player says no, or Discord fails', async () => {
    const s = await start('/play/join/tok');
    const denied = await app.inject({ url: `/auth/discord/callback?error=access_denied&error_description=The+resource+owner+denied&state=${s.state}`, headers: { host: HOST, cookie: s.cookie } });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['content-type']).toMatch(/^text\/html/);
    expect(denied.body).toContain('You didn&#39;t allow Quillwarren Table to see your Discord name');
    expect(denied.body).toContain('href="/auth/discord?next=%2Fplay%2Fjoin%2Ftok"'); // try again, back to the same invite
    expect(cookieNamed(denied, 'delve_account')).toBeUndefined();

    const other = await start();
    const err = await app.inject({ url: `/auth/discord/callback?error=server_error&state=${other.state}`, headers: { host: HOST, cookie: other.cookie } });
    expect(err.statusCode).toBe(502);
    expect(err.body).toContain('Discord login did not work');

    const unknown = await start();
    const failed = await app.inject({ url: `/auth/discord/callback?code=nobody.1&state=${unknown.state}`, headers: { host: HOST, cookie: unknown.cookie } });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).toContain('Discord login did not work');
    expect(failed.body).not.toContain('nobody.1');
    expect(cookieNamed(failed, 'delve_account')).toBeUndefined();

    const nocode = await start();
    expect((await app.inject({ url: `/auth/discord/callback?state=${nocode.state}`, headers: { host: HOST, cookie: nocode.cookie } })).statusCode).toBe(400);
  });

  it('changes nothing without Discord settings', async () => {
    await app.close();
    app = await build(null);
    expect((await app.inject({ url: '/auth/discord' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/auth/discord/callback?code=x&state=y' })).statusCode).toBe(404);
    const id = await createGame();
    const tok = await invite(id);
    const page = await app.inject({ url: `/play/join/${tok}` });
    expect(page.body).toContain('name="name"');
    expect(page.body).not.toContain('Discord');
    expect((await app.inject({ url: '/play' })).body).not.toContain('Discord');
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/games/${id}`, headers: bearer, payload: { requireDiscord: true } });
    expect(patch.statusCode).toBe(409);
  });
});

describe('seats that follow the Discord login', () => {
  it('links an invite join to the account and lets a second device in without a new invite', async () => {
    const id = await createGame('Curse of the Crypt');
    const tok = await invite(id);
    const anon = await app.inject({ url: `/play/join/${tok}` });
    expect(anon.body).toContain(`href="/auth/discord?next=${encodeURIComponent(`/play/join/${tok}`)}"`);
    expect(anon.body).toContain('or just type a name');
    expect(anon.body).toContain('name="name"');

    const a = await login('alice', `/play/join/${tok}`);
    expect(a.location).toBe(`/play/join/${tok}`);
    const form = await app.inject({ url: a.location, headers: { cookie: a.cookie } });
    expect(form.body).toContain('Logged in with Discord as <strong>Alice</strong>');
    expect(form.body).toContain('value="Alice"');
    expect(form.body).not.toContain('Log in with Discord');
    const joined = await joinForm(tok, 'Alice the Bold', a.cookie);
    expect(joined.statusCode).toBe(303);
    expect(joined.headers.location).toBe(`/play/${id}`);
    expect(cookieNamed(joined, `delve_player_${id}`)).toBeUndefined(); // the login is the key
    expect((await app.inject({ url: `/play/join/${tok}`, headers: { cookie: a.cookie } })).headers.location).toBe(`/play/${id}`);

    const h = await hello(id, a.cookie);
    expect(h.type).toBe('hello');
    expect(h.view.you).toMatchObject({ id: 'p1', name: 'Alice the Bold', role: 'player', avatar: expect.stringMatching(new RegExp(`^/api/v1/games/${id}/assets/[0-9a-f]{64}\\.png$`)) });
    expect(h.view.you.accountId).toBeUndefined();
    const pic = await app.inject({ url: h.view.you.avatar, headers: { cookie: a.cookie } });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    const table = await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } });
    expect(table.body).toContain('Logged in as Alice');
    expect(table.body).toContain('action="/auth/logout"');
    expect(table.body).toContain('data-discord="1" data-linked="1"');

    // a second device: log in again, no invite, no player cookie
    const b = await login('alice');
    expect(b.cookie).not.toBe(a.cookie);
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie: b.cookie } })).statusCode).toBe(200);
    expect((await hello(id, b.cookie)).view.you.id).toBe('p1');
    const lobby = await app.inject({ url: '/play', headers: { cookie: b.cookie } });
    expect(lobby.body).toContain(`href="/play/${id}"`);
    expect(lobby.body).toContain('Curse of the Crypt');

    // someone else's login isn't in the game; nobody logged in gets the Discord button
    const bob = await login('bob');
    const notIn = await app.inject({ url: `/play/${id}`, headers: { cookie: bob.cookie } });
    expect(notIn.statusCode).toBe(403);
    expect(notIn.body).toContain('isn&#39;t in this game');
    const out = await app.inject({ url: `/play/${id}` });
    expect(out.statusCode).toBe(403);
    expect(out.body).toContain(`/auth/discord?next=${encodeURIComponent(`/play/${id}`)}`);
    expect((await hello(id, bob.cookie)).type).toBe('error');

    // a cross-site socket with the login doesn't count
    expect(await closeCode(id, { cookie: b.cookie, origin: 'http://evil.example' })).toBe(4401);

    // the GM removes the seat: every device of the account is out
    const gm = await app.injectWS(`/api/v1/games/${id}/live`, { headers: bearer });
    gm.send(JSON.stringify({ type: 'intent', ref: 1, intent: { type: 'member.remove', id: 'p1' } }));
    for (let i = 0; i < 100 && (await app.inject({ url: `/play/${id}`, headers: { cookie: b.cookie } })).statusCode === 200; i++) await new Promise((ok) => setTimeout(ok, 10));
    gm.terminate();
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } })).statusCode).toBe(403);
  });

  it('never shows Discord ids or account ids to anyone at the table', async () => {
    const id = await createGame();
    const tok = await invite(id);
    const gmAll: Msg[] = [];
    const gm = await app.injectWS(`/api/v1/games/${id}/live`, { headers: bearer }, { onInit: (s: WebSocket) => s.on('message', (raw) => gmAll.push(JSON.parse(String(raw)) as Msg)) });
    const a = await login('alice', `/play/join/${tok}`);
    expect((await joinForm(tok, 'Alice', a.cookie)).statusCode).toBe(303);
    const bobCookie = pair(cookieNamed(await joinForm(tok, 'Bob'), `delve_player_${id}`));
    for (let i = 0; i < 100 && !gmAll.some((m) => m.type === 'events' && JSON.stringify(m).includes('Bob')); i++) await new Promise((ok) => setTimeout(ok, 10));
    gm.terminate();

    const secret = [users.alice!.id, 'acc_', 'alice_d', 'accountId'];
    const seen = [JSON.stringify(gmAll), JSON.stringify(await hello(id, a.cookie)), JSON.stringify(await hello(id, bobCookie)), JSON.stringify(await gmHello(id))];
    seen.push((await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } })).body, (await app.inject({ url: `/play/${id}`, headers: { cookie: bobCookie } })).body);
    expect(gmAll.some((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'members'))).toBe(true);
    for (const text of seen) for (const s of secret) expect(text).not.toContain(s);
    // the picture is ours, not Discord's CDN (whose URLs carry the Discord id)
    expect(JSON.stringify(await hello(id, bobCookie))).toMatch(/"avatar":"\/api\/v1\/games\//);
  });

  it('updates the picture on every seat when the avatar changes', async () => {
    const id = await createGame();
    const tok = await invite(id);
    const a = await login('alice', `/play/join/${tok}`);
    await joinForm(tok, 'Alice', a.cookie);
    const before = (await hello(id, a.cookie)).view.you.avatar;
    users.alice!.avatar = AVATAR_B;
    try {
      await login('alice');
    } finally {
      users.alice!.avatar = AVATAR_A;
    }
    expect(calls.avatars.at(-1)).toContain(AVATAR_B);
    const after = (await hello(id, a.cookie)).view.you.avatar;
    expect(after).toMatch(/^\/api\/v1\/games\//);
    // same 1×1 picture from the fake, so the file is the same; the hash change still refetched it
    expect(after).toBe(before);
    users.alice!.avatar = null;
    try {
      await login('alice');
    } finally {
      users.alice!.avatar = AVATAR_A;
    }
    expect((await hello(id, a.cookie)).view.you.avatar).toBeUndefined();
  });

  it('makes invites Discord-only when the GM asks for it', async () => {
    const id = await createGame();
    const tok = await invite(id);
    const url = `/api/v1/games/${id}`;
    expect((await app.inject({ method: 'PATCH', url, payload: { requireDiscord: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url, headers: bearer, payload: { requireDiscord: 'yes' } })).statusCode).toBe(400);
    const on = await app.inject({ method: 'PATCH', url, headers: bearer, payload: { requireDiscord: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ requireDiscord: true });

    const page = await app.inject({ url: `/play/join/${tok}` });
    expect(page.body).toContain('Log in with Discord');
    expect(page.body).toContain('asks players to log in with Discord');
    expect(page.body).not.toContain('name="name"');
    const refused = await joinForm(tok, 'Nameless');
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('needs a Discord login');
    expect(cookieNamed(refused, `delve_player_${id}`)).toBeUndefined();

    const a = await login('alice', `/play/join/${tok}`);
    expect((await joinForm(tok, 'Alice', a.cookie)).statusCode).toBe(303);
    expect((await hello(id, a.cookie)).view.requireDiscord).toBeUndefined(); // a GM setting
    expect((await gmHello(id)).view.requireDiscord).toBe(true);

    expect((await app.inject({ method: 'PATCH', url, headers: bearer, payload: { requireDiscord: false } })).json()).toEqual({ requireDiscord: false });
    expect((await joinForm(tok, 'Bob')).statusCode).toBe(303);
  });
});

describe('co-GMs and logging out', () => {
  it('makes a DELVE_GM_DISCORD_IDS account GM of every game', async () => {
    await app.close();
    app = await build({ gmIds: [users.cogm!.id] });
    const one = await createGame('First game');
    await createGame('Second game');
    const gm = await login('cogm');
    const lobby = await app.inject({ url: '/play', headers: { cookie: gm.cookie } });
    expect(lobby.body).toContain('First game');
    expect(lobby.body).toContain('Second game');
    expect(lobby.body).toContain('New game');
    expect(lobby.body).toContain('Logged in with Discord as <strong>Co GM</strong>');
    expect((await app.inject({ url: '/api/v1/games', headers: { cookie: gm.cookie } })).statusCode).toBe(200);
    const h = await hello(one, gm.cookie);
    expect(h.view.you).toMatchObject({ id: 'gm', role: 'gm' });
    expect(h.view.invites).toEqual([]);
    const cross = await app.inject({ method: 'POST', url: '/api/v1/games', headers: { cookie: gm.cookie, host: HOST, origin: 'http://evil.example' }, payload: { name: 'x' } });
    expect(cross.statusCode).toBe(401);
    const same = await app.inject({ method: 'POST', url: '/api/v1/games', headers: { cookie: gm.cookie, host: HOST, origin: `http://${HOST}` }, payload: { name: 'Third' } });
    expect(same.statusCode).toBe(201);

    // an ordinary Discord login is no GM
    const bob = await login('bob');
    expect((await app.inject({ url: '/api/v1/games', headers: { cookie: bob.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/play', headers: { cookie: bob.cookie } })).body).not.toContain('First game');
  });

  it('logs out on the server too, only from this site', async () => {
    const id = await createGame();
    const tok = await invite(id);
    const a = await login('alice', `/play/join/${tok}`);
    await joinForm(tok, 'Alice', a.cookie);
    const confirm = await app.inject({ url: '/auth/logout?next=/play', headers: { cookie: a.cookie } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('method="post" action="/auth/logout"');
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } })).statusCode).toBe(200); // a GET doesn't log out

    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/auth/logout', headers: { 'content-type': 'application/x-www-form-urlencoded', host: HOST, cookie: a.cookie, ...headers }, payload: 'next=%2F%2Fevil.example' });
    expect((await post({ origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } })).statusCode).toBe(200);
    const out = await post({ origin: `http://${HOST}` });
    expect(out.statusCode).toBe(303);
    expect(out.headers.location).toBe('/play');
    expect(cookieNamed(out, 'delve_account')).toBe('delve_account=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    // the old cookie is dead even if a browser kept it
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie: a.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/play', headers: { cookie: a.cookie } })).body).toContain('Log in with Discord');
    // logging in again finds the same seat
    const again = await login('alice');
    expect((await hello(id, again.cookie)).view.you.name).toBe('Alice');
  });

  it('keeps accounts and seats across a restart', async () => {
    const id = await createGame();
    const tok = await invite(id);
    const a = await login('alice', `/play/join/${tok}`);
    await joinForm(tok, 'Alice', a.cookie);
    await app.close();
    app = await build();
    expect((await hello(id, a.cookie)).view.you).toMatchObject({ id: 'p1', name: 'Alice' });
  });
});
