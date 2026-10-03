// Two small outdoor maps for the canopy layer (canopy.test.ts). The clearing has
// no trees: boulders, ruin walls, rubble, bushes, a stump and a log, a camp, a
// rug, a GM symbol, a label, a marker and a note on the map, some of them
// overlapping. Its byte-for-byte hashes in canopy.test.ts were taken with this
// file against the code before the canopy layer (84c8003). The grove adds trees
// over some of them.
import type { DelveMap, MapObject } from '../src/index.ts';

export function clearing(extra: MapObject[] = []): DelveMap {
  const objects: MapObject[] = [
    { id: 'r1', type: 'room', shape: { rect: [0, 0, 16, 12] }, label: '1', name: 'Clearing' },
    { id: 't1', type: 'terrain', asset: 'c-ground-grass-short', shape: { rect: [0, 0, 16, 12] } },
    { id: 'i1', type: 'prop', asset: 'boulder', at: [2.5, 2.5] },
    { id: 'i2', type: 'prop', asset: 'boulder-large', at: [5, 3] },
    { id: 'i3', type: 'prop', asset: 'c-boulder-a', at: [8.5, 2.5] },
    { id: 'i4', type: 'prop', asset: 'c-boulder-mossy', at: [12, 3] },
    { id: 'i5', type: 'prop', asset: 'c-wall-2', at: [3, 6.5] },
    { id: 'i6', type: 'prop', asset: 'c-wall-corner', at: [4.5, 6.5] },
    { id: 'i7', type: 'prop', asset: 'rubble', at: [3.5, 6.5] },
    { id: 'i8', type: 'prop', asset: 'c-rubble-pile', at: [6.5, 7.5] },
    { id: 'i9', type: 'prop', asset: 'bush', at: [9.5, 6.5] },
    { id: 'i10', type: 'prop', asset: 'stump', at: [10.5, 7.5] },
    { id: 'i11', type: 'prop', asset: 'log', at: [12, 8.5], rotation: 30 },
    { id: 'i12', type: 'prop', asset: 'c-bush-a', at: [14.5, 6.5] },
    { id: 'i13', type: 'prop', asset: 'tent', at: [3, 10] },
    { id: 'i14', type: 'prop', asset: 'campfire', at: [5.5, 10.5] },
    { id: 'i15', type: 'prop', asset: 'c-persian-red-a', at: [8, 10] },
    { id: 'i16', type: 'prop', asset: 'mushrooms', at: [10.5, 10.5] },
    { id: 'i17', type: 'prop', asset: 'trap', at: [12.5, 10.5] },
    { id: 'l1', type: 'label', text: 'Old camp', at: [4, 11.5] },
    { id: 'm1', type: 'marker', kind: 'discover', at: [8.5, 2.5], text: 'A coin under the boulder' },
    { id: 'w1', type: 'inscription', text: 'Here be wolves', at: [12, 1], onMap: true },
    ...extra,
  ];
  return { format: 'delve.map', version: 1, id: 'canopy-clearing', name: 'Clearing', grid: { type: 'square' }, seed: 11, objects };
}

/** The clearing with trees: an oak over the mossy boulder, ink trees over the stump and the rubble pile, a giant mushroom, a sapling. */
export function grove(): DelveMap {
  return clearing([
    { id: 'i20', type: 'prop', asset: 'c-oak-a', at: [12.5, 3.5] },
    { id: 'i21', type: 'prop', asset: 'tree', at: [10.5, 8] },
    { id: 'i22', type: 'prop', asset: 'tree-dead', at: [6.5, 7] },
    { id: 'i23', type: 'prop', asset: 'mushroom-giant', at: [14, 10] },
    { id: 'i24', type: 'prop', asset: 'c-sapling-a', at: [1.5, 4.5] },
  ]);
}
