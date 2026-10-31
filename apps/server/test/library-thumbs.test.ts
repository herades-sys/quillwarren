// The library's map cards: pictures fitted to what is drawn (render.svg
// fit=content), and a note instead of a blank grid for an empty map.
import { contentFrame, hatchReach, resolveStyle, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const TOKEN = 'thumbs-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
beforeEach(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const make = async (payload: object): Promise<string> => ((await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload })).json() as { id: string }).id;
const getMap = async (id: string): Promise<DelveMap> => ((await app.inject({ url: `/api/v1/maps/${id}` })).json() as { map: DelveMap }).map;
const svg = async (id: string, q: string) => app.inject({ url: `/api/v1/maps/${id}/render.svg?${q}` });
const viewBox = (body: string): number[] => /viewBox="([^"]+)"/.exec(body)![1]!.split(' ').map(Number);
const asBox = (f: { x0: number; y0: number; x1: number; y1: number }) => [f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0];

describe('render.svg fit=content', () => {
  it('frames what is drawn, with the style’s hatching round the rooms', async () => {
    const id = await make({ name: 'Crypt', template: 'test-dungeon' });
    const map = await getMap(id);
    const fitted = await svg(id, 'view=gm&fit=content');
    expect(fitted.statusCode).toBe(200);
    expect(viewBox(fitted.body)).toEqual(asBox(contentFrame(map, { reach: hatchReach(resolveStyle(map)) })!));
    expect(viewBox(fitted.body)).not.toEqual(viewBox((await svg(id, 'view=gm')).body));
    // another style, another reach
    const clean = { ...map, style: { ...map.style, preset: 'clean' } };
    expect(viewBox((await svg(id, 'view=gm&fit=content&style=clean')).body)).toEqual(asBox(contentFrame(clean, { reach: hatchReach(resolveStyle(clean)) })!));
  });

  it('keeps the usual picture for an empty map, gives way to frame, and refuses other values', async () => {
    const blank = await make({ name: 'Blank', template: 'empty' });
    expect(viewBox((await svg(blank, 'view=gm&fit=content')).body)).toEqual(viewBox((await svg(blank, 'view=gm')).body));
    const id = await make({ name: 'Crypt', template: 'test-dungeon' });
    expect(viewBox((await svg(id, 'frame=0,0,4,4&fit=content')).body)).toEqual([0, 0, 4, 4]);
    const bad = await svg(id, 'fit=page');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('fit must be content');
  });
});

describe('library cards', () => {
  it('show the fitted picture, and a note for a map with nothing on it', async () => {
    const crypt = await make({ name: 'Crypt', template: 'test-dungeon' });
    const blank = await make({ name: 'Blank', template: 'empty' });
    const page = (await app.inject({ url: '/', headers: bearer })).body;
    expect(page).toMatch(new RegExp(`<img src="/api/v1/maps/${crypt}/render\\.svg\\?view=gm&fit=content&rev=\\d+" alt="" loading="lazy">`));
    expect(page).not.toContain(`<img src="/api/v1/maps/${blank}/render.svg`); // its menu still offers the downloads
    expect(page).toContain(`<a class="map-card-thumb-link" href="/maps/${blank}" tabindex="-1" aria-hidden="true"><span class="map-card-empty">Empty map</span></a>`);
  });
});
