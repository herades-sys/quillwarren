// A small keep for the handout's legend: three rooms with every door style
// players see (and a secret one they don't), stairs, a ladder and a trapdoor,
// ink and colour terrain, a cliff, grouped colour props (oaks, red rugs), and
// what players never see: hidden traps, a GM symbol, a GM-only chest, a marker.
// (legend.test.ts; the byte-for-byte hashes there were taken with this
// file against the code before the legend.)
import type { DelveMap, MapObject } from '../src/index.ts';

export function legendKeep(extra: Partial<DelveMap> = {}): DelveMap {
  const objects: MapObject[] = [
    { id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] }, label: '1', name: 'Hall' },
    { id: 'r2', type: 'room', shape: { rect: [10, 0, 6, 6] }, label: '2', name: 'Garden' },
    { id: 'r3', type: 'room', shape: { rect: [0, 10, 8, 6] }, label: '3', name: 'Cellar' },
    { id: 'c1', type: 'corridor', width: 2, path: [[8, 3], [10, 3]] },
    { id: 'c2', type: 'corridor', width: 2, path: [[4, 6], [4, 10]] },
    { id: 'd1', type: 'door', at: [8, 2], along: 'y', width: 2 },
    { id: 'd2', type: 'door', at: [10, 2], along: 'y', width: 2, style: 'locked' },
    { id: 'd3', type: 'door', at: [3, 6], along: 'x', width: 2, style: 'secret' },
    { id: 'd4', type: 'door', at: [3, 10], along: 'x', width: 2, style: 'double' },
    // the hall: barrels, a table and two red rugs (one group)
    { id: 'i1', type: 'prop', asset: 'barrel', at: [1, 1] },
    { id: 'i2', type: 'prop', asset: 'barrel', at: [2, 1] },
    { id: 'i3', type: 'prop', asset: 'barrel', at: [1, 2] },
    { id: 'i4', type: 'prop', asset: 'table-round', at: [5, 2] },
    { id: 'i5', type: 'prop', asset: 'c-persian-red-a', at: [3, 4] },
    { id: 'i6', type: 'prop', asset: 'c-persian-red-b', at: [6, 4.5], rotation: 90 },
    // the garden: three kinds of oak (one group), a trap found, and things players never see
    { id: 'i7', type: 'prop', asset: 'c-oak-a', at: [11.5, 1.5] },
    { id: 'i8', type: 'prop', asset: 'c-oak-b', at: [14.5, 1.5] },
    { id: 'i9', type: 'prop', asset: 'c-oak-c', at: [14, 4.5] },
    { id: 'i10', type: 'prop', asset: 'spike-trap', at: [11.5, 4.5], gmOnly: false },
    { id: 'i11', type: 'prop', asset: 'pressure-plate', at: [12.5, 4.5] },
    { id: 'i12', type: 'prop', asset: 'c-hidden-trapdoor-stone', at: [12.5, 3.5] },
    { id: 'i13', type: 'prop', asset: 'trap', at: [13.5, 3.5] },
    { id: 'i14', type: 'prop', asset: 'chest', at: [15.5, 5.5], gmOnly: true },
    { id: 'm1', type: 'marker', kind: 'trap', at: [12.5, 4.5], text: 'Spikes under the leaves' },
    // the cellar: lava and calm water, a ledge with a cliff, stairs up to it, a ladder and a trapdoor
    { id: 't1', type: 'terrain', asset: 'lava', shape: { rect: [5, 13, 3, 3] } },
    { id: 't2', type: 'terrain', asset: 'c-water-calm', shape: { rect: [0, 13, 3, 3] } },
    { id: 'h1', type: 'height', shape: { rect: [0, 10, 8, 2] }, height: 10, edge: 'cliff' },
    { id: 's1', type: 'stairs', shape: { rect: [3, 11, 2, 2] }, direction: 'n' },
    { id: 'i15', type: 'prop', asset: 'ladder', at: [7.5, 10.5] },
    { id: 'i16', type: 'prop', asset: 'c-trapdoor-wood', at: [4, 14.5] },
  ];
  return { format: 'delve.map', version: 1, id: 'legend-keep', name: 'The Legend Keep', grid: { type: 'square' }, seed: 5, objects, ...extra };
}

/**
 * The map with every terrain area's edge set to hard. Hashes taken before terrain
 * got soft edges (render/terrain-edges.ts) hold for it: a hard edge draws terrain
 * exactly as before.
 */
export function hardTerrain(map: DelveMap): DelveMap {
  return { ...map, objects: map.objects.map((o) => (o.type === 'terrain' ? { ...o, edge: 'hard' as const } : o)) };
}

/**
 * A handout sheet with its stains written as they were before the blur moved
 * onto a plain group around each ring (docs/API.md, "resvg's layer limit"). Hashes taken before then hold for it, so they still show that
 * nothing else on the sheet moved.
 */
export const oldStains = (svg: string): string => svg.replace(/<g filter="url\(#hp-soft\)">(<circle [^>]*?)\/><\/g>/g, '$1 filter="url(#hp-soft)"/>');
