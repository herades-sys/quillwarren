// Keeping props off trees and boulders over MCP: add_props_along skips occupied
// spots (unless overlap is asked for) and says how many, the same seed gives the
// same copies, add_prop warns with the ids and the nearest free spot (or moves
// there with avoid), and apply_ops names new props that stand on others.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { blockingProps, type DelveMap, type Prop } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let client: Client;

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const getMap = async (id: string) => ((await app.inject({ url: `/api/v1/maps/${id}` })).json() as { map: DelveMap }).map;
const props = async (id: string) => (await getMap(id)).objects.filter((o): o is Prop => o.type === 'prop');
/** A fresh empty map with an oak (3×3) at [10.5, 5.5]. */
async function withOak(): Promise<string> {
  const id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'empty', name: 'Glade' } })).json().id as string;
  await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: [{ op: 'add', object: { id: 'i1', type: 'prop', asset: 'c-oak-a', at: [10.5, 5.5] } }] } });
  return id;
}

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

describe('add_props_along keeps clear of trees and boulders', () => {
  it('skips the spots under the oak and says how many', async () => {
    const id = await withOak();
    const row = await call('add_props_along', { map: id, asset: 'c-boulder-a', path: [[0.5, 5.5], [20.5, 5.5]], spacing: 1, mix: false });
    expect(row.text).toMatch(/^Added 18 × Boulder \(i2–i19\) along the path\. 3 spots were skipped where a copy would have stood on a tree, boulder, wall or other blocking prop, or on another copy \(overlap true allows that\)\./);
    expect((await props(id)).map((p) => p.at[0])).toEqual([10.5, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5]);
    // a stroke that only crosses the oak places nothing
    expect((await call('add_props_along', { map: id, asset: 'c-pine-a', path: [[10.5, 5.5], [11, 5.5]], mix: false })).text).toBe('Nothing placed: 1 spot was skipped where a copy would have stood on a tree, boulder, wall or other blocking prop, or on another copy (overlap true allows that).');
  });

  it('lets them overlap with overlap true (a dense thicket)', async () => {
    const id = await withOak();
    const row = await call('add_props_along', { map: id, asset: 'c-boulder-a', path: [[0.5, 5.5], [20.5, 5.5]], spacing: 1, mix: false, overlap: true });
    expect(row.text).toMatch(/^Added 21 × Boulder \(i2–i22\) along the path\. Map is at rev/);
  });

  it('gives the same copies for the same seed, and others for another', async () => {
    const stroke = { asset: 'c-oak-a', path: [[0, 0], [30, 0], [30, 12], [0, 12]], spacing: 2.5, placement: 'irregular', spread: 1 };
    const forest = async (seed: number) => {
      const id = await withOak();
      const res = await call('add_props_along', { map: id, ...stroke, seed });
      return { text: res.text, props: (await props(id)).map(({ id: _id, ...p }) => p) };
    };
    const a = await forest(11);
    expect(await forest(11)).toEqual(a);
    expect((await forest(12)).props).not.toEqual(a.props);
    expect(a.text).toMatch(/spots? (was|were) skipped/);
    // no tree of it stands on another, or on the oak
    const trees = a.props.map((p, k) => ({ ...p, id: `x${k}`, type: 'prop' as const }));
    for (const t of trees) expect(blockingProps(trees, t)).toEqual([]);
  });
});

describe('add_prop on a tree', () => {
  it('still places it, and warns with the ids it overlaps and the nearest free spot', async () => {
    const id = await withOak();
    const res = await call('add_prop', { map: id, asset: 'c-boulder-a', at: [10.5, 5.5] });
    expect(res.text).toContain('Added Boulder i2');
    expect(res.text).toContain('Warning: it overlaps i1 (Oak), so they are drawn over each other. The nearest free spot is [11.5, 4]: move it there, or add it with avoid true.');
    expect((await props(id)).find((p) => p.id === 'i2')!.at).toEqual([10.5, 5.5]);
  });

  it('moves it to the nearest free spot with avoid true', async () => {
    const id = await withOak();
    const res = await call('add_prop', { map: id, asset: 'c-boulder-a', at: [10.5, 5.5], avoid: true });
    expect(res.text).toContain('Moved to [11.5, 4], the nearest free spot: at [10.5, 5.5] it would overlap i1 (Oak).');
    const map = await getMap(id);
    const boulder = map.objects.find((o): o is Prop => o.id === 'i2')!;
    expect(boulder.at).toEqual([11.5, 4]);
    expect(blockingProps(map.objects, boulder)).toEqual([]);
  });

  it('says nothing for props that go anywhere, or clear of the tree', async () => {
    const id = await withOak();
    for (const [asset, at] of [['c-leaf-pile-a', [10.5, 5.5]], ['candles', [10.5, 5.5]], ['c-boulder-a', [10.5, 1.5]]] as const) {
      expect((await call('add_prop', { map: id, asset, at })).text, asset).not.toContain('Warning');
    }
  });
});

describe('apply_ops adding props on a tree', () => {
  it('names the new props that stand on others, and nothing when they are clear', async () => {
    const id = await withOak();
    const ops = [
      { op: 'add', object: { id: 'i2', type: 'prop', asset: 'boulder', at: [11, 5.5] } },
      { op: 'batch', ops: [{ op: 'add', object: { id: 'i3', type: 'prop', asset: 'c-wall-2', at: [2, 0.5] } }] },
      { op: 'add', object: { id: 'i4', type: 'prop', asset: 'c-boulder-a', at: [2, 1] } },
    ];
    const res = await call('apply_ops', { map: id, ops });
    expect(res.text).toMatch(/^Applied 3 ops\. Map is at rev \d+\. Warning: 2 new props stand on trees or other props in the way, so they are drawn over each other: i2 overlaps i1; i4 overlaps i3\. Move them clear unless that is meant\.$/);
    const clear = await call('apply_ops', { map: id, ops: [{ op: 'add', object: { id: 'i5', type: 'prop', asset: 'boulder', at: [20.5, 20.5] } }] });
    expect(clear.text).toMatch(/^Applied 1 op\. Map is at rev \d+\.$/);
  });
});
