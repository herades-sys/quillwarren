// Delve Table's server: games, invites and player cookies, the live channel's
// per-member filtering, uploads, and pages made from Delve maps.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { computeFloor, computeWalls, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { Sessions } from '../src/auth.ts';
import { sceneFor } from '../src/render.ts';

const TOKEN = 'table-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const session = `delve_session=${new Sessions(TOKEN).issue()}`;
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

type Msg = Record<string, any>;

let dir: string;
let app: FastifyInstance;

/** An app whose table keeps its data in `dir`. */
async function build(): Promise<FastifyInstance> {
  const built = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir });
  await built.ready();
  return built;
}

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), 'delve-table-'));
  app = await build();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createGame(name = 'Crypt night'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function invite(gameId: string, body: object = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: body });
  expect(res.statusCode).toBe(201);
  return String(res.json().url).split('/play/join/')[1]!;
}

const joinForm = (token: string, name: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/play/join/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams({ name }).toString(),
  });

/** Join through an invite and return the player's cookie ("delve_player_<id>=…"). */
async function join(gameId: string, name: string, token?: string): Promise<string> {
  const res = await joinForm(token ?? (await invite(gameId)), name);
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe(`/play/${gameId}`);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** A live connection that keeps every message, so tests can await them in order and check what never came. */
async function connect(gameId: string, headers: Record<string, string>, query = '') {
  const all: Msg[] = [];
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  let closed: (c: number) => void = () => {};
  const closing = new Promise<number>((ok) => (closed = ok));
  const ws: WebSocket = await app.injectWS(`/api/v1/games/${gameId}/live${query}`, { headers }, {
    onInit: (s: WebSocket) => {
      s.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as Msg;
        all.push(m);
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      });
      s.on('close', (code) => closed(code));
    },
  });
  const next = (): Promise<Msg> => new Promise((ok) => (queue.length ? ok(queue.shift()!) : waiters.push(ok)));
  let ref = 0;
  return {
    ws,
    all,
    next,
    closing,
    /** The next message of this type, skipping others. */
    async nextOf(type: string): Promise<Msg> {
      for (;;) {
        const m = await next();
        if (m.type === type) return m;
      }
    },
    /** Send an intent and wait for its ack or error (events that come first are kept for next()). */
    async intent(intent: object): Promise<Msg> {
      const r = ++ref;
      ws.send(JSON.stringify({ type: 'intent', ref: r, intent }));
      for (;;) {
        const i = queue.findIndex((m) => (m.type === 'ack' || m.type === 'error') && m.ref === r);
        if (i >= 0) return queue.splice(i, 1)[0]!;
        await new Promise((ok) => setTimeout(ok, 5));
      }
    },
    send: (msg: unknown) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  };
}
type Client = Awaited<ReturnType<typeof connect>>;

const gmSocket = (gameId: string) => connect(gameId, { cookie: session });
const token = (over: object = {}) => ({ pageId: 'pg1', layer: 'tokens', x: 2, y: 3, w: 1, h: 1, image: '/assets/props/x.svg', controlledBy: [], ...over });

/** Events for this client until one of the given type arrives; returns them all. */
async function eventsUntil(c: Client, type: string): Promise<Msg[]> {
  const got: Msg[] = [];
  for (;;) {
    const m = await c.next();
    if (m.type === 'events') {
      got.push(...m.events);
      if (m.events.some((e: Msg) => e.type === type)) return got;
    }
  }
}

/** The first event (in any events message) that matches. */
async function eventWhere(c: Client, pred: (e: Msg) => boolean): Promise<Msg> {
  for (;;) {
    const m = await c.next();
    const hit = m.type === 'events' ? (m.events as Msg[]).find(pred) : undefined;
    if (hit) return hit;
  }
}

