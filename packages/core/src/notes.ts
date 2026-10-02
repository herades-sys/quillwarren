// GM notes on rooms, corridors and terrain: the prep a GM writes into the map
// (a description, the monsters, the loot). They travel with the map but are only
// for the GM and Claude: never drawn, so never in a players' picture, scene or
// export. describeMap lists them; Delve Table shows them to the GM only (a click
// on a room's floor, see docs/TABLE.md "GM notes").
// Every object may carry `notes` (schema `common`); these helpers are about the
// areas a GM clicks on the table.
import { assetInfo } from './assets/catalog.ts';
import { corridorPath, pathLength, roomsById } from './geometry/corridors.ts';
import { EPS, pointInRing, pointInShape, shapeBounds } from './geometry/shapes.ts';
import type { Op } from './ops.ts';
import type { Corridor, DelveMap, MapObject, Point, Room, Terrain } from './schema.ts';

/** The longest note an object may carry (the schema's limit). */
export const NOTES_MAX = 10_000;

export const NOTE_AREA_TYPES = ['room', 'corridor', 'terrain'] as const;
/** What a GM picks on the table to read or write its notes. */
export type NoteArea = Room | Corridor | Terrain;

export const isNoteArea = (o: MapObject): o is NoteArea => o.type === 'room' || o.type === 'corridor' || o.type === 'terrain';

/** Does an object have notes worth showing (not just blanks)? */
export const hasNotes = (o: { notes?: string | undefined }): boolean => Boolean(o.notes?.trim());

/** Inside a corridor of this centreline and width: butt ends, square joins (like corridorOutline). */
function inCorridor(path: readonly Point[], width: number, p: Point): boolean {
  const r = width / 2;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const along = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
    const across = Math.abs((p[1] - a[1]) * ux - (p[0] - a[0]) * uy);
    // an inner corner's square join reaches half the width past the segment's end
    const lo = i > 1 ? -r : 0;
    const hi = i < path.length - 1 ? len + r : len;
    if (along >= lo - EPS && along <= hi + EPS && across <= r + EPS) return true;
  }
  return false;
}

/** Is p on this area's floor? (Rooms by their shape, corridors by their path and width, terrain minus its holes.) */
export function areaContains(map: DelveMap, o: NoteArea, p: Point, rooms = roomsById(map)): boolean {
  switch (o.type) {
    case 'room':
      return pointInShape(o.shape, p);
    case 'corridor': {
      const path = corridorPath(o, rooms);
      return path !== null && inCorridor(path, o.width, p);
    }
    case 'terrain':
      return pointInShape(o.shape, p) && !o.holes?.some((ring) => pointInRing(p, ring));
  }
}

/**
 * Every room, corridor and terrain area under p, in the order a click picks
 * them: rooms first (the topmost, i.e. the last in the map, first), then
 * corridors, then terrain.
 */
export function noteAreasAt(map: DelveMap, p: Point): NoteArea[] {
  const rooms = roomsById(map);
  const out: NoteArea[] = [];
  for (const type of NOTE_AREA_TYPES) {
    for (let i = map.objects.length - 1; i >= 0; i--) {
      const o = map.objects[i]!;
      if (o.type === type && isNoteArea(o) && areaContains(map, o, p, rooms)) out.push(o);
    }
  }
  return out;
}

/** The area a click at p opens, or null. */
export const noteAreaAt = (map: DelveMap, p: Point): NoteArea | null => noteAreasAt(map, p)[0] ?? null;

/** A short name for an area: "5 Boss chamber", "Corridor 1–2", "Water". */
export function areaTitle(map: DelveMap, o: NoteArea): string {
  switch (o.type) {
    case 'room':
      return [o.label, o.name].filter(Boolean).join(' ') || `Room ${o.id}`;
    case 'corridor': {
      if (o.name) return o.name;
      const rooms = roomsById(map);
      const ends = [o.from, o.to].flatMap((id) => {
        const r = id ? rooms.get(id) : undefined;
        return r ? [r.label ?? r.name ?? r.id] : [];
      });
      return ends.length === 2 ? `Corridor ${ends[0]}–${ends[1]}` : `Corridor ${o.id}`;
    }
    case 'terrain':
      return o.name ?? assetInfo(o.asset)?.name ?? o.asset;
  }
}

/** Where an area's notes hint goes: a room's middle (by its number), half way along a corridor, a terrain's middle. */
export function noteAnchor(map: DelveMap, o: NoteArea): Point | null {
  if (o.type === 'corridor') {
    const path = corridorPath(o, roomsById(map));
    if (!path || path.length < 2) return null;
    let left = pathLength(path) / 2;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len >= left && len > 0) return [a[0] + ((b[0] - a[0]) * left) / len, a[1] + ((b[1] - a[1]) * left) / len];
      left -= len;
    }
    return path[path.length - 1]!;
  }
  const b = shapeBounds(o.shape);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}

/** The rooms, corridors and terrain areas that have notes, in map order. */
export const notedAreas = (map: DelveMap): NoteArea[] => map.objects.filter((o): o is NoteArea => isNoteArea(o) && hasNotes(o));

const flatOps = (ops: readonly Op[]): Exclude<Op, { op: 'batch' }>[] => ops.flatMap((o) => (o.op === 'batch' ? flatOps(o.ops) : [o]));

/**
 * Do these ops change nothing but notes (or the map's library category)? Neither
 * is ever drawn, so such a change leaves every picture as it was: the players'
 * screens and table pages need no redraw (only the GM's notes do).
 */
export function notesOnly(ops: readonly Op[]): boolean {
  const flat = flatOps(ops);
  const only = (o: { set?: Record<string, unknown>; unset?: string[] }, key: string) => {
    const keys = [...Object.keys(o.set ?? {}), ...(o.unset ?? [])];
    return keys.length > 0 && keys.every((k) => k === key);
  };
  return flat.length > 0 && flat.every((o) => (o.op === 'update' && only(o, 'notes')) || (o.op === 'update_map' && only(o, 'category')));
}

/** The ops that set (or, when blank, remove) an object's notes. */
export function notesOps(id: string, text: string): Op[] {
  return [text.trim() ? { op: 'update', id, set: { notes: text } } : { op: 'update', id, unset: ['notes'] }];
}
