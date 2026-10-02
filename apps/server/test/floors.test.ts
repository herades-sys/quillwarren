// Floor numbers, stair labels, room shapes and solid cutouts across REST, MCP, the chat prompt and the viewer page.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap, MapObject } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { CHAT_SYSTEM_PROMPT, chatContext } from '../src/chat/prompt.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };
const newMapId = async (template = 'empty') => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template, name: 'Tower' } })).json().id as string;
const addLevel = async (id: string, name: string, position: 'above' | 'below' = 'above') =>
  (await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/levels`, headers: auth, payload: { name, position } })).json().id as string;
const add = (id: string, ...objects: MapObject[]) => app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: objects.map((object) => ({ op: 'add', object })) } });
const labelOf = async (id: string, obj: string) => (await getMap(id)).map.objects.find((o) => o.id === obj) as (MapObject & { label?: string }) | undefined;
const stairs = (id: string): MapObject => ({ id, type: 'stairs', shape: { rect: [2, 2, 2, 3] }, direction: 'n' });
const ladder = (id: string): MapObject => ({ id, type: 'prop', asset: 'ladder', at: [20.5, 3.5] });

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('stair labels', () => {
  it("numbers the user's example over REST: a staircase 0 → 1 → 2 and a ladder 2 → 3", async () => {
    const ground = await newMapId();
    const first = await addLevel(ground, 'First floor');
    const second = await addLevel(ground, 'Second floor');
    const third = await addLevel(ground, 'Third floor');
    await add(ground, stairs('s1'));
    await add(first, stairs('s1'));
    await add(second, stairs('s1'), ladder('i1'));
    await add(third, ladder('i1'));
    expect((await app.inject({ method: 'POST', url: `/api/v1/maps/${ground}/levels/label-stairs`, payload: {} })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: `/api/v1/maps/${first}/levels/label-stairs`, headers: auth, payload: { by: 'test' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { storeys: { id: string; floor: number; stairs: number; changed: number }[]; summary: string };
    expect(body.storeys.map((s) => [s.floor, s.stairs, s.changed])).toEqual([[3, 1, 1], [2, 2, 2], [1, 1, 1], [0, 1, 1]]);
    expect(body.summary).toBe('Numbered 5 stairs on 4 storeys (5 labels changed).');
    expect((await labelOf(ground, 's1'))?.label).toBe('0A');
    expect((await labelOf(first, 's1'))?.label).toBe('1A');
    expect((await labelOf(second, 's1'))?.label).toBe('2A');
    expect((await labelOf(second, 'i1'))?.label).toBe('2B');
    expect((await labelOf(third, 'i1'))?.label).toBe('3B');
    // one undo step per changed map, and nothing at all when the labels are right
    const rev = (await getMap(second)).rev;
    const again = (await app.inject({ method: 'POST', url: `/api/v1/maps/${ground}/levels/label-stairs`, headers: auth, payload: {} })).json() as { storeys: { changed: number }[] };
    expect(again.storeys.every((s) => s.changed === 0)).toBe(true);
    expect((await getMap(second)).rev).toBe(rev);
  });

  it('labels a single map as floor 0 over MCP, and when a storey is added', async () => {
    const id = await newMapId();
    await add(id, stairs('s1'), ladder('i2'));
    const r = await call('label_stairs', { map: id });
    expect(r.text).toContain('Numbered 2 stairs (2 labels changed).');
    expect((await labelOf(id, 's1'))?.label).toBe('0A');
    expect((await labelOf(id, 'i2'))?.label).toBe('0B');
    // a cellar under it: the ground floor stays 0, and add_level renumbers on its own
    await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: [{ op: 'update', id: 's1', unset: ['label'] }] } });
    const added = await call('add_level', { map: id, name: 'Cellar', position: 'below' });
    expect(added.text).toMatch(/Storeys, top first: Ground floor \(map_[0-9a-f]+, floor 0\), Cellar \(map_[0-9a-f]+, floor -1\)/);
    expect((await labelOf(id, 's1'))?.label).toBe('0A');
    expect((await call('label_stairs', { map: 'map_nope' })).isError).toBe(true);
  });
});

describe('floor numbers', () => {
  it('sets a storey’s floor with set_map, warns about a clash, and describes it', async () => {
    const id = await newMapId();
    const cellar = await addLevel(id, 'Cellar', 'below');
    expect((await getMap(cellar)).map.level?.order).toBe(-1);
    const clash = await call('set_map', { map: cellar, floor: 0 });
    expect(clash.text).toContain('is floor 0 too');
    expect(clash.text).toContain('label_stairs');
    await call('set_map', { map: cellar, floor: -2, level_name: 'Deep cellar' });
    expect((await getMap(cellar)).map.level).toMatchObject({ order: -2, name: 'Deep cellar' });
    expect((await call('describe_map', { map: cellar })).text).toContain(`Floor −2 (Deep cellar) of ${id}.`);
    expect((await call('set_map', { map: await newMapId(), floor: 1 })).text).toContain('not a storey');
  });

  it('tells the other storeys’ viewers when a storey is renumbered', async () => {
    const id = await newMapId();
    const top = await addLevel(id, 'Loft');
    const ws: WebSocket = await app.injectWS(`/api/v1/maps/${id}/live`);
    const got = new Promise<string[]>((ok) => {
      const seen: string[] = [];
      ws.on('message', (raw) => {
        seen.push(JSON.parse(String(raw)).type);
        if (seen.includes('levels')) ok(seen);
      });
    });
    await call('set_map', { map: top, floor: 3 });
    expect(await got).toContain('levels');
    ws.terminate();
  });

  it('shows the floors in the storeys control on the map page, not in the first picture', async () => {
    const id = await newMapId('test-dungeon');
    const cellar = await addLevel(id, 'Cellar', 'below');
    const page = (await app.inject({ url: `/maps/${cellar}` })).body;
    // the control is drawn by the page script from the storeys in the initial data
    expect(page).toContain('id="storeys"');
    expect(page).toMatch(/"levels":\[.*"Ground floor".*"Cellar".*"order":-1/s);
    expect(page).toMatch(/<button class="btn btn-icon ed-storey-btn" type="button" id="storey-btn" aria-label="Change storey" aria-haspopup="menu" aria-expanded="false">/);
    expect(page).not.toContain('data-layer="floor-number"');
    const alone = (await app.inject({ url: `/maps/${await newMapId()}` })).body;
    expect(alone).toMatch(/id="storey-btn"[^>]* hidden>/);
    // GM renders carry the number in the corner; the players' view doesn't
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=gm` })).body).toContain('data-layer="floor-number"');
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players` })).body).not.toContain('data-layer="floor-number"');
  });
});

describe('room shapes and solid cutouts over MCP', () => {
  it('adds a hexagon room, an oval pillar and a solid one', async () => {
    const id = await newMapId();
    const room = await call('add_room', { map: id, preset: { kind: 'hexagon', box: [0, 0, 8, 8] } });
    expect(room.isError).toBe(false);
    const oval = await call('add_cutout', { map: id, preset: { kind: 'oval', box: [2, 3, 2, 1] } });
    expect(oval.text).toContain('Added cutout p1');
    const solid = await call('add_cutout', { map: id, rect: [5, 3, 1, 1], fill: 'solid' });
    expect(solid.text).toContain('Added solid cutout p2');
    const { map } = await getMap(id);
    expect(map.objects.find((o) => o.id === 'r1')).toMatchObject({ shape: { poly: [[2, 0], [6, 0], [8, 4], [6, 8], [2, 8], [0, 4]] } });
    expect((map.objects.find((o) => o.id === 'p1') as { shape: { poly: unknown[] } }).shape.poly).toHaveLength(40);
    expect(map.objects.find((o) => o.id === 'p2')).toMatchObject({ fill: 'solid' });
    expect((await call('add_room', { map: id, rect: [0, 0, 1, 1], preset: { kind: 'oval', box: [0, 0, 2, 2] } })).text).toContain('exactly one of rect, poly or circle');
    expect((await call('resize', { map: id, id: 'r1', preset: { kind: 'octagon', box: [0, 0, 8, 8] } })).isError).toBe(false);
    expect((await call('describe_map', { map: id })).text).toContain('p2 (solid)');
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players` })).body).toContain('data-layer="solid-cutouts"');
  });

  it('tells the chat about shapes, fills, floors and stair labels', () => {
    for (const s of ['preset {"kind"', 'fill "solid"', '**Floor numbers:**', '**Stair labels:**', 'label_stairs', '0A, 1A and 2A']) expect(CHAT_SYSTEM_PROMPT).toContain(s);
    const map: DelveMap = {
      format: 'delve.map',
      version: 1,
      id: 'map_a',
      name: 'Tower',
      grid: { type: 'square' },
      level: { group: 'map_a', name: 'Cellar', order: -1 },
      objects: [{ ...stairs('s1'), label: '-1A' } as MapObject, { id: 'p1', type: 'cutout', shape: { rect: [5, 5, 1, 1] }, fill: 'solid' }],
    };
    const levels = [
      { id: 'map_b', name: 'Tower', level: { group: 'map_a', name: 'Hall', order: 0 } },
      { id: 'map_a', name: 'Tower', level: { group: 'map_a', name: 'Cellar', order: -1 } },
    ];
    const ctx = chatContext({ map, rev: 3, levels });
    expect(ctx).toContain('Floor numbers: "Hall" 0, "Cellar" -1.');
    expect(ctx).toContain('s1 stairs rect [2, 2, 2, 3], up n, label "-1A"');
    expect(ctx).toContain('p1 cutout rect [5, 5, 1, 1], solid');
  });
});
