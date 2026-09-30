// Segments over REST and MCP: save part of a map, list/rename/delete, place a
// copy (renumbered, turned) and fill the land around the rooms with a forest.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { areaPathsD, FillRule, intersectD } from 'clipper2-ts';
import { floorPaths, propBounds, terrainArea, type DelveMap, type MapObject, type Op, type Prop, type Terrain } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { MapStore } from '../src/store.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

/** A patch of forest drawn at 100,100: grass under three trees, a bush and a rock. */
const FOREST: MapObject[] = [
  { id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [100, 100, 8, 8] } },
  { id: 'i1', type: 'prop', asset: 'tree', at: [101.5, 101.5] },
  { id: 'i2', type: 'prop', asset: 'tree', at: [105, 102] },
  { id: 'i3', type: 'prop', asset: 'bush', at: [103.5, 104.5] },
  { id: 'i4', type: 'prop', asset: 'boulder', at: [106.5, 105.5] },
  { id: 'i5', type: 'prop', asset: 'tree', at: [101.5, 106.5] },
];

describe('segments REST API', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: object, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, headers, payload });
  const dungeon = async (): Promise<string> => (await post('/api/v1/maps', { name: 'Crypt', template: 'test-dungeon' })).json().id;
  const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };

  it('saves rooms as a segment, lists, renames and deletes it', async () => {
    const id = await dungeon();
    expect((await post('/api/v1/segments', { name: 'Temple', map: id, ids: ['r1', 'r2'] }, {})).statusCode).toBe(401);
    const res = await post('/api/v1/segments', { name: '  Temple of  Efferd ', map: id, ids: ['r1', 'r2'] });
    expect(res.statusCode).toBe(201);
    const seg = res.json().segment as { id: string; name: string; size: number[]; counts: Record<string, number>; objects: MapObject[] };
    expect(seg.id).toMatch(/^seg_[0-9a-f]{12}$/);
    expect(seg.name).toBe('Temple of Efferd');
    expect(seg.size).toEqual([8, 16]);
    expect(seg.counts).toEqual({ room: 2, corridor: 1, door: 2 });

    const list = (await app.inject({ url: '/api/v1/segments' })).json().segments as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: seg.id, name: 'Temple of Efferd', size: [8, 16], counts: { room: 2 }, source: id });
    expect(list[0]!.objects).toBeUndefined();
    expect((await app.inject({ url: `/api/v1/segments/${seg.id}` })).json().segment.objects).toHaveLength(5);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/segments/${seg.id}`, headers: auth, payload: { name: 'Antechamber' } });
    expect(renamed.json().segment.name).toBe('Antechamber');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/segments/${seg.id}`, headers: auth, payload: { name: ' ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/segments/${seg.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/segments/${seg.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/v1/segments/${seg.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/segments/${seg.id}`, headers: auth })).statusCode).toBe(404);
  });

  it('explains what is wrong with a save', async () => {
    const id = await dungeon();
    const both = await post('/api/v1/segments', { name: 'X', map: id, ids: ['r1'], rect: [0, 0, 4, 4] });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toMatch(/either ids .* or rect/);
    const nothing = await post('/api/v1/segments', { name: 'X', map: id, rect: [50, 50, 4, 4] });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json().error).toMatch(/nothing to save/);
    expect((await post('/api/v1/segments', { name: 'X', map: 'map_nope', ids: ['r1'] })).statusCode).toBe(404);
    expect((await post('/api/v1/segments', { map: id, ids: ['r1'] })).json().error).toMatch(/name/);
  });

  it('places a turned, renumbered copy as one undo step', async () => {
    const id = await dungeon();
    const seg = (await post('/api/v1/segments', { name: 'Temple', map: id, ids: ['r5', 'r6'] })).json().segment as { id: string };
    const before = await getMap(id);
    const res = await post(`/api/v1/maps/${id}/segments/place`, { segment: seg.id, at: [30, 0], rotation: 90 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rev: number; ids: string[]; summary: string };
    expect(body.rev).toBe(before.rev + 1);
    expect(body.summary).toContain('Rooms r7 (room 7), r8 (room 8)');
    const { map } = await getMap(id);
    // r5 [4, 1, 12, 10] turned a quarter: 10 wide, 12 tall
    expect(map.objects.find((o) => o.id === 'r7')).toMatchObject({ label: '7', shape: { rect: [30, 0, 10, 12] } });
    expect(new Set(map.objects.map((o) => o.id)).size).toBe(map.objects.length);
    // by name works too
    expect((await post(`/api/v1/maps/${id}/segments/place`, { segment: 'temple', at: [30, 20] })).statusCode).toBe(200);
    await post(`/api/v1/maps/${id}/undo`, {});
    await post(`/api/v1/maps/${id}/undo`, {});
    expect((await getMap(id)).map.objects).toEqual(before.map.objects);
    expect((await post(`/api/v1/maps/${id}/segments/place`, { segment: seg.id, at: [30, 0], rotation: 45 })).json().error).toMatch(/rotation/);
    expect((await post(`/api/v1/maps/${id}/segments/place`, { segment: 'seg_nope', at: [0, 0] })).statusCode).toBe(404);
  });

  it('fills the land around the rooms with a forest and keeps the floor clear', async () => {
    const id = await dungeon();
    const patch = (await post('/api/v1/maps', { name: 'Forest' })).json().id as string;
    await post(`/api/v1/maps/${patch}/ops`, { ops: FOREST.map((object): Op => ({ op: 'add', object })) });
    const seg = (await post('/api/v1/segments', { name: 'Mixed forest', map: patch, rect: [100, 100, 8, 8] })).json().segment as { id: string; size: number[] };
    expect(seg.size).toEqual([8, 8]);

    const before = await getMap(id);
    const res = await post(`/api/v1/maps/${id}/segments/fill`, { segment: 'Mixed forest', around: 5, seed: 5 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rev: number; props: number; terrain: number; summary: string };
    expect(body.props).toBeGreaterThan(20);
    expect(body.terrain).toBe(1);
    expect(body.summary).toMatch(/^Filled the land around the rooms/);
    const { map } = await getMap(id);
    const floor = floorPaths(map);
    const grass = map.objects.find((o): o is Terrain => o.type === 'terrain')!;
    expect(grass.holes?.length).toBe(1);
    expect(Math.abs(areaPathsD(intersectD(terrainArea(grass), floor, FillRule.NonZero, 6)))).toBeLessThan(1e-6);
    for (const p of map.objects.filter((o): o is Prop => o.type === 'prop')) {
      const b = propBounds(p);
      const box = [[{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]];
      expect(Math.abs(areaPathsD(intersectD(box, floor, FillRule.NonZero, 6)))).toBeLessThan(1e-9);
    }
    // one undo takes the whole forest away
    await post(`/api/v1/maps/${id}/undo`, {});
    expect((await getMap(id)).map.objects).toEqual(before.map.objects);

    const rect = await post(`/api/v1/maps/${id}/segments/fill`, { segment: seg.id, rect: [30, 0, 16, 16], vary: false });
    expect(rect.json().summary).toMatch(/^Filled x 30–46, y 0–16/);
    expect((await post(`/api/v1/maps/${id}/segments/fill`, { segment: seg.id, rect: [0, 0, 4, 4], around: 3 })).statusCode).toBe(400);
  });

  it('keeps segments in the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-seg-'));
    try {
      const file = join(dir, 'delve.db');
      const s1 = new MapStore(file);
      const a1 = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, store: s1 });
      const m = (await a1.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon' } })).json().id;
      await a1.inject({ method: 'POST', url: '/api/v1/segments', headers: auth, payload: { name: 'Vault', map: m, ids: ['r6'] } });
      await a1.close();
      s1.close();
      const s2 = new MapStore(file);
      expect(s2.segments.list().map((s) => s.name)).toEqual(['Vault']);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('segments over MCP', () => {
  let app: FastifyInstance;
  let client: Client;
  type Content = { type: string; text?: string };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
    return { isError: res.isError, text: res.content.map((c) => c.text ?? '').join('\n') };
  };

  beforeAll(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    client = new Client({ name: 'delve-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: auth } }));
  });
  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it('saves, lists, places and fills', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['list_segments', 'save_segment', 'place_segment', 'fill_with_segment']) expect(names).toContain(n);
    expect((await call('list_segments')).text).toContain('No segments saved yet');

    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Temple', template: 'test-dungeon' })).text)![1]!;
    const saved = await call('save_segment', { map: id, name: 'Temple of Efferd', ids: ['r5', 'r6'] });
    expect(saved.text).toMatch(/^Saved segment seg_[0-9a-f]+ "Temple of Efferd": 16×10 squares with 2 rooms, 1 corridor, 4 cutouts, 2 doors/);
    expect((await call('list_segments')).text).toMatch(/"Temple of Efferd" · 16×10 squares/);

    const placed = await call('place_segment', { map: id, segment: 'Temple of Efferd', at: [30, 0], rotation: 180 });
    expect(placed.isError).toBeFalsy();
    expect(placed.text).toContain('turned 180° clockwise');
    expect(placed.text).toContain('Rooms r7 (room 7), r8 (room 8)');
    expect(placed.text).toMatch(/Map is at rev \d+\./);

    const patch = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Forest patch' })).text)![1]!;
    await call('apply_ops', { map: patch, ops: FOREST.map((object) => ({ op: 'add', object })) });
    await call('save_segment', { map: patch, name: 'Mixed forest', rect: [100, 100, 8, 8] });
    const filled = await call('fill_with_segment', { map: id, segment: 'Mixed forest', around: 4 });
    expect(filled.isError).toBeFalsy();
    expect(filled.text).toMatch(/^Filled the land around the rooms \(4 squares out: x -4–/);

    const bad = await call('fill_with_segment', { map: id, segment: 'Temple of Efferd', rect: [60, 0, 10, 10] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('place it instead');
  });
});
