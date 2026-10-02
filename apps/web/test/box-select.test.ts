// The Select tool's box selection and "Crop to selection", as pure functions
// (edit-logic.ts): what a box picks, how Shift / Ctrl add to it, what counts as
// empty ground, and what a drag does with a finger.
import type { DelveMap, MapObject } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { boxOf, boxSelect, clickSelection, cropToSelection, groundDrag, hitAll, mergeSelection, pressesGround } from '../src/edit-logic.ts';

// Test 003's entrance: the long corridor (r4), room 11 on top with its archway, an open area over it, a room beside
const objects: MapObject[] = [
  { id: 'r4', type: 'room', shape: { rect: [3, -14, 2, 17] } },
  { id: 'r11', type: 'room', shape: { rect: [3, -15, 2, 1] } },
  { id: 'd1', type: 'door', at: [3, -15], along: 'x', width: 2, style: 'archway' },
  { id: 'o1', type: 'opening', shape: { rect: [3, -17, 2, 2] } },
  { id: 'r5', type: 'room', shape: { rect: [10, -8, 7, 24] } },
  { id: 'i1', type: 'prop', asset: 'barrel', at: [4.5, -5.5] },
  { id: 'm1', type: 'marker', kind: 'trap', at: [4.5, 0.5], text: 'Dart trap' },
];
const map: DelveMap = { format: 'delve.map', version: 1, id: 'm', name: 'Entrance', grid: { type: 'square' }, objects };

describe('box selection', () => {
  it('spans a box from any corner', () => {
    expect(boxOf([5, 2], [1, 4])).toEqual({ x0: 1, y0: 2, x1: 5, y1: 4 });
  });

  it('picks what lies wholly inside the box, a door by its line', () => {
    // around rooms 4 and 11: the door on 11's top edge, the open area above it, and what stands inside
    expect(boxSelect(map, boxOf([2.5, -17.5], [5.5, 3.5]))).toEqual(['r4', 'r11', 'd1', 'o1', 'i1', 'm1']);
    // the box must hold all of a room: cutting through r4 leaves it out
    expect(boxSelect(map, boxOf([2.5, -15.5], [5.5, -10]))).toEqual(['r11', 'd1']);
    // nothing wholly inside
    expect(boxSelect(map, boxOf([6, 0], [9, 2]))).toEqual([]);
  });

  it('can leave things out (GM markers in the players view)', () => {
    expect(boxSelect(map, boxOf([2.5, -17.5], [5.5, 3.5]), (o) => o.type !== 'marker')).not.toContain('m1');
  });

  it('replaces the selection, or with Shift or Ctrl adds to it', () => {
    expect(mergeSelection(['r5'], ['r4', 'r11'], false)).toEqual(['r4', 'r11']);
    expect(mergeSelection(['r5', 'r4'], ['r4', 'r11'], true)).toEqual(['r5', 'r4', 'r11']);
    expect(mergeSelection(['r5'], [], true)).toEqual(['r5']);
  });

  it('clicks: pick one, toggle with Shift or Ctrl, clear on empty ground', () => {
    expect(clickSelection(['r4', 'r11'], 'r5', false)).toEqual(['r5']);
    expect(clickSelection(['r4', 'r11'], 'r11', true)).toEqual(['r4']);
    expect(clickSelection(['r4'], 'r11', true)).toEqual(['r4', 'r11']);
    expect(clickSelection(['r4'], null, false)).toEqual([]);
    expect(clickSelection(['r4'], null, true)).toEqual(['r4']);
  });

  it('counts open ground, and invisible open areas that are not selected, as empty ground', () => {
    expect(pressesGround(map, hitAll(map, [8, -5], 0.1), [])).toBe(true); // between the rooms
    const onOpening = hitAll(map, [4, -16], 0.1);
    expect(onOpening).toEqual(['o1']);
    expect(pressesGround(map, onOpening, [])).toBe(true);
    expect(pressesGround(map, onOpening, ['o1'])).toBe(false); // selected: dragging it moves it
    expect(pressesGround(map, hitAll(map, [4, -10], 0.1), [])).toBe(false); // on room 4
  });

  it('ranks open areas below the rooms they overlap', () => {
    const over: DelveMap = { ...map, objects: [...objects, { id: 'o2', type: 'opening', shape: { rect: [2, -16, 4, 3] } }] };
    expect(hitAll(over, [4, -14.5], 0.1)).toEqual(['r11', 'o2']);
  });

  it('draws a box with the mouse or pen; one finger pans unless Box mode is on', () => {
    expect(groundDrag('mouse', false)).toBe('box');
    expect(groundDrag('pen', false)).toBe('box');
    expect(groundDrag('touch', false)).toBe('pan');
    expect(groundDrag('touch', true)).toBe('box');
  });
});

describe('crop to selection', () => {
  it('frames the selection plus a margin in whole squares', () => {
    expect(cropToSelection(map, ['r4', 'r11'])).toEqual({ x0: 2, y0: -16, x1: 6, y1: 4 });
    expect(cropToSelection(map, ['d1'], 0)).toEqual({ x0: 3, y0: -15, x1: 5, y1: -14 });
    expect(cropToSelection(map, ['i1'], 0.5)).toEqual({ x0: 3, y0: -7, x1: 6, y1: -4 });
    expect(cropToSelection(map, [])).toBeNull();
    expect(cropToSelection(map, ['gone'])).toBeNull();
  });
});
