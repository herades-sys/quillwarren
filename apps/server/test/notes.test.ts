// GM notes (docs/TABLE.md, "GM notes"): room, corridor and terrain notes travel
// with the Quillwarren map but never reach a player (pictures, 3D scenes, the live
// channel, the players' screen, exports), and the GM's session notebook is the
// GM's alone (REST and GM-only live messages).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { DelveMap } from '@delve/core';
import type { NotebookEntry, Page } from '@delve/table';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { Sessions } from '../src/auth.ts';

const TOKEN = 'notes-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const session = `delve_session=${new Sessions(TOKEN).issue()}`;
const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };
// the fixture's own room note (r5), and the ones the tests add
const SECRETS = ['Cult leader', 'ogre-under-the-floor', 'oil-slick-corridor', 'drowned-key'];

type Msg = Record<string, any>;

let dir: string;
let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const built = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir, publicUrl: 'https://delve.example' });
  await built.ready();
  return built;
}

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), 'delve-notes-'));
  app = await build();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));

async function createGame(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: 'Notes night' } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function join(gameId: string, name: string): Promise<string> {
  const inv = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: {} });
  const token = String(inv.json().url).split('/play/join/')[1]!;
  const res = await app.inject({ method: 'POST', url: `/play/join/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ name }).toString() });
  expect(res.statusCode).toBe(303);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** A live connection that keeps every message. */
async function connect(gameId: string, headers: Record<string, string>) {
  const all: Msg[] = [];
  const ws: WebSocket = await app.injectWS(`/api/v1/games/${gameId}/live`, { headers }, {
    onInit: (s: WebSocket) => s.on('message', (raw) => all.push(JSON.parse(String(raw)) as Msg)),
  });
  let ref = 0;
  return {
    ws,
    all,
    async until(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
      const end = Date.now() + ms;
      for (;;) {
        const m = all.find(pred);
        if (m) return m;
        if (Date.now() > end) throw new Error('no such message came');
        await sleep(10);
      }
    },
    async intent(intent: object): Promise<Msg> {
      const r = ++ref;
      ws.send(JSON.stringify({ type: 'intent', ref: r, intent }));
      for (;;) {
        const m = all.find((x) => (x.type === 'ack' || x.type === 'error') && x.ref === r);
        if (m) return m;
        await sleep(5);
      }
    },
  };
}

const ops = (mapId: string, list: object[]) => app.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: bearer, payload: { ops: list } });

/** The test dungeon (r5 has notes) as the players' page of a new game, with a player at the table. */
async function table(): Promise<{ gameId: string; page: Page; mapId: string; cookie: string }> {
  const { id: mapId } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon', name: 'Crypt' } })).json() as { id: string };
  const gameId = await createGame();
  const { page } = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/pages/from-map`, headers: bearer, payload: { mapId } })).json() as { page: Page };
  const gm = await connect(gameId, { cookie: session });
  expect(await gm.intent({ type: 'page.activate', id: page.id })).toMatchObject({ type: 'ack' });
  gm.ws.terminate();
  const cookie = await join(gameId, 'Alice');
  return { gameId, page, mapId, cookie };
}

const noteOps: [object, object, object] = [
  { op: 'update', id: 'r1', set: { notes: 'ogre-under-the-floor' } },
  { op: 'update', id: 'c1', set: { notes: 'oil-slick-corridor' } },
  { op: 'add', object: { id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [8, 26, 2, 2] }, notes: 'drowned-key' } },
];

