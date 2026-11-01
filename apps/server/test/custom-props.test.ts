// Custom props on the server: the shared library on disk, its API and access
// rules (also through the tunnel), drawing them in renders, the MCP tools
// Claude draws with (preview pictures included), and the chat context.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assetInfo, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { chatContext } from '../src/chat/prompt.ts';
import { customId, PropLibrary } from '../src/custom-props.ts';
import { decodePng, pngSize } from '../src/png.ts';

const TOKEN = 'props-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };

/** A 1×1 drawing by the rules: a shade crate with a paper lid and an outline. */
const CRATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect x="18" y="18" width="64" height="64" rx="3" fill="#999999" stroke="none"/>
<rect x="26" y="26" width="48" height="48" fill="#FFFFFF" stroke="#000000" stroke-width="2"/>
<line x1="30" y1="40" x2="70" y2="41" stroke="#000000" stroke-width="1.5"/>
<rect x="18" y="18" width="64" height="64" rx="3" fill="none" stroke="#000000" stroke-width="4"/>
</svg>`;
/** A solid ink block over most of a 1×1 square: easy to find in a PNG. */
const BLOCK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="8" y="8" width="84" height="84" fill="#000000" stroke="none"/></svg>';

let dir: string;
let app: FastifyInstance;
let base: string;
let client: Client;

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { ...res, isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), image: res.content.find((c) => c.type === 'image') };
}
const post = (payload: Record<string, unknown>, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: '/api/v1/props', headers, payload });
const newMap = async (): Promise<string> => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { name: 'Smithy' } })).json().id as string;
const ops = (id: string, list: unknown[]) => app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: list } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delve-props-test-'));
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the custom prop library', () => {
  it('saves a prop as my-<name> with its art, its source and the index on disk', async () => {
    const res = await post({ name: 'Iron Crate', w: 1, h: 1, svg: CRATE, tags: ['Storage', 'iron box'], blocks: 'movement' });
    expect(res.statusCode).toBe(201);
    const { prop, notes } = res.json() as { prop: { id: string; by: string; category: string; tags: string[]; url: string }; notes: string[] };
    expect(prop).toMatchObject({ id: 'my-iron-crate', by: 'api', category: 'custom', tags: ['storage', 'iron-box'] });
    expect(prop.url).toMatch(/^\/assets\/props\/my-iron-crate\.svg\?v=/);
    expect(notes.join(' ')).toMatch(/round caps/);
    for (const f of ['my-iron-crate.svg', 'my-iron-crate.source.svg', 'index.json']) expect(existsSync(join(dir, 'props', f)), f).toBe(true);
    expect(readFileSync(join(dir, 'props', 'my-iron-crate.source.svg'), 'utf8')).toBe(CRATE);
    // core knows it now: footprint, category, custom
    expect(assetInfo('my-iron-crate')).toMatchObject({ w: 1, h: 1, custom: true, category: 'custom' });
  });

  it('never clashes: a taken name gets a number, a taken id is refused, built-in names get the prefix', async () => {
    expect((await post({ name: 'Iron Crate', w: 1, h: 1, svg: CRATE })).json().prop.id).toBe('my-iron-crate-2');
    const taken = await post({ name: 'Another', id: 'iron-crate', w: 1, h: 1, svg: CRATE });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatch(/my-iron-crate already exists/);
    expect(customId('chair')).toBe('my-chair');
    expect(customId('Blacksmith’s Anvil!')).toBe('my-blacksmiths-anvil');
    expect((await post({ name: 'Chair', w: 1, h: 1, svg: CRATE })).json().prop.id).toBe('my-chair');
    expect(assetInfo('chair')?.custom).toBeUndefined();
  });

  it('refuses a bad drawing with every problem, and saves nothing', async () => {
    const before = (await app.inject({ url: '/api/v1/props' })).json().props.length;
    const bad = CRATE.replace('#FFFFFF', '#FF8800').replace('</svg>', '<script>alert(1)</script><image href="https://x.example/a.png"/></svg>');
    const res = await post({ name: 'Bad', w: 2, h: 1, svg: bad });
    expect(res.statusCode).toBe(400);
    const problems = (res.json() as { problems: string[] }).problems.join('\n');
    for (const want of ['no scripts', 'no <image>', 'no links', 'snapped', 'viewBox']) expect(problems).toContain(want);
    expect((await post({ name: '', w: 9, h: 1 })).json().problems.join(' ')).toMatch(/name: .*w: from 0\.5 to 6.*svg:/);
    expect((await app.inject({ url: '/api/v1/props' })).json().props.length).toBe(before);
  });

  it('changes metadata and art, keeps the id, and redraws the old art at a new size', async () => {
    const { prop } = (await post({ name: 'Cart', w: 1, h: 1, svg: CRATE })).json();
    const id = prop.id as string;
    const renamed = await app.inject({ method: 'PUT', url: `/api/v1/props/${id}`, headers: auth, payload: { name: 'Hand cart', category: 'workshop', blocks: 'sight' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().prop).toMatchObject({ id, name: 'Hand cart', category: 'workshop', blocks: 'sight', created: prop.created, by: 'api' });
    const before = (await app.inject({ url: `/assets/props/${id}.svg` })).body;
    const bigger = await app.inject({ method: 'PUT', url: `/api/v1/props/${id}`, headers: auth, payload: { w: 2, h: 1 } });
    expect(bigger.statusCode).toBe(200);
    expect(bigger.json().notes.join(' ')).toMatch(/redrew the old drawing at 2×1/);
    const after = (await app.inject({ url: `/assets/props/${id}.svg` })).body;
    expect(after).toMatch(/viewBox="0 0 200 100"/);
    expect(after).not.toBe(before);
    expect(assetInfo(id)).toMatchObject({ w: 2, h: 1 });
    // new art must fit the size it comes with; a refused one leaves the old art in place
    const wrong = await app.inject({ method: 'PUT', url: `/api/v1/props/${id}`, headers: auth, payload: { svg: CRATE } });
    expect(wrong.statusCode).toBe(400);
    expect((await app.inject({ url: `/assets/props/${id}.svg` })).body).toBe(after);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/props/${id}`, headers: auth, payload: { svg: CRATE, w: 1, h: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/props/my-nothing', headers: auth, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/props/${id}`, headers: auth, payload: { id: 'my-other' } })).statusCode).toBe(400);
  });

  it('persists across a restart, and finds its props again without the index', async () => {
    const props = join(dir, 'props');
    const again = new PropLibrary(props);
    try {
      expect(again.get('my-iron-crate')).toMatchObject({ name: 'Iron Crate', tags: ['storage', 'iron-box'] });
      expect(again.body('my-iron-crate')).toMatch(/<path d="M/);
      expect(again.source('my-iron-crate')).toBe(CRATE);
    } finally {
      again.close();
    }
    // the app's library is the registered one again
    expect(assetInfo('my-iron-crate')?.custom).toBe(true);
    const lost = mkdtempSync(join(tmpdir(), 'delve-props-lost-'));
    try {
      const a = new PropLibrary(lost);
      a.create({ name: 'Lost one', w: 1, h: 1, svg: CRATE }, 'test');
      a.close();
      rmSync(join(lost, 'index.json'));
      const b = new PropLibrary(lost);
      expect(b.get('my-lost-one')).toMatchObject({ name: 'lost one', w: 1, h: 1, category: 'custom' });
      b.close();
    } finally {
      rmSync(lost, { recursive: true, force: true });
    }
    expect(assetInfo('my-iron-crate')?.custom).toBe(true);
  });
});

