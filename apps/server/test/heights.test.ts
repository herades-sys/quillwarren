// Height areas on the server: MCP add_height (and describe_map, update, delete),
// the Quillwarren Table page drawn from a map with heights (its GM-only cliffs, and a
// player refused across one with "Respect heights" on), and the 3D scene's heights.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import { addMember, applyIntent, newGame, viewFor, type Page } from '@delve/table';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { pageFromMap } from '../src/table/routes.ts';
import { scene3d } from '../src/table/scene3d.ts';

const TOKEN = 'heights-test-token';
let app: FastifyInstance;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { ...res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
});

const hall = (): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id: 'map_hall',
  name: 'Hall',
  grid: { type: 'square' },
  objects: [
    { id: 'r1', type: 'room', shape: { rect: [0, 0, 16, 10] }, label: '1', name: 'Great hall' },
    { id: 'h1', type: 'height', shape: { rect: [0, 0, 16, 3] }, height: 10 },
    { id: 's1', type: 'stairs', shape: { rect: [12, 2, 2, 3] }, direction: 'n' },
  ],
});

describe('MCP add_height', () => {
  it('builds an archers\' ledge and a sunken arena, says how they are reached, and changes them', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('add_height');
    expect(client.getInstructions()).toContain('add_height');
    const created = await call('create_map', { name: 'Ledges' });
    const id = /id (map_[0-9a-f]+)/.exec(created.text)![1]!;
    await call('add_room', { map: id, rect: [0, 0, 16, 10], name: 'Great hall' });
    await call('add_stairs', { map: id, rect: [12, 2, 2, 3], direction: 's' });
    const ledge = await call('add_height', { map: id, rect: [0, 0, 16, 3], height: 10, name: "Archers' ledge" });
    expect(ledge.isError).toBeFalsy();
    expect(ledge.text).toContain('Added height area h1: +10 ft, 16×3 squares at 0,0.');
    expect(ledge.text).toContain('reached by stairs s1');
    // the stairs were put in pointing the wrong way: the answer says so
    expect(ledge.text).toContain('s1 (up is n now: update {"direction": "n"})');
    await call('add_room', { map: id, circle: [30, 5, 5], name: 'Arena' });
    const pit = await call('add_height', { map: id, preset: { kind: 'octagon', box: [26, 1, 8, 8] }, height: -10, edge: 'cliff', name: 'Sunken arena' });
    expect(pit.text).toContain('Added height area h2: −10 ft');
    expect(pit.text).toContain('no stairs or ladder');
    const described = await call('describe_map', { map: id });
    expect(described.text).toContain('Heights (relative to the floor');
    expect(described.text).toContain('h2 "Sunken arena": −10 ft, cliff edge');
    expect((await call('update', { map: id, id: 'h2', set: { edge: 'slope' } })).isError).toBeFalsy();
    expect((await call('describe_map', { map: id })).text).toContain('h2 "Sunken arena": −10 ft hollow, slope (walkable)');
    const bad = await call('add_height', { map: id, rect: [0, 0, 2, 2], height: 5, edge: 'wall' });
    expect(bad.isError).toBe(true);
    expect((await call('delete', { map: id, ids: ['h2'] })).isError).toBeFalsy();
  });
});

describe('Quillwarren Table pages from a map with heights', () => {
  it('carry the blocking cliff edges (GM only), and with Respect heights the server refuses a player across one', () => {
    const page = pageFromMap(hall());
    expect(page.cliffs).toEqual([
      { a: [0, 3], b: [12, 3], drop: 10 },
      { a: [14, 3], b: [16, 3], drop: 10 },
    ]);
    expect(pageFromMap({ ...hall(), objects: hall().objects.filter((o) => o.type !== 'height') })).not.toHaveProperty('cliffs');

    let s = newGame('g1', 'Night', 0);
    s = addMember(s, 'Ann').state;
    const ctx = { now: 1, rng: () => 1, nextSeq: () => 1 };
    s = applyIntent(s, 'gm', { type: 'page.update', id: 'pg1', set: { ...page, respectHeights: true } as Partial<Page> }, ctx).state;
    s = applyIntent(s, 'gm', { type: 'token.create', token: { pageId: 'pg1', layer: 'tokens', x: 2, y: 5, w: 1, h: 1, image: '/x.png', controlledBy: ['p1'] } }, ctx).state;
    expect(viewFor(s, 'p1').pages[0]).not.toHaveProperty('cliffs');
    expect(() => applyIntent(s, 'p1', { type: 'token.move', id: 'k1', x: 2, y: 1 }, ctx)).toThrow(/cliff edge \(a 10 ft drop\)/);
    // up the stairs: along x 13 from below to the ledge
    s = applyIntent(s, 'p1', { type: 'token.move', id: 'k1', x: 12.5, y: 5 }, ctx).state;
    s = applyIntent(s, 'p1', { type: 'token.move', id: 'k1', x: 12.5, y: 1 }, ctx).state;
    expect(s.tokens[0]).toMatchObject({ x: 12.5, y: 1 });
  });

  it('give the 3D scene its heights, cut to what the players may see', () => {
    const map = hall();
    const page = { id: 'pg1', ...pageFromMap(map) } as Page;
    const gm = scene3d('g1', page, map, 'gm', 'all');
    expect(gm.heights?.bands.map((b) => b.h)).toEqual([2]);
    expect(gm.heights?.edges[0]).toMatchObject({ hi: 2, lo: 0, kind: 'cliff', run: 0 });
    const region = [{ outer: [[0, 5], [16, 5], [16, 10], [0, 10]] as [number, number][], holes: [] }];
    const players = scene3d('g1', page, map, 'players', region);
    expect(players.heights?.bands ?? []).toEqual([]);
    expect(players.heights?.edges ?? []).toEqual([]);
    const hidden = { ...map, objects: map.objects.map((o) => (o.type === 'height' ? { ...o, hidden: true } : o)) };
    expect(scene3d('g1', page, hidden, 'players', 'all').heights).toBeUndefined();
  });

  it('drape a hill in the 3D scene (a piece with a grid of heights), cut to what the players may see', () => {
    const map: DelveMap = { ...hall(), objects: [...hall().objects, { id: 'h2', type: 'height', shape: { circle: [8, 7, 2.5] }, height: 5, edge: 'slope' }] };
    const page = { id: 'pg1', ...pageFromMap(map) } as Page;
    const gm = scene3d('g1', page, map, 'gm', 'all').heights!;
    expect(gm.pieces?.find((p) => !p.grid)?.h).toBe(2); // the ledge
    const hill = gm.pieces?.find((p) => p.grid);
    expect(hill?.grid?.max).toBeGreaterThan(0.9);
    expect(gm.step).toBe(0.25);
    const region = [{ outer: [[0, 4], [6, 4], [6, 10], [0, 10]] as [number, number][], holes: [] }];
    const players = scene3d('g1', page, map, 'players', region).heights!;
    expect(players.pieces?.length).toBeGreaterThan(0);
    expect(players.pieces?.every((p) => p.polygons.every((q) => q.outer.every(([x, y]) => x <= 6 + 1e-6 && y >= 4 - 1e-6)))).toBe(true);
  });
});