describe('room notes never reach players', () => {
  it('leave the players’ picture, scene and screen as they were, and stay out of them', async () => {
    const { gameId, page, mapId, cookie } = await table();
    const png = `/api/v1/games/${gameId}/pages/${page.id}/background.png`;
    // the terrain itself is drawn: add it first, then compare pictures with and without the notes
    expect((await ops(mapId, [{ op: 'add', object: { id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [8, 26, 2, 2] } } }])).statusCode).toBe(200);
    const before = (await app.inject({ url: png, headers: { cookie } })).rawPayload;
    const notes = [noteOps[0], noteOps[1], { op: 'update', id: 't1', set: { notes: 'drowned-key' } }];
    expect((await ops(mapId, notes)).statusCode).toBe(200);
    const after = await app.inject({ url: png, headers: { cookie } });
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.equals(before)).toBe(true);
    expect(leaks(after.rawPayload.toString('latin1'))).toEqual([]);

    for (const q of ['', '?view=gm']) {
      // players always get the players' scene; the GM's own scene has no notes either (they come from the map)
      const s = await app.inject({ url: `/api/v1/games/${gameId}/pages/${page.id}/scene3d.json${q}`, headers: { cookie } });
      expect(s.statusCode).toBe(200);
      expect(leaks(s.body)).toEqual([]);
    }
    const gmScene = await app.inject({ url: `/api/v1/games/${gameId}/pages/${page.id}/scene3d.json?view=gm`, headers: { cookie: session } });
    expect(leaks(gmScene.body)).toEqual([]);

    // the players' screen and its picture, the players' render and handout
    for (const url of [`/maps/${mapId}/screen`, `/api/v1/maps/${mapId}/screen`, `/api/v1/maps/${mapId}/render.svg?view=players`, `/api/v1/maps/${mapId}/render.svg?view=gm`, `/api/v1/maps/${mapId}/handout.svg`]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(leaks(res.body), url).toEqual([]);
    }
    // the table page itself
    expect(leaks((await app.inject({ url: `/play/${gameId}`, headers: { cookie } })).body)).toEqual([]);
  });

  it('are not in Dungeon Scrawl exports, but are in Claude’s text view', async () => {
    const { mapId } = await table();
    expect((await ops(mapId, noteOps)).statusCode).toBe(200);
    for (const view of ['gm', 'players']) {
      const ds = await app.inject({ url: `/api/v1/maps/${mapId}/export.ds?view=${view}` });
      expect(ds.statusCode).toBe(200);
      expect(leaks(ds.rawPayload.toString('utf8'))).toEqual([]);
    }
    const text = (await app.inject({ url: `/api/v1/maps/${mapId}/describe` })).body;
    expect(text).toContain('GM notes (GM only, never drawn):');
    expect(leaks(text)).toEqual(SECRETS);
  });

  it('send players nothing over the live channel; the GM hears “map.notes” and no page again', async () => {
    const { gameId, mapId, cookie } = await table();
    const player = await connect(gameId, { cookie });
    const gm = await connect(gameId, { cookie: session });
    await player.until((m) => m.type === 'hello');
    await gm.until((m) => m.type === 'hello');
    const seenBefore = player.all.length;
    expect((await ops(mapId, [noteOps[0], noteOps[1]])).statusCode).toBe(200);
    const heard = await gm.until((m) => m.type === 'map.notes');
    expect(heard).toEqual({ type: 'map.notes', mapId });
    await sleep(300);
    // nothing at all for the player: no page.upsert, so no picture or 3D scene is fetched again
    expect(player.all.slice(seenBefore)).toEqual([]);
    expect(gm.all.some((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'page.upsert'))).toBe(false);

    // a real change still redraws the page for everyone, notes or not in the same wait
    expect((await ops(mapId, [{ op: 'update', id: 'r1', set: { notes: 'ogre-under-the-floor (2)' } }, { op: 'update', id: 'r2', set: { name: 'Crossroads!' } }])).statusCode).toBe(200);
    const upsert = await player.until((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'page.upsert'));
    expect(upsert).toBeTruthy();
    for (const m of player.all) expect(leaks(JSON.stringify(m))).toEqual([]);
    // the player's page has no map id to fetch notes with
    const hello = player.all.find((m) => m.type === 'hello')!;
    expect(hello.view.pages[0].background).toEqual({ kind: 'delve', mapId: '' });
    player.ws.terminate();
    gm.ws.terminate();
  });

  it('do not wake the players’ screen; other changes do', async () => {
    const { mapId } = await table();
    const got: Msg[] = [];
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${mapId}/live?screen=1`, {}, { onInit: (s: WebSocket) => s.on('message', (raw) => got.push(JSON.parse(String(raw)) as Msg)) });
    for (let i = 0; i < 100 && !got.length; i++) await sleep(5);
    expect(got).toMatchObject([{ type: 'hello' }]);
    expect((await ops(mapId, [noteOps[0]])).statusCode).toBe(200);
    expect((await ops(mapId, [{ op: 'update', id: 'r1', unset: ['notes'] }])).statusCode).toBe(200);
    await sleep(100);
    expect(got).toHaveLength(1);
    expect((await ops(mapId, [{ op: 'update', id: 'r2', set: { name: 'Hall' } }])).statusCode).toBe(200);
    for (let i = 0; i < 100 && got.length < 2; i++) await sleep(5);
    expect(got[1]).toMatchObject({ type: 'changed' });
    for (const m of got) expect(leaks(JSON.stringify(m))).toEqual([]);
    ws.terminate();
  });

  it('are the GM’s to write with map ops, and refused without the editor login', async () => {
    const { mapId } = await table();
    const res = await app.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: { cookie: session, origin: 'http://table.lan:8799', host: 'table.lan:8799' }, payload: { ops: [noteOps[0]], by: 'table' } });
    expect(res.statusCode).toBe(200);
    const map = (await app.inject({ url: `/api/v1/maps/${mapId}` })).json().map as DelveMap;
    expect(map.objects.find((o) => o.id === 'r1')).toMatchObject({ notes: 'ogre-under-the-floor' });
    // a player's cookie is no editor login
    const { cookie } = await table();
    const refused = await app.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: { cookie }, payload: { ops: [noteOps[1]] } });
    expect(refused.statusCode).toBe(401);
    // and from the internet nobody reads the map without logging in
    expect((await app.inject({ url: `/api/v1/maps/${mapId}`, headers: tunnel })).statusCode).toBe(401);
  });
});

describe('the session notebook', () => {
  const nb = (gameId: string, rest = '') => `/api/v1/games/${gameId}/notebook${rest}`;

  it('is written, read, renamed and deleted by the GM, and kept across a restart', async () => {
    const gameId = await createGame();
    expect((await app.inject({ url: nb(gameId), headers: bearer })).json()).toEqual({ entries: [] });
    const made = await app.inject({ method: 'POST', url: nb(gameId), headers: bearer, payload: { title: '  Session  1 ', text: 'Met the\r\nduke' } });
    expect(made.statusCode).toBe(201);
    const entry = made.json().entry as NotebookEntry;
    expect(entry).toMatchObject({ id: expect.stringMatching(/^nb_[0-9a-f]{12}$/), title: 'Session 1', text: 'Met the\nduke' });
    expect(entry.created).toBe(entry.updated);
    const blank = (await app.inject({ method: 'POST', url: nb(gameId), headers: bearer, payload: {} })).json().entry as NotebookEntry;
    expect(blank).toMatchObject({ title: 'Untitled', text: '' });

    await sleep(5); // a later change than both creations
    const patched = await app.inject({ method: 'PATCH', url: nb(gameId, `/${entry.id}`), headers: bearer, payload: { title: 'NPCs', text: 'Duke Varo: wants the key' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().entry).toMatchObject({ id: entry.id, title: 'NPCs', text: 'Duke Varo: wants the key', created: entry.created });
    expect(patched.json().entry.updated).toBeGreaterThan(entry.updated);

    await app.close();
    app = await build();
    const list = (await app.inject({ url: nb(gameId), headers: bearer })).json().entries as NotebookEntry[];
    expect(list.map((e) => e.id)).toEqual([entry.id, blank.id]); // the latest change first
    expect(list[0]).toMatchObject({ title: 'NPCs', text: 'Duke Varo: wants the key' });

    expect((await app.inject({ method: 'DELETE', url: nb(gameId, `/${blank.id}`), headers: bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: nb(gameId, `/${blank.id}`), headers: bearer })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: nb(gameId, '/nb_000000000000'), headers: bearer, payload: { text: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ url: nb(gameId), headers: bearer })).json().entries).toHaveLength(1);
    // deleting the game deletes its notebook
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/games/${gameId}`, headers: bearer })).statusCode).toBe(204);
    expect((await app.inject({ url: nb(gameId), headers: bearer })).statusCode).toBe(404);
  });

  it('checks what is written', async () => {
    const gameId = await createGame();
    const post = (payload: object) => app.inject({ method: 'POST', url: nb(gameId), headers: bearer, payload });
    expect((await post({ title: 'x'.repeat(121) })).json()).toEqual({ error: 'title is too long (max 120 characters)' });
    expect((await post({ text: 'x'.repeat(100_001) })).statusCode).toBe(400);
    expect((await post({ text: 5 })).json()).toEqual({ error: 'text must be text' });
    expect((await post({ title: 'a', secret: true })).json()).toEqual({ error: 'notebook entries have no field "secret"' });
    expect((await post({ title: 'Line\none' })).json().entry.title).toBe('Line one');
  });

  it('is the GM’s alone: players, strangers and other sites are refused', async () => {
    const { gameId, cookie } = await table();
    const entry = (await app.inject({ method: 'POST', url: nb(gameId), headers: bearer, payload: { title: 'Plot', text: 'drowned-key' } })).json().entry as NotebookEntry;
    const tries = [
      { method: 'GET' as const, url: nb(gameId) },
      { method: 'POST' as const, url: nb(gameId), payload: { title: 'x' } },
      { method: 'PATCH' as const, url: nb(gameId, `/${entry.id}`), payload: { text: 'x' } },
      { method: 'DELETE' as const, url: nb(gameId, `/${entry.id}`) },
    ];
    for (const t of tries) {
      const asPlayer = await app.inject({ ...t, headers: { cookie } });
      expect(asPlayer.statusCode, `${t.method} as a player`).toBe(403);
      expect(leaks(asPlayer.body)).toEqual([]);
      // the GM trying the game with a player cookie is a player too
      expect((await app.inject({ ...t, headers: { cookie: `${session}; ${cookie}` } })).statusCode).toBe(403);
      expect((await app.inject(t)).statusCode, `${t.method} with no login`).toBe(401);
      expect((await app.inject({ ...t, headers: { ...tunnel } })).statusCode, `${t.method} through the tunnel`).toBe(401);
    }
    // a write with the GM's cookie from another site
    const cross = await app.inject({ method: 'POST', url: nb(gameId), headers: { cookie: session, origin: 'https://evil.example', host: 'localhost:80' }, payload: { title: 'x' } });
    expect(cross.statusCode).toBe(401);
    expect((await app.inject({ url: nb(gameId), headers: { cookie: session } })).json().entries).toHaveLength(1);
  });

  it('reaches only the GM’s live connections; players get nothing and can’t ask for it', async () => {
    const { gameId, cookie } = await table();
    const player = await connect(gameId, { cookie });
    const gm = await connect(gameId, { cookie: session });
    await player.until((m) => m.type === 'hello');
    await gm.until((m) => m.type === 'hello');
    const made = (await app.inject({ method: 'POST', url: nb(gameId), headers: bearer, payload: { title: 'Session log', text: 'drowned-key' } })).json().entry as NotebookEntry;
    expect(await gm.until((m) => m.type === 'notebook' && m.entry?.id === made.id)).toEqual({ type: 'notebook', entry: made });
    await app.inject({ method: 'PATCH', url: nb(gameId, `/${made.id}`), headers: bearer, payload: { text: 'drowned-key, twice' } });
    await gm.until((m) => m.type === 'notebook' && m.entry?.text === 'drowned-key, twice');
    await app.inject({ method: 'DELETE', url: nb(gameId, `/${made.id}`), headers: bearer });
    expect(await gm.until((m) => m.type === 'notebook' && m.removed)).toEqual({ type: 'notebook', removed: made.id });

    // there is no intent for the notebook: a player's (or anyone's) attempt is refused
    for (const type of ['notebook.create', 'notebook.update', 'notebook.list']) {
      expect(await player.intent({ type, title: 'x', id: made.id })).toMatchObject({ type: 'error', error: expect.stringContaining('Unknown intent') });
    }
    await sleep(100);
    expect(player.all.some((m) => m.type === 'notebook' || m.type === 'map.notes')).toBe(false);
    for (const m of player.all) expect(leaks(JSON.stringify(m))).toEqual([]);
    // the hello carries no notebook, for the GM either
    expect(JSON.stringify(gm.all.find((m) => m.type === 'hello'))).not.toContain('notebook');
    player.ws.terminate();
    gm.ws.terminate();
  });
});

