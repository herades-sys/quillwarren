// The frame of a picture fitted to its content (the library's map cards):
// everything the view draws counts, the page size doesn't, nothing is cut.
import { describe, expect, it } from 'vitest';
import { contentFrame, FIT_PADDING, hatchReach, resolveStyle, type DelveMap, type MapObject } from '../src/index.ts';

const mapOf = (objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id: 'm1',
  name: 'Cards',
  grid: { type: 'square' },
  seed: 7,
  roughness: 1,
  style: { preset: 'classic-hatching' },
  objects,
  ...extra,
});
const room = (id: string, rect: [number, number, number, number], roughness?: number): MapObject => ({ id, type: 'room', shape: { rect }, ...(roughness ? { roughness } : {}) });
const reachOf = (map: DelveMap) => hatchReach(resolveStyle(map));
const quarter = (v: number) => Number.isInteger(v * 4);

describe('contentFrame', () => {
  it('fits the rooms and their hatching, not the page', () => {
    const map = mapOf([room('r1', [40, 40, 6, 4])], { grid: { type: 'square', bounds: [0, 0, 100, 100] } });
    const reach = reachOf(map);
    expect(reach).toBeGreaterThan(0);
    const f = contentFrame(map, { reach })!;
    expect(f.x0).toBeLessThanOrEqual(40 - reach - FIT_PADDING);
    expect(f.x0).toBeGreaterThan(40 - reach - FIT_PADDING - 0.25);
    expect(f.x1).toBeGreaterThanOrEqual(46 + reach + FIT_PADDING);
    expect(f.x1).toBeLessThan(46 + reach + FIT_PADDING + 0.25);
    expect(f.y1 - f.y0).toBeLessThan(4 + 2 * (reach + FIT_PADDING) + 0.5); // nowhere near the 100-square page
    expect([f.x0, f.y0, f.x1, f.y1].every(quarter)).toBe(true);
  });

  it('keeps labels, markers, stairs and notes on the map that lie outside the rooms', () => {
    const base = [room('r1', [0, 0, 4, 4])];
    const plain = contentFrame(mapOf(base), { reach: 1 })!;
    const label: MapObject = { id: 'l1', type: 'label', text: 'The old well', at: [20, 2] };
    const marker: MapObject = { id: 'k1', type: 'marker', kind: 'trap', at: [2, -9], text: '' };
    const stairs: MapObject = { id: 's1', type: 'stairs', shape: { rect: [-8, 1, 2, 1] } } as MapObject;
    const f = contentFrame(mapOf([...base, label, marker, stairs]), { reach: 1 })!;
    expect(f.x1).toBeGreaterThan(20 + 1.5); // the label's text runs right of its centre
    expect(f.y0).toBeLessThanOrEqual(-9.4);
    expect(f.x0).toBeLessThanOrEqual(-8);
    expect(f.x1 - f.x0).toBeGreaterThan(plain.x1 - plain.x0);
  });

  it('counts notes only when they are on the map, and leaves GM-only things out of the players view', () => {
    const base = [room('r1', [0, 0, 4, 4])];
    const handoutOnly: MapObject = { id: 'n1', type: 'inscription', text: 'Here be rats', at: [30, 2] };
    expect(contentFrame(mapOf([...base, handoutOnly]))).toEqual(contentFrame(mapOf(base)));
    expect(contentFrame(mapOf([...base, { ...handoutOnly, onMap: true } as MapObject]))!.x1).toBeGreaterThan(28);
    const marker: MapObject = { id: 'k1', type: 'marker', kind: 'discover', at: [2, 20], text: 'a key' };
    const secret: MapObject = { id: 'i1', type: 'prop', asset: 'chest-closed', at: [2, -15], gmOnly: true } as MapObject;
    const map = mapOf([...base, marker, secret]);
    expect(contentFrame(map, { view: 'gm' })!.y1).toBeGreaterThan(20);
    expect(contentFrame(map, { view: 'gm' })!.y0).toBeLessThan(-14);
    expect(contentFrame(map, { view: 'players' })).toEqual(contentFrame(mapOf(base)));
  });

  it('allows for rough walls', () => {
    const smooth = contentFrame(mapOf([room('r1', [0, 0, 8, 8])]), { reach: 1 })!;
    const cave = contentFrame(mapOf([room('r1', [0, 0, 8, 8], 10)]), { reach: 1 })!;
    expect(cave.x1 - cave.x0).toBeGreaterThan(smooth.x1 - smooth.x0 + 1.5);
  });

  it('is null for a map with nothing drawn', () => {
    expect(contentFrame(mapOf([]))).toBeNull();
    expect(contentFrame(mapOf([{ id: 'n1', type: 'inscription', text: 'Only on the handout', at: [3, 3] }]))).toBeNull();
  });

  it('keeps very wide and very tall maps whole, shape and all', () => {
    const wide = contentFrame(mapOf([room('r1', [0, 0, 120, 3])]), { reach: 1 })!;
    expect(wide.x1 - wide.x0).toBeGreaterThanOrEqual(122.5);
    expect(wide.y1 - wide.y0).toBeLessThan(6);
    const tall = contentFrame(mapOf([room('r1', [0, 0, 2, 90])]), { reach: 1 })!;
    expect(tall.y1 - tall.y0).toBeGreaterThanOrEqual(92.5);
    expect(tall.x1 - tall.x0).toBeLessThan(5);
  });
});
