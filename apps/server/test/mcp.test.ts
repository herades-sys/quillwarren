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
