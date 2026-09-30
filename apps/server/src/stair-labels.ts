// Numbering the stairs: every stair, ladder, spiral stair and trapdoor of a
// place (all storeys of the map's group, or the single map as floor 0) gets
// its GM label, e.g. 0A, 1A, 2A up one staircase. One undoable change per map
// whose labels changed, through MapService so open viewers update live.
import { floorOf, levelSiblings, stairLabelOps, stairLabels } from '@delve/core';
import type { MapService } from './service.ts';

export interface LabelStairsResult {
  /** Every storey, top first: its floor, how many connectors it has and how many labels changed. */
  storeys: { id: string; name: string; floor: number; stairs: number; changed: number; rev: number }[];
}

export function labelStairs(service: MapService, id: string, by: string): LabelStairsResult {
  service.store.get(id); // 404 for unknown maps
  const maps = levelSiblings(service.store.list(), id).map((s) => ({ id: s.id, ...service.store.get(s.id) }));
  const labels = stairLabels(maps.map((m) => ({ id: m.id, map: m.map })));
  const storeys = maps.map(({ id: mapId, rev, map }) => {
    const mine = labels.get(mapId) ?? new Map<string, string>();
    const ops = stairLabelOps(map, mine);
    const after = ops.length ? service.apply(mapId, ops, { by }).rev : rev;
    return { id: mapId, name: map.level?.name ?? map.name, floor: floorOf(map), stairs: mine.size, changed: ops.length, rev: after };
  });
  return { storeys: storeys.reverse() };
}

/** "Numbered 5 stairs on 3 storeys (2 labels changed)." for people and Claude. */
export function labelStairsSummary(r: LabelStairsResult): string {
  const stairs = r.storeys.reduce((s, x) => s + x.stairs, 0);
  const changed = r.storeys.reduce((s, x) => s + x.changed, 0);
  if (!stairs) return r.storeys.length > 1 ? 'No stairs, ladders, spiral stairs or trapdoors on these storeys yet.' : 'No stairs, ladders, spiral stairs or trapdoors on this map yet.';
  const where = r.storeys.length > 1 ? ` on ${r.storeys.length} storeys` : '';
  return `Numbered ${stairs} stair${stairs === 1 ? '' : 's'}${where} (${changed ? `${changed} label${changed === 1 ? '' : 's'} changed` : 'no changes'}).`;
}
