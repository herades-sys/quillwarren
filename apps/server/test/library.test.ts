// The start page's library: maps on shelves by category, the storeys of one
// place (the Ashen Tower's three floors) as one row that opens, and filing a
// whole place under a category with one request.
import { notesOnly } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { cleanCategory, libraryShelves } from '../src/library.ts';
import type { MapSummary } from '../src/store.ts';

const TOKEN = 'library-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
beforeEach(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const make = async (name: string): Promise<string> =>
  ((await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { name } })).json() as { id: string }).id;
const addStorey = async (id: string, name: string, position: 'above' | 'below' = 'above'): Promise<string> =>
  ((await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/levels`, headers: bearer, payload: { name, position } })).json() as { id: string }).id;
const file = (id: string, category: unknown, headers: Record<string, string> = bearer) =>
  app.inject({ method: 'PUT', url: `/api/v1/maps/${id}/category`, headers, payload: { category } });
const list = async (): Promise<MapSummary[]> => (await app.inject({ url: '/api/v1/maps' })).json().maps;

/** The Ashen Tower: cellar, ground floor and wizard's floor. */
async function ashenTower() {
  const ground = await make('The Ashen Tower');
  const wizard = await addStorey(ground, "Wizard's floor");
  const cellar = await addStorey(ground, 'Cellar', 'below');
  return { ground, wizard, cellar };
}

describe('categories', () => {
  it('are cleaned as typed, and blank means none', () => {
    expect(cleanCategory('  Dungeons   of  Doom ')).toBe('Dungeons of Doom');
    expect(cleanCategory('')).toBeNull();
    expect(cleanCategory('   ')).toBeNull();
    expect(cleanCategory(null)).toBeNull();
    expect(() => cleanCategory('x'.repeat(61))).toThrow(/60/);
    expect(() => cleanCategory(5)).toThrow();
  });

  it('file a whole place at once, and new storeys join its shelf', async () => {
    const t = await ashenTower();
    const res = await file(t.wizard, ' Towers ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ category: 'Towers', changed: expect.arrayContaining([t.ground, t.wizard, t.cellar]) });
    for (const m of (await list()).filter((m) => m.level)) expect(m.category).toBe('Towers');
    const attic = await addStorey(t.ground, 'Attic');
    expect((await list()).find((m) => m.id === attic)?.category).toBe('Towers');
    // the same again changes nothing; null takes the place off its shelf
    expect((await file(t.ground, 'Towers')).json().changed).toEqual([]);
    expect((await file(t.ground, null)).json().changed).toHaveLength(4);
    expect((await list()).some((m) => m.category)).toBe(false);
  });

  it('need the editor login or the API token, and valid input', async () => {
    const id = await make('Crypt');
    expect((await file(id, 'Dungeons', {})).statusCode).toBe(401);
    expect((await file(id, 'x'.repeat(61))).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/maps/${id}/category`, headers: bearer, payload: {} })).statusCode).toBe(400);
    expect((await file('map_000000000000', 'Dungeons')).statusCode).toBe(404);
  });

  it('redraw nothing: a category-only change counts like a notes-only one', () => {
    expect(notesOnly([{ op: 'update_map', set: { category: 'Cities' } }])).toBe(true);
    expect(notesOnly([{ op: 'update_map', unset: ['category'] }])).toBe(true);
    expect(notesOnly([{ op: 'update_map', set: { category: 'Cities', name: 'X' } }])).toBe(false);
  });
});

