// Small map helpers shared by the starting maps and the task families:
// rooms and their walls, doors and corridors per room, props in a room,
// lengths in the map's own units, and plain-English references to things.
import { assetInfo, corridorPath, doorCentre, parseSquareUnit, pointInShape, propBounds, roomsById, shapeBounds, type Bounds, type DelveMap, type MapObject } from '@delve/core';
import type { Rng } from './rng.ts';
import { checkMap, type Problem } from '@delve/core';
import type { Side } from './tools.ts';

export type Typed<T extends MapObject['type']> = Extract<MapObject, { type: T }>;
export type Room = Typed<'room'>;
export type Door = Typed<'door'>;
export type Prop = Typed<'prop'>;
export type Corridor = Typed<'corridor'>;
export type Rect = [number, number, number, number];

export const ofType = <T extends MapObject['type']>(m: DelveMap, type: T): Typed<T>[] => m.objects.filter((o): o is Typed<T> => o.type === type);
export const byId = (m: DelveMap, id: string): MapObject | undefined => m.objects.find((o) => o.id === id);
export const roomById = (m: DelveMap, id: string): Room | undefined => {
  const o = byId(m, id);
  return o?.type === 'room' ? o : undefined;
};

export const isRect = (r: Room): r is Room & { shape: { rect: Rect } } => 'rect' in r.shape;
export const rectOf = (r: Room): Rect => {
  const b = shapeBounds(r.shape);
  return [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0];
};
export const boxOf = (o: { shape: Parameters<typeof shapeBounds>[0] }): Bounds => shapeBounds(o.shape);
export const width = (b: Bounds) => b.x1 - b.x0;
export const height = (b: Bounds) => b.y1 - b.y0;
export const centre = (b: Bounds): [number, number] => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];

/** Gap between two boxes (0 when they touch or overlap). */
export function boxGap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.max(dx, dy);
}
export const overlapArea = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
export const toBounds = (r: Rect): Bounds => ({ x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] });

/** Distance from a point to a box's outline. */
export function toOutline(p: readonly [number, number], b: Bounds): number {
  const inside = p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;
  if (inside) return Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]);
  return Math.hypot(Math.max(b.x0 - p[0], 0, p[0] - b.x1), Math.max(b.y0 - p[1], 0, p[1] - b.y1));
}

/** Which wall of a box a point on its outline is on. */
export function wallOf(p: readonly [number, number], b: Bounds): Side {
  const d: [Side, number][] = [
    ['north', Math.abs(p[1] - b.y0)],
    ['south', Math.abs(p[1] - b.y1)],
    ['west', Math.abs(p[0] - b.x0)],
    ['east', Math.abs(p[0] - b.x1)],
  ];
  return d.sort((a, c) => a[1] - c[1])[0]![0];
}

/** Doors whose middle lies on this room's outline (box rooms; others: within half a square of the box). */
export function doorsOf(m: DelveMap, room: Room): Door[] {
  const b = boxOf(room);
  return ofType(m, 'door').filter((d) => toOutline(doorCentre(d), b) <= 0.3);
}

/** The doors on each wall of a box room. */
export function doorsByWall(m: DelveMap, room: Room): Record<Side, Door[]> {
  const b = boxOf(room);
  const out: Record<Side, Door[]> = { north: [], south: [], east: [], west: [] };
  for (const d of doorsOf(m, room)) out[wallOf(doorCentre(d), b)].push(d);
  return out;
}

/** The doors describe_map lists on a corridor: their middle inside the corridor's box (its path, widened by half its width). */
export function corridorDoors(m: DelveMap, c: Corridor): Door[] {
  const path = corridorPath(c, roomsById(m));
  if (!path?.length) return [];
  const r = c.width / 2 + 1e-6;
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  const b = { x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r };
  return ofType(m, 'door').filter((d) => {
    const [x, y] = doorCentre(d);
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  });
}

export const corridorsOf = (m: DelveMap, roomId: string): Corridor[] => ofType(m, 'corridor').filter((c) => c.from === roomId || c.to === roomId);
export const corridorBetween = (m: DelveMap, a: string, b: string): Corridor | undefined => ofType(m, 'corridor').find((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));
/** The rooms a room is joined to by corridors. */
export const neighbours = (m: DelveMap, roomId: string): string[] => corridorsOf(m, roomId).map((c) => (c.from === roomId ? c.to! : c.from!)).filter(Boolean);

