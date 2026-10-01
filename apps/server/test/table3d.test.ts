// The 3D table view's server side: the page /play/:id/3d and scene3d.json, which
// sends each viewer only the geometry they may see (players: cut to the fog of
// war; the GM: everything, secret doors as doors), by the same rules as background.png.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { computeWalls, insidePolygons, visiblePolygons, type DelveMap } from '@delve/core';
import type { GameState, Member, Page, Scene3D } from '@delve/table';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { Sessions } from '../src/auth.ts';
import { revealedRegion } from '../src/table/scene3d.ts';

const TOKEN = 'table3d-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const session = `delve_session=${new Sessions(TOKEN).issue()}`;
// what cloudflared adds to every request it passes on
const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };

type Msg = Record<string, any>;

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), 'delve-table3d-'));
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir, publicUrl: 'https://delve.example' });
  await app.ready();
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

/** Join through a fresh invite and return the player's cookie. */
async function join(gameId: string, name: string): Promise<string> {
  const inv = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: {} });
  const token = String(inv.json().url).split('/play/join/')[1]!;
  const res = await app.inject({ method: 'POST', url: `/play/join/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ name }).toString() });
  expect(res.statusCode).toBe(303);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** The GM's live connection, enough to send intents and wait for their acks. */
async function gmSocket(gameId: string) {
  const queue: Msg[] = [];
  const ws: WebSocket = await app.injectWS(`/api/v1/games/${gameId}/live`, { headers: { cookie: session } }, {
    onInit: (s: WebSocket) => s.on('message', (raw) => queue.push(JSON.parse(String(raw)) as Msg)),
  });
  let ref = 0;
  return {
    async intent(intent: object): Promise<Msg> {
      const r = ++ref;
      ws.send(JSON.stringify({ type: 'intent', ref: r, intent }));
      for (;;) {
        const i = queue.findIndex((m) => (m.type === 'ack' || m.type === 'error') && m.ref === r);
        if (i >= 0) return queue.splice(i, 1)[0]!;
        await new Promise((ok) => setTimeout(ok, 5));
      }
    },
  };
}

/** The test dungeon with fog on and only the entrance hall (r1) revealed, as a page of a new game. */
async function fogged(): Promise<{ gameId: string; page: Page; map: DelveMap }> {
  const { id: mapId } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon', name: 'Crypt' } })).json() as { id: string };
  const ops = await app.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: bearer, payload: { ops: [{ op: 'update_map', set: { fog: { on: true, revealed: ['r1'] } } }] } });
  expect(ops.statusCode).toBe(200);
  const map = (await app.inject({ url: `/api/v1/maps/${mapId}`, headers: bearer })).json().map as DelveMap;
  const gameId = await createGame();
  const { page } = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/pages/from-map`, headers: bearer, payload: { mapId } })).json() as { page: Page };
  return { gameId, page, map };
}

const sceneUrl = (gameId: string, pageId: string, q = '') => `/api/v1/games/${gameId}/pages/${pageId}/scene3d.json${q}`;
const segKey = (seg: readonly [readonly [number, number], readonly [number, number]]) => JSON.stringify([...seg].sort((p, q) => p[0] - q[0] || p[1] - q[1]));

