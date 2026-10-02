// Props, terrain, storeys and deleting maps, across the API, MCP, the chat prompt and the pages.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { assets } from '../src/assets.ts';
import { CHAT_SYSTEM_PROMPT, chatContext } from '../src/chat/prompt.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let base: string;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };
const newMapId = async (template = 'test-dungeon') =>
  (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template, name: 'Keep' } })).json().id as string;

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('asset files', () => {
  it('finds the design system folder', () => {
    expect(assets.dir).toMatch(/delve-props-design-system[\\/]assets/);
  });

  it('lists the catalog and serves cleaned SVGs', async () => {
    const list = (await app.inject({ url: '/api/v1/assets' })).json() as { assets: { id: string; available: boolean; file?: string }[]; categories: unknown[] };
    expect(list.assets.length).toBeGreaterThan(100);
    expect(list.assets.every((a) => a.available && a.file === undefined)).toBe(true);
    const chair = await app.inject({ url: '/assets/props/chair.svg' });
    expect(chair.statusCode).toBe(200);
    expect(chair.headers['content-type']).toContain('image/svg+xml');
    expect(chair.body).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="100" viewBox="0 0 100 100">/);
    expect(chair.body).not.toContain('metadata');
    expect((await app.inject({ url: '/assets/props/nope.svg' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/assets/props/..%2F..%2Fetc.svg' })).statusCode).toBe(404);
  });

  it('serves the icons and logo without their embedded metadata', async () => {
    const fav = await app.inject({ url: '/favicon.svg' });
    expect(fav.statusCode).toBe(200);
    expect(fav.body).not.toContain('c2pa');
    expect((await app.inject({ url: '/assets/icons/room.svg' })).body).toContain('currentColor');
    expect((await app.inject({ url: '/assets/icons/..%2Fbrand%2Flogo.svg' })).statusCode).toBe(404);
  });
});

describe('props and terrain over MCP', () => {
  it('lists assets, places a prop and a terrain area, and refuses wrong kinds', async () => {
    const id = await newMapId();
    expect((await call('list_assets', { search: 'barrel' })).text).toMatch(/barrels — Barrel Cluster, 2×2, blocks movement, storage/);
    expect((await call('list_assets', { category: 'terrain' })).text).toContain('lava — Lava (terrain)');
    const prop = await call('add_prop', { map: id, asset: 'bench', at: [9, 27.5], rotation: 90, notes: 'creaks' });
    expect(prop.text).toContain('Added Wooden Bench i1, covering x 8.5–9.5, y 26.5–28.5.');
    const terrain = await call('add_terrain', { map: id, asset: 'water-shallow', rect: [6, 2, 4, 4] });
    expect(terrain.text).toContain('Added Shallow Water terrain t1');
    expect((await call('add_prop', { map: id, asset: 'lava', at: [1, 1] })).isError).toBe(true);
    expect((await call('add_terrain', { map: id, asset: 'chair', rect: [0, 0, 1, 1] })).text).toContain('not a terrain tile');
    const { map } = await getMap(id);
    expect(map.objects.find((o) => o.id === 'i1')).toMatchObject({ type: 'prop', asset: 'bench', at: [9, 27.5], rotation: 90, notes: 'creaks' });
    expect((await call('describe_map', { map: id })).text).toMatch(/Props:\n {2}in 1 Entrance hall: Wooden Bench \(i1\)/);
    const png = await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=20` });
    expect(png.statusCode).toBe(200);
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const svg = (await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body;
    expect(svg).toContain('<pattern id="tile-water-shallow-');
    expect(svg).not.toContain('data-missing'); // real art, no stand-ins
  });
});

describe('GM markers over MCP', () => {
  it('pins a note, strikes it through, and keeps it out of the players view', async () => {
    const id = await newMapId();
    const added = await call('add_marker', { map: id, kind: 'trap', at: [10.5, 27.5], text: 'Poison dart trap with a pressure plate.' });
    expect(added.text).toContain('Added trap marker m1 at [10.5, 27.5].');
    expect((await call('add_marker', { map: id, kind: 'secret', at: [1, 1], text: '' })).isError).toBe(true);
    await call('update', { map: id, id: 'm1', set: { done: true } });
    expect((await getMap(id)).map.objects.find((o) => o.id === 'm1')).toMatchObject({ type: 'marker', kind: 'trap', done: true });
    expect((await call('describe_map', { map: id })).text).toContain('trap m1 at 10.5,27.5 in 1 Entrance hall (done): "Poison dart trap with a pressure plate."');
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body).toContain('data-marker="m1" data-kind="trap" data-done=""');
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players` })).body).not.toContain('data-marker');
    expect(CHAT_SYSTEM_PROMPT).toContain('add_marker (kind, at, text)');
  });
});

