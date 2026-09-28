import { describe, expect, it } from 'vitest';
import { applyOps, connectOps, ConnectError, floorArea, nextId, nextLabel, withAttachedDoors, type DelveMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const empty = (): DelveMap => ({ format: 'delve.map', version: 1, id: 'm1', name: 'M', grid: { type: 'square' }, objects: [] });

describe('build helpers', () => {
  it('hands out the next id and room number', () => {
    const map = testMap();
    expect(nextId(map, 'r')).toBe('r7');
    expect(nextId(map, 'd')).toBe('d7');
    expect(nextId(map, 'd', 1)).toBe('d8');
    expect(nextId(map, 'x')).toBe('x1');
    expect(nextLabel(map)).toBe('7');
    expect(nextLabel(empty())).toBe('1');
  });

  it('connects two rooms with a routed corridor and doors at both mouths', () => {
    const { map } = applyOps(empty(), [
      { op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 6] } } },
      { op: 'add', object: { id: 'r2', type: 'room', shape: { rect: [0, 10, 8, 6] } } },
    ]);
    const plan = connectOps(map, 'r1', 'r2', { doors: 'both', doorStyle: 'locked' });
    expect(plan.path).toEqual([
      [3, 6],
      [3, 10],
    ]);
    expect(plan.doorIds).toEqual(['d1', 'd2']);
    const after = applyOps(map, plan.ops).map;
    expect(after.objects.filter((o) => o.type === 'door').map((d) => (d as { at: number[] }).at)).toEqual([
      [2, 6],
      [2, 10],
    ]);
    expect(floorArea(after)).toBe(36 + 48 + 8);
  });

  it('moves doors on a room\'s edges along with the room', () => {
    const map = testMap();
    // entrance hall: d1 (to the corridor) and d5 (outer wall) sit on its edges
    expect(withAttachedDoors(map, ['r1']).sort()).toEqual(['d1', 'd5', 'r1']);
    // boss chamber: d4 (south mouth) and d6 (secret door east)
    expect(withAttachedDoors(map, ['r5']).sort()).toEqual(['d4', 'd6', 'r5']);
    expect(withAttachedDoors(map, ['p1'])).toEqual(['p1']);
  });

  it('explains why it cannot connect', () => {
    const map = testMap();
    expect(() => connectOps(map, 'r1', 'nope')).toThrow(ConnectError);
    expect(() => connectOps(map, 'r1', 'r1')).toThrow(/two different rooms/);
  });
});