describe('the API', () => {
  it('lists, serves and previews custom props, and adds them to /api/v1/assets', async () => {
    const list = (await app.inject({ url: '/api/v1/props' })).json() as { props: { id: string; custom: boolean }[]; categories: { id: string }[] };
    expect(list.props.map((p) => p.id)).toContain('my-iron-crate');
    expect(list.categories.map((c) => c.id)).toContain('custom');
    const one = (await app.inject({ url: '/api/v1/props/my-iron-crate' })).json() as { svg: string; maps: unknown[] };
    expect(one.svg).toBe(CRATE);
    expect(one.maps).toEqual([]);
    const art = await app.inject({ url: '/assets/props/my-iron-crate.svg' });
    expect(art.statusCode).toBe(200);
    expect(art.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(art.headers['cache-control']).toBe('no-cache');
    expect(art.headers['x-content-type-options']).toBe('nosniff');
    expect(art.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(art.body).not.toMatch(/script|href|style/);
    const preview = await app.inject({ url: '/api/v1/props/my-iron-crate/preview.png' });
    expect(preview.headers['content-type']).toBe('image/png');
    expect(pngSize(preview.rawPayload)).toEqual({ width: 1215, height: 365 });
    const assets = (await app.inject({ url: '/api/v1/assets' })).json() as { assets: { id: string; custom?: boolean; available: boolean }[] };
    expect(assets.assets.find((a) => a.id === 'my-iron-crate')).toMatchObject({ custom: true, available: true });
    expect((await app.inject({ url: '/assets/props/my-nothing.svg' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/props/my-nothing/preview.png' })).statusCode).toBe(404);
  });

  it('takes changes only with the API token or an editor login', async () => {
    expect((await post({ name: 'Sneaky', w: 1, h: 1, svg: CRATE }, {})).statusCode).toBe(401);
    expect((await post({ name: 'Sneaky', w: 1, h: 1, svg: CRATE }, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/props/my-iron-crate', payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/props/my-iron-crate' })).statusCode).toBe(401);
    expect(assetInfo('my-iron-crate')?.name).toBe('Iron Crate');
  });

  it('behind the tunnel: reads need a login, writes refuse the token, the art stays open like the built-in props', async () => {
    const pdir = mkdtempSync(join(tmpdir(), 'delve-props-public-'));
    const pub = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: pdir, publicUrl: 'https://delve.example' });
    try {
      await pub.ready();
      expect((await pub.inject({ method: 'POST', url: '/api/v1/props', headers: auth, payload: { name: 'Box', w: 1, h: 1, svg: CRATE } })).statusCode).toBe(201);
      expect((await pub.inject({ url: '/api/v1/props', headers: tunnel })).statusCode).toBe(401);
      expect((await pub.inject({ url: '/api/v1/props/my-box', headers: tunnel })).statusCode).toBe(401);
      expect((await pub.inject({ url: '/api/v1/props/my-box/preview.png', headers: tunnel })).statusCode).toBe(401);
      expect((await pub.inject({ method: 'POST', url: '/api/v1/props', headers: { ...tunnel, ...auth }, payload: { name: 'Box', w: 1, h: 1, svg: CRATE } })).statusCode).toBe(403);
      expect((await pub.inject({ method: 'DELETE', url: '/api/v1/props/my-box', headers: tunnel })).statusCode).toBe(401);
      expect((await pub.inject({ method: 'POST', url: '/mcp', headers: { ...tunnel, ...auth }, payload: {} })).statusCode).toBe(404);
      // Quillwarren Table players may see one dropped on the board as a picture
      expect((await pub.inject({ url: '/assets/props/my-box.svg', headers: tunnel })).statusCode).toBe(200);
      // at home, reading is open as for maps
      expect((await pub.inject({ url: '/api/v1/props' })).statusCode).toBe(200);
    } finally {
      await pub.close();
      rmSync(pdir, { recursive: true, force: true });
    }
    expect(assetInfo('my-iron-crate')?.custom).toBe(true);
  });
});

describe('drawing custom props on maps', () => {
  it('renders one in PNG and SVG, refuses to delete it while used, and draws the dashed outline once it is forced out', async () => {
    const { prop } = (await post({ name: 'Ink block', w: 1, h: 1, svg: BLOCK, ink: false })).json();
    const mapId = await newMap();
    expect((await ops(mapId, [{ op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } } }, { op: 'add', object: { id: 'i1', type: 'prop', asset: prop.id, at: [2.5, 2.5] } }])).statusCode).toBe(200);
    const svg = (await app.inject({ url: `/api/v1/maps/${mapId}/render.svg` })).body;
    expect(svg).toContain('translate(2.5 2.5) scale(0.01) translate(-50 -50)');
    expect(svg).toMatch(/<rect x="8" y="8" width="84" height="84" fill="#[0-9A-Fa-f]{6}" stroke="none"\/>/);
    expect(svg).not.toContain('data-missing');
    const dark = (png: Buffer) => {
      const { rgba } = decodePng(png);
      let n = 0;
      for (let k = 0; k < rgba.length; k += 4) if (rgba[k]! + rgba[k + 1]! + rgba[k + 2]! < 150) n++;
      return n;
    };
    const withProp = dark((await app.inject({ url: `/api/v1/maps/${mapId}/render.png` })).rawPayload);

    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/props/${prop.id}`, headers: auth });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().maps).toEqual([{ id: mapId, name: 'Smithy', count: 1 }]);
    expect(refused.json().error).toMatch(/force=1/);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/props/${prop.id}?force=1`, headers: auth })).statusCode).toBe(204);
    expect(assetInfo(prop.id)).toBeUndefined();
    expect(existsSync(join(dir, 'props', `${prop.id}.svg`))).toBe(false);
    const gone = (await app.inject({ url: `/api/v1/maps/${mapId}/render.svg` })).body;
    expect(gone).toContain(`data-missing="${prop.id}"`);
    const without = dark((await app.inject({ url: `/api/v1/maps/${mapId}/render.png` })).rawPayload);
    // the ink block is about 59 × 59 px at 70 px per square
    expect(withProp - without).toBeGreaterThan(2500);
    expect((await app.inject({ url: `/assets/props/${prop.id}.svg` })).statusCode).toBe(404);
  });
});

