// Open areas and cropped exports over MCP and HTTP: add_opening, the export
// tool's crop / around, and the render route's frame in whole squares.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CHAT_SYSTEM_PROMPT, objectLine } from '../src/chat/prompt.ts';
import { sceneFor } from '../src/render.ts';

const TOKEN = 'test-token';
let app: FastifyInstance;
let base: string;
let client: Client;
let id: string;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { ...res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const auth = { authorization: `Bearer ${TOKEN}` };
const getMap = async (): Promise<DelveMap> => ((await (await fetch(`${base}/api/v1/maps/${id}`, { headers: auth })).json()) as { map: DelveMap }).map;
/** Width and height from a PNG's IHDR. */
const pngSize = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  // Test 003's entrance, small: the long corridor (room 4) with room 11 on top and an archway out
  const created = await call('create_map', { name: 'Entrance' });
  id = /id (map_[0-9a-f]+)/.exec(created.text)![1]!;
  await call('add_room', { map: id, id: 'r4', rect: [3, -14, 2, 17], label: '' });
  await call('add_room', { map: id, id: 'r11', rect: [3, -15, 2, 1], label: '' });
  await call('add_room', { map: id, id: 'r5', rect: [10, -8, 7, 24] });
  await call('add_door', { map: id, at: [3, -15], along: 'x', width: 2, style: 'archway' });
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('add_opening', () => {
  it('adds an open area, lists it, and changes it with update and delete', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'add_opening')!;
    expect(tool.description).toContain('no hatching');
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['rect', 'poly', 'circle', 'preset', 'walls']));
    expect(client.getInstructions()).toContain('add_opening');

    const added = await call('add_opening', { map: id, rect: [5, -6, 2, 2], name: 'Ledge' });
    expect(added.isError).toBeFalsy();
    expect(added.text).toContain('Added open area o1: 2×2 squares at 5,-6, no hatching or shading inside.');
    expect((await getMap()).objects.find((o) => o.id === 'o1')).toEqual({ id: 'o1', type: 'opening', shape: { rect: [5, -6, 2, 2] }, name: 'Ledge' });

    const walls = await call('add_opening', { map: id, preset: { kind: 'hexagon', box: [-2, 0, 4, 4] }, walls: true });
    expect(walls.text).toContain('Added open area o2');
    expect(walls.text).toContain('and no walls');
    const o2 = (await getMap()).objects.find((o) => o.id === 'o2')!;
    expect(o2).toMatchObject({ type: 'opening', walls: true });
    expect('poly' in (o2 as { shape: object }).shape).toBe(true);

    expect((await call('describe_map', { map: id })).text).toContain('o1 "Ledge": 2×2 sq at 5,-6');
    await call('update', { map: id, id: 'o1', set: { walls: true } });
    expect((await getMap()).objects.find((o) => o.id === 'o1')).toMatchObject({ walls: true });
    await call('delete', { map: id, ids: ['o1', 'o2'] });
    expect((await getMap()).objects.some((o) => o.type === 'opening')).toBe(false);

    const bad = await call('add_opening', { map: id, rect: [0, 0, 1, 1], circle: [0, 0, 1] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('give exactly one of rect, poly or circle');
  });

  it('is in the chat prompt and the chat context lines', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('add_opening');
    expect(CHAT_SYSTEM_PROMPT).toContain('No hatching at the top of room 11');
    expect(objectLine({ id: 'o3', type: 'opening', shape: { rect: [3, -17, 2, 2] }, walls: true })).toBe('o3 open area rect [3, -17, 2, 2], walls left out too');
  });
});

describe('cropped exports', () => {
  it('export crops around objects, with a margin, in whole squares; the PNG is that size', async () => {
    const out = await call('export', { map: id, around: ['r4', 'r11'], ppg: 10 });
    expect(out.isError).toBeFalsy();
    // r4 and r11: x 3–5, y -15–3; plus 1 square
    expect(out.text).toContain(`${base}/api/v1/maps/${id}/render.png?view=players&ppg=10&frame=2,-16,6,4`);
    expect(out.text).toContain('Cropped to x 2–6, y -16–4 (4×20 squares).');
    const url = out.text.split('\n')[0]!;
    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('_4x20.png');
    expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual({ w: 40, h: 200 });
  });

  it('takes a crop rectangle, both together, svg and handout, and refuses a crop for .ds', async () => {
    const rect = await call('export', { map: id, format: 'svg', view: 'gm', crop: [2.5, -15.5, 3, 4.2] });
    expect(rect.text).toContain('render.svg?view=gm&frame=2,-16,6,-11');
    const svg = await (await fetch(rect.text.split('\n')[0]!, { headers: auth })).text();
    expect(svg).toContain('viewBox="2 -16 4 5"');

    const both = await call('export', { map: id, crop: [20, 20, 1, 1], around: ['r11'], margin: 0 });
    expect(both.text).toContain('frame=3,-15,21,21');

    const handout = await call('export', { map: id, format: 'handout', around: ['r11'] });
    expect(handout.text).toContain(`${base}/maps/${id}/handout?crop=2,-16,6,-13`);
    const sheet = await fetch(`${base}/api/v1/maps/${id}/handout.svg?crop=2,-16,6,-13&paper=fit`, { headers: auth });
    expect(sheet.status).toBe(200);

    const ds = await call('export', { map: id, format: 'ds', around: ['r11'] });
    expect(ds.isError).toBe(true);
    expect(ds.text).toContain('a .ds file is always the whole map');
    const missing = await call('export', { map: id, around: ['nope'] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('around: no object with id "nope"');
  });

  it('widens the render route frame to whole squares and still refuses bad ones', async () => {
    const res = await fetch(`${base}/api/v1/maps/${id}/render.png?ppg=10&frame=2.5,0,7.2,4`, { headers: auth });
    expect(res.status).toBe(200);
    expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual({ w: 60, h: 40 });
    expect((await fetch(`${base}/api/v1/maps/${id}/render.png?frame=0,0,2000,1`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/maps/${id}/render.png?frame=1,2,3`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/maps/${id}/handout.png?crop=5,5,1,1`, { headers: auth })).status).toBe(400);
  });

  it('cuts a framed render to its frame (resvg panicked on stairs running past it, which took the server down)', async () => {
    const { map } = (await (await fetch(`${base}/api/v1/maps/${id}`, { headers: auth })).json()) as { map: DelveMap };
    for (const view of ['gm', 'players']) {
      const scene = sceneFor(map, { view, frame: '4,2,9,6' });
      const b = scene.bounds;
      const far = (p: readonly number[]) => p[0]! < b.x0 - 1 || p[0]! > b.x1 + 1 || p[1]! < b.y0 - 1 || p[1]! > b.y1 + 1;
      for (const l of scene.layers) {
        if (l.kind === 'stroke') for (const line of l.lines) expect(line.points.some(far), l.name).toBe(false);
        if (l.kind === 'fill' || l.kind === 'pattern') for (const poly of l.polygons) for (const ring of [poly.outer, ...poly.holes]) expect(ring.some(far), l.name).toBe(false);
      }
    }
  });
});
