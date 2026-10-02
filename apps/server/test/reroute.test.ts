// Corridors between rooms that aren't rectangles over MCP: connect routes to
// the real outlines and puts doors in the walls it meets, reroute redoes older
// corridors; a door connect turned into a hexagon's wall blocks sight at the
// table and stands in the 3D scene.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { applyOps, connectOps, corridorRoute, doorSegment, isTurned, roomsById, shapeFromBox, type DelveMap, type Door } from '@delve/core';
import { blockersOf, pointIn, visibilityPolygon } from '@delve/table';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { objectLine } from '../src/chat/prompt.ts';
import { delveGeometry } from '../src/table/scene3d.ts';
import { pageSightData } from '../src/table/vision.ts';

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

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  id = /id (map_[0-9a-f]+)/.exec((await call('create_map', { name: 'Hex and octagon' })).text)![1]!;
  await call('add_room', { map: id, preset: { kind: 'hexagon', box: [0, 0, 8, 8] } });
  await call('add_room', { map: id, preset: { kind: 'octagon', box: [13, 13, 10, 10] } });
  await call('add_room', { map: id, preset: { kind: 'octagon', box: [26, 0, 8, 8] } });
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('corridors to odd shapes over MCP', () => {
  it('connects to the real outline, with doors turned in the slanted walls', async () => {
    const res = await call('connect', { map: id, from: 'r1', to: 'r2', doors: 'both' });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/squares long, path/);
    const map = await getMap();
    const c = map.objects.find((o) => o.id === 'c1')!;
    expect(c).toMatchObject({ type: 'corridor', route: 'outline' });
    const doors = map.objects.filter((o): o is Door => o.type === 'door');
    expect(doors.some(isTurned)).toBe(true);
    // the chat's object list says how a turned door runs
    expect(objectLine(doors.find(isTurned)!)).toMatch(/angle -?\d+(\.\d+)?°/);
    const png = await fetch(`${base}/api/v1/maps/${id}/render.png?ppg=20`);
    expect(png.status).toBe(200);
  });

  it('reroutes an older corridor in one undo step, and says when there is nothing to do', async () => {
    await call('apply_ops', { map: id, ops: [{ op: 'add', object: { id: 'c9', type: 'corridor', from: 'r1', to: 'r3', width: 2 } }] });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('reroute');
    const res = await call('reroute', { map: id, ids: ['c9', 'c42'] });
    expect(res.text).toContain('Re-routed c9 (r1 → r3)');
    expect(res.text).toContain('Skipped c42: no corridor with id "c42"');
    expect((await getMap()).objects.find((o) => o.id === 'c9')).toMatchObject({ route: 'outline' });
    expect((await call('reroute', { map: id })).text).toContain('Nothing to change: c1, c9 already route to the room outlines');
    await call('undo', { map: id });
    const back = (await getMap()).objects.find((o) => o.id === 'c9')!;
    expect('route' in back).toBe(false);
  });
});

describe('a door connect turned into a hexagon wall, at the table and in 3D', () => {
  // a hexagon and an octagon diagonally apart: the corridor leaves the hexagon's slanted lower-right side
  const built = (): { map: DelveMap; door: Door } => {
    const map: DelveMap = {
      format: 'delve.map',
      version: 1,
      id: 'm_hex',
      name: 'Hex',
      grid: { type: 'square' },
      objects: [
        { id: 'r1', type: 'room', shape: shapeFromBox('hexagon', [0, 0, 8, 8]) },
        { id: 'r2', type: 'room', shape: shapeFromBox('octagon', [13, 13, 10, 10]) },
      ],
    };
    const plan = connectOps(map, 'r1', 'r2', { doors: 'from' });
    const after = applyOps(map, plan.ops).map;
    return { map: after, door: after.objects.find((o): o is Door => o.type === 'door')! };
  };

  it('is turned in the slanted wall and shuts the corridor off from the room for line of sight', () => {
    const { map, door } = built();
    expect(isTurned(door)).toBe(true);
    const { walls, doors } = pageSightData(map);
    const d = doors.find((x) => x.id === door.id)!;
    const [a, b] = doorSegment(door);
    expect(d.a[0]).toBeCloseTo(a[0], 9);
    expect(d.b[1]).toBeCloseTo(b[1], 9);
    // from the middle of the hexagon: a spot two squares down the corridor is hidden while the door is shut
    const route = corridorRoute(map.objects.find((o) => o.type === 'corridor') as never, roomsById(map))!;
    const [p0, p1] = route.path;
    const len = Math.hypot(p1![0] - p0![0], p1![1] - p0![1]);
    const beyond: [number, number] = [p0![0] + ((p1![0] - p0![0]) / len) * 2.5, p0![1] + ((p1![1] - p0![1]) / len) * 2.5];
    const box = { x0: -5, y0: -5, x1: 30, y1: 30 };
    const sees = (doorState: Record<string, boolean>) => pointIn([{ outer: visibilityPolygon([4, 4], blockersOf({ walls, doors, doorState }), box), holes: [] }], beyond);
    expect(sees({})).toBe(false);
    expect(sees({ [door.id]: true })).toBe(true);
  });

  it('stands the door frame in the slanted wall in the 3D scene', () => {
    const { map, door } = built();
    const g = delveGeometry(map, 'gm', 'all');
    expect(g.doors.length).toBe(1);
    const [a, b] = doorSegment(door);
    expect(g.doors[0]!.a[0]).toBeCloseTo(a[0], 2);
    expect(g.doors[0]!.b[1]).toBeCloseTo(b[1], 2);
  });
});