describe('the 3D page', () => {
  it('is open to members only, with the same refusal as the 2D table', async () => {
    const id = await createGame();
    const gm = await app.inject({ url: `/play/${id}/3d`, headers: { cookie: session } });
    expect(gm.statusCode).toBe(200);
    expect(gm.headers['content-type']).toMatch(/^text\/html/);
    expect(gm.body).toContain('/assets/table3d.js');
    expect(gm.body).toContain(`href="/play/${id}"`); // back to 2D

    const anon = await app.inject({ url: `/play/${id}/3d` });
    expect(anon.statusCode).toBe(403);
    expect(anon.body).toContain('Not at this table');
    expect(anon.body).not.toContain('table3d.js');
    // public mode lets /play through; the game's own check still says no
    expect((await app.inject({ url: `/play/${id}/3d`, headers: { ...tunnel, accept: 'text/html' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/play/game_000000000000/3d', headers: { cookie: session } })).statusCode).toBe(404);

    const cookie = await join(id, 'Alice');
    const player = await app.inject({ url: `/play/${id}/3d`, headers: { cookie } });
    expect(player.statusCode).toBe(200);
    expect(player.body).toContain('"role":"player"');
    // and the 2D table links here
    expect((await app.inject({ url: `/play/${id}`, headers: { cookie } })).body).toContain(`href="/play/${id}/3d"`);
  });
});

describe('scene3d.json', () => {
  it('gives the GM every wall, door and stairs, the secret door as a door', async () => {
    const { gameId, page, map } = await fogged();
    const res = await app.inject({ url: sceneUrl(gameId, page.id, '?view=gm'), headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('private');
    const s = res.json() as Scene3D;
    expect(s).toMatchObject({ pageId: page.id, view: 'gm', kind: 'delve', region: 'all' });
    expect(s.bounds).toEqual({ x0: page.origin[0], y0: page.origin[1], x1: page.origin[0] + page.width, y1: page.origin[1] + page.height });
    expect(s.floor).toEqual({ url: `/api/v1/games/${gameId}/pages/${page.id}/background.png?view=gm`, box: s.bounds });
    expect(s.focus).toEqual(s.bounds);
    // the same walls the map has, door gaps (the secret one too) left open
    expect(new Set(s.walls.map(segKey))).toEqual(new Set(computeWalls(map).map(segKey)));
    expect(s.doors).toHaveLength(6);
    expect(s.doors.filter((d) => d.style === 'secret')).toEqual([{ a: [16, 5], b: [16, 6], style: 'secret' }]);
  });

  it('gives players nothing from rooms they have not seen', async () => {
    const { gameId, page, map } = await fogged();
    const gm = await gmSocket(gameId);
    expect(await gm.intent({ type: 'page.activate', id: page.id })).toMatchObject({ type: 'ack' });
    const cookie = await join(gameId, 'Alice');
    const res = await app.inject({ url: sceneUrl(gameId, page.id), headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Scene3D;
    expect(s.view).toBe('players');
    expect(s.floor?.url).toBe(`/api/v1/games/${gameId}/pages/${page.id}/background.png?view=players`);
    // only the entrance hall (r1: 7,25 6×6) plus the fog's margin
    const seen = visiblePolygons(map);
    expect(s.walls.length).toBeGreaterThan(4);
    for (const [a, b] of s.walls) {
      expect(insidePolygons(seen, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])).toBe(true);
      for (const p of [a, b]) {
        expect(p[0]).toBeGreaterThanOrEqual(6.6);
        expect(p[0]).toBeLessThanOrEqual(13.4);
        expect(p[1]).toBeGreaterThanOrEqual(24.6);
        expect(p[1]).toBeLessThanOrEqual(31.4);
      }
    }
    // its two doors, and nothing of the boss chamber, its secret door or the other rooms
    expect(s.doors.map((d) => d.a).sort()).toEqual([[9, 25], [9, 31]]);
    expect(s.stairs).toEqual([]);
    expect(Array.isArray(s.region)).toBe(true);
    expect(s.focus!.y0).toBeGreaterThan(24);
    expect(res.body).not.toContain('secret');
    const unseen = [...s.walls.flat(), ...s.doors.flatMap((d) => [d.a, d.b])].filter((p) => p[1] < 24);
    expect(unseen).toEqual([]);

    // the GM looking as the players do gets exactly that; a player asking for the GM's view doesn't
    const asPlayers = await app.inject({ url: sceneUrl(gameId, page.id, '?view=players'), headers: { cookie: session } });
    expect(asPlayers.json()).toEqual(s);
    const sneaky = await app.inject({ url: sceneUrl(gameId, page.id, '?view=gm'), headers: { cookie } });
    expect(sneaky.json()).toEqual(s);
    // from the internet (public mode) the same player gets the same scene
    const tunnelPlayer = await app.inject({ url: sceneUrl(gameId, page.id), headers: { ...tunnel, cookie } });
    expect(tunnelPlayer.json()).toEqual(s);
  });

  it('follows the map: more revealed, more walls', async () => {
    const { gameId, page, map } = await fogged();
    const gm = await gmSocket(gameId);
    await gm.intent({ type: 'page.activate', id: page.id });
    const cookie = await join(gameId, 'Alice');
    const fog = (f: object) => app.inject({ method: 'POST', url: `/api/v1/maps/${map.id}/ops`, headers: bearer, payload: { ops: [{ op: 'update_map', set: { fog: f } }] } });
    const before = (await app.inject({ url: sceneUrl(gameId, page.id), headers: { cookie } })).json() as Scene3D;
    expect((await fog({ on: true, revealed: ['r1', 'r2', 'c1'] })).statusCode).toBe(200);
    const after = (await app.inject({ url: sceneUrl(gameId, page.id), headers: { cookie } })).json() as Scene3D;
    expect(after.walls.length).toBeGreaterThan(before.walls.length);
    expect(after.walls.some(([a]) => a[1] < 22)).toBe(true);
    // fog off: the players see the whole map, the secret door still shut (a wall, no door)
    expect((await fog({ on: false })).statusCode).toBe(200);
    const open = (await app.inject({ url: sceneUrl(gameId, page.id), headers: { cookie } })).json() as Scene3D;
    expect(open.region).toBe('all');
    expect(open.doors).toHaveLength(5);
    expect(open.walls.length).toBe(computeWalls(map).length + 1);
  });

  it('refuses non-members, and players a page they are not on', async () => {
    const { gameId, page } = await fogged();
    const url = sceneUrl(gameId, page.id);
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: tunnel })).statusCode).toBe(403); // the gate lets it through, the game says no
    const cookie = await join(gameId, 'Alice');
    // the players are still on the first (blank) page
    const res = await app.inject({ url, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('walls');
    expect((await app.inject({ url: sceneUrl(gameId, 'nope'), headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: sceneUrl(gameId, 'nope'), headers: { cookie: session } })).statusCode).toBe(404);
    expect((await app.inject({ url: sceneUrl('game_000000000000', page.id), headers: { cookie: session } })).statusCode).toBe(404);
    // their own page is fine
    expect((await app.inject({ url: sceneUrl(gameId, 'pg1'), headers: { cookie } })).statusCode).toBe(200);
  });

  it('draws picture pages as a plane with the picture and blank pages as a grid', async () => {
    const gameId = await createGame();
    const gm = await gmSocket(gameId);
    const url = `/api/v1/games/${gameId}/assets/${'a'.repeat(64)}.png`;
    expect(await gm.intent({ type: 'page.create', page: { id: 'pic', name: 'Tavern', width: 12, height: 9, origin: [0, 0], cellPx: 70, cellUnit: '5 ft', showGrid: true, background: { kind: 'image', url, w: 12, h: 8 } } })).toMatchObject({ type: 'ack' });
    const pic = (await app.inject({ url: sceneUrl(gameId, 'pic', '?view=gm'), headers: { cookie: session } })).json() as Scene3D;
    expect(pic).toMatchObject({ kind: 'image', floor: { url, box: { x0: 0, y0: 0, x1: 12, y1: 8 } }, walls: [], doors: [], stairs: [], region: 'all' });
    const blank = (await app.inject({ url: sceneUrl(gameId, 'pg1', '?view=gm'), headers: { cookie: session } })).json() as Scene3D;
    expect(blank).toMatchObject({ kind: 'none', floor: null, walls: [], bounds: { x0: 0, y0: 0, x1: 30, y1: 20 } });
  });
});

describe('revealedRegion', () => {
  const gmMember: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#d4a017' };
  const player: Member = { id: 'p1', name: 'Alice', role: 'player', color: '#e05252' };
  const page: Page = { id: 'pg', name: 'Crypt', width: 26, height: 38, origin: [-3, -3], cellPx: 70, cellUnit: '5 ft', showGrid: true, background: { kind: 'delve', mapId: 'm' } };
  const state = {} as GameState;
  const map = { format: 'delve.map', version: 1, id: 'm', name: 'M', grid: { type: 'square' }, objects: [{ type: 'room', id: 'r1', shape: { rect: [0, 0, 4, 4] } }, { type: 'room', id: 'r2', shape: { rect: [10, 0, 4, 4] } }] } as DelveMap;

  it('is everything for the GM, the fog for players, and everything without fog', () => {
    const withFog = { ...map, fog: { on: true, revealed: ['r1'] } };
    expect(revealedRegion(state, page, withFog, { member: gmMember, view: 'gm' })).toBe('all');
    const seen = revealedRegion(state, page, withFog, { member: player, view: 'players' });
    expect(seen).toEqual(visiblePolygons(withFog));
    expect(revealedRegion(state, page, withFog, { member: gmMember, view: 'players' })).toEqual(seen);
    // a player asking for the GM's view is still a player
    expect(revealedRegion(state, page, withFog, { member: player, view: 'gm' })).toEqual(seen);
    expect(revealedRegion(state, page, map, { member: player, view: 'players' })).toBe('all');
    expect(revealedRegion(state, page, { ...map, fog: { on: true } }, { member: player, view: 'players' })).toEqual([]);
    expect(revealedRegion(state, { ...page, background: { kind: 'none' } }, null, { member: player, view: 'players' })).toBe('all');
  });
});
