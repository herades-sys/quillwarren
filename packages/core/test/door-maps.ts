// Test maps for doors: one with only the old axis-aligned doors (no `angle`),
// whose renders and exports must stay byte for byte what they were before doors
// could turn, and helpers for maps with turned doors.
import type { DelveMap, MapObject } from '../src/index.ts';

const base = (id: string, objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id,
  name: id,
  grid: { type: 'square' },
  seed: 7,
  objects,
  ...extra,
});

/**
 * Every door style the old way: on straight walls, across a hand-drawn
 * corridor's mouths, on the outer edge (an outer archway), plus axis doors
 * sitting on a circle's top and an octagon's slanted wall, which cut no gap.
 * No auto-routed corridors, so routing changes elsewhere can't move anything.
 */
export function axisDoorMap(extra: Partial<DelveMap> = {}): DelveMap {
  return base(
    'axis-doors',
    [
      { id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] }, label: '1' },
      { id: 'r2', type: 'room', shape: { rect: [10, 0, 6, 6] }, label: '2' },
      { id: 'c1', type: 'corridor', width: 2, path: [[8, 3], [10, 3]] },
      { id: 'r3', type: 'room', shape: { circle: [4, 12, 3] }, label: '3' },
      { id: 'r4', type: 'room', shape: { poly: [[12, 8], [16, 8], [19, 11], [19, 15], [16, 18], [12, 18], [9, 15], [9, 11]] }, label: '4' },
      { id: 'd1', type: 'door', at: [8, 2], along: 'y', width: 2, style: 'normal' },
      { id: 'd2', type: 'door', at: [10, 2], along: 'y', width: 2, style: 'double' },
      { id: 'd3', type: 'door', at: [2, 6], along: 'x', width: 1, style: 'locked' },
      { id: 'd4', type: 'door', at: [0, 2], along: 'y', width: 1, style: 'secret' },
      { id: 'd5', type: 'door', at: [12, 0], along: 'x', width: 2, style: 'portcullis' },
      { id: 'd6', type: 'door', at: [16, 2], along: 'y', width: 2, style: 'archway' },
      { id: 'd7', type: 'door', at: [4, 0], along: 'x', width: 1, style: 'normal', open: true },
      { id: 'd8', type: 'door', at: [3.5, 9], along: 'x', width: 1 },
      { id: 'd9', type: 'door', at: [17, 9], along: 'y', width: 1, style: 'secret' },
      { id: 'd10', type: 'door', at: [12, 18], along: 'x', width: 2, style: 'portcullis' },
    ],
    extra,
  );
}

/** A map with these objects and nothing else. */
export const mapWith = (objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap => base('doors', objects, extra);