describe('the MCP tools', () => {
  it('teach the rules with examples', async () => {
    const { tools } = await client.listTools();
    for (const n of ['prop_rules', 'create_prop', 'update_prop', 'get_prop', 'delete_prop']) expect(tools.map((t) => t.name)).toContain(n);
    expect(client.getInstructions()).toContain('create_prop');
    const rules = await call('prop_rules');
    for (const s of ['viewBox="0 0 {w*100} {h*100}"', '#000000 ink', 'stroke-width 4', 'faces SOUTH', '70 px', 'EXAMPLE 1', 'EXAMPLE 3']) expect(rules.text).toContain(s);
    expect(rules.text).toMatch(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="100" height="100" viewBox="0 0 100 100">/); // the real chair
  });

  it('create a prop and return its preview picture, or the problems', async () => {
    const made = await call('create_prop', { name: 'Smith’s anvil', w: 1, h: 1, category: 'workshop', tags: ['smithy'], svg: CRATE });
    expect(made.isError).toBe(false);
    expect(made.text).toMatch(/Saved the new prop my-smiths-anvil\./);
    expect(made.text).toContain(`${base}/api/v1/props/my-smiths-anvil/preview.png`);
    expect(made.image?.mimeType).toBe('image/png');
    expect(pngSize(Buffer.from(made.image!.data!, 'base64'))).toEqual({ width: 1215, height: 365 });
    expect((await app.inject({ url: '/api/v1/props/my-smiths-anvil' })).json()).toMatchObject({ by: 'claude', category: 'workshop' });

    const refused = await call('create_prop', { name: 'Red', w: 1, h: 1, svg: CRATE.replace('#999999', '#CC0000') });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Not saved\. Fix this and send it again:\n- colour #CC0000 snapped to #000000/);
    expect(refused.image).toBeUndefined();
  });

  it('list custom props with the catalog, place them, and redraw, read and delete them', async () => {
    expect((await call('list_assets', { search: 'anvil' })).text).toMatch(/my-smiths-anvil — Smith’s anvil, 1×1, blocks movement, workshop, custom/);
    expect((await call('list_assets', { category: 'custom' })).text).toContain('my-iron-crate');
    const mapId = await newMap();
    await ops(mapId, [{ op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 6] } } }]);
    expect((await call('add_prop', { map: mapId, asset: 'my-smiths-anvil', at: [2.5, 2.5] })).text).toMatch(/Added Smith’s anvil i1/);

    const bigger = await call('update_prop', { id: 'my-smiths-anvil', w: 2, h: 2 });
    expect(bigger.text).toMatch(/Updated my-smiths-anvil\.[\s\S]*2×2 squares/);
    expect(pngSize(Buffer.from(bigger.image!.data!, 'base64')).width).toBeGreaterThan(1215);
    const read = await call('get_prop', { id: 'my-smiths-anvil' });
    expect(read.text).toMatch(/Used on "Smithy" \(1×\)/);
    expect(read.text).toMatch(/SVG as drawn:\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200" height="200" viewBox="0 0 200 200">/);
    expect((await call('update_prop', { id: 'my-nothing', name: 'x' })).isError).toBe(true);

    const kept = await call('delete_prop', { id: 'my-smiths-anvil' });
    expect(kept.isError).toBe(true);
    expect(kept.text).toMatch(/Not deleted: Smith’s anvil is on "Smithy" \(1×\)/);
    expect((await call('delete_prop', { id: 'my-smiths-anvil', force: true })).text).toMatch(/Deleted my-smiths-anvil .*1 map now shows? a dashed outline/);
    expect(assetInfo('my-smiths-anvil')).toBeUndefined();
  });
});

describe('the chat', () => {
  it('lists the custom props in the context block', () => {
    const map = { format: 'delve.map', version: 1, id: 'map_chat0000001', name: 'X', grid: { type: 'square' }, objects: [] } as unknown as DelveMap;
    const text = chatContext({ map, rev: 1 });
    expect(text).toMatch(/Custom props on this Quillwarren \(place them like catalog props\): .*my-iron-crate 1×1 \(Iron Crate\)/);
  });
});
