// A map's own background colour over MCP and HTTP: set_map background (hex or
// "reset"), and the pictures that show it: renders (also cropped and, with
// background=0, transparent), the viewer and editor page, the players' screen,
// Quillwarren Table pages and the Dungeon Scrawl export. The handout keeps its paper.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CHAT_SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { decodePng } from '../src/png.ts';

const TOKEN = 'background-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let client: Client;
let dir: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const getMap = async (id: string) => (await app.inject({ url: `/api/v1/maps/${id}` })).json() as { rev: number; map: DelveMap };
const newMapId = async () => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Crypt' } })).json().id as string;
const pixel = (png: Buffer, x = 0, y = 0) => {
  const d = decodePng(png);
  const i = (y * d.width + x) * 4;
  return [...d.rgba.slice(i, i + 4)];
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delve-bg-'));
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a map's background colour", () => {
  it('is set with set_map background, keeps the other overrides, and shows in every picture', async () => {
    const id = await newMapId();
    const handoutBefore = (await app.inject({ url: `/api/v1/maps/${id}/handout.svg` })).body;
    expect((await call('set_map', { map: id, overrides: { 'grid.style': 'dots' } })).isError).toBe(false);
    const res = await call('set_map', { map: id, background: '#1a2540' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Background #1A2540.');
    expect(res.text).toContain('lighter ink');
    expect((await getMap(id)).map.style).toEqual({ preset: 'classic-hatching', overrides: { 'grid.style': 'dots', background: '#1A2540' } });

    // renders: SVG, PNG, cropped, and transparent with background=0
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body).toMatch(/<g data-layer="background"><rect [^>]*fill="#1A2540"\/>/);
    expect(pixel((await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=10&view=players` })).rawPayload)).toEqual([0x1a, 0x25, 0x40, 255]);
    const crop = await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=10&frame=-3,-3,1,1` });
    expect(crop.statusCode).toBe(200);
    expect(pixel(crop.rawPayload)).toEqual([0x1a, 0x25, 0x40, 255]);
    expect(pixel((await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=10&background=0` })).rawPayload)[3]).toBe(0);
    // previewing another style keeps the map's colour
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg?style=parchment` })).body).toContain('fill="#1A2540"');

    // the viewer and editor page (first paint and the stage behind it), and the players' screen
    expect((await app.inject({ url: `/maps/${id}` })).body).toContain('id="stage" style="background:#1A2540"');
    expect((await app.inject({ url: `/maps/${id}/screen` })).body).toContain('background: #1A2540;');

    // the Dungeon Scrawl export's page colour (a stored zip, so the JSON is plain inside)
    const ds = await app.inject({ url: `/api/v1/maps/${id}/export.ds` });
    expect(ds.statusCode).toBe(200);
    expect(ds.rawPayload.toString('latin1')).toContain(`"background":{"colour":{"colour":${0x1a2540},"alpha":1}}`);

    // the parchment handout keeps its own paper
    expect((await app.inject({ url: `/api/v1/maps/${id}/handout.svg` })).body).toBe(handoutBefore);
  });

  it('goes back to the style’s own with "reset", and refuses what isn’t a colour', async () => {
    const id = await newMapId();
    await call('set_map', { map: id, background: '2F4A33' });
    expect((await getMap(id)).map.style?.overrides).toEqual({ background: '#2F4A33' });
    const reset = await call('set_map', { map: id, background: 'reset' });
    expect(reset.isError).toBe(false);
    expect(reset.text).toContain("the style's own (#EFEAE2)");
    expect((await getMap(id)).map.style).toEqual({ preset: 'classic-hatching' });
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.svg` })).body).toContain('fill="#EFEAE2"');

    const bad = await call('set_map', { map: id, background: 'teal' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('must be a colour like "#2F4A33"');
    // ops that would store a bad one are refused as a whole
    const ops = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: [{ op: 'update_map', set: { style: { preset: 'clean', overrides: { background: 'teal' } } } }] } });
    expect(ops.statusCode).toBe(400);
    expect(ops.body).toContain('style.overrides.background');
    expect((await getMap(id)).map.style).toEqual({ preset: 'classic-hatching' });

    // a new style keeps it; overrides null clears it with the rest
    await call('set_map', { map: id, background: '#4A525C' });
    await call('set_map', { map: id, style: 'old-school-blue' });
    expect((await getMap(id)).map.style).toEqual({ preset: 'old-school-blue', overrides: { background: '#4A525C' } });
    await call('set_map', { map: id, overrides: null });
    expect((await getMap(id)).map.style).toEqual({ preset: 'old-school-blue' });
    // undo brings it back, one step
    expect((await call('undo', { map: id })).isError).toBe(false);
    expect((await getMap(id)).map.style?.overrides).toEqual({ background: '#4A525C' });
  });

  it('is the colour of Quillwarren Table pages drawn from the map', async () => {
    const mapId = await newMapId();
    const { id: gameId } = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: auth, payload: { name: 'Crypt night' } })).json() as { id: string };
    const { page } = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/pages/from-map`, headers: auth, payload: { mapId } })).json();
    const url = `/api/v1/games/${gameId}/pages/${page.id}/background.png?view=gm`;
    expect(pixel((await app.inject({ url, headers: auth })).rawPayload)).toEqual([0xef, 0xea, 0xe2, 255]);
    await call('set_map', { map: mapId, background: '#2F4A33' });
    expect(pixel((await app.inject({ url, headers: auth })).rawPayload)).toEqual([0x2f, 0x4a, 0x33, 255]);
  });

  it('is in the chat prompt', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('background (the colour the map sits on: "#RRGGBB", or "reset"');
  });
});
