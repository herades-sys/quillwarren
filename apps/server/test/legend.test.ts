// The handout's legend over HTTP and MCP: legend=0 / legend=1, the x-handout-frame
// header following the map when the legend moves it, PNGs of a busy map on every
// paper and way round (resvg must never panic on it), the page's checkbox and
// the MCP export link.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap, MapObject } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { decodePng } from '../src/png.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}

/** A busy keep: every door style, stairs, a trapdoor, ink and colour terrain, a cliff, oaks and rugs (groups of variants), a hidden trap. */
function busyKeep(): DelveMap {
  const objects: MapObject[] = [
    { id: 'r1', type: 'room', shape: { rect: [0, 0, 10, 8] } },
    { id: 'r2', type: 'room', shape: { rect: [12, 0, 8, 8] } },
    { id: 'r3', type: 'room', shape: { rect: [0, 12, 10, 8] } },
    { id: 'c1', type: 'corridor', width: 2, path: [[10, 3], [12, 3]] },
    { id: 'c2', type: 'corridor', width: 2, path: [[4, 8], [4, 12]] },
    { id: 'd1', type: 'door', at: [10, 2], along: 'y', width: 2 },
    { id: 'd2', type: 'door', at: [12, 2], along: 'y', width: 2, style: 'portcullis' },
    { id: 'd3', type: 'door', at: [3, 8], along: 'x', width: 2, style: 'secret' },
    { id: 'd4', type: 'door', at: [3, 12], along: 'x', width: 2, style: 'archway' },
    { id: 's1', type: 'stairs', shape: { rect: [7, 13, 2, 2] }, direction: 'n' },
    { id: 't1', type: 'terrain', asset: 'water-deep', shape: { rect: [0, 16, 4, 4] } },
    { id: 't2', type: 'terrain', asset: 'c-floor-planks-oak', shape: { rect: [12, 0, 8, 8] } },
    { id: 'h1', type: 'height', shape: { rect: [5, 16, 5, 4] }, height: -5, edge: 'rock' },
  ];
  const props = ['c-oak-a', 'c-oak-b', 'c-oak-c', 'c-persian-red-a', 'c-persian-red-b', 'c-trapdoor-wood', 'barrel', 'chair', 'bench', 'crate', 'sack', 'table-round', 'pressure-plate'];
  props.forEach((asset, i) => objects.push({ id: `i${i + 1}`, type: 'prop', asset, at: i < 3 ? [13.5 + i * 2, 5.5] : [1.5 + (i - 3) * 0.9, 1.5 + (i % 3) * 2] }));
  return { format: 'delve.map', version: 1, id: 'busy-keep', name: 'Busy Keep', grid: { type: 'square' }, seed: 9, objects };
}

let id = '';
beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { map: busyKeep() } })).json().id as string;
});
afterAll(async () => {
  await client.close();
  await app.close();
});

const frameOf = (headers: Record<string, unknown>) => JSON.parse(String(headers['x-handout-frame'])) as { w: number; h: number; x: number; y: number; k: number; x0: number; y0: number };
const n = (v: number) => String(Math.round(v * 1000) / 1000);

