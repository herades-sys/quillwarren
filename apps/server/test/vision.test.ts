// Dynamic vision over the live channel: what players are sent (and never sent)
// about a page with line of sight, the vision messages, the explored fog and
// its GM tools, door state, and the page picture cut to what was explored.
// The test dungeon: the party's torch-bearer stands in room 1 (the entrance
// hall, y 25..31); door d1 at its top leads up corridor c1 to room 2 (y 15..21);
// room 4 (the storeroom, x 16..20, y 14..20) has a torch sconce; room 3 is dark.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { Sessions } from '../src/auth.ts';
import { readFileSync } from 'node:fs';
import { computeFloor, doorOnWall, placeDoorBetween, shapeFromBox, type DelveMap } from '@delve/core';
import { blockersOf, partySight, pointIn, visibilityPolygon, type Page, type Token } from '@delve/table';
import { decodePng } from '../src/png.ts';
import { exploredRegion, pageSightData, TableVision, withTableDoors } from '../src/table/vision.ts';
import { TableStore } from '../src/table/store.ts';

const TOKEN = 'vision-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const session = `delve_session=${new Sessions(TOKEN).issue()}`;

type Msg = Record<string, any>;

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), 'delve-vision-'));
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function connect(gameId: string, headers: Record<string, string>) {
  const all: Msg[] = [];
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  const ws: WebSocket = await app.injectWS(`/api/v1/games/${gameId}/live`, { headers }, {
    onInit: (s: WebSocket) => {
      s.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as Msg;
        all.push(m);
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      });
    },
  });
  const next = (): Promise<Msg> => new Promise((ok) => (queue.length ? ok(queue.shift()!) : waiters.push(ok)));
  let ref = 0;
  return {
    ws,
    all,
    async nextOf(type: string): Promise<Msg> {
      for (;;) {
        const m = await next();
        if (m.type === type) return m;
      }
    },
    async intent(intent: object): Promise<Msg> {
      const r = ++ref;
      ws.send(JSON.stringify({ type: 'intent', ref: r, intent }));
      for (;;) {
        const i = queue.findIndex((m) => (m.type === 'ack' || m.type === 'error') && m.ref === r);
        if (i >= 0) return queue.splice(i, 1)[0]!;
        await wait(5);
      }
    },
    /** Drop what has queued up so far (next() then waits for new messages). */
    drain() {
      queue.length = 0;
    },
  };
}
type Client = Awaited<ReturnType<typeof connect>>;

/** Every token id and name in what a client was sent after message `from`. */
const sentAfter = (c: Client, from: number): string => JSON.stringify(c.all.slice(from));
/** Token events in what a client was sent after message `from`. */
const tokenEvents = (c: Client, from: number): Msg[] =>
  c.all.slice(from).flatMap((m) => (m.type === 'events' ? (m.events as Msg[]).filter((e) => e.type === 'token.upsert' || e.type === 'token.remove') : []));

const ok = async (c: Client, intent: object) => {
  const res = await c.intent(intent);
  expect(res, JSON.stringify(res)).toMatchObject({ type: 'ack' });
  return res;
};

const tok = (id: string, x: number, y: number, over: object = {}) => ({ id, layer: 'tokens', x, y, w: 1, h: 1, image: '/assets/props/x.svg', controlledBy: [], name: id, ...over });

/**
 * A game on the test dungeon with dynamic vision (dark), Ann (p1) with a
 * torch in room 1, a rat beside her, a ghoul behind door d1 in room 2, a
 * lurker in the lit storeroom (out of sight) and a sleeper in dark room 3.
 */
