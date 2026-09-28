import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DelveMap } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { ago, changedIds, countOps, objectBounds, unionBounds, zoomAt } from '../src/logic.ts';

const map = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as DelveMap;
const obj = (id: string) => map.objects.find((o) => o.id === id)!;

describe('viewer logic', () => {
  it('finds what an op batch touched', () => {
    expect(
      changedIds([
        { op: 'add', object: { id: 'r7', type: 'room', shape: { rect: [0, 0, 1, 1] } } },
        { op: 'batch', ops: [{ op: 'move', ids: ['r1', 'd1'], dx: 1, dy: 0 }] },
        { op: 'update', id: 'r1', set: { name: 'x' } },
        { op: 'delete', ids: ['d5'] },
        { op: 'update_map', set: { name: 'y' } },
      ]),
    ).toEqual(['r7', 'r1', 'd1']);
    expect(countOps([{ op: 'batch', ops: [{ op: 'delete', ids: ['a'] }, { op: 'delete', ids: ['b'] }] }])).toBe(2);
  });

  it('knows where every kind of object is', () => {
    expect(objectBounds(obj('r5'), map)).toEqual({ x0: 4, y0: 1, x1: 16, y1: 11 });
    expect(objectBounds(obj('c1'), map)).toEqual({ x0: 9, y0: 21, x1: 11, y1: 25 });
    expect(objectBounds(obj('d5'), map)).toEqual({ x0: 8.7, y0: 30.7, x1: 11.3, y1: 31.3 });
    expect(unionBounds([objectBounds(obj('r1'), map), null, objectBounds(obj('r6'), map)])).toEqual({ x0: 7, y0: 3, x1: 20, y1: 31 });
  });

  it('zooms around the pointer and respects limits', () => {
    const vb = { x0: 0, y0: 0, x1: 20, y1: 10 };
    expect(zoomAt(vb, [10, 5], 0.5, 1, 100)).toEqual({ x0: 5, y0: 2.5, x1: 15, y1: 7.5 });
    const tiny = zoomAt(vb, [0, 0], 0.01, 4, 100); // can't go below 4 squares wide
    expect(tiny.x1 - tiny.x0).toBeCloseTo(4);
  });

  it('says how long ago', () => {
    expect(ago(1000)).toBe('just now');
    expect(ago(12_000)).toBe('12 s ago');
    expect(ago(180_000)).toBe('3 min ago');
  });
});
