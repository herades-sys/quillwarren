// Squares in feet or metres over HTTP and MCP: new maps, the city import, set_map,
// and the start page's choices.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const TOKEN = 'units-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const city = readFileSync(resolve(import.meta.dirname, '../../../fixtures/watabou/feyvale.json'), 'utf8');

let app: FastifyInstance;
beforeEach(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('square size in metres', () => {
  it('can be chosen for a new map, and defaults to 5 ft', async () => {
    const make = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload });
    expect((await make({ name: 'Metric', unit: '1.5 m' })).json().map.grid.unit).toBe('1.5 m');
    expect((await make({ name: 'Metric', unit: '2 metres' })).json().map.grid.unit).toBe('2 m');
    expect((await make({ name: 'Plain' })).json().map.grid.unit).toBe('5 ft');
    expect((await make({ name: 'Sample', template: 'test-dungeon', unit: '1.5 m' })).json().map.grid.unit).toBe('1.5 m');
    expect((await make({ name: 'Bad', unit: '5 parsecs' })).statusCode).toBe(400);
  });

  it('can scale a city import, which keeps taking feet as before', async () => {
    const imp = (q: string) =>
      app.inject({ method: 'POST', url: `/api/v1/maps/import.city${q}`, headers: { ...bearer, 'content-type': 'application/json' }, payload: city });
    const metric = await imp('?unit=3%20m');
    expect(metric.statusCode).toBe(201);
    expect(metric.json().map.grid.unit).toBe('3 m');
    expect(metric.json().notes.join(' ')).toContain('1 square = 3 m');
    expect((await imp('?feet=20')).json().map.grid.unit).toBe('20 ft');
    expect((await imp('?unit=lots')).statusCode).toBe(400);
  });

  it('is offered on the start page for new maps and for the city import', async () => {
    const open = buildApp({ version: 'test', started: 'now' }, { openEdit: true });
    await open.ready();
    try {
      const page = (await open.inject({ url: '/' })).body;
      expect(page).toContain('<select name="unit"');
      expect(page).toContain('<option value="5 ft" selected>5 ft</option>');
      expect(page).toContain('<option value="1.5 m">1.5 m</option>');
      expect(page).toContain('<option value="1.5 m">1.5 m (true scale)</option>');
      expect(page).toContain("'/api/v1/maps/import.city?unit='");
      // the form posts it along
      const res = await open.inject({ method: 'POST', url: '/maps/new', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=Metric&style=classic-hatching&template=empty&unit=2+m' });
      expect(res.statusCode).toBe(303);
      const id = String(res.headers.location).split('/maps/')[1]!.split('?')[0]!;
      expect((await open.inject({ url: `/api/v1/maps/${id}` })).json().map.grid.unit).toBe('2 m');
    } finally {
      await open.close();
    }
  });
});
