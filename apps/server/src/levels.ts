// Storeys: adding one creates a new, empty map in the same group, above or
// below the others (see @delve/core levels.ts). The first time, the map it's
// added to joins the group too, named "Ground floor" unless told otherwise.
import { randomInt } from 'node:crypto';
import { FORMAT, FORMAT_VERSION, levelSiblings, ValidationError, type DelveMap } from '@delve/core';
import type { MapService } from './service.ts';
import { labelStairs } from './stair-labels.ts';
import { newMapId, type Change } from './store.ts';

export interface AddLevelOptions {
  name: string;
  /** Default "above". */
  position?: 'above' | 'below';
  /** The name for the existing map's storey, when it isn't part of a group yet. */
  currentName?: string;
  by: string;
}

const levelName = (v: unknown, what: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 60) throw new ValidationError([`${what}: give a storey name of 1 to 60 characters, e.g. "Cellar" or "Top floor"`]);
  return s;
};

export function addLevel(service: MapService, baseId: string, o: AddLevelOptions): Change {
  const name = levelName(o.name, 'name');
  const { map: base } = service.store.get(baseId);
  const group = base.level?.group ?? base.id;
  if (!base.level) {
    const current = o.currentName === undefined ? 'Ground floor' : levelName(o.currentName, 'current_name');
    service.apply(baseId, [{ op: 'update_map', set: { level: { group, name: current, order: 0 } } }], { by: o.by });
  }
  const orders = levelSiblings(service.store.list(), baseId).map((m) => m.level?.order ?? 0);
  const order = o.position === 'below' ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
  const map: DelveMap = {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: newMapId(),
    name: base.name,
    grid: base.grid,
    ...(base.style ? { style: base.style } : {}),
    seed: randomInt(1, 2 ** 31),
    level: { group, name, order },
    // the place's library shelf
    ...(base.category ? { category: base.category } : {}),
    objects: [],
  };
  const created = service.create(map, o.by);
  // the floor numbers may have shifted the stairs' labels (0A, 1A…): renumber them
  labelStairs(service, created.mapId, o.by);
  // open editors of the other storeys refresh their storey picker
  for (const s of levelSiblings(service.store.list(), created.mapId)) if (s.id !== created.mapId) service.hub.broadcast(s.id, { type: 'levels' });
  return created;
}

/** The storeys of a map, top storey first (the order a building is drawn in). */
export function levelsOf(service: MapService, id: string) {
  service.store.get(id); // 404 for unknown maps
  return levelSiblings(service.store.list(), id)
    .map((m) => ({ id: m.id, name: m.name, level: m.level }))
    .reverse();
}
