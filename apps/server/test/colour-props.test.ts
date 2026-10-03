// Colour props over the API, MCP and the chat prompt: listed by palette and
// category (short by default), placed by id, painted as mixed groups, served
// with their palette, and summed up for Claude instead of listed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assetInfo, ASSETS, COLOUR_ASSETS, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { assets } from '../src/assets.ts';
import { CHAT_SYSTEM_PROMPT } from '../src/chat/prompt.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };
const newMapId = async () => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'empty', name: 'Glade' } })).json().id as string;

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

describe('list_assets with colour props', () => {
  it('stays short by default: the ink catalog as before, and the colour props by category', async () => {
    const { text } = await call('list_assets');
    const lines = text.split('\n');
    expect(lines.length).toBeLessThan(ASSETS.length + 40);
    expect(text).toMatch(/^barrels — Barrel Cluster, 2×2, blocks movement, storage$/m);
    expect(text).not.toMatch(/^c-oak-a — /m);
    expect(text).toMatch(/- Trees \(trees, \d+\): c-oak-a, /);
    expect((await call('list_assets', { palette: 'colour' })).text).toMatch(/- Rocks \(rocks, 20\): /);
  });

  it('filters by palette and category, and finds groups by search', async () => {
    const trees = (await call('list_assets', { palette: 'colour', category: 'trees' })).text.split('\n');
    expect(trees.every((l) => l.startsWith('c-'))).toBe(true);
    expect(trees).toContain('c-oak-a — Oak, 3×3, blocks sight, trees, colour, group oak');
    // nature is a category of both libraries
    const nature = (await call('list_assets', { category: 'nature' })).text;
    expect(nature).toMatch(/^tree — /m);
    expect(nature).toMatch(/^c-stump-a — /m);
    expect((await call('list_assets', { category: 'nature', palette: 'ink' })).text).not.toMatch(/^c-/m);
    expect((await call('list_assets', { search: 'rug-persian-red' })).text).toMatch(/c-persian-red-a — .*on the floor, group rug-persian-red/);
    expect((await call('list_assets', { search: 'hidden trapdoor' })).text).toMatch(/c-hidden-trapdoor-stone — .*hidden from players/);
    expect((await call('list_assets', { palette: 'colour', category: 'ruins' })).text).toMatch(/c-wall-1 — .*modular/);
  });
});

describe('placing colour props', () => {
  it('adds them by id, snaps ruin walls onto whole squares, and paints a group as a mixed forest', async () => {
    const id = await newMapId();
    expect((await call('add_prop', { map: id, asset: 'c-persian-red-a', at: [5, 5.5] })).text).toMatch(/Added Persian rug, red i1/);
    const wall = await call('add_prop', { map: id, asset: 'c-wall-2', at: [10.5, 3.5] });
    expect(wall.text).toMatch(/Moved onto whole squares \(at \[11, 3\.5\]\)/);
    const hidden = await call('add_prop', { map: id, asset: 'c-hidden-trapdoor-stone', at: [2.5, 2.5] });
    expect(hidden.text).toContain('hidden from players');
    const forest = await call('add_props_along', { map: id, asset: 'c-oak-a', path: [[0, 20], [40, 20], [40, 30], [0, 30]], spacing: 3, placement: 'irregular' });
    expect(forest.text).toMatch(/props of group oak/);
    const { map } = await getMap(id);
    const trees = map.objects.filter((o) => o.type === 'prop' && assetInfo(o.asset)?.group === 'oak');
    expect(trees.length).toBeGreaterThan(10);
    expect(new Set(trees.map((t) => (t as { asset: string }).asset)).size).toBeGreaterThan(1);
    expect(map.objects.find((o) => o.id === 'i2')).toMatchObject({ asset: 'c-wall-2', at: [11, 3.5] });
    // mix false paints the one prop
    await call('add_props_along', { map: id, asset: 'c-pine-a', path: [[0, 40], [30, 40]], spacing: 3, mix: false });
    const pines = (await getMap(id)).map.objects.filter((o) => o.type === 'prop' && assetInfo(o.asset)?.group === 'pine');
    expect(new Set(pines.map((t) => (t as { asset: string }).asset))).toEqual(new Set(['c-pine-a']));
  });

  it('fills an area with a colour terrain texture, listed as terrain, not as a prop', async () => {
    const floors = (await call('list_assets', { palette: 'colour', category: 'floors' })).text;
    expect(floors).toMatch(/^c-floor-planks-oak — Oak floorboards \(terrain, colour texture 2×2, group floor-planks\)$/m);
    expect((await call('list_assets', { palette: 'colour', category: 'water' })).text).toMatch(/^c-water-calm — .*\(terrain, colour texture 3×3, group water-calm, difficult\)$/m);
    expect((await call('list_assets')).text).toMatch(/- Floors \(floors, \d+ terrain textures\): c-floor-planks-oak, /);
    const id = await newMapId();
    expect((await call('add_terrain', { map: id, asset: 'c-floor-planks-oak', rect: [0, 0, 4, 4] })).text).toMatch(/Added Oak floorboards terrain t1/);
    expect((await call('add_prop', { map: id, asset: 'c-floor-planks-oak', at: [1, 1] })).isError).toBe(true);
    const svg = (await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body;
    expect(svg).toMatch(/<pattern id="[^"]*tile-c-floor-planks-oak-[^"]*" patternUnits="userSpaceOnUse" x="0" y="0" width="2" height="2">/);
  });

  it('serves their art with its palette, lists them in /api/v1/assets, and renders them per style', async () => {
    const list = (await app.inject({ url: '/api/v1/assets' })).json() as { assets: { id: string; palette?: string; available: boolean }[]; categories: { id: string }[] };
    expect(list.assets.filter((a) => a.palette === 'colour').length).toBe(COLOUR_ASSETS.length);
    expect(list.assets.every((a) => a.available)).toBe(true);
    expect(list.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['trees', 'carpets', 'nature']));
    expect(new Set(list.categories.map((c) => c.id)).size).toBe(list.categories.length);
    const oak = await app.inject({ url: '/assets/props/c-oak-a.svg' });
    expect(oak.statusCode).toBe(200);
    expect(oak.body).toContain('#4F803C');
    expect(assets.body('c-hidden-trapdoor-stone')).toContain('stroke-dasharray="7 5"');
    const id = await newMapId();
    await call('add_room', { map: id, rect: [0, 0, 6, 6] });
    await call('add_prop', { map: id, asset: 'c-oak-a', at: [1.5, 1.5] });
    const svg = async (style: string) => (await app.inject({ url: `/api/v1/maps/${id}/render.svg?style=${style}` })).body;
    expect(await svg('classic-hatching')).toContain('#4F803C');
    expect(await svg('print')).not.toContain('#4F803C');
  });
});

describe('what Claude is told about colour props', () => {
  it('sums them up by category instead of listing them, with the recipe for a mixed forest', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('# Colour props (ids c-…)');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/- Trees \(trees, \d+\): c-oak-a 3×3, /);
    expect(CHAT_SYSTEM_PROMPT).toContain('A forest of mixed trees');
    expect(CHAT_SYSTEM_PROMPT).toContain('add_props_along (asset, path, spacing, placement, spread, mix, overlap)');
    // a line per category, not per prop
    const section = CHAT_SYSTEM_PROMPT.slice(CHAT_SYSTEM_PROMPT.indexOf('# Colour props'));
    expect(section.split('\n').length).toBeLessThan(50);
    expect(section).not.toContain('c-walnut-a');
  });
});