async function setup() {
  const { id: mapId } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon', name: 'Crypt' } })).json() as { id: string };
  const lit = await app.inject({
    method: 'POST',
    url: `/api/v1/maps/${mapId}/ops`,
    headers: bearer,
    payload: { ops: [{ op: 'add', object: { id: 'torch1', type: 'prop', asset: 'sconce', at: [18, 15] } }] },
  });
  expect(lit.statusCode).toBe(200);
  const { id: gameId } = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: 'Crypt night' } })).json() as { id: string };
  const made = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/pages/from-map`, headers: bearer, payload: { mapId } });
  const page = made.json().page as Msg;
  expect(page.lights).toEqual([{ id: 'torch1', x: 18, y: 15, bright: 4, dim: 4, asset: 'sconce' }]);
  expect(page.doors.map((d: Msg) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  const inviteUrl = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: {} })).json().url as string;
  const join = await app.inject({
    method: 'POST',
    url: `/play/join/${inviteUrl.split('/play/join/')[1]}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'name=Ann',
  });
  const cookie = String(join.headers['set-cookie']).split(';')[0]!;
  const gm = await connect(gameId, { cookie: session });
  await gm.nextOf('hello');
  const pageId = page.id as string;
  await ok(gm, { type: 'page.activate', id: pageId });
  await ok(gm, { type: 'page.view', id: pageId });
  await ok(gm, { type: 'page.update', id: pageId, set: { vision: { mode: 'dynamic', ambient: 'dark' } } });
  const tokens = [
    tok('ann', 9, 27, { controlledBy: ['p1'], name: 'Ann', light: { bright: 4, dim: 4 } }),
    tok('rat', 11, 28, { name: 'Rat' }),
    tok('ghoul', 12, 17, { name: 'Ghoul', gmNotes: 'hungry', bars: [{ value: 9, max: 9 }] }),
    tok('lurker', 17, 17, { name: 'Lurker' }),
    tok('sleeper', 1, 16, { name: 'Sleeper' }),
  ];
  for (const t of tokens) await ok(gm, { type: 'token.create', token: { pageId, ...t } });
  await wait(300); // let vision settle
  const player = await connect(gameId, { cookie });
  const hello = await player.nextOf('hello');
  return { mapId, gameId, pageId, gm, player, hello, cookie };
}

/** The next vision message for a client that satisfies `pred`. */
async function visionWhere(c: Client, pred: (v: Msg) => boolean = () => true): Promise<Msg> {
  for (;;) {
    const m = await c.nextOf('vision');
    if (m.vision && pred(m.vision)) return m.vision;
  }
}

