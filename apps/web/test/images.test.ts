// Picking uploaded pictures in the editor: ones on top come before the props
// under them; floor ones rank by size with rooms and terrain.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DelveMap, MapObject } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { hitAll, hitTest } from '../src/edit-logic.ts';

const base = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as DelveMap;
const SRC = `${'ab'.repeat(32)}.png`;
const withObjects = (...objects: MapObject[]): DelveMap => ({ ...base, objects: [...base.objects, ...objects] });

describe('picking pictures', () => {
  it('finds a picture on top before the prop under it, and only on the (turned) picture itself', () => {
    const map = withObjects(
      { id: 'i1', type: 'prop', asset: 'chest-closed', at: [2.5, 17.5] },
      { id: 'img1', type: 'image', src: SRC, at: [2, 17], w: 2, h: 1, rotation: 90 },
    );
    expect(hitAll(map, [2.4, 17.4], 0.05)).toEqual(['img1', 'i1', 'r3']);
    expect(hitTest(map, [2.9, 16.6], 0.05)).toBe('r3'); // inside the box it covers, but off the turned picture
  });

  it('ranks floor pictures with the areas: a rug before its room, a backdrop after every room', () => {
    const map = withObjects(
      { id: 'img1', type: 'image', src: SRC, at: [2, 17], w: 2, h: 2, layer: 'floor' },
      { id: 'img2', type: 'image', src: SRC, at: [10, 16], w: 40, h: 40, layer: 'floor' },
    );
    expect(hitAll(map, [2, 17], 0.05)).toEqual(['img1', 'r3', 'img2']);
    expect(hitTest(map, [30, 30], 0.05)).toBe('img2');
  });
});
