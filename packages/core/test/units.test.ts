// Square sizes in feet or metres: reading a map's unit, checking typed input,
// and converting for the city import.
import { describe, expect, it } from 'vitest';
import { describeMap, fromWatabou, metresPerSquare, parseSquareUnit, SQUARE_SIZES, squareUnit, validateMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('square sizes', () => {
  it('read a map unit, 5 ft when there is none', () => {
    expect(parseSquareUnit('1.5 m')).toEqual({ size: 1.5, name: 'm' });
    expect(parseSquareUnit('10 ft')).toEqual({ size: 10, name: 'ft' });
    expect(parseSquareUnit(undefined)).toEqual({ size: 5, name: 'ft' });
    expect(parseSquareUnit('nonsense')).toEqual({ size: 5, name: 'ft' });
  });

  it('take typed input in feet or metres, in any common spelling', () => {
    expect(squareUnit('1.5 m')).toBe('1.5 m');
    expect(squareUnit('1,5 Meter')).toBe('1.5 m');
    expect(squareUnit('2 metres')).toBe('2 m');
    expect(squareUnit('10ft')).toBe('10 ft');
    expect(squareUnit(' 5 feet ')).toBe('5 ft');
    for (const bad of ['', 'm', '0 m', '-2 ft', '5 parsecs', 3, null, '2000 m']) expect(() => squareUnit(bad)).toThrow(/square size/);
    // every size the pages offer is valid as it is
    for (const u of SQUARE_SIZES) expect(squareUnit(u)).toBe(u);
    expect(SQUARE_SIZES.some((u) => u.endsWith(' m'))).toBe(true);
  });

  it('convert to metres', () => {
    expect(metresPerSquare({ size: 1.5, name: 'm' })).toBe(1.5);
    expect(metresPerSquare({ size: 10, name: 'ft' })).toBeCloseTo(3.048);
  });

  it('show in the map description', () => {
    const map = validateMap({ ...testMap(), grid: { ...testMap().grid, unit: '1.5 m' } });
    const text = describeMap(map);
    expect(text).toContain('1 square = 1.5 m');
    expect(text).toMatch(/\d m\b/);
  });

  it('scale an imported city: 3 m squares make it as big as 10 ft ones, in metres', () => {
    const city = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/watabou/feyvale.json'), 'utf8'));
    const feet = fromWatabou(city, { id: 'map_000000000001', unit: '10 ft' }).map;
    const metres = fromWatabou(city, { id: 'map_000000000002', unit: '3 m' }).map;
    expect(metres.grid.unit).toBe('3 m');
    expect(fromWatabou(city, { id: 'map_000000000003', feetPerSquare: 5 }).map.grid.unit).toBe('5 ft');
    // 10 ft is 3.048 m, so the 3 m map is about 1.6 % bigger in squares
    const span = (m: typeof feet) => {
      const xs = m.objects.flatMap((o) => ('shape' in o && o.shape && 'poly' in o.shape && o.shape.poly ? o.shape.poly.map((p) => p[0]) : []));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(metres) / span(feet)).toBeCloseTo(3.048 / 3, 2);
  });
});