describe('dynamic vision: what players are sent', () => {
  it('sends a player only the tokens the party sees, and the GM everything', async () => {
    const { player, hello, gm, pageId } = await setup();
    const ids = (hello.view.tokens as Msg[]).map((t) => t.id).sort();
    expect(ids).toEqual(['ann', 'rat']);
    // nothing of the others, anywhere in what the player got
    const sent = JSON.stringify(player.all);
    for (const s of ['ghoul', 'Ghoul', 'lurker', 'Lurker', 'sleeper', 'Sleeper', 'hungry']) expect(sent).not.toContain(s);
    // no walls, doors or lights in the player's page
    const p = hello.view.pages[0];
    for (const k of ['walls', 'doors', 'lights', 'doorState']) expect(p).not.toHaveProperty(k);
    expect(p.vision).toEqual({ mode: 'dynamic', ambient: 'dark' });
    // their own token keeps its light; the vision message follows the hello
    expect((hello.view.tokens as Msg[]).find((t) => t.id === 'ann')!.light).toEqual({ bright: 4, dim: 4 });
    const v = await visionWhere(player);
    expect(v.pageId).toBe(pageId);
    expect(v.visible.length).toBeGreaterThan(0);
    expect(v.explored.length).toBeGreaterThan(0);
    expect(v.exploredVersion).toBeGreaterThan(0);
    expect(v).not.toHaveProperty('seen');
    // the GM sees every token, and what the party sees
    gm.drain();
    await ok(gm, { type: 'page.view', id: pageId });
    const gmHello = await gm.nextOf('hello');
    expect((gmHello.view.tokens as Msg[]).map((t) => t.id).sort()).toEqual(['ann', 'ghoul', 'lurker', 'rat', 'sleeper']);
    const gv = await visionWhere(gm);
    expect(gv.seen.sort()).toEqual(['ann', 'rat']);
  });

  it('sends nothing at all about tokens moving, changing or appearing where the party can’t see', async () => {
    const { player, gm, pageId } = await setup();
    await visionWhere(player);
    const from = player.all.length;
    // the ghoul paces behind the shut door, gets hurt and renamed
    for (const [x, y] of [[11, 16], [12, 18], [8, 19]]) await ok(gm, { type: 'token.move', id: 'ghoul', x, y });
    await ok(gm, { type: 'token.update', id: 'ghoul', set: { bars: [{ value: 3, max: 9 }], name: 'Wounded ghoul' } });
    await ok(gm, { type: 'token.update', id: 'lurker', set: { x: 18, y: 18 } });
    // a token made in the dark room 3, and one made behind the wall
    await ok(gm, { type: 'token.create', token: { pageId, ...tok('ambusher', 2, 18, { name: 'Ambusher' }) } });
    await ok(gm, { type: 'token.create', token: { pageId, ...tok('archer', 8, 22, { name: 'Archer' }) } });
    // deleting one the player never had
    await ok(gm, { type: 'token.delete', ids: ['sleeper'] });
    // a GM roll, and the hidden ghoul in the turn order
    await ok(gm, { type: 'chat.send', text: '/gr 1d20+5' });
    await ok(gm, { type: 'turn.add', entry: { tokenId: 'ghoul', initiative: 15 } });
    await wait(400);
    expect(tokenEvents(player, from)).toEqual([]);
    const sent = sentAfter(player, from);
    for (const s of ['ghoul', 'Ghoul', 'lurker', 'ambusher', 'Ambusher', 'archer', 'Archer', 'sleeper', '1d20']) expect(sent).not.toContain(s);
    // the turn order shows a hidden entry, without its token
    const turns = player.all.slice(from).flatMap((m) => (m.type === 'events' ? (m.events as Msg[]).filter((e) => e.type === 'turn') : []));
    expect(turns.at(-1)!.turn.entries).toEqual([{ id: 't1', name: 'Hidden', initiative: 15 }]);
    // and a token made in plain view does arrive
    await ok(gm, { type: 'token.create', token: { pageId, ...tok('bat', 12, 26, { name: 'Bat' }) } });
    await wait(50);
    expect(tokenEvents(player, from).map((e) => e.token?.id)).toEqual(['bat']);
  });

  it('brings a token in when it walks into sight, takes it out when it leaves, and says nothing in between', async () => {
    const { player, gm, pageId } = await setup();
    await visionWhere(player);
    await ok(gm, { type: 'turn.add', entry: { tokenId: 'ghoul', initiative: 15 } });
    // open the door: Ann's torch reaches up the corridor, the ghoul in room 2 is still too far
    let from = player.all.length;
    await ok(gm, { type: 'door.set', pageId, id: 'd1', open: true });
    await visionWhere(player, (v) => v.explored !== undefined);
    expect(tokenEvents(player, from)).toEqual([]);
    // the ghoul steps into the corridor, into the torchlight
    from = player.all.length;
    await ok(gm, { type: 'token.move', id: 'ghoul', x: 9, y: 22 });
    await wait(300);
    const came = tokenEvents(player, from);
    expect(came.map((e) => [e.type, e.token?.id])).toEqual([['token.upsert', 'ghoul']]);
    expect(came[0]!.token).not.toHaveProperty('gmNotes');
    const turn = player.all.slice(from).flatMap((m) => (m.type === 'events' ? (m.events as Msg[]).filter((e) => e.type === 'turn') : []));
    expect(turn.at(-1)!.turn.entries[0]).toMatchObject({ tokenId: 'ghoul', name: 'Ghoul' });
    // moves in sight arrive as usual
    from = player.all.length;
    await ok(gm, { type: 'token.move', id: 'ghoul', x: 10, y: 22 });
    await wait(50);
    expect(tokenEvents(player, from).map((e) => [e.type, e.token?.x])).toEqual([['token.upsert', 10]]);
    // back into the dark room: one removal, then silence
    from = player.all.length;
    await ok(gm, { type: 'token.move', id: 'ghoul', x: 12, y: 17 });
    for (const [x, y] of [[12, 16], [7, 16]]) await ok(gm, { type: 'token.move', id: 'ghoul', x, y });
    await wait(300);
    expect(tokenEvents(player, from)).toEqual([{ type: 'token.remove', ids: ['ghoul'] }]);
    expect(sentAfter(player, from)).not.toContain('"x":7');
    // shut the door again while the ghoul waits in the corridor: it goes out of sight
    await ok(gm, { type: 'token.move', id: 'ghoul', x: 9, y: 22 });
    await wait(200);
    from = player.all.length;
    await ok(gm, { type: 'door.set', pageId, id: 'd1', open: false });
    await wait(300);
    expect(tokenEvents(player, from)).toEqual([{ type: 'token.remove', ids: ['ghoul'] }]);
  });

  it('follows the party’s eyes as they move, at most about every 120 ms, ending on the final spot', async () => {
    const { player, gm, pageId } = await setup();
    await visionWhere(player);
    await ok(gm, { type: 'door.set', pageId, id: 'd1', open: true });
    await wait(300);
    const from = player.all.length;
    // Ann walks up the corridor into room 2 in quick steps; the ghoul waits there
    const t0 = Date.now();
    for (let y = 26; y >= 18; y--) await ok(player, { type: 'token.move', id: 'ann', x: 9, y });
    const took = Date.now() - t0;
    await wait(400);
    const visions = player.all.slice(from).filter((m) => m.type === 'vision');
    expect(visions.length).toBeGreaterThan(0);
    expect(visions.length).toBeLessThanOrEqual(Math.ceil(took / 100) + 2);
    expect(tokenEvents(player, from).filter((e) => e.type === 'token.upsert' && e.token.id === 'ghoul')).toHaveLength(1);
    // the last vision is what she sees from (9.5, 18.5)
    const last = visions.at(-1)!.vision;
    expect(pointIn(last.visible, [7, 16])).toBe(true);
    expect(pointIn(last.visible, [12, 30])).toBe(false);
  });

  it('keeps players from changing light, sight or doors', async () => {
    const { player, pageId } = await setup();
    for (const set of [{ light: { bright: 20, dim: 20 } }, { sight: { darkvision: 60 } }, { sight: { enabled: true } }]) {
      expect(await player.intent({ type: 'token.update', id: 'ann', set })).toMatchObject({ type: 'error' });
    }
    expect(await player.intent({ type: 'door.set', pageId, id: 'd1', open: true })).toMatchObject({ type: 'error', error: 'Only the GM can open and shut doors' });
    expect(await player.intent({ type: 'vision.explored', pageId, action: 'reveal' })).toMatchObject({ type: 'error' });
    expect(await player.intent({ type: 'page.update', id: pageId, set: { vision: { mode: 'off' } } })).toMatchObject({ type: 'error' });
  });
});

