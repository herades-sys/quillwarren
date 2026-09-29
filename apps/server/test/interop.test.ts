import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { floorArea, toDungeonScrawl, validateMap, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { unzipEntry, zipOne, ZipError } from '../src/zip.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const dsFile = readFileSync(resolve(import.meta.dirname, '../../../fixtures/dungeonscrawl/test-map-4p.ds'));

describe('zip', () => {
  it('writes a stored entry and reads it back', () => {
    const data = Buffer.from('{"hello":"dungeon"}');
    const z = zipOne('map', data);
    expect(z.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(unzipEntry(z, 'map').equals(data)).toBe(true);
  });

  it('exports every node with the same fields Dungeon Scrawl writes', () => {
    // Dungeon Scrawl crashes on a missing field (it did on GRID.roughOptions), so match its node shapes exactly.
    const fixture = JSON.parse(unzipEntry(dsFile, 'map').toString());
    const map = validateMap(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')));
    const paths = (v: unknown, p = ''): string[] =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => [p + k, ...paths(x, `${p}${k}.`)]) : [];
    const shapes = (doc: { state: { document: { nodes: Record<string, Record<string, unknown>> } } }) => {
      const out: Record<string, string[]> = {};
      for (const n of Object.values(doc.state.document.nodes)) {
        const t = String(n.type);
        out[t] = [...new Set([...(out[t] ?? []), ...paths(n)])].sort();
      }
      return out;
    };
    expect(shapes(toDungeonScrawl(map))).toEqual(shapes(fixture));
  });

  it('reads the real Dungeon Scrawl file and explains bad input', () => {
    expect(JSON.parse(unzipEntry(dsFile, 'map').toString()).version).toBe(1);
    expect(() => unzipEntry(Buffer.from('not a zip at all, sorry'), 'map')).toThrow(ZipError);
    expect(() => unzipEntry(zipOne('other', Buffer.from('x')), 'map')).toThrow(/no "map" entry/);
  });
});

describe('Dungeon Scrawl over the API', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const importDs = (body: Buffer, headers: Record<string, string> = auth, name = 'Old map') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/maps/import.ds?name=${encodeURIComponent(name)}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: body,
    });

  it('imports a .ds file as a new map', async () => {
    const res = await importDs(dsFile);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; map: DelveMap; notes: string[] };
    expect(body.map.name).toBe('Old map');
    expect(floorArea(body.map)).toBe(296);
    expect(body.map.objects.filter((o) => o.type === 'door')).toHaveLength(5);
    expect(body.notes.join(' ')).toContain('1 area');
    expect((await app.inject({ url: `/api/v1/maps/${body.id}` })).statusCode).toBe(200);
  });

  it('exports a map as a .ds file that imports back the same', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Crypt of Tests' } });
    const { id } = created.json();
    const res = await app.inject({ url: `/api/v1/maps/${id}/export.ds` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="crypt-of-tests.ds"');
    const back = (await importDs(res.rawPayload)).json() as { map: DelveMap };
    expect(floorArea(back.map)).toBe(296);
    const players = await app.inject({ url: `/api/v1/maps/${id}/export.ds?view=players` });
    expect(players.headers['content-disposition']).toContain('crypt-of-tests_players.ds');
  });

  it('refuses junk and anonymous uploads', async () => {
    expect((await importDs(Buffer.from('PK nope'))).statusCode).toBe(400);
    expect((await importDs(zipOne('map', Buffer.from('{not json')))).json().error).toContain('not valid JSON');
    expect((await importDs(zipOne('map', Buffer.from('{"a":1}')))).json().error).toContain('not a Dungeon Scrawl map');
    expect((await importDs(dsFile, {})).statusCode).toBe(401);
  });
});

describe('Watabou city import over the API', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  const city = readFileSync(resolve(import.meta.dirname, '../../../fixtures/watabou/feyvale.json'), 'utf8');
  const post = (q: string, body: string, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: `/api/v1/maps/import.city${q}`, headers: { ...headers, 'content-type': 'application/json' }, payload: body });

  it('imports a city as a new map at the chosen scale', async () => {
    const res = await post('?name=Feyvale&feet=5', city);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; map: DelveMap; notes: string[] };
    expect(body.map).toMatchObject({ name: 'Feyvale', grid: { unit: '5 ft' } });
    expect(body.notes.join(' ')).toContain('14 towers');
    expect((await app.inject({ url: `/api/v1/maps/${body.id}/export.ds` })).statusCode).toBe(200);
  });

  it('refuses bad input and anonymous uploads', async () => {
    expect((await post('?feet=0', city)).statusCode).toBe(400);
    expect((await post('', '{"type":"nope"}')).json().error).toContain('not a Watabou city export');
    expect((await post('', '{not json')).statusCode).toBe(400);
    expect((await post('', city, {})).statusCode).toBe(401);
  });
});