/** Props whose middle is in the room. */
export const propsIn = (m: DelveMap, room: Room): Prop[] => ofType(m, 'prop').filter((p) => pointInShape(room.shape, p.at));
/** Props whose footprint lies wholly in the room. */
export const propInside = (p: Prop, room: Room): boolean => {
  const b = propBounds(p);
  const r = boxOf(room);
  return b.x0 >= r.x0 - 0.01 && b.y0 >= r.y0 - 0.01 && b.x1 <= r.x1 + 0.01 && b.y1 <= r.y1 + 0.01;
};

export const assetName = (asset: string): string => assetInfo(asset)?.name ?? asset;

// ---------- numbers and lengths ----------

/** A number without trailing zeros: 3, 2.5, 0.25. */
export const n = (v: number): string => String(Math.round(v * 100) / 100);

export const unitOf = (m: DelveMap) => parseSquareUnit(m.grid.unit);
export const metric = (m: DelveMap) => unitOf(m).name === 'm';
/** Squares as the map's own length: "30 ft", "4.5 m". */
export function inUnits(m: DelveMap, squares: number): string {
  const u = unitOf(m);
  return `${n(squares * u.size)} ${u.name}`;
}

// ---------- referring to rooms ----------

/** "room 3", or the name when it has one and no number. */
export function roomRef(r: Room): string {
  return r.label ? `room ${r.label}` : r.name ? `the ${r.name.toLowerCase()}` : r.id;
}

/** The ways a user might name a room: by number, by name, both. */
export function roomWords(r: Room, rng: Rng, opts: { allowName?: boolean } = {}): string {
  const choices: string[] = [];
  if (r.label) choices.push(`room ${r.label}`, `room ${r.label}`, `room ${r.label}`);
  if (r.name && opts.allowName !== false) {
    choices.push(`the ${r.name}`, `the ${r.name.toLowerCase()}`);
    if (r.label) choices.push(`room ${r.label} (the ${r.name.toLowerCase()})`);
  }
  if (!choices.length) choices.push(r.id);
  return rng.pick(choices);
}

/** Room names must be unique to be used as references. */
export function uniqueName(m: DelveMap, r: Room): boolean {
  if (!r.name) return false;
  const k = r.name.toLowerCase();
  return ofType(m, 'room').filter((x) => x.name?.toLowerCase() === k).length === 1;
}

/** Where a box lies relative to another: the side of `base` that `other` is on (by the larger gap). */
export function sideOfBox(base: Bounds, other: Bounds): Side {
  const gaps: [Side, number][] = [
    ['north', base.y0 - other.y1],
    ['south', other.y0 - base.y1],
    ['west', base.x0 - other.x1],
    ['east', other.x0 - base.x1],
  ];
  return gaps.sort((a, b) => b[1] - a[1])[0]![0];
}

// ---------- checks ----------

const key = (p: Problem) => `${p.kind}:${[...p.ids].sort().join(',')}`;
/** Problems on `after` that `before` didn't have (check_map's list). */
export function newProblems(before: DelveMap, after: DelveMap): Problem[] {
  const old = new Set(checkMap(before).map(key));
  return checkMap(after).filter((p) => !old.has(key(p)));
}

export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const plural = (k: number, one: string, many: string): string => (k === 1 ? one : many);
/** "a, b and c". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
/** "i3–i6" for a run of ids, else "i3, i5". */
export function idRange(ids: readonly string[]): string {
  if (ids.length <= 2) return ids.join(', ');
  const nums = ids.map((id) => Number(/\d+$/.exec(id)?.[0]));
  const prefix = ids[0]!.replace(/\d+$/, '');
  const run = ids.every((id) => id.replace(/\d+$/, '') === prefix) && nums.every((v, i) => i === 0 || v === nums[i - 1]! + 1);
  return run ? `${ids[0]}–${ids[ids.length - 1]}` : ids.join(', ');
}

/** A room for an answer: "room 3 (Scullery)", "room 3", or its name. */
export function roomTitle(r: Room): string {
  if (r.label) return `room ${r.label}${r.name ? ` (${r.name})` : ''}`;
  return r.name ? `the ${r.name.toLowerCase()} (${r.id})` : r.id;
}
