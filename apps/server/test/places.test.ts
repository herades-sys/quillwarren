// The meaning-level options of the MCP tools, through the real endpoint: rooms
// beside rooms, doors on walls, props by place, regions, lengths with units,
// corridors round rooms, the check lines and check_map.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doorCentre, propBounds, shapeBounds, type DelveMap, type MapObject } from '@delve/core';
import { buildApp } from '../src/app.ts';

const TOKEN = 'test-token';
let app: FastifyInstance;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { isError: Boolean(res.isError), text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
async function newMap(template: 'test-dungeon' | 'empty' = 'test-dungeon', unit?: string): Promise<string> {
  const r = await call('create_map', { name: 'places', template, ...(unit ? { unit } : {}) });
  return /id (map_[0-9a-f]+)/.exec(r.text)![1]!;
}
async function mapOf(id: string): Promise<DelveMap> {
  return (JSON.parse((await call('get_map', { map: id })).text) as { map: DelveMap }).map;
}
const byId = (m: DelveMap, id: string) => m.objects.find((o) => o.id === id) as MapObject;
const area = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('placing by meaning over MCP', () => {
  it('add_room beside a room: east of room 1, joined by a corridor with a door, checked', async () => {
    const id = await newMap();
    const r = await call('add_room', { map: id, beside: 'r1', side: 'east', size: [6, 4], connect: true, door: 'locked', name: 'Guard post' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Added room r7 "Guard post" (label 7): 6×4 squares at 15,26. It lies east of room 1 Entrance hall (r1), 2 squares from it');
    expect(r.text).toContain('Joined to r1 by corridor c6 (2 wide, 2 squares long) with a locked door d7 where it enters r7.');
    expect(r.text).toMatch(/\nCheck: all 3 fine/);
    const m = await mapOf(id);
    expect((byId(m, 'r7') as { shape: { rect: number[] } }).shape.rect).toEqual([15, 26, 6, 4]);
    expect(byId(m, 'c6')).toMatchObject({ type: 'corridor', from: 'r1', to: 'r7' });
    const d7 = byId(m, 'd7') as Extract<MapObject, { type: 'door' }>;
    expect(d7.style).toBe('locked');
    expect(doorCentre(d7)[0]).toBe(15);
    // a size with units: 30 ft × 20 ft on a 5 ft map is 6 × 4
    const r2 = await call('add_room', { map: id, beside: 'r3', side: 'west', size: ['30 ft', '20 ft'] });
    expect(r2.text).toContain('6×4 squares');
    expect(r2.text).toContain('size: 30 ft = 6 squares');
    // nonsense is refused with a reason
    expect((await call('add_room', { map: id, beside: 'r1', side: 'sideways' })).text).toMatch(/side: north, south, east or west/);
    expect((await call('add_room', { map: id, beside: 'r1', side: 'east', rect: [0, 0, 2, 2] })).text).toMatch(/not both/);
  });

  it('add_door on a named wall, beside the corridor mouth that takes its middle', async () => {
    const id = await newMap();
    const r = await call('add_door', { map: id, room: 'r2', wall: 'north', style: 'secret' });
    expect(r.text).toMatch(/^Added secret door d7 on the north wall of room 2 Crossroads \(r2\), 2 squares off its middle \(the middle is taken\), leads outside, at [\d.]+,15 along x, 1 wide\./);
    expect(r.text).toContain('Check: on the north wall of r2.');
    const d = byId(await mapOf(id), 'd7') as Extract<MapObject, { type: 'door' }>;
    expect(d.at[1]).toBe(15);
    expect(d.at[0] + 1 <= 9 || d.at[0] >= 11).toBe(true);
    // the old way still works, and a floating door is reported
    const off = await call('add_door', { map: id, at: [9, 27], along: 'x', width: 1 });
    expect(off.text).toMatch(/Check: WARNING: door d8 is not on a wall: it floats inside r1/);
  });

  it('add_prop by place: a table in the middle, chairs around it, a bar against the north wall, all inside room 2', async () => {
    const id = await newMap();
    const t = await call('add_prop', { map: id, asset: 'table-rect', in: 'r2', place: 'center' });
    expect(t.text).toMatch(/^Added Rectangular Table i1 at \[10, 18\] in the middle of room 2 Crossroads \(r2\)/);
    expect(t.text).toContain('Check: inside r2, doorways clear, no overlaps.');
    const c = await call('add_prop', { map: id, asset: 'chair', place: 'around i1', count: 4 });
    expect(c.text).toMatch(/^Added 4 × Wooden Chair: i2 at \[10, 17\] north of Rectangular Table i1, facing it/);
    expect(c.text).toContain('Check: all 4 fine: inside r2');
    const b = await call('add_prop', { map: id, asset: 'bar-counter', in: 'r2', place: 'north wall' });
    expect(b.text).toContain('against the north wall of room 2 Crossroads (r2), facing south into the room');
    const m = await mapOf(id);
    const props = m.objects.filter((o): o is Extract<MapObject, { type: 'prop' }> => o.type === 'prop');
    expect(props).toHaveLength(6);
    for (const p of props) {
      const pb = propBounds(p);
      expect(pb.x0 >= 6 && pb.x1 <= 14 && pb.y0 >= 15 && pb.y1 <= 21).toBe(true);
      for (const q of props) if (q !== p) expect(area(pb, propBounds(q))).toBe(0);
    }
    // a raw position half outside the room is called out
    const raw = await call('add_prop', { map: id, asset: 'bar-counter', at: [10, 21] });
    expect(raw.text).toMatch(/Check: WARNING: half of i7 \(Bar Counter with Tankards\) is outside r2: it sticks out past the south wall/);
    expect((await call('add_prop', { map: id, asset: 'chair', in: 'r2', place: 'on the ceiling' })).text).toMatch(/place: one of/);
  });

  it('regions: water in all of room 5, a forest along the north edge, a label in a room', async () => {
    const id = await newMap();
    const w = await call('add_terrain', { map: id, asset: 'water-shallow', region: { in: 'r5' } });
    expect(w.text).toContain('12×10 squares at 4,1, all of room 5 Boss chamber (r5)');
    expect(w.text).toContain('Check: covers all of r5.');
    const f = await call('add_props_along', { map: id, asset: 'c-oak-a', region: { edge: 'north' }, seed: 4 });
    expect(f.text).toMatch(/^Added \d+ × props of group oak .* filling a 3-square band just outside the map's north edge/);
    const m = await mapOf(id);
    const trees = m.objects.filter((o): o is Extract<MapObject, { type: 'prop' }> => o.type === 'prop' && o.asset.startsWith('c-oak'));
    expect(trees.length).toBeGreaterThanOrEqual(5);
    for (const t of trees) expect(t.at[1]).toBeLessThan(1);
    const l = await call('add_label', { map: id, text: 'The Pool', region: { in: 'r5' } });
    expect(l.text).toContain('Added label l1 "The Pool" at [10, 6], the middle of all of room 5');
  });

  it('heights with units and a region: a 5 m hill in the south-west of the grass, a dirt path from the east up to it', async () => {
    const id = await newMap('empty', '1.5 m');
    await call('add_terrain', { map: id, asset: 'grass', rect: [0, 0, 30, 20] });
    const h = await call('add_height', { map: id, region: { corner: 'sw', size: 8 }, height: '5 m', edge: 'slope' });
    expect(h.text).toMatch(/^Added height area h1: \+5 m, 8×8 squares at 0,12, the south-west corner of the map/);
    expect(h.text).toContain('Units: height: 5 m = 5 m.');
    expect(h.text).toContain('Check: on the ground.');
    const p = await call('add_terrain', { map: id, asset: 'dirt', region: { between: ['east', 'h1'], width: 2 } });
    expect(p.text).toContain('from the east edge of the map at [30, 16] to height area h1');
    const m = await mapOf(id);
    expect((byId(m, 'h1') as { height: number }).height).toBe(5);
    expect(shapeBounds((byId(m, 't2') as { shape: Parameters<typeof shapeBounds>[0] }).shape)).toEqual({ x0: 4, y0: 15, x1: 30, y1: 17 });
    // on a feet map the same 5 m is 16.4 ft
    const ft = await newMap('empty');
    await call('add_terrain', { map: ft, asset: 'grass', rect: [0, 0, 10, 10] });
    // a plain shape given as the region works too (small models write it that way)
    expect((await call('add_height', { map: ft, region: { rect: [2, 2, 4, 4] }, height: '5 m' })).text).toContain('the area x 2–6, y 2–6');
    expect((byId(await mapOf(ft), 'h1') as { height: number }).height).toBe(16.4);
  });

  it('connect goes round a room in the way, and widths take units', async () => {
    const id = await newMap('empty');
    await call('add_room', { map: id, rect: [0, 0, 4, 4] });
    await call('add_room', { map: id, rect: [16, 0, 4, 4] });
    await call('add_room', { map: id, rect: [7, -2, 6, 8] });
    const c = await call('connect', { map: id, from: 'r1', to: 'r2', width: '10 ft', doors: 'both' });
    expect(c.text).toContain('The direct route ran through r3, so it goes round them instead');
    expect(c.text).toContain('Units: width: 10 ft = 2 squares');
    expect(c.text).toMatch(/\nCheck: all 3 fine/);
    expect((await call('check_map', { map: id })).text).toMatch(/^No problems found/);
  });

  it('check_map lists the problems, describe_map says where north is', async () => {
    const id = await newMap();
    await call('apply_ops', { map: id, ops: [{ op: 'add', object: { id: 'r9', type: 'room', shape: { rect: [13, 25, 4, 4] } } }] });
    const r = await call('check_map', { map: id });
    expect(r.text).toMatch(/^1 problem \(7 rooms/);
    expect(r.text).toMatch(/- r(1|9) touches r(9|1): no wall between them/);
    const d = await call('describe_map', { map: id });
    expect(d.text).toContain('Orientation: north is up (small y)');
    expect(d.text).toContain('[r5]: 12×10 sq (60 ft × 50 ft) at 4,1 (x 4–16, y 1–11; north part of the map)');
    // a made-up field gets the right one named
    const upd = await call('update', { map: id, id: 'r1', set: { position: [5, 6] } });
    expect(upd.isError).toBe(true);
    expect(upd.text).toMatch(/^set: there is no field "position"\. Props, labels and markers sit at \{"at": \[x, y\]\}/);
    // apply_ops says so too, for rooms that merge
    const ops = await call('apply_ops', { map: id, ops: [{ op: 'add', object: { id: 'r10', type: 'room', shape: { rect: [15, 9, 4, 4] } } }] });
    expect(ops.text).toMatch(/^Applied 1 op\. Map is at rev \d+\.\nCheck: WARNING: r10 and r5 overlap/);
  });
});