describe('renaming', () => {
  const rename = (id: string, payload: object, headers: Record<string, string> = bearer) =>
    app.inject({ method: 'PUT', url: `/api/v1/maps/${id}/name`, headers, payload });

  it('renames a whole place at once, or one storey', async () => {
    const t = await ashenTower();
    const res = await rename(t.cellar, { name: '  The   Burnt Tower ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'The Burnt Tower', changed: expect.arrayContaining([t.ground, t.wizard, t.cellar]) });
    for (const m of (await list()).filter((m) => m.level)) expect(m.name).toBe('The Burnt Tower');
    const storey = await rename(t.cellar, { storey: 'Dungeon' });
    expect(storey.json()).toEqual({ storey: 'Dungeon', changed: [t.cellar] });
    const names = (await list()).filter((m) => m.level).map((m) => m.level!.name).sort();
    expect(names).toEqual(['Dungeon', 'Ground floor', "Wizard's floor"]);
    // a single map, and the same name again
    const crypt = await make('Crypt');
    expect((await rename(crypt, { name: 'Crypt of the Lich' })).json().changed).toEqual([crypt]);
    expect((await rename(crypt, { name: 'Crypt of the Lich' })).json().changed).toEqual([]);
  });

  it('checks the input and the login', async () => {
    const crypt = await make('Crypt');
    expect((await rename(crypt, { name: 'X' }, {})).statusCode).toBe(401);
    expect((await rename(crypt, { name: '   ' })).statusCode).toBe(400);
    expect((await rename(crypt, { name: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await rename(crypt, {})).statusCode).toBe(400);
    expect((await rename(crypt, { storey: 'Cellar' })).statusCode).toBe(400); // not a storey
    expect((await rename('map_000000000000', { name: 'Gone' })).statusCode).toBe(404);
  });

  it('is offered in each map’s menu on the start page', async () => {
    const open = buildApp({ version: 'test', started: 'now' }, { openEdit: true });
    await open.ready();
    try {
      const ground = ((await open.inject({ method: 'POST', url: '/api/v1/maps', payload: { name: 'The Ashen Tower' } })).json() as { id: string }).id;
      await open.inject({ method: 'POST', url: `/api/v1/maps/${ground}/levels`, payload: { name: 'Cellar', position: 'below' } });
      await open.inject({ method: 'POST', url: '/api/v1/maps', payload: { name: 'Crypt' } });
      const page = (await open.inject({ url: '/' })).body;
      expect(page).toContain('data-rename-kind="storey" data-current="Cellar"');
      expect(page).toContain('data-rename-kind="place" data-current="The Ashen Tower"');
      expect(page).toContain('data-rename-kind="place" data-current="Crypt"');
      expect(page).toContain("'/name'");
    } finally {
      await open.close();
    }
  });
});

describe('the library', () => {
  it('puts places on shelves A–Z, the unfiled last, and keeps a place’s storeys together, top first', async () => {
    const t = await ashenTower();
    const crypt = await make('Crypt');
    const city = await make('Feyvale');
    const loose = await make('Sketch');
    await file(t.ground, 'Towers');
    await file(crypt, 'dungeons');
    await file(city, 'Cities');
    const shelves = libraryShelves(await list());
    expect(shelves.map((s) => s.category)).toEqual(['Cities', 'dungeons', 'Towers', null]);
    const tower = shelves.find((s) => s.category === 'Towers')!.places;
    expect(tower).toHaveLength(1);
    expect(tower[0]!.name).toBe('The Ashen Tower');
    expect(tower[0]!.storeys.map((s) => s.level?.name)).toEqual(["Wizard's floor", 'Ground floor', 'Cellar']);
    expect(shelves.at(-1)!.places.map((p) => p.storeys[0]!.id)).toEqual([loose]);
    // "DUNGEONS" typed later takes the shelf's spelling, so it lands on the same shelf
    const other = await make('Barrow');
    expect((await file(other, 'DUNGEONS')).json().category).toBe('dungeons');
    const dungeons = libraryShelves(await list()).filter((s) => s.category?.toLowerCase() === 'dungeons');
    expect(dungeons).toHaveLength(1);
    expect(dungeons[0]!.category).toBe('dungeons');
    expect(dungeons[0]!.places).toHaveLength(2);
    // a place alone on its shelf can change the spelling
    expect((await file(t.cellar, 'TOWERS')).json().category).toBe('TOWERS');
  });

  it('shows a place as one row that opens to its storeys, and lets editors type a category', async () => {
    const t = await ashenTower();
    await file(t.ground, 'Towers');
    await make('Crypt');
    const page = (await app.inject({ url: '/', headers: bearer })).body;
    expect(page).toContain('class="shelf"');
    expect(page).toMatch(/<h3 class="shelf-head">.*Towers<\/button> <span class="count">3 maps<\/span>/);
    expect(page).toContain('No category');
    // one card for the tower, its storeys folded away in it
    expect(page.match(/ place group"/g)).toHaveLength(1);
    expect(page).toContain('<span class="tag storeys">3 storeys</span>');
    expect(page).toMatch(/<div class="place-storeys" id="place-[^"]+" hidden>/);
    for (const id of [t.ground, t.wizard, t.cellar]) expect(page).toContain(`<code>${id}</code>`);
    expect(page).toContain(`href="/maps/${t.wizard}/3d"`); // the stack, from the top storey
    // read-only visitors see the category, editors get the field (with suggestions)
    expect(page).not.toContain('class="cat-input"');
    expect(page).toContain('<span class="tag">Towers</span>');
  });

  it('gives editors a category field per place, with the categories in use as suggestions', async () => {
    const open = buildApp({ version: 'test', started: 'now' }, { openEdit: true });
    await open.ready();
    try {
      const make2 = async (name: string) => ((await open.inject({ method: 'POST', url: '/api/v1/maps', payload: { name } })).json() as { id: string }).id;
      const ground = await make2('The Ashen Tower');
      await open.inject({ method: 'POST', url: `/api/v1/maps/${ground}/levels`, payload: { name: 'Cellar', position: 'below' } });
      await open.inject({ method: 'PUT', url: `/api/v1/maps/${ground}/category`, payload: { category: 'Towers' } });
      await make2('Crypt');
      const page = (await open.inject({ url: '/' })).body;
      // one field for the tower (filing both storeys) and one for the crypt
      expect(page.match(/class="cat-input"/g)).toHaveLength(2);
      expect(page).toContain('aria-label="Category of The Ashen Tower (all 2 storeys)"');
      expect(page).toContain('<datalist id="map-categories"><option value="Towers"></option></datalist>');
      expect(page).toContain("'/category'");
    } finally {
      await open.close();
    }
  });
});