describe('games and access', () => {
  it('lets only the GM create and list games', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/games', payload: { name: 'Nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: '' } })).statusCode).toBe(400);
    const id = await createGame('Curse of the Crypt');
    expect(id).toMatch(/^game_[0-9a-f]{12}$/);
    expect((await app.inject({ url: '/api/v1/games' })).statusCode).toBe(401);
    const list = await app.inject({ url: '/api/v1/games', headers: { cookie: session } });
    expect(list.json().games).toEqual([{ id, name: 'Curse of the Crypt', created: expect.any(String), players: 0 }]);
    // a cookie write from another site doesn't count
    const cross = await app.inject({ method: 'POST', url: '/api/v1/games', headers: { cookie: session, host: 'delve.test', origin: 'http://evil.example' }, payload: { name: 'x' } });
    expect(cross.statusCode).toBe(401);
  });

  it('serves the lobby to the GM, a hint to everyone else, and the table to members only', async () => {
    const id = await createGame('Curse of the Crypt');
    const lobby = await app.inject({ url: '/play', headers: { cookie: session } });
    expect(lobby.statusCode).toBe(200);
    expect(lobby.body).toContain('Curse of the Crypt');
    expect(lobby.body).toContain(`href="/play/${id}"`);
    const anon = await app.inject({ url: '/play' });
    expect(anon.body).toContain('ask your GM for an invite link');
    expect(anon.body).not.toContain('Curse of the Crypt');

    expect((await app.inject({ url: `/play/${id}` })).statusCode).toBe(403);
    expect((await app.inject({ url: '/play/game_000000000000' })).statusCode).toBe(404);
    const table = await app.inject({ url: `/play/${id}`, headers: { cookie: session } });
    expect(table.statusCode).toBe(200);
    expect(table.headers['content-type']).toMatch(/^text\/html/);

    const made = await app.inject({ method: 'POST', url: '/play/new', headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=Second+game' });
    expect(made.statusCode).toBe(303);
    expect(made.headers.location).toMatch(/^\/play\/game_[0-9a-f]{12}$/);
    expect((await app.inject({ method: 'POST', url: '/play/new', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=x' })).statusCode).toBe(401);
  });

  it('closes the live channel for non-members with 4401', async () => {
    const id = await createGame();
    const c = await connect(id, {});
    expect((await c.next()).type).toBe('error');
    expect(await c.closing).toBe(4401);
    const forged = await connect(id, { cookie: `delve_player_${id}=p1.${'A'.repeat(43)}` });
    expect(await forged.closing).toBe(4401);
    const unknown = await connect('game_000000000000', { cookie: session });
    expect(await unknown.closing).toBe(4401);
  });
});

describe('invites and players', () => {
  it('joins through an invite link, sets a signed cookie and says hello as that player', async () => {
    const id = await createGame();
    const res = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/invites`, headers: bearer, payload: { name: 'Thursday group' } });
    expect(res.statusCode).toBe(201);
    const { url, expires } = res.json();
    expect(url).toMatch(/^http:\/\/[^/]+\/play\/join\/[\w-]+\.[\w-]{43}$/);
    expect(expires).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    const tok = String(url).split('/play/join/')[1]!;

    const form = await app.inject({ url: `/play/join/${tok}` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('name="name"');
    expect(form.body).toContain('Thursday group');

    expect((await joinForm(tok, 'Alice', { host: 'delve.test', origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await joinForm(tok, '   ')).statusCode).toBe(400);
    const joined = await joinForm(tok, 'Alice');
    expect(joined.statusCode).toBe(303);
    expect(joined.headers.location).toBe(`/play/${id}`);
    const setCookie = String(joined.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^delve_player_${id}=p1\\.[\\w-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`));
    const cookie = setCookie.split(';')[0]!;

    // the same link works for a second player (Roll20-style)
    await join(id, 'Bob', tok);
    expect((await app.inject({ url: '/api/v1/games', headers: bearer })).json().games[0].players).toBe(2);

    expect((await app.inject({ url: `/play/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/play/join/${tok}`, headers: { cookie } })).headers.location).toBe(`/play/${id}`);
    const lobby = await app.inject({ url: '/play', headers: { cookie } });
    expect(lobby.body).toContain(`href="/play/${id}"`); // "your games"

    const p = await connect(id, { cookie });
    const hello = await p.next();
    expect(hello.type).toBe('hello');
    expect(hello.view.you).toMatchObject({ id: 'p1', name: 'Alice', role: 'player' });
    expect(hello.view.invites).toBeUndefined();
    expect(JSON.stringify(hello)).not.toContain('Thursday group');

    // a player cookie wins over the GM login, until /leave drops it
    const both = await connect(id, { cookie: `${session}; ${cookie}` });
    expect((await both.next()).view.you.id).toBe('p1');
    const leave = await app.inject({ url: `/play/${id}/leave`, headers: { cookie } });
    expect(leave.statusCode).toBe(303);
    expect(String(leave.headers['set-cookie'])).toContain(`delve_player_${id}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });

  it('refuses expired, withdrawn and forged invites with a friendly page', async () => {
    const id = await createGame();
    const expired = await invite(id, { hours: 1e-9 });
    const e = await app.inject({ url: `/play/join/${expired}` });
    expect(e.statusCode).toBe(410);
    expect(e.body).toContain('expired');
    expect((await joinForm(expired, 'Late')).statusCode).toBe(410);

    const res = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/invites`, headers: bearer, payload: {} });
    const { id: inviteId, url } = res.json();
    const tok = String(url).split('/play/join/')[1]!;
    const listed = await app.inject({ url: `/api/v1/games/${id}/invites`, headers: bearer });
    expect(listed.json().invites.map((i: Msg) => i.id)).toContain(inviteId);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/games/${id}/invites/${inviteId}`, headers: bearer })).statusCode).toBe(204);
    const w = await app.inject({ url: `/play/join/${tok}` });
    expect(w.statusCode).toBe(410);
    expect(w.body).toContain('withdrawn');

    const [payload, mac] = tok.split('.');
    const other = Buffer.from(JSON.stringify({ g: id, i: inviteId, e: Date.now() + 1e9 })).toString('base64url');
    expect((await app.inject({ url: `/play/join/${other}.${mac}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/play/join/${payload}.${'A'.repeat(43)}` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/play/join/nonsense' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/invites`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/invites`, headers: bearer, payload: { hours: -1 } })).statusCode).toBe(400);
  });

  it('keeps games, chat and player cookies across a restart', async () => {
    const id = await createGame();
    const cookie = await join(id, 'Alice');
    const p = await connect(id, { cookie });
    await p.next();
    expect((await p.intent({ type: 'chat.send', text: 'still here?' })).type).toBe('ack');
    await app.close();
    app = await build();
    expect((await app.inject({ url: '/api/v1/games', headers: bearer })).json().games).toMatchObject([{ id, players: 1 }]);
    const again = await connect(id, { cookie });
    const hello = await again.next();
    expect(hello.view.you.name).toBe('Alice');
    expect(hello.chat.map((m: Msg) => m.text)).toEqual(['still here?']);
  });
});

describe('the live channel', () => {
  it('never sends players gm-layer tokens or GM notes', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    const gmHello = await gm.next();
    expect(gmHello.view.you.role).toBe('gm');
    const p = await connect(id, { cookie: await join(id, 'Alice') });
    await p.next();

    expect(await gm.intent({ type: 'token.create', token: token({ id: 'lurker', layer: 'gm', name: 'Hidden ogre', gmNotes: 'ambush-secret' }) })).toMatchObject({ type: 'ack' });
    expect(await gm.intent({ type: 'token.create', token: token({ id: 'goblin', name: 'Goblin', gmNotes: 'carries-the-key-secret' }) })).toMatchObject({ type: 'ack' });
    const seen = (await eventsUntil(p, 'token.upsert')).filter((e) => e.type === 'token.upsert');
    expect(seen).toEqual([{ type: 'token.upsert', token: expect.objectContaining({ id: 'goblin', name: 'Goblin' }) }]);
    expect(seen[0]!.token.gmNotes).toBeUndefined();

    const later = await connect(id, { cookie: await join(id, 'Bob') });
    const hello = await later.next();
    expect(hello.view.tokens.map((t: Msg) => t.id)).toEqual(['goblin']);

    // the GM still has everything
    const gm2 = await gmSocket(id);
    const full = await gm2.next();
    expect(full.view.tokens.map((t: Msg) => t.id).sort()).toEqual(['goblin', 'lurker']);
    expect(JSON.stringify(full)).toContain('ambush-secret');

    // (bare ids of gm-layer tokens are checked by packages/table's own leak test)
    for (const msgs of [p.all, later.all]) {
      const text = JSON.stringify(msgs);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('Hidden ogre');
    }
  });

  it('acks a move of a token the player controls and refuses one they don’t', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const p = await connect(id, { cookie: await join(id, 'Alice') });
    await p.next();
    await gm.intent({ type: 'token.create', token: token({ id: 'hero', controlledBy: ['p1'] }) });
    await gm.intent({ type: 'token.create', token: token({ id: 'ogre', x: 8 }) });

    const ok = await p.intent({ type: 'token.move', id: 'hero', x: 5, y: 6 });
    expect(ok).toMatchObject({ type: 'ack', ref: 1, rev: expect.any(Number) });
    const moved = await eventWhere(gm, (e) => e.type === 'token.upsert' && e.token.id === 'hero' && e.token.x === 5);
    expect(moved.token).toMatchObject({ x: 5, y: 6 });

    const no = await p.intent({ type: 'token.move', id: 'ogre', x: 1, y: 1 });
    expect(no).toMatchObject({ type: 'error', ref: 2, error: expect.any(String) });
    const ogre = await connect(id, { cookie: session });
    expect((await ogre.next()).view.tokens.find((t: Msg) => t.id === 'ogre')).toMatchObject({ x: 8, y: 3 });
  });

  it('sends rolls to everyone and whispers only to the people in them', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const alice = await connect(id, { cookie: await join(id, 'Alice') });
    await alice.next();
    const bobCookie = await join(id, 'Bob');
    const bob = await connect(id, { cookie: bobCookie });
    await bob.next();
    const chatOf = async (c: Client) => (await eventsUntil(c, 'chat')).find((e) => e.type === 'chat')!.message as Msg;

    expect((await alice.intent({ type: 'chat.send', text: '/r 2d6+3' })).type).toBe('ack');
    for (const c of [gm, alice, bob]) {
      const m = await chatOf(c);
      expect(m).toMatchObject({ kind: 'roll', from: 'p1', speaker: 'Alice' });
      expect(m.rolls[0].terms[0].dice).toHaveLength(2);
      expect(m.rolls[0].total).toBeGreaterThanOrEqual(5);
    }

    await alice.intent({ type: 'chat.send', text: '/w GM the door is a mimic' });
    await alice.intent({ type: 'chat.send', text: 'anyway' });
    expect((await chatOf(gm)).text).toBe('the door is a mimic');
    expect((await chatOf(alice)).text).toBe('the door is a mimic');
    expect((await chatOf(bob)).text).toBe('anyway'); // the whisper never came
    expect(JSON.stringify(bob.all)).not.toContain('mimic');

    // nor does it come later, in the stored log
    const bobAgain = await connect(id, { cookie: bobCookie });
    expect(JSON.stringify((await bobAgain.next()).chat)).not.toContain('mimic');
    const gmAgain = await gmSocket(id);
    expect((await gmAgain.next()).chat.map((m: Msg) => m.text)).toContain('the door is a mimic');
  });

  it('gives the players a fresh hello when the GM moves them to another page', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const p = await connect(id, { cookie: await join(id, 'Alice') });
    const first = await p.next();
    expect(first.view.pageId).toBe('pg1');

    const made = await gm.intent({ type: 'page.create', page: { id: 'cellar', name: 'Cellar', width: 10, height: 8, origin: [0, 0], cellPx: 70, cellUnit: '5 ft', showGrid: true, background: { kind: 'none' } } });
    expect(made.type).toBe('ack');
    await gm.intent({ type: 'token.create', token: token({ id: 'rat', pageId: 'cellar' }) });
    expect(await gm.intent({ type: 'page.activate', id: 'cellar' })).toMatchObject({ type: 'ack' });
    const hello = await p.nextOf('hello');
    expect(hello.view.pageId).toBe('cellar');
    expect(hello.view.pages.map((pg: Msg) => pg.id)).toEqual(['cellar']);
    expect(hello.view.tokens.map((t: Msg) => t.id)).toEqual(['rat']);
    // before the switch the player heard nothing of the other page
    const before = p.all.slice(0, p.all.indexOf(hello));
    expect(JSON.stringify(before)).not.toContain('Cellar');
  });

  it('relays pings to the members on that page, throttled', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const p = await connect(id, { cookie: await join(id, 'Alice') });
    const hello = await p.next();
    p.send({ type: 'ping', pageId: 'pg1', x: 3.5, y: 4 });
    const got = await gm.nextOf('ping');
    expect(got).toEqual({ type: 'ping', from: 'p1', color: hello.view.you.color, pageId: 'pg1', x: 3.5, y: 4 });
    p.send({ type: 'ping', pageId: 'elsewhere', x: 1, y: 1 }); // not their page: dropped
    for (let i = 0; i < 40; i++) p.send({ type: 'ping', pageId: 'pg1', x: i, y: 0 });
    await new Promise((ok) => setTimeout(ok, 100));
    const pings = gm.all.filter((m) => m.type === 'ping');
    expect(pings.length).toBeLessThanOrEqual(21 + 20); // at most 20 per second (the burst may straddle two seconds)
    expect(pings.length).toBeLessThan(41);
    expect(pings.some((m) => m.pageId === 'elsewhere')).toBe(false);
  });

  it('answers bad messages with errors and keeps going', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    gm.send('not json');
    expect(await gm.next()).toMatchObject({ type: 'error', error: expect.stringContaining('JSON') });
    gm.send({ type: 'teleport' });
    expect((await gm.next()).type).toBe('error');
    gm.send({ type: 'intent', intent: { type: 'chat.send', text: 'x' } });
    expect((await gm.next()).error).toContain('ref');
    gm.send({ type: 'intent', ref: 9, intent: 'nope' });
    expect(await gm.next()).toMatchObject({ type: 'error', ref: 9 });
    gm.send({ type: 'intent', ref: 10, intent: { type: 'token.move', id: 'ghost', x: 0, y: 0 } });
    expect(await gm.next()).toMatchObject({ type: 'error', ref: 10 });
    gm.send({ type: 'keepalive' });
    gm.send({ type: 'intent', ref: 11, intent: { type: 'chat.send', text: 'x'.repeat(70_000) } });
    expect(await gm.next()).toMatchObject({ type: 'error', error: expect.stringContaining('64 KB') });
    expect(await gm.intent({ type: 'chat.send', text: 'still alive' })).toMatchObject({ type: 'ack' });
  });

  it('says bye to a removed member, whose cookie then stops working', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const cookie = await join(id, 'Alice');
    const p = await connect(id, { cookie });
    await p.next();
    expect(await gm.intent({ type: 'member.remove', id: 'p1' })).toMatchObject({ type: 'ack' });
    expect(await p.nextOf('bye')).toMatchObject({ type: 'bye', reason: expect.any(String) });
    expect(await p.closing).toBe(4403);
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie } })).statusCode).toBe(403);
    const again = await connect(id, { cookie });
    expect(await again.closing).toBe(4401);
    // the next player gets a new id, and the old cookie doesn't fit it
    const bob = await join(id, 'Bob');
    expect(bob).toMatch(new RegExp(`^delve_player_${id}=p2\\.`));
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie } })).statusCode).toBe(403);
  });

  it('says bye to everyone when the game is deleted', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();
    const p = await connect(id, { cookie: await join(id, 'Alice') });
    await p.next();
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/games/${id}`, headers: bearer })).statusCode).toBe(204);
    expect((await p.nextOf('bye')).type).toBe('bye');
    expect((await gm.nextOf('bye')).type).toBe('bye');
    expect(await p.closing).toBe(4404);
    expect((await app.inject({ url: '/api/v1/games', headers: bearer })).json().games).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/games/${id}`, headers: bearer })).statusCode).toBe(404);
  });

  it('refreshes the GM’s view when invites change', async () => {
    const id = await createGame();
    const gm = await gmSocket(id);
    expect((await gm.next()).view.invites).toEqual([]);
    await invite(id, { name: 'Friday' });
    const hello = await gm.nextOf('hello');
    expect(hello.view.invites).toMatchObject([{ name: 'Friday' }]);
  });
});

describe('images', () => {
  it('stores PNGs for the GM, serves them to members only, and refuses anything else', async () => {
    const id = await createGame();
    const up = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { ...bearer, 'content-type': 'image/png' }, payload: PNG });
    expect(up.statusCode).toBe(201);
    const { url } = up.json();
    expect(url).toMatch(new RegExp(`^/api/v1/games/${id}/assets/[0-9a-f]{64}\\.png$`));
    const raw = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { ...bearer, 'content-type': 'application/octet-stream' }, payload: PNG });
    expect(raw.json().url).toBe(url); // same bytes, same file

    const text = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { ...bearer, 'content-type': 'application/octet-stream' }, payload: Buffer.from('just some text') });
    expect(text.statusCode).toBe(415);
    const plain = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { ...bearer, 'content-type': 'text/plain' }, payload: 'hello' });
    expect(plain.statusCode).toBe(415);
    const big = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { ...bearer, 'content-type': 'image/png' }, payload: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]) });
    expect(big.statusCode).toBe(413);

    const cookie = await join(id, 'Alice');
    expect((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/assets`, headers: { cookie, 'content-type': 'image/png' }, payload: PNG })).statusCode).toBe(401);
    const got = await app.inject({ url, headers: { cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('max-age=31536000');
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/games/${id}/assets/../../etc.png`, headers: bearer })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/games/${id}/assets/${'0'.repeat(64)}.png`, headers: bearer })).statusCode).toBe(404);
  });
});