describe('brush and roughness over MCP', () => {
  it('places a row of props in one step and sets the wall roughness', async () => {
    const id = await newMapId();
    const row = await call('add_props_along', { map: id, asset: 'barrel', path: [[1.5, 1.5], [13.5, 1.5]], spacing: 3 });
    expect(row.text).toMatch(/^Added 5 × Barrel \(i1–i5\) along the path\./);
    expect((await call('add_props_along', { map: id, asset: 'barrel', path: [[1.5, 1.5], [13.5, 1.5]], spacing: 3 })).text).toContain('Nothing placed');
    const { map, rev } = await getMap(id);
    expect(map.objects.filter((o) => o.type === 'prop').map((o) => (o.type === 'prop' ? o.at : null))).toEqual([[1.5, 1.5], [4.5, 1.5], [7.5, 1.5], [10.5, 1.5], [13.5, 1.5]]);
    await call('undo', { map: id });
    expect((await getMap(id)).map.objects.some((o) => o.type === 'prop')).toBe(false); // one undo step
    expect(rev).toBeGreaterThan(1);
    await call('set_map', { map: id, roughness: 9 });
    expect((await getMap(id)).map.roughness).toBe(9);
    expect((await call('describe_map', { map: id })).text).toContain('Walls: roughness 9 of 10 (cave-like).');
    await call('set_map', { map: id, roughness: null });
    expect((await getMap(id)).map).not.toHaveProperty('roughness');
    expect((await call('set_map', { map: id, roughness: 12 })).isError).toBe(true);
  });
});

