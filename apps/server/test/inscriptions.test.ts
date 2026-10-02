// Handwritten notes on the parchment handout: MCP, the handout pictures and their frame, the
// PNG font, the page's Notes tool for the GM, and the chat prompt.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CHAT_SYSTEM_PROMPT, objectLine } from '../src/chat/prompt.ts';
import { decodePng, FONT_FILES, svgToPng } from '../src/png.ts';

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
const newMapId = async () => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Crypt' } })).json().id as string;

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

/** How many pixels of a PNG are dark ink (not paper, not see-through). */
function inkPixels(png: Buffer): number {
  const { rgba } = decodePng(png);
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]! > 200 && rgba[i]! + rgba[i + 1]! + rgba[i + 2]! < 300) n++;
  return n;
}

describe('handout notes over MCP', () => {
  it('writes, changes and deletes a note with add_inscription, update and delete', async () => {
    const id = await newMapId();
    const added = await call('add_inscription', { map: id, text: 'Here be dragons', at: [22, 3], rotation: -4, ink: 'red' });
    expect(added.isError).toBe(false);
    expect(added.text).toContain('Added handout note w1 "Here be dragons" at [22, 3]');
    expect(added.text).toContain(`/maps/${id}/handout`);
    let note = (await getMap(id)).map.objects.find((o) => o.id === 'w1');
    expect(note).toEqual({ id: 'w1', type: 'inscription', text: 'Here be dragons', at: [22, 3], rotation: -4, ink: 'red' });
    // defaults are left out: brown ink, no tilt, handout only
    await call('add_inscription', { map: id, text: 'Beware!\nNone return.', at: [8, 30], ink: 'brown', size: 1.2, on_map: true });
    expect((await getMap(id)).map.objects.find((o) => o.id === 'w2')).toEqual({ id: 'w2', type: 'inscription', text: 'Beware!\nNone return.', at: [8, 30], size: 1.2, onMap: true });
    expect((await call('describe_map', { map: id })).text).toContain('w1 at 22,3 outside rooms (red ink, tilted -4°, handout only): "Here be dragons"');
    await call('update', { map: id, id: 'w1', set: { text: 'Here be wyverns', onMap: true }, unset: ['ink'] });
    note = (await getMap(id)).map.objects.find((o) => o.id === 'w1');
    expect(note).toMatchObject({ text: 'Here be wyverns', onMap: true });
    expect(note).not.toHaveProperty('ink');
    // only on the map with onMap
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?view=players` })).body).toContain('data-inscription="w1"');
    await call('move', { map: id, ids: ['w1'], dx: 1, dy: 1 });
    expect((await getMap(id)).map.objects.find((o) => o.id === 'w1')).toMatchObject({ at: [23, 4] });
    await call('undo', { map: id });
    expect((await getMap(id)).map.objects.find((o) => o.id === 'w1')).toMatchObject({ at: [22, 3] });
    await call('delete', { map: id, ids: ['w1'] });
    expect((await getMap(id)).map.objects.some((o) => o.id === 'w1')).toBe(false);
    expect((await call('add_inscription', { map: id, text: 'x', at: [0, 0], ink: 'blue' })).isError).toBe(true);
    expect((await call('add_inscription', { map: id, text: 'x'.repeat(301), at: [0, 0] })).isError).toBe(true);
  });

  it('are in the chat prompt and the context lines', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('add_inscription (text, at, size, rotation, ink, on_map)');
    expect(CHAT_SYSTEM_PROMPT).toContain('**Handout notes** (add_inscription)');
    expect(CHAT_SYSTEM_PROMPT).toContain('w handout notes');
    expect(objectLine({ id: 'w1', type: 'inscription', text: 'Here be dragons', at: [22, 3], ink: 'red', onMap: true })).toBe('w1 handout note "Here be dragons" at [22, 3], ink red, also on the map');
  });
});

describe('handout notes in pictures', () => {
  it('ships IM FELL English Italic to resvg, which draws it unlike the roman', async () => {
    expect(Object.keys(FONT_FILES)).toContain('im-fell-english-italic.ttf');
    const text = (style: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60" viewBox="0 0 300 60"><rect width="300" height="60" fill="#fff"/><text x="10" y="42" font-size="36" font-family="IM FELL English" ${style}>Here be dragons</text></svg>`;
    const roman = decodePng(await svgToPng(text(''))).rgba;
    const italic = decodePng(await svgToPng(text('font-style="italic"'))).rgba;
    let differ = 0;
    for (let i = 0; i < roman.length; i += 4) if (Math.abs(roman[i]! - italic[i]!) > 60) differ++;
    expect(differ).toBeGreaterThan(500);
  });

  it('draws the notes into the handout PNG and SVG, and says where the map sits on the sheet', async () => {
    const id = await newMapId();
    await call('add_inscription', { map: id, text: 'Here be dragons and worse', at: [10, 23], size: 1.5, ink: 'black' });
    await call('add_inscription', { map: id, text: 'far, far away', at: [900, -600] }); // left out: resvg can't take it
    const png = await app.inject({ url: `/api/v1/maps/${id}/handout.png?dpi=60` });
    expect(png.statusCode).toBe(200);
    const frame = JSON.parse(String(png.headers['x-handout-frame'])) as Record<string, number>;
    expect(Object.keys(frame).sort()).toEqual(['h', 'k', 'w', 'x', 'x0', 'y', 'y0']);
    expect(frame.w).toBeCloseTo(595.28);
    expect(frame.k).toBeGreaterThan(10);
    const bare = await app.inject({ url: `/api/v1/maps/${id}/handout.png?dpi=60&inscriptions=0` });
    expect(bare.statusCode).toBe(200);
    expect(inkPixels(png.rawPayload)).toBeGreaterThan(inkPixels(bare.rawPayload) + 50);
    const svg = (await app.inject({ url: `/api/v1/maps/${id}/handout.svg` })).body;
    expect(svg).toContain('data-inscription="w1"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).not.toContain('data-inscription="w2"');
    expect((await app.inject({ url: `/api/v1/maps/${id}/handout.svg?inscriptions=0` })).body).not.toContain('data-inscription');
    // every paper and a few odd sizes draw without trouble
    for (const q of ['paper=a3&dpi=61', 'paper=letter&orientation=landscape&dpi=77', 'paper=fit&dpi=53']) {
      expect((await app.inject({ url: `/api/v1/maps/${id}/handout.png?${q}` })).statusCode).toBe(200);
    }
  });
});

describe('the handout page', () => {
  it('gives the GM the Notes tool, and players the handout without it', async () => {
    const id = await newMapId();
    const visitor = (await app.inject({ url: `/maps/${id}/handout` })).body;
    expect(visitor).toContain('Print or save as PDF');
    expect(visitor).not.toContain('id="notes-panel"');
    expect(visitor).not.toContain('/assets/handout.js');
    const open = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, openEdit: true });
    try {
      const mapId = (await open.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Crypt' } })).json().id as string;
      const gm = (await open.inject({ url: `/maps/${mapId}/handout` })).body;
      expect(gm).toContain('<span class="section-label">Handwritten notes</span>');
      expect(gm).toContain('id="notes-panel"');
      expect(gm).toContain('<script type="module" src="/assets/handout.js?v=test"></script>');
      // the page's own script still runs the preview, print and downloads
      expect(gm).toContain('window.delveHandout');
      expect(gm).toContain("id=\"print\"");
      // the tool saves through the normal ops, with the editor login, from the same origin
      const note = { id: 'w1', type: 'inscription', text: 'Here be dragons', at: [3, 4] };
      const host = 'delve.test';
      const ok = await open.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: { host, origin: `http://${host}` }, payload: { ops: [{ op: 'add', object: note }], by: 'handout' } });
      expect(ok.statusCode).toBe(200);
      const foreign = await open.inject({ method: 'POST', url: `/api/v1/maps/${mapId}/ops`, headers: { host, origin: 'http://evil.example' }, payload: { ops: [{ op: 'delete', ids: ['w1'] }] } });
      expect(foreign.statusCode).toBe(401);
      expect(((await open.inject({ url: `/api/v1/maps/${mapId}` })).json() as { map: DelveMap }).map.objects.at(-1)).toEqual(note);
    } finally {
      await open.close();
    }
  });
});