describe('pages from Delve maps', () => {
  it('sizes the page from the players’ render bounds and keeps the walls, secret doors shut', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon', name: 'Test dungeon' } });
    const { id: mapId, map } = res.json() as { id: string; map: DelveMap };
    const id = await createGame();
    const gm = await gmSocket(id);
    await gm.next();

    const made = await app.inject({ method: 'POST', url: `/api/v1/games/${id}/pages/from-map`, headers: bearer, payload: { mapId } });
    expect(made.statusCode).toBe(201);
    const { page } = made.json();
    const { bounds } = sceneFor(map, { view: 'players' });
    expect(page).toMatchObject({
      name: 'Test dungeon',
      width: bounds.x1 - bounds.x0,
      height: bounds.y1 - bounds.y0,
      origin: [bounds.x0, bounds.y0],
      cellPx: 70,
      cellUnit: '5 ft',
      background: { kind: 'delve', mapId },
    });
    expect([page.width, page.height, ...page.origin]).toEqual([26, 38, -3, -3]);
    const shut = { ...map, objects: map.objects.filter((o) => !(o.type === 'door' && o.style === 'secret')) };
    // the players' walls: the secret door (d6, across a corridor mouth) is a wall like any other
    expect(page.walls).toEqual([...computeWalls(shut, computeFloor(map)), [[16, 5], [16, 6]]]);
    expect(page.walls.length).toBe(computeWalls(map).length + 1);
    // it went out like any other change
    const ev = await eventsUntil(gm, 'page.upsert');
    expect(ev.find((e) => e.type === 'page.upsert')!.page.id).toBe(page.id);

    expect((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/pages/from-map`, headers: bearer, payload: { mapId: 'map_nope' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/pages/from-map`, payload: { mapId } })).statusCode).toBe(401);
  });

  it('sends the page again when its Delve map changes, so the picture reloads', async () => {
    const { id: mapId } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon', name: 'Crypt' } })).json() as { id: string };
    const id = await createGame();
    const { page } = (await app.inject({ method: 'POST', url: `/api/v1/games/${id}/pages/from-map`, headers: bearer, payload: { mapId } })).json();
    const gm = await gmSocket(id);
    await gm.next();
    // three quick edits (a fog reveal, say) arrive as one page update once the map settles
    for (const x of [1, 2, 3]) await app.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: bearer, payload: { ops: [{ op: 'update_map', set: { seed: x } }] } });
    const started = Date.now();
    const again = await eventWhere(gm, (e) => e.type === 'page.upsert');
    expect(again.page).toEqual(page);
    expect(Date.now() - started).toBeGreaterThan(300);
    await new Promise((ok) => setTimeout(ok, 1000));
    expect(gm.all.filter((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'page.upsert'))).toHaveLength(1);
  });
});