describe('parchment handout', () => {
  it('renders the players map on a sheet, as PNG and SVG, with a page to print it', async () => {
    const id = await newMapId();
    await call('add_marker', { map: id, kind: 'trap', at: [10.5, 27.5], text: 'Poison darts' });
    const png = await app.inject({ url: `/api/v1/maps/${id}/handout.png?dpi=60&paper=a3&download=1` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^attachment; filename="keep_handout_a3(-landscape)?\.png"$/);
    expect(png.headers['x-handout-size']).toBe('842x1191pt');
    expect(png.rawPayload.readUInt32BE(16)).toBe(Math.round((841.89 * 60) / 72)); // A3 at 60 dpi
    const svg = await app.inject({ url: `/api/v1/maps/${id}/handout.svg?title=Old%20crypt&compass=0` });
    expect(svg.body).toContain('>Old crypt</text>');
    expect(svg.body).not.toContain('>N</text>');
    expect(svg.body).not.toContain('Poison darts');
    for (const bad of ['paper=b5', 'orientation=sideways', 'dpi=2000']) {
      expect((await app.inject({ url: `/api/v1/maps/${id}/handout.png?${bad}` })).statusCode).toBe(400);
    }
    const page = (await app.inject({ url: `/maps/${id}/handout` })).body;
    expect(page).toContain('<h1>Parchment handout</h1>');
    expect(page).toContain('Print or save as PDF');
    expect((await app.inject({ url: `/maps/${id}` })).body).toContain(`href="/maps/${id}/handout"`);
    expect((await call('export', { map: id, format: 'handout' })).text).toContain(`/maps/${id}/handout`);
  });
});

describe('storeys', () => {
  it('adds storeys over MCP and REST, lists them top first, and renames one', async () => {
    const id = await newMapId();
    const added = await call('add_level', { map: id, name: 'Tower top', current_name: 'Hall' });
    const top = /as map (map_[0-9a-f]+)/.exec(added.text)![1]!;
    expect(added.text).toContain('Storeys, top first: Tower top');
    const cellar = (await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/levels`, headers: auth, payload: { name: 'Cellar', position: 'below' } })).json();
    const levels = (await app.inject({ url: `/api/v1/maps/${id}/levels` })).json().levels as { id: string; level: { name: string; order: number } }[];
    expect(levels.map((l) => l.level.name)).toEqual(['Tower top', 'Hall', 'Cellar']);
    expect(levels.map((l) => l.id)).toEqual([top, id, cellar.id]);
    expect((await getMap(top)).map).toMatchObject({ name: 'Keep', objects: [], level: { group: id, order: 1 } });
    expect((await call('list_maps')).text).toContain(`storey "Cellar" (order -1) of group ${id}`);
    await call('set_map', { map: top, level_name: 'Belfry' });
    expect((await getMap(top)).map.level?.name).toBe('Belfry');
    expect((await call('set_map', { map: (await newMapId('empty')), level_name: 'X' })).text).toContain('not a storey');
    expect((await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/levels`, headers: auth, payload: { name: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/levels`, payload: { name: 'Attic' } })).statusCode).toBe(401);

    // the map page lists the storeys for its storeys control, and deleting a storey takes it out of the group
    const page = (await app.inject({ url: `/maps/${id}` })).body;
    expect(page).toMatch(/id="storey-btn" aria-label="Change storey" aria-haspopup="menu" aria-expanded="false">/);
    expect(page).toMatch(/"levels":\[.*"Belfry".*"order":1/s); // floor number 1
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/maps/${cellar.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/v1/maps/${id}/levels` })).json().levels).toHaveLength(2);
    const alone = (await app.inject({ url: `/maps/${await newMapId('empty')}` })).body;
    expect(alone).toMatch(/id="storey-btn"[^>]* hidden>/);
  });
});

describe('what the chat knows', () => {
  it('has the catalog and the storey rules in its prompt, and the storeys in its context', async () => {
    for (const s of ['add_prop', 'add_terrain', 'add_level', '# Storeys', 'chest-closed 1×1', 'water-shallow', 'GM symbols (GM view only)', 'faces south']) {
      expect(CHAT_SYSTEM_PROMPT).toContain(s);
    }
    const id = await newMapId();
    await call('add_prop', { map: id, asset: 'chest-closed', at: [10.5, 27.5] });
    await call('add_level', { map: id, name: 'Cellar', position: 'below' });
    const { rev, map } = await getMap(id);
    const levels = (await app.inject({ url: `/api/v1/maps/${id}/levels` })).json().levels;
    const ctx = chatContext({ map, rev, levels });
    expect(ctx).toMatch(/This map is the storey "Ground floor"\. Storeys, top first: "Ground floor" \(map_[0-9a-f]+, this one\), "Cellar" \(map_[0-9a-f]+\)\./);
    expect(ctx).toContain('i1 prop chest-closed (Closed Chest, 1×1) at [10.5, 27.5]');
  });
});

describe('deleting maps from the start page', () => {
  it('shows Delete buttons only to logged-in editors', async () => {
    await newMapId();
    expect((await app.inject({ url: '/' })).body).not.toContain('data-delete=');
    const open = buildApp({ version: 'test', started: 'now' }, { openEdit: true });
    try {
      await open.inject({ method: 'POST', url: '/api/v1/maps', payload: { name: 'Doomed' } });
      const page = (await open.inject({ url: '/' })).body;
      expect(page).toMatch(/<button class="button danger" type="button" data-delete="map_[0-9a-f]+" data-name="Doomed">Delete<\/button>/);
    } finally {
      await open.close();
    }
  });
});

