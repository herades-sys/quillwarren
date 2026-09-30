import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CityImportError, fromWatabou, toDungeonScrawl } from '../src/index.ts';

const feyvale = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/watabou/feyvale.json'), 'utf8'));
const size = (notes: string[]) => (/city is (\d+) × (\d+) squares/.exec(notes.join(' ')) ?? []).slice(1).map(Number);

describe('Watabou city import', () => {
  it('turns a city into houses, walls with towers and gates, terrain and district names', () => {
    const { map, notes } = fromWatabou(feyvale, { id: 'map_feyvale00001', name: 'Feyvale', seed: 7 });
    expect(notes[0]).toMatch(/^1[23]\d buildings, 1 landmark, a wall with 14 towers and 2 gates\.$/);
    expect(map).toMatchObject({ name: 'Feyvale', grid: { unit: '10 ft' }, style: { preset: 'clean' } });
    const rooms = map.objects.filter((o) => o.type === 'room');
    expect(rooms.filter((r) => r.name === 'Tower')).toHaveLength(14);
    // a small gatehouse on each side of both gates
    expect(rooms.filter((r) => r.name === 'Gatehouse')).toHaveLength(4);
    expect(rooms.filter((r) => r.name === 'City wall').length).toBeGreaterThan(10);
    const assets = new Set(map.objects.flatMap((o) => (o.type === 'terrain' ? [o.asset] : [])));
    expect([...assets].sort()).toEqual(['cobblestones', 'dirt', 'flagstones', 'water-deep']);
    const labels = map.objects.flatMap((o) => (o.type === 'label' ? [o] : []));
    expect(labels.map((l) => l.text).sort()).toEqual(['Dusk Walk', 'Greengate', 'The Slums']);
    // north stays up: Greengate lies north of The Slums
    const y = (t: string) => labels.find((l) => l.text === t)!.at[1];
    expect(y('Greengate')).toBeLessThan(y('The Slums'));
    // everything sits inside the cropped map, from 0,0
    const [w = 0, h = 0] = size(notes);
    for (const o of map.objects) if (o.type === 'room' && 'poly' in o.shape) for (const [px, py] of o.shape.poly) expect(px >= 0 && py >= 0 && px <= w && py <= h).toBe(true);
    // houses stay separate, so Dungeon Scrawl gets one outline per house (plus the wall ring)
    expect(toDungeonScrawl(map).data.geometry && Object.values(toDungeonScrawl(map).data.geometry)[0]!.polygons.length).toBeGreaterThan(100);
  });

  it('scales to the chosen feet per square', () => {
    const [w10, h10] = size(fromWatabou(feyvale, { id: 'map_a' }).notes);
    const [w5, h5] = size(fromWatabou(feyvale, { id: 'map_b', feetPerSquare: 5 }).notes);
    expect(Math.abs(w5! - 2 * w10!)).toBeLessThanOrEqual(1);
    expect(Math.abs(h5! - 2 * h10!)).toBeLessThanOrEqual(1);
    expect(fromWatabou(feyvale, { id: 'map_c', feetPerSquare: 5 }).map.grid.unit).toBe('5 ft');
  });

  it('explains files that are not city exports', () => {
    expect(() => fromWatabou({}, { id: 'map_x' })).toThrow(CityImportError);
    expect(() => fromWatabou({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'values', generator: 'vg' }] }, { id: 'map_x' })).toThrow(/only city exports/);
    expect(() => fromWatabou({ type: 'FeatureCollection', features: [] }, { id: 'map_x' })).toThrow(/no buildings/);
  });
});
