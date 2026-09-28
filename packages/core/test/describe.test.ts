import { describe, expect, it } from 'vitest';
import { describeMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

describe('describeMap', () => {
  const text = describeMap(testMap());

  it('summarises counts and units', () => {
    expect(text.split('\n')[0]).toBe(
      'Test dungeon (4 players) (map_test4p): 6 rooms, 5 corridors, 6 doors, 4 cutouts. 1 square = 5 ft.',
    );
  });

  it('lists rooms with size in squares and feet', () => {
    expect(text).toContain('  1 Entrance hall [r1]: 6×6 sq (30 ft × 30 ft) at 7,25');
    expect(text).toContain('  5 Boss chamber [r5]: 12×10 sq (60 ft × 50 ft) at 4,1');
  });

  it('lists connections with their doors', () => {
    expect(text).toContain('  c1: 1 Entrance hall ↔ 2 Crossroads, 2 sq wide, 4 sq (20 ft) long; doors d1 (normal)');
    expect(text).toContain('  c5: 5 Boss chamber ↔ 6 Vault, 1 sq wide, 1 sq (5 ft) long; doors d6 (secret)');
  });

  it('says which door leads outside', () => {
    expect(text).toContain('  d5 (normal): 1 Entrance hall, leads outside');
  });

  it('groups cutouts by room', () => {
    expect(text).toContain('Cutouts: p1 pillar, p2 pillar, p3 pillar, p4 pillar in 5 Boss chamber');
  });
});
