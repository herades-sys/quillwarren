// Drives the MCP endpoint with the official SDK client over real HTTP, the
// way Claude Code will.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';

const TOKEN = 'test-token';
let app: FastifyInstance;
let base: string;
let client: Client;

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { ...res, text };
}

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
  );
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('MCP endpoint', () => {
  it('refuses clients without the token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('offers the map tools and explains coordinates', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['list_maps', 'create_map', 'add_room', 'connect', 'add_cutout', 'add_door', 'move', 'undo', 'render', 'focus', 'export', 'apply_ops']) {
      expect(names).toContain(n);
    }
    expect(client.getInstructions()).toContain('y grows downward');
  });

  it('builds a small dungeon, looks at it, and undoes a step', async () => {
    const created = await call('create_map', { name: 'Goblin warren' });
    const id = /id (map_[0-9a-f]+)/.exec(created.text)![1]!;
    expect(created.text).toContain(`${base}/maps/${id}`);

    expect((await call('add_room', { map: id, rect: [0, 0, 6, 6], name: 'Entrance' })).text).toContain('Added room r1 "Entrance" (label 1): 6×6 squares at 0,0');
    await call('add_room', { map: id, rect: [0, 10, 8, 6], name: 'Den' });
    await call('add_room', { map: id, rect: [14, 11, 5, 4], name: 'Chief' });
    const c1 = await call('connect', { map: id, from: 'r1', to: 'r2', doors: 'both' });
    expect(c1.text).toContain('Added corridor c1 from r1 to r2: 2 wide, 4 squares long');
    expect(c1.text).toContain('doors d1, d2');
    const c2 = await call('connect', { map: id, from: 'r2', to: 'r3', width: 1, doors: 'to', door_style: 'locked' });
    expect(c2.text).toContain('doors d3');
    await call('add_cutout', { map: id, rect: [3, 12, 1, 1], name: 'Pillar' });

    const d = await call('describe_map', { map: id });
    expect(d.text).toContain('3 rooms, 2 corridors, 3 doors, 1 cutouts');
    expect(d.text).toContain('c2: 2 Den ↔ 3 Chief, 1 sq wide');
    expect(d.text).toContain('d3 (locked)');

    const pic = await call('render', { map: id, view: 'players' });
    const img = pic.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

    await call('move', { map: id, ids: ['r3'], dx: 2, dy: 0 });
    expect((await call('undo', { map: id })).text).toMatch(/Undid one change\. Map is at rev \d+/);
    const map = JSON.parse((await call('get_map', { map: id })).text).map;
    expect(map.objects.find((o: { id: string }) => o.id === 'r3').shape.rect).toEqual([14, 11, 5, 4]);

    expect((await call('export', { map: id })).text).toBe(`${base}/api/v1/maps/${id}/render.png?view=players`);
  });

  it('reports mistakes as tool errors instead of failing the call', async () => {
    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Oops' })).text)![1]!;
    const noShape = await call('add_room', { map: id, name: 'Nowhere' });
    expect(noShape.isError).toBe(true);
    expect(noShape.text).toContain('exactly one of rect, poly or circle');
    await call('add_room', { map: id, rect: [0, 0, 4, 4] });
    await call('add_room', { map: id, rect: [2, 2, 4, 4] });
    const overlap = await call('connect', { map: id, from: 'r1', to: 'r2' });
    expect(overlap.isError).toBe(true);
    expect(overlap.text).toContain('overlap');
    expect((await call('describe_map', { map: 'map_nope' })).text).toContain('no map with id "map_nope"');
  });

  it('writes GM notes on rooms, corridors and terrain, and lists them in describe_map', async () => {
    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Noted', template: 'test-dungeon' })).text)![1]!;
    expect((await call('update', { map: id, id: 'c1', set: { notes: 'Oil on the floor: DC 10 or fall' } })).isError).toBeFalsy();
    expect((await call('update', { map: id, id: 'r5', unset: ['notes'] })).isError).toBeFalsy();
    await call('add_terrain', { map: id, asset: 'water-shallow', rect: [8, 26, 2, 2] });
    const terrain = JSON.parse((await call('get_map', { map: id })).text).map.objects.find((o: { type: string }) => o.type === 'terrain');
    await call('update', { map: id, id: terrain.id, set: { notes: 'The key lies at the bottom' } });
    const text = (await call('describe_map', { map: id })).text;
    expect(text).toContain('GM notes (GM only, never drawn):');
    expect(text).toContain('  Corridor 1–2 [c1]: "Oil on the floor: DC 10 or fall"');
    expect(text).toContain(`[${terrain.id}]: "The key lies at the bottom"`);
    expect(text).not.toContain('Cult leader');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'update')?.description).toContain('"notes"');
  });

  it('puts doors in walls at any angle: by angle, or near a slanted wall', async () => {
    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Octagon hall' })).text)![1]!;
    await call('add_room', { map: id, preset: { kind: 'octagon', box: [0, 0, 10, 10] } });
    const turned = await call('add_door', { map: id, at: [1, 1], angle: 45, width: 1.5, style: 'locked' });
    expect(turned.isError).toBeFalsy();
    expect(turned.text).toMatch(/^Added locked door d1 at 1,1 turned 45°, 1\.5 wide\. /);
    // near the slanted north-east wall: centred on it and turned to match (it runs at 45°)
    const near = await call('add_door', { map: id, near: [8.4, 1.4], width: 2 });
    expect(near.text).toMatch(/^Added normal door d2 on the wall at [\d.]+,[\d.]+ turned 45°, 2 wide\. /);
    const objects = JSON.parse((await call('get_map', { map: id })).text).map.objects as { id: string; angle?: number; along?: string }[];
    expect(objects.find((o) => o.id === 'd1')).toMatchObject({ angle: 45, along: 'x' });
    expect(objects.find((o) => o.id === 'd2')).toMatchObject({ angle: 45 });
    expect((await call('update', { map: id, id: 'd1', set: { angle: 100 } })).isError).toBeFalsy();
    expect((await call('update', { map: id, id: 'd1', set: { angle: 'west' } })).isError).toBe(true);
    // the old way still works, and a spot far from any wall is refused
    expect((await call('add_door', { map: id, at: [4, 0], along: 'x', width: 2 })).text).toMatch(/^Added normal door d3 at 4,0 along x, 2 wide\. /);
    const far = await call('add_door', { map: id, near: [5, 5], width: 1 });
    expect(far.isError).toBe(true);
    expect(far.text).toContain('no wall within a square');
    expect((await call('describe_map', { map: id })).text).toContain('d2 (normal, turned 45°)');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'add_door')?.description).toContain('any angle');
  });

  it('focus reaches an open viewer', async () => {
    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Watched', template: 'test-dungeon' })).text)![1]!;
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/maps/${id}/live`);
    const messages: { type: string; ids?: string[] }[] = [];
    await new Promise<void>((ok) => ws.on('message', (raw) => (messages.push(JSON.parse(String(raw))), messages.length === 1 && ok())));
    expect((await call('focus', { map: id, ids: ['r5'] })).text).toBe('Pointed 1 open viewer at r5.');
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.at(-1)).toMatchObject({ type: 'focus', ids: ['r5'], by: 'claude' });
    ws.close();
  });
});