describe('the 3D view', () => {
  it('serves a page with the storeys, top first, and a link from the map page', async () => {
    const id = await newMapId();
    await call('add_level', { map: id, name: 'Loft' });
    const page = await app.inject({ url: `/maps/${id}/3d` });
    expect(page.statusCode).toBe(200);
    const initial = JSON.parse(/<script id="delve-initial" type="application\/json">(.*?)<\/script>/.exec(page.body)![1]!) as { storeys: { level: { name: string } }[] };
    expect(initial.storeys.map((s) => s.level.name)).toEqual(['Loft', 'Ground floor']);
    expect(page.body).toContain('/assets/stack.js?v=test');
    expect((await app.inject({ url: `/maps/${id}` })).body).toContain(`href="/maps/${id}/3d"`);
    expect((await app.inject({ url: '/maps/map_000000000000/3d' })).statusCode).toBe(404);
  });

  it('renders floors without their background on request', async () => {
    const id = await newMapId();
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body).toContain('data-layer="background"');
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?background=0` })).body).not.toContain('data-layer="background"');
  });
});

describe('fog of war', () => {
  it('reveals rooms over MCP, shows only them on the players screen, and shades the rest for the GM', async () => {
    const id = await newMapId();
    const res = await call('fog', { map: id, reveal: ['r1', 'c1'] });
    expect(res.text).toContain('Fog of war: on. Revealed: 1 Entrance hall [r1], c1.');
    expect(res.text).toContain(`/maps/${id}/screen`);
    expect((await call('fog', { map: id, reveal: ['zz'] })).isError).toBe(true);
    // the players' screen carries no map data, only the picture of what's revealed
    const screen = await app.inject({ url: `/maps/${id}/screen` });
    expect(screen.statusCode).toBe(200);
    expect(screen.body).toContain('/assets/screen.js?v=test');
    expect(screen.body).not.toContain('"objects"');
    const payload = (await app.inject({ url: `/api/v1/maps/${id}/screen` })).json() as { svg: string; frame: unknown; hidden: boolean };
    expect(payload.hidden).toBe(false);
    expect(payload.frame).toEqual({ x0: 4.7, y0: 18.7, x1: 15.3, y1: 33.3 });
    const players = (await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players&fog=1` })).body;
    const whole = (await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players` })).body;
    expect(players.length).toBeLessThan(whole.length / 2); // only room 1 and its corridor are in it
    const gm = (await app.inject({ url: `/api/v1/maps/${id}/render.svg?fog=1` })).body;
    expect(gm).toContain('data-layer="fog"');
    const page = (await app.inject({ url: `/maps/${id}` })).body;
    expect(page).toContain('data-layer="fog"'); // the GM view's first picture is shaded
    await call('fog', { map: id, on: false });
    expect((await getMap(id)).map.fog?.on).toBe(false);
  });
});

describe('the players screen socket', () => {
  it('never sends map data, only that something changed', async () => {
    const id = await newMapId();
    await call('fog', { map: id, reveal: ['r1'] });
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/maps/${id}/live?screen=1`);
    const got: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => ws.addEventListener('message', (e) => (got.push(JSON.parse(String(e.data))), got.length === 1 && resolve())));
    await call('add_label', { map: id, text: 'Hi', at: [10, 28] });
    await call('focus', { map: id, ids: ['r1', 'r5'] }); // r5 isn't revealed: the screen only looks at r1
    await expect.poll(() => got.length, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
    ws.close();
    expect(got[0]).toEqual({ type: 'hello', rev: 2 });
    expect(got[1]).toEqual({ type: 'changed', rev: 3 });
    expect(got[2]).toEqual({ type: 'look', bounds: { x0: 7, y0: 25, x1: 13, y1: 31 } });
    expect(JSON.stringify(got)).not.toContain('objects');
  });
});
