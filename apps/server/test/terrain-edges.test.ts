// Terrain edges on the server: MCP add_terrain's edge, fade_width, edge_details
// and stack (stored, said back, changed with update, refused when out of range,
// listed by describe_map), and the PNG stress run (terrain-stress.ts) in a child
// process, so a resvg panic shows up as a failed test instead of silently
// killing the test runner.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap, Terrain } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const TOKEN = 'terrain-edges-test-token';
let app: FastifyInstance;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
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

describe('MCP add_terrain: edges', () => {
  it('stores edge, fade width, details and stack, says how the edge looks, and update changes them', async () => {
    const id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Valley' })).text)![1]!;
    const grass = await call('add_terrain', { map: id, asset: 'c-ground-grass-short', rect: [0, 0, 30, 20] });
    expect(grass.text).toContain('Added Short grass terrain t1: 30×20 squares at 0,0; fades over 0.75 squares into the terrain under it (ragged against bare ground) (by material).');
    const sand = await call('add_terrain', { map: id, asset: 'c-ground-sand', rect: [10, 5, 10, 8], edge: 'fade', fade_width: 4, edge_details: false, stack: 6 });
    expect(sand.isError).toBe(false);
    expect(sand.text).toContain('fades over 4 squares into the terrain under it (ragged against bare ground), stack 6, no edge details');
    const floor = await call('add_terrain', { map: id, asset: 'c-floor-planks-oak', rect: [2, 2, 4, 4] });
    expect(floor.text).toContain('a hard edge (by material)');
    const map = (await call('get_map', { map: id })).text;
    const terrain = (JSON.parse(map) as { map: DelveMap }).map.objects.filter((o): o is Terrain => o.type === 'terrain');
    expect(terrain.map(({ id: tid, edge, fadeWidth, edgeDetails, stack }) => ({ tid, edge, fadeWidth, edgeDetails, stack }))).toEqual([
      { tid: 't1', edge: undefined, fadeWidth: undefined, edgeDetails: undefined, stack: undefined },
      { tid: 't2', edge: 'fade', fadeWidth: 4, edgeDetails: false, stack: 6 },
      { tid: 't3', edge: undefined, fadeWidth: undefined, edgeDetails: undefined, stack: undefined },
    ]);
    // describe_map names the edges set on an area, not the defaults
    const described = (await call('describe_map', { map: id })).text;
    expect(described).toContain('t2 Sand 10×8');
    expect(described).toContain('(fades over 4 squares into the terrain under it (ragged against bare ground), stack 6, no edge details)');
    expect(described).not.toMatch(/t1 Short grass[^;]*fades/);
    // update and unset
    expect((await call('update', { map: id, id: 't2', set: { edge: 'ragged' }, unset: ['stack'] })).isError).toBe(false);
    expect((await call('update', { map: id, id: 't1', set: { fadeWidth: 2.5 } })).isError).toBe(false);
    const after = (JSON.parse((await call('get_map', { map: id })).text) as { map: DelveMap }).map.objects;
    expect(after.find((o) => o.id === 't2')).toMatchObject({ edge: 'ragged', fadeWidth: 4, edgeDetails: false });
    expect(after.find((o) => o.id === 't2')).not.toHaveProperty('stack');
    expect(after.find((o) => o.id === 't1')).toMatchObject({ fadeWidth: 2.5 });
    // out of range or unknown: refused, nothing changes
    expect((await call('add_terrain', { map: id, asset: 'c-ground-sand', rect: [0, 0, 2, 2], fade_width: 9 })).isError).toBe(true);
    expect((await call('add_terrain', { map: id, asset: 'c-ground-sand', rect: [0, 0, 2, 2], edge: 'soft' })).isError).toBe(true);
    const bad = await call('update', { map: id, id: 't2', set: { stack: 12 } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('from 0 to 9');
    // and it draws: a PNG of the whole map (soft edges and all) from the render route
    const png = await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=10` });
    expect(png.statusCode).toBe(200);
    const svg = await app.inject({ url: `/api/v1/maps/${id}/render.svg` });
    expect(svg.body).toContain('data-layer="terrain-fade:t2"');
    expect(svg.body).toContain('fill-opacity="0.3"');
  });
});

describe('PNG stress: terrain edges through resvg', () => {
  it('renders every style, view, crop, handout paper and a big map without resvg panicking', () => {
    const script = resolve(import.meta.dirname, 'terrain-stress.ts');
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 240_000 });
    const lines = run.stdout.trim().split('\n');
    // a panic aborts the child (SIGABRT): name the picture it died on
    expect(run.signal, `resvg died on "${lines.at(-1)}": ${run.stderr.slice(-500)}`).toBeNull();
    expect(run.status, run.stderr.slice(-1000)).toBe(0);
    expect(lines.at(-1)).toMatch(/^ok \d+ pictures/);
    expect(Number(/^ok (\d+)/.exec(lines.at(-1)!)![1])).toBeGreaterThan(80);
  }, 300_000);
});
