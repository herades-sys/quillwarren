import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DelveMap } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { closesPolygon, deletionSet, doorFromDrag, handleAt, hitAll, hitTest, nextHit, pointInShape, rectFromDrag, resizeBounds, snap, snapPoint } from '../src/edit-logic.ts';

const map = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as DelveMap;

describe('editing logic', () => {
  it('snaps to whole or half squares', () => {
    expect(snap(3.4, 1)).toBe(3);
    expect(snap(3.4, 0.5)).toBe(3.5);
    expect(snapPoint([2.6, -0.2], 1)).toEqual([3, -0]);
  });

  it('picks the smallest, most specific thing under the pointer', () => {
    expect(hitTest(map, [10, 5], 0.1)).toBe('r5'); // boss chamber floor
    expect(hitTest(map, [6.5, 3.5], 0.1)).toBe('p1'); // a pillar inside it
    expect(hitTest(map, [10, 25.1], 0.1)).toBe('d1'); // door across the corridor mouth
    expect(hitTest(map, [10, 23], 0.1)).toBe('c1'); // the corridor itself
    expect(hitTest(map, [30, 30], 0.1)).toBeNull();
  });

  it('tests points against every shape kind', () => {
    expect(pointInShape({ circle: [0, 0, 2] }, [1, 1])).toBe(true);
    expect(pointInShape({ circle: [0, 0, 2] }, [2, 2])).toBe(false);
    expect(pointInShape({ poly: [[0, 0], [4, 0], [0, 4]] }, [1, 1])).toBe(true);
    expect(pointInShape({ poly: [[0, 0], [4, 0], [0, 4]] }, [3, 3])).toBe(false);
  });

  it('finds and drags resize handles', () => {
    const b = { x0: 0, y0: 0, x1: 6, y1: 4 };
    expect(handleAt(b, [6.1, 4.05], 0.3)).toBe('se');
    expect(handleAt(b, [3, 0], 0.3)).toBe('n');
    expect(handleAt(b, [3, 2], 0.3)).toBeNull();
    expect(resizeBounds(b, 'se', [8, 5])).toEqual({ x0: 0, y0: 0, x1: 8, y1: 5 });
    expect(resizeBounds(b, 'w', [9, 0])).toEqual({ x0: 5, y0: 0, x1: 6, y1: 4 }); // can't pass the other edge
  });

  it('turns drags into rooms and doors', () => {
    expect(rectFromDrag([5, 5], [1, 2])).toEqual([1, 2, 4, 3]);
    expect(rectFromDrag([1, 1], [1.5, 4])).toBeNull();
    expect(doorFromDrag([9, 25], [11, 25.4])).toEqual({ at: [9, 25], along: 'x', width: 2 });
    expect(doorFromDrag([4, 19], [4, 17])).toEqual({ at: [4, 17], along: 'y', width: 2 });
    expect(doorFromDrag([4, 19], [4.2, 19.1])).toBeNull();
  });

  it('closes polygons on the first corner', () => {
    expect(closesPolygon([[0, 0], [4, 0], [4, 4]], [0.1, 0], 0.3)).toBe(true);
    expect(closesPolygon([[0, 0], [4, 0]], [0, 0], 0.3)).toBe(false);
  });

  it('takes attached corridors along when deleting rooms', () => {
    expect(deletionSet(map, ['r3']).sort()).toEqual(['c2', 'r3']);
    expect(deletionSet(map, ['r2']).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'r2']);
    expect(deletionSet(map, ['d1'])).toEqual(['d1']);
  });
});

describe('picking with props and terrain', () => {
  const furnished: DelveMap = {
    ...map,
    objects: [
      ...map.objects,
      { id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [7, 25, 6, 6] } },
      { id: 'i1', type: 'prop', asset: 'chest-closed', at: [10.5, 27.5] },
      { id: 'i2', type: 'prop', asset: 'bench', at: [9, 29.5], rotation: 90 },
    ],
  };

  it('lists everything under the pointer, props first, terrain over its room', () => {
    expect(hitAll(furnished, [10.5, 27.5], 0)).toEqual(['i1', 't1', 'r1']);
    expect(hitTest(furnished, [8.6, 30.2], 0)).toBe('i2'); // the turned bench covers x 8.5–9.5, y 28.5–30.5
    expect(hitAll(furnished, [12.5, 25.5], 0)).toEqual(['t1', 'r1']);
  });

  it('puts a GM marker above the prop it sits on', () => {
    const marked: DelveMap = { ...furnished, objects: [...furnished.objects, { id: 'm1', type: 'marker', kind: 'trap', at: [10.5, 27.5], text: 'Needle trap in the lock.' }] };
    expect(hitAll(marked, [10.6, 27.6], 0)).toEqual(['m1', 'i1', 't1', 'r1']);
  });

  it('moves on to the next hit when the selected one is clicked again', () => {
    expect(nextHit(['i1', 't1', 'r1'], 'i1')).toBe('t1');
    expect(nextHit(['i1', 't1', 'r1'], 'r1')).toBe('i1');
    expect(nextHit(['t1'], undefined)).toBe('t1');
    expect(nextHit([], 'x')).toBeNull();
  });
});