describe('dynamic vision: explored fog and the picture', () => {
  it('cuts the player’s picture to what was explored, black elsewhere; the GM gets the whole map', async () => {
    const { gameId, pageId, cookie, player } = await setup();
    await visionWhere(player);
    const url = `/api/v1/games/${gameId}/pages/${pageId}/background.png`;
    const res = await app.inject({ url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const png = decodePng(res.rawPayload);
    expect([png.width, png.height]).toEqual([26 * 70, 38 * 70]);
    // page origin (-3, -3): the pixel of a map cell's middle
    const at = (img: typeof png, x: number, y: number) => {
      const i = (Math.round((y + 3) * 70) * img.width + Math.round((x + 3) * 70)) * 4;
      return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!];
    };
    expect(at(png, 10, 28)).not.toEqual([0, 0, 0, 255]); // room 1, lit by Ann's torch
    for (const [x, y] of [[10, 6], [18, 17], [10, 18], [2, 17], [18.5, 5], [-2, -2]] as [number, number][]) expect(at(png, x, y), `${x},${y}`).toEqual([0, 0, 0, 255]);
    // the whole picture has nothing but black more than a cell beyond room 1
    let leaks = 0;
    for (let py = 0; py < png.height; py += 7) {
      for (let px = 0; px < png.width; px += 7) {
        const x = px / 70 - 3;
        const y = py / 70 - 3;
        if (x > 5.5 && x < 14.5 && y > 23.5 && y < 32.5) continue;
        const i = (py * png.width + px) * 4;
        if (png.rgba[i] !== 0 || png.rgba[i + 1] !== 0 || png.rgba[i + 2] !== 0) leaks++;
      }
    }
    expect(leaks).toBe(0);
    // the GM's picture is the whole map
    const gm = decodePng((await app.inject({ url: `${url}?view=gm`, headers: bearer })).rawPayload);
    expect(at(gm, 10, 6)).not.toEqual([0, 0, 0, 255]);
    // and the GM asking for the players' view gets theirs
    const asPlayers = decodePng((await app.inject({ url, headers: bearer })).rawPayload);
    expect(at(asPlayers, 10, 6)).toEqual([0, 0, 0, 255]);
  });

  it('gives the GM reset, reveal-all and hide-everything, and keeps the fog across a restart', async () => {
    const { gameId, pageId, gm, player, cookie } = await setup();
    const first = await visionWhere(player);
    expect(Array.isArray(first.explored)).toBe(true);
    // a crate on the map layer in the unexplored storeroom only shows once that is explored
    await ok(gm, { type: 'token.create', token: { pageId, ...tok('crate', 17, 15, { layer: 'map', name: 'Crate' }) } });
    await ok(gm, { type: 'vision.explored', pageId, action: 'reveal' });
    const all = await visionWhere(player, (v) => v.explored === 'all');
    expect(all.exploredVersion).toBeGreaterThan(first.exploredVersion);
    await wait(100);
    expect(tokenEvents(player, 0).some((e) => e.type === 'token.upsert' && e.token.id === 'crate')).toBe(true);
    // the revealed picture shows the boss chamber
    const url = `/api/v1/games/${gameId}/pages/${pageId}/background.png`;
    const shown = decodePng((await app.inject({ url, headers: { cookie } })).rawPayload);
    const i = (Math.round(9 * 70) * shown.width + Math.round(13 * 70)) * 4;
    expect([shown.rgba[i], shown.rgba[i + 1], shown.rgba[i + 2]]).not.toEqual([0, 0, 0]);
    // hide everything: nothing explored, nothing visible, the crate goes
    let from = player.all.length;
    await ok(gm, { type: 'vision.explored', pageId, action: 'hide' });
    const hidden = await visionWhere(player, (v) => Array.isArray(v.explored) && v.explored.length === 0);
    expect(hidden.visible).toEqual([]);
    await wait(50);
    expect(tokenEvents(player, from)).toContainEqual({ type: 'token.remove', ids: ['crate'] });
    // reset: what the party sees now comes back
    from = player.all.length;
    await ok(gm, { type: 'vision.explored', pageId, action: 'reset' });
    const reset = await visionWhere(player, (v) => Array.isArray(v.explored) && v.explored.length > 0);
    expect(reset.visible.length).toBeGreaterThan(0);
    // the fog is in table.db: a restart keeps it
    await wait(400);
    await app.close();
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir });
    await app.ready();
    const again = await connect(gameId, { cookie });
    await again.nextOf('hello');
    const v = await visionWhere(again);
    expect(v.exploredVersion).toBe(reset.exploredVersion);
    expect(v.explored).toEqual(reset.explored);
  });

  it('switching vision off gives players every token again, as before', async () => {
    const { player, gm, pageId } = await setup();
    await visionWhere(player);
    await ok(gm, { type: 'page.update', id: pageId, set: { vision: { mode: 'off' } } });
    const hello = await player.nextOf('hello');
    expect((hello.view.tokens as Msg[]).map((t) => t.id).sort()).toEqual(['ann', 'ghoul', 'lurker', 'rat', 'sleeper']);
    // and back on: only what the party sees
    await ok(gm, { type: 'page.update', id: pageId, set: { vision: { mode: 'dynamic', ambient: 'bright' } } });
    const back = await player.nextOf('hello');
    expect((back.view.tokens as Msg[]).map((t) => t.id).sort()).toEqual(['ann', 'rat']);
    const v = await visionWhere(player);
    expect(v.ambient).toBe('bright');
  });
});