describe('the handout legend over HTTP', () => {
  it('is on by default, legend=0 leaves it out, and the frame header follows the map', async () => {
    const on = await app.inject({ url: `/api/v1/maps/${id}/handout.svg?orientation=portrait` });
    const off = await app.inject({ url: `/api/v1/maps/${id}/handout.svg?orientation=portrait&legend=0` });
    expect(on.body).toContain('data-legend=""');
    for (const name of ['>Door</text>', '>Portcullis</text>', '>Archway</text>', '>Stairs</text>', '>Trapdoor</text>', '>Deep Water</text>', '>Oak floorboards</text>', '>Rock face</text>', '>Oak</text>', '>Persian rug, red</text>']) expect(on.body).toContain(name);
    expect(on.body).not.toContain('Pressure Plate');
    expect(off.body).not.toContain('data-legend');
    // a hall filling its map leaves no corner free: the legend moves (or shrinks) the map, the header says
    // where it went, and the map is drawn where the header says (the page's Notes tool places notes by it)
    const hall = { ...busyKeep(), id: 'busy-hall', objects: [{ id: 'r1', type: 'room', shape: { rect: [0, 0, 16, 10] } }, ...busyKeep().objects.filter((o) => o.type === 'prop').map((o, i) => ({ ...o, at: [1.5 + i * 1.1, 5] }))] };
    const hallId = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { map: hall } })).json().id as string;
    const moved = await app.inject({ url: `/api/v1/maps/${hallId}/handout.svg?orientation=landscape` });
    const still = await app.inject({ url: `/api/v1/maps/${hallId}/handout.svg?orientation=landscape&legend=0` });
    const a = frameOf(moved.headers);
    const b = frameOf(still.headers);
    expect(moved.body).toContain('data-legend');
    expect([a.x, a.y, a.k]).not.toEqual([b.x, b.y, b.k]);
    for (const [res, f] of [[moved, a], [still, b], [on, frameOf(on.headers)], [off, frameOf(off.headers)]] as const) {
      expect(res.body).toContain(`<svg xmlns="http://www.w3.org/2000/svg" x="${n(f.x)}" y="${n(f.y)}" width=`);
    }
    // legend=1 keeps even a single entry: one room with a door
    const single = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { map: { ...busyKeep(), id: 'busy-single', objects: busyKeep().objects.filter((o) => o.id === 'r1' || o.id === 'd1') } } })).json().id as string;
    expect((await app.inject({ url: `/api/v1/maps/${single}/handout.svg` })).body).not.toContain('data-legend');
    expect((await app.inject({ url: `/api/v1/maps/${single}/handout.svg?legend=1` })).body).toContain('data-legend');
  });

  it('draws PNGs of a busy map with its legend on every paper, both ways round and at odd sizes', async () => {
    const papers = ['a4', 'a3', 'letter'].flatMap((p) => ['portrait', 'landscape'].map((o) => `paper=${p}&orientation=${o}`));
    for (const [i, q] of [...papers, 'paper=fit', 'paper=fit&crop=0,0,12,10', 'paper=a4&revealed=1'].entries()) {
      const dpi = [50, 53, 61, 77][i % 4]!;
      const res = await app.inject({ url: `/api/v1/maps/${id}/handout.png?${q}&dpi=${dpi}` });
      expect(res.statusCode, q).toBe(200);
      const f = frameOf(res.headers);
      const png = decodePng(res.rawPayload);
      expect(png.width, q).toBe(Math.round((f.w * dpi) / 72));
      expect(png.height, q).toBe(Math.round((f.h * dpi) / 72));
    }
  }, 60_000);
});

describe('the handout legend on the page and over MCP', () => {
  it('has a Legend checkbox beside the compass, scale bar and frame, which the page address can switch off', async () => {
    const page = (await app.inject({ url: `/maps/${id}/handout` })).body;
    expect(page).toMatch(/id="frame" type="checkbox" checked>.*?<\/label>\s*<label class="check"[^>]*><input id="legend" type="checkbox" checked>/s);
    expect(page).toContain("['compass', 'scale', 'frame', 'stains', 'legend']");
    expect(page).toContain("if (legendQ === '0') $('legend').checked = false;");
    // the options are remembered in this browser, the title per map
    expect(page).toContain("var KEY = 'delve-handout-options', TITLE_KEY = 'delve-handout-title:' + init.id;");
    expect(page).toContain("function () { remember(); clearTimeout(timer);");
  });

  it('takes legend in the handout export', async () => {
    expect((await call('export', { map: id, format: 'handout' })).text).toMatch(new RegExp(`/maps/${id}/handout$`));
    expect((await call('export', { map: id, format: 'handout', legend: false })).text).toContain(`/maps/${id}/handout?legend=0`);
    expect((await call('export', { map: id, format: 'handout', legend: true, crop: [0, 0, 10, 8] })).text).toContain(`/maps/${id}/handout?crop=0,0,10,8&legend=1`);
  });
});
