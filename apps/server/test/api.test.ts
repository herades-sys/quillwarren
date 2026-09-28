import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { floorArea, type DelveMap, type Op } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { MapStore } from '../src/store.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8'),
) as DelveMap;

let app: FastifyInstance;
beforeEach(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function createMap(body: object = { name: 'Crypt' }): Promise<{ id: string; rev: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}
const ops = (id: string, payload: object) =>
  app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload });
const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };

/**
 * Open a socket and collect its messages so tests can await them in order.
 * The listener goes on in onInit: the server says hello as soon as the socket
 * opens, before injectWS's promise resolves.
 */
async function connect(url: string) {
  const queue: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  const ws: WebSocket = await app.injectWS(url, {}, {
    onInit: (socket: WebSocket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
      });
    },
  });
  return {
    ws,
    next: <T = Record<string, unknown>>(): Promise<T> =>
      new Promise((ok) => (queue.length ? ok(queue.shift() as T) : waiters.push(ok as (m: unknown) => void))),
  };
}

describe('maps API', () => {
  it('builds the test dungeon through the API and renders it (phase 3 done-when)', async () => {
    const { id, rev } = await createMap({ name: 'Built over HTTP' });
    expect(rev).toBe(1);
    let cur = rev;
    for (const types of [['room'], ['corridor'], ['cutout'], ['door']]) {
      const batch: Op[] = fixture.objects.filter((o) => types.includes(o.type)).map((object) => ({ op: 'add', object }));
      const res = await ops(id, { baseRev: cur, ops: batch, by: 'test' });
      expect(res.statusCode).toBe(200);
      cur = res.json().rev;
    }
    expect(cur).toBe(5);
    const { map } = await getMap(id);
    expect(map.objects).toHaveLength(fixture.objects.length);
    expect(floorArea(map)).toBe(296);

    const png = await app.inject({ url: `/api/v1/maps/${id}/render.png?view=players&ppg=20` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/built-over-http_classic-hatching_players_\d+x\d+\.png/);
    const svg = await app.inject({ url: `/api/v1/maps/${id}/render.svg?style=print` });
    expect(svg.body).toMatch(/^<svg /);
    const text = await app.inject({ url: `/api/v1/maps/${id}/describe` });
    expect(text.body).toContain('6 rooms, 5 corridors, 6 doors, 4 cutouts');
  });

  it('lists, reads and soft-deletes maps', async () => {
    const a = await createMap({ name: 'A' });
    await createMap({ name: 'B', template: 'test-dungeon' });
    const list = (await app.inject({ url: '/api/v1/maps' })).json().maps as { name: string; objects: number }[];
    expect(list.map((m) => m.name).sort()).toEqual(['A', 'B']);
    expect(list.find((m) => m.name === 'B')!.objects).toBe(fixture.objects.length);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/maps/${a.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/v1/maps/${a.id}` })).statusCode).toBe(404);
  });

  it('creates from a full document and refuses a taken id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { map: fixture } });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('map_test4p');
    const again = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { map: fixture } });
    expect(again.statusCode).toBe(409);
  });

  it('needs the token for every change but not for reading', async () => {
    const { id } = await createMap();
    const tries = [
      { method: 'POST' as const, url: '/api/v1/maps', payload: {} },
      { method: 'POST' as const, url: `/api/v1/maps/${id}/ops`, payload: { ops: [] } },
      { method: 'POST' as const, url: `/api/v1/maps/${id}/undo`, payload: {} },
      { method: 'DELETE' as const, url: `/api/v1/maps/${id}` },
    ];
    for (const t of tries) {
      expect((await app.inject(t)).statusCode).toBe(401);
      expect((await app.inject({ ...t, headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: `/api/v1/maps/${id}` })).statusCode).toBe(200);
  });

  it('is read-only when the server has no token', async () => {
    const ro = buildApp({ version: 'test', started: 'now' });
    const res = await ro.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: {} });
    expect(res.statusCode).toBe(503);
    await ro.close();
  });

  it('rejects a stale baseRev with the current rev', async () => {
    const { id } = await createMap();
    await ops(id, { ops: [{ op: 'update_map', set: { name: 'Crypt 2' } }] });
    const res = await ops(id, { baseRev: 1, ops: [{ op: 'update_map', set: { name: 'Crypt 3' } }] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ rev: 2 });
  });

  it('explains bad ops and invalid results', async () => {
    const { id } = await createMap();
    const bad = await ops(id, { ops: [{ op: 'teleport' }] });
    expect(bad.statusCode).toBe(400);
    const invalid = await ops(id, { ops: [{ op: 'add', object: { id: 'c1', type: 'corridor', from: 'r1', to: 'r2', width: 1 } }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('no object with id "r1"');
    expect((await getMap(id)).rev).toBe(1); // nothing changed
  });

  it('undoes and redoes in order, and a new change ends the redo chain', async () => {
    const { id } = await createMap();
    const room = (n: number): Op => ({ op: 'add', object: { id: `r${n}`, type: 'room', shape: { rect: [n * 10, 0, 5, 5] } } });
    await ops(id, { ops: [room(1)] });
    await ops(id, { ops: [room(2)] });
    const ids = async () => (await getMap(id)).map.objects.map((o) => o.id);
    const post = (a: string) => app.inject({ method: 'POST', url: `/api/v1/maps/${id}/${a}`, headers: auth, payload: {} });

    expect((await post('undo')).json().rev).toBe(4);
    expect(await ids()).toEqual(['r1']);
    await post('undo');
    expect(await ids()).toEqual([]);
    expect((await post('undo')).statusCode).toBe(409); // nothing left
    await post('redo');
    expect(await ids()).toEqual(['r1']);
    await ops(id, { ops: [room(3)] });
    expect((await post('redo')).statusCode).toBe(409); // r2 can't come back now
    await post('undo');
    await post('undo');
    expect(await ids()).toEqual([]);

    const history = (await app.inject({ url: `/api/v1/maps/${id}/history` })).json().history as { kind: string }[];
    expect(history.map((h) => h.kind)).toEqual(['undo', 'undo', 'ops', 'redo', 'undo', 'undo', 'ops', 'ops', 'create']);
  });

  it('keeps maps across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-store-'));
    try {
      const file = join(dir, 'delve.db');
      const s1 = new MapStore(file);
      const a1 = buildApp({ version: 't', started: 'now' }, { store: s1, token: TOKEN });
      const res = await a1.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon' } });
      const { id } = res.json();
      await a1.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: [{ op: 'move', ids: ['r6'], dx: 1, dy: 0 }] } });
      await a1.close();
      s1.close();

      const s2 = new MapStore(file);
      const a2 = buildApp({ version: 't', started: 'now' }, { store: s2, token: TOKEN });
      const got = (await a2.inject({ url: `/api/v1/maps/${id}` })).json();
      expect(got.rev).toBe(2);
      expect(got.map.objects.find((o: { id: string }) => o.id === 'r6').shape.rect[0]).toBe(18);
      // undo still works after the restart
      await a2.inject({ method: 'POST', url: `/api/v1/maps/${id}/undo`, headers: auth, payload: {} });
      expect((await a2.inject({ url: `/api/v1/maps/${id}` })).json().map.objects.find((o: { id: string }) => o.id === 'r6').shape.rect[0]).toBe(17);
      await a2.close();
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live WebSocket', () => {
  it('says hello with the map, then streams every change and focus', async () => {
    const { id } = await createMap();
    const box = await connect(`/api/v1/maps/${id}/live`);
    const hello = await box.next<{ type: string; rev: number; map: DelveMap }>();
    expect(hello).toMatchObject({ type: 'hello', rev: 1 });
    expect(hello.map.name).toBe('Crypt');

    await ops(id, { ops: [{ op: 'update_map', set: { name: 'Crypt 2' } }], by: 'claude' });
    expect(await box.next()).toMatchObject({ type: 'ops', rev: 2, by: 'claude', kind: 'ops' });

    await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/undo`, headers: auth, payload: {} });
    const undo = await box.next<{ ops: Op[] }>();
    expect(undo).toMatchObject({ type: 'ops', rev: 3, kind: 'undo' });
    expect(undo.ops).toEqual([{ op: 'update_map', set: { name: 'Crypt' } }]);

    const focus = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/focus`, headers: auth, payload: { ids: ['r1'] } });
    expect(focus.json()).toEqual({ viewers: 1 });
    expect(await box.next()).toMatchObject({ type: 'focus', ids: ['r1'] });
    box.ws.terminate();
  });

  it('accepts ops over the socket only with the token', async () => {
    const { id } = await createMap();
    const ro = await connect(`/api/v1/maps/${id}/live`);
    await ro.next(); // hello
    ro.ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'update_map', set: { name: 'X' } }], ref: 7 }));
    expect(await ro.next()).toMatchObject({ type: 'error', ref: 7 });

    const rw = await connect(`/api/v1/maps/${id}/live?token=${TOKEN}`);
    await rw.next(); // hello
    rw.ws.send(JSON.stringify({ type: 'ops', baseRev: 1, ops: [{ op: 'update_map', set: { name: 'Y' } }], ref: 8 }));
    expect(await rw.next()).toEqual({ type: 'ack', rev: 2, ref: 8 });
    expect(await rw.next()).toMatchObject({ type: 'ops', rev: 2, by: 'editor' });
    expect(await ro.next()).toMatchObject({ type: 'ops', rev: 2 }); // the read-only viewer sees it too
    ro.ws.terminate();
    rw.ws.terminate();
  });
});