describe('page data from the Quillwarren map', () => {
  const fixture = (): DelveMap => JSON.parse(readFileSync(new URL('../../../fixtures/test-map-4p.delve.json', import.meta.url), 'utf8')) as DelveMap;
  const pageOf = (map: DelveMap, over: Partial<Page> = {}): Page => ({
    id: 'pg',
    name: 'x',
    width: 26,
    height: 38,
    origin: [-3, -3],
    cellPx: 70,
    cellUnit: '5 ft',
    showGrid: true,
    background: { kind: 'delve', mapId: map.id },
    ...pageSightData(map),
    vision: { mode: 'dynamic', ambient: 'bright' },
    ...over,
  });
  const ann: Token = { id: 'ann', pageId: 'pg', layer: 'tokens', x: 9, y: 28, w: 1, h: 1, image: '/x', controlledBy: ['p1'] };

  it('keeps door gaps in rough walls, so an open door is a way to look through', () => {
    const map = { ...fixture(), roughness: 8 };
    const data = pageSightData(map);
    expect(data.walls.length).toBeGreaterThan(pageSightData(fixture()).walls.length * 3);
    // door d1 (top of room 1): shut, room 2 is out of sight; open, the corridor and room 2 come into view
    const shut = partySight(pageOf(map), [ann]);
    expect(pointIn(shut.raw, [10, 23])).toBe(false);
    const open = partySight(pageOf(map, { doorState: { d1: true } }), [ann]);
    expect(pointIn(open.raw, [10, 23])).toBe(true);
    expect(pointIn(open.raw, [10, 19])).toBe(true);
    // the secret door d6 stays a wall until the GM opens it
    const ring = visibilityPolygon([15, 5.5], blockersOf(pageOf(map)), { x0: -3, y0: -3, x1: 23, y1: 35 });
    expect(pointIn([{ outer: ring, holes: [] }], [18.5, 5.5])).toBe(false);
    const opened = visibilityPolygon([15, 5.5], blockersOf(pageOf(map, { doorState: { d6: true } })), { x0: -3, y0: -3, x1: 23, y1: 35 });
    expect(pointIn([{ outer: opened, holes: [] }], [18.5, 5.5])).toBe(true);
  });

  it('lets a turned shut door block exactly its line in a slanted or curved wall, and see through it open', () => {
    const rooms: DelveMap['objects'] = [
      { id: 'r1', type: 'room', shape: shapeFromBox('octagon', [0, 0, 10, 10]) },
      { id: 'r2', type: 'room', shape: { circle: [20, 5, 4] } },
    ];
    const base = { ...fixture(), objects: rooms };
    const door = (id: string, p: [number, number], width: number): DelveMap['objects'][number] => {
      const ends = doorOnWall(computeFloor(base), p, width)!;
      return { id, type: 'door', ...placeDoorBetween(computeFloor(base), ends[0], ends[1]), style: 'normal' };
    };
    // d1 in the octagon's slanted north-east wall, d2 in the circle's west curve
    const map = { ...base, objects: [...rooms, door('d1', [8.5, 1.5], 2), door('d2', [16.2, 6.2], 2)] };
    const data = pageSightData(map);
    for (const id of ['d1', 'd2']) expect(data.doors.find((d) => d.id === id)).toBeDefined();
    const box = { x0: -3, y0: -3, x1: 30, y1: 15 };
    const sees = (from: [number, number], p: [number, number], doorState?: Record<string, boolean>) =>
      pointIn([{ outer: visibilityPolygon(from, blockersOf(pageOf(map, doorState ? { doorState } : {})), box), holes: [] }], p);
    const { a, b } = data.doors.find((d) => d.id === 'd1')!;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // out through the door's middle, a square into the rock (north-east)
    const beyond: [number, number] = [mid[0] + 0.71, mid[1] - 0.71];
    expect(sees([5, 5], beyond)).toBe(false);
    expect(sees([5, 5], beyond, { d1: true })).toBe(true);
    // the wall beside the door still blocks, open or shut: no crack at either end of it
    for (const t of [-0.3, 1.3]) {
      const side: [number, number] = [a[0] + (b[0] - a[0]) * t + 0.71, a[1] + (b[1] - a[1]) * t - 0.71];
      expect(sees([5, 5], side, { d1: true })).toBe(false);
    }
    for (const end of [a, b]) {
      for (const k of [0.02, 0.1]) expect(sees([5, 5], [end[0] + 0.71 * k * 10, end[1] - 0.71 * k * 10])).toBe(false);
    }
    // the circle's door: shut, the octagon can't be seen from inside the circle, nor the rock west of the door
    expect(sees([20, 5], [15, 6.5])).toBe(false);
    expect(sees([20, 5], [15, 6.5], { d2: true })).toBe(true);
  });

  it('turns light props into lights on the floor, even a sconce hung on the wall line', () => {
    const map = fixture();
    map.objects.push({ id: 'wall-torch', type: 'prop', asset: 'sconce', at: [8, 25] } as DelveMap['objects'][number]); // right on room 1's top wall
    map.objects.push({ id: 'chair1', type: 'prop', asset: 'chair', at: [8, 27] } as DelveMap['objects'][number]);
    const { lights } = pageSightData(map);
    expect(lights).toHaveLength(1);
    expect(lights[0]).toMatchObject({ id: 'wall-torch', bright: 4, dim: 4, asset: 'sconce' });
    expect(lights[0]!.y).toBeGreaterThanOrEqual(25);
    // it lights room 1, in the dark
    const sight = partySight(pageOf(map, { vision: { mode: 'dynamic', ambient: 'dark' } }), [ann]);
    expect(pointIn(sight.raw, [8, 26])).toBe(true);
    const unlit = { ...map, objects: map.objects.filter((o) => o.id !== 'wall-torch') };
    expect(partySight(pageOf(unlit, { vision: { mode: 'dynamic', ambient: 'dark' } }), [ann]).raw).toEqual([]);
  });

  it('draws the table’s doors: opened, shut, and a found secret door as an open door for players', () => {
    const map = fixture();
    const page = { doorState: { d1: true, d6: true, d2: false } };
    const doors = (m: DelveMap) => Object.fromEntries(m.objects.filter((o) => o.type === 'door').map((o) => [o.id, o]));
    const players = doors(withTableDoors(map, page, 'players'));
    expect(players.d1).toMatchObject({ open: true });
    expect(players.d2).toMatchObject({ open: false });
    expect(players.d6).toMatchObject({ style: 'normal', open: true });
    expect(doors(withTableDoors(map, page, 'gm')).d6).toMatchObject({ style: 'secret', open: true });
    expect(withTableDoors(map, {}, 'players')).toBe(map);
  });

  it('gives the 3D view the explored region: all for the GM, the fog for players, null without dynamic vision', () => {
    const store = new TableStore(':memory:');
    const vision = new TableVision(store, () => {});
    const map = fixture();
    const page = pageOf(map);
    const state = {
      id: 'g1',
      name: 'x',
      rev: 1,
      members: [
        { id: 'gm', name: 'GM', role: 'gm' as const, color: '#000' },
        { id: 'p1', name: 'Ann', role: 'player' as const, color: '#111' },
      ],
      invites: [],
      pages: [page],
      playerPageId: 'pg',
      gmPageId: 'pg',
      tokens: [ann],
      turn: { entries: [], current: 0, round: 1, visible: true },
    };
    store.create(state);
    expect(exploredRegion(vision, state, page, { member: 'gm' })).toBe('all');
    const fog = exploredRegion(vision, state, page, { member: 'p1' });
    expect(Array.isArray(fog) && fog.length > 0 && pointIn(fog, [10, 28]) && !pointIn(fog, [10, 6])).toBe(true);
    expect(exploredRegion(vision, state, page, { member: { id: 'gm', role: 'gm' }, view: 'players' })).toEqual(fog);
    expect(exploredRegion(vision, state, { ...page, vision: { mode: 'off' } }, { member: 'p1' })).toBeNull();
    vision.close();
    store.close();
  });
});