describe('notes on characters (token gmNotes)', () => {
  it('are kept from players, and players can’t write them', async () => {
    const { gameId, page, cookie } = await table();
    const gm = await connect(gameId, { cookie: session });
    const player = await connect(gameId, { cookie });
    await player.until((m) => m.type === 'hello');
    expect(await gm.intent({ type: 'page.view', id: page.id })).toMatchObject({ type: 'ack' }); // the GM looks at the players' page
    const tok = { pageId: page.id, layer: 'tokens', x: 9, y: 27, w: 1, h: 1, image: '/assets/props/x.svg', controlledBy: ['p1'], name: 'Ann' };
    expect(await gm.intent({ type: 'token.create', token: { ...tok, id: 'ann' } })).toMatchObject({ type: 'ack' });
    expect(await gm.intent({ type: 'token.update', id: 'ann', set: { gmNotes: 'ogre-under-the-floor is her brother' } })).toMatchObject({ type: 'ack' });
    await player.until((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'token.upsert' && e.token.id === 'ann'));
    expect(await player.intent({ type: 'token.update', id: 'ann', set: { gmNotes: 'mine now' } })).toMatchObject({ type: 'error', error: "Only the GM can change a token's gmNotes" });
    await sleep(50);
    for (const m of player.all) expect(leaks(JSON.stringify(m))).toEqual([]);

    // a change of nothing but the notes sends players nothing at all, also on a line-of-sight page
    // (where a token they may not get would otherwise be taken away from them)
    for (const vision of [undefined, { mode: 'dynamic', ambient: 'bright' }]) {
      if (vision) {
        expect(await gm.intent({ type: 'page.update', id: page.id, set: { vision } })).toMatchObject({ type: 'ack' });
        await player.until((m) => m.type === 'vision');
        await sleep(300);
      }
      const before = player.all.length;
      expect(await gm.intent({ type: 'token.update', id: 'ann', set: { gmNotes: `drowned-key ${vision ? 'dynamic' : 'off'}` } })).toMatchObject({ type: 'ack' });
      await gm.until((m) => m.type === 'events' && m.events.some((e: Msg) => e.type === 'token.upsert' && e.token.gmNotes === `drowned-key ${vision ? 'dynamic' : 'off'}`));
      await sleep(250);
      expect(player.all.slice(before)).toEqual([]);
    }
    expect(JSON.stringify(gm.all)).not.toContain('gmOnly');
    gm.ws.terminate();
    player.ws.terminate();
  });
});