describe('dynamic vision in the 3D view and the players’ page data', () => {
  it('cuts the players’ 3D scene to the explored fog, and never names the Quillwarren map', async () => {
    const { gameId, pageId, cookie, hello } = await setup();
    // the players' page has no map id, so the map's own API can't be asked for the whole map
    expect(hello.view.pages[0].background).toEqual({ kind: 'delve', mapId: '' });
    expect(JSON.stringify(hello)).not.toMatch(/map_[0-9a-f]{12}/);

    const url = `/api/v1/games/${gameId}/pages/${pageId}/scene3d.json`;
    const players = (await app.inject({ url, headers: { cookie } })).json() as Msg;
    const all = (await app.inject({ url: `${url}?view=gm`, headers: { cookie: session } })).json() as Msg;
    expect(Array.isArray(players.region)).toBe(true);
    expect(players.walls.length).toBeGreaterThan(3);
    expect(players.walls.length).toBeLessThan(all.walls.length);
    // every wall piece lies in what the party has explored, nothing from room 2 up the corridor's far end
    for (const [a, b] of players.walls as [number, number][][]) {
      expect(pointIn(players.region, [(a![0]! + b![0]!) / 2, (a![1]! + b![1]!) / 2])).toBe(true);
    }
    expect((players.walls as [number, number][][]).flat().filter((p) => p[1]! < 21)).toEqual([]);
    // the GM looking as the players gets the same
    const asPlayers = (await app.inject({ url: `${url}?view=players`, headers: { cookie: session } })).json();
    expect(asPlayers).toEqual(players);
  });
});
