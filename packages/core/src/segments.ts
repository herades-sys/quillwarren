// Segments: a saved piece of a map (the five rooms of a temple with their
// furniture, one antechamber, a patch of mixed forest) that can be placed again
// elsewhere, turned in quarter turns, or tiled over the land around a dungeon.
// Everything here is pure: the server stores segments, and the editor and the
// MCP tools send the ops these functions return (one request, one undo step).
import { differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, unionD, type PathD, type PathsD } from 'clipper2-ts';
import { assetInfo, propBounds } from './assets/catalog.ts';
import { nextId, nextLabel, withAttachedDoors } from './build.ts';
import { corridorOutline, corridorPath, roomsById } from './geometry/corridors.ts';
import { floorParts, polygonsOf } from './geometry/floor.ts';
import { insidePolygons, objectBounds } from './geometry/objects.ts';
import { maxBulge } from './geometry/rough.ts';
import { PRECISION, shapeBounds, shapePath, type Bounds, type Polygon, type Ring } from './geometry/shapes.ts';
import { terrainArea } from './geometry/terrain.ts';
import { doorSegment } from './geometry/walls.ts';
import type { Op } from './ops.ts';
import { rng } from './render/rng.ts';
import { FORMAT, FORMAT_VERSION, type Corridor, type DelveMap, type MapObject, type Point, type Prop, type Room, type Shape, type Terrain } from './schema.ts';
import { validateMap, ValidationError } from './validate.ts';

/** What a segment holds: objects moved so the segment's top-left corner is 0,0, inside a box of size [w, h] squares. */
export interface SegmentContent {
  size: [number, number];
  objects: MapObject[];
}

/** A saved segment, as the server keeps it. */
export interface MapSegment extends SegmentContent {
  id: string;
  name: string;
  created: string;
}

/** What to save: objects by id (rooms bring their doors and contents), or everything inside a rectangle [x, y, w, h]. */
export type SegmentPick = { ids: readonly string[] } | { rect: readonly [number, number, number, number] };

type Loose = Record<string, unknown>;
type Xf = (p: Point) => Point;

const EPS = 1e-6;
/** A fill never lays more copies than this (a 1×1 segment over a 50×50 area). */
const MAX_TILES = 2500;
const DIRS = ['n', 'e', 's', 'w'] as const;
/** Ids by type, as the tools and the editor pick them. */
const PREFIX: Record<string, string> = { room: 'r', corridor: 'c', cutout: 'p', door: 'd', stairs: 's', label: 'l', prop: 'i', terrain: 't', marker: 'm', opening: 'o' };
/** Objects centred on `at` that turn by a `rotation` field. */
const TURNS_WITH_ROTATION = new Set(['prop', 'image']);
/** What "around the rooms" means: the built part of the map. */
const BUILT = new Set(['room', 'corridor', 'cutout', 'door', 'stairs']);

const r6 = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;
const fold = (deg: number): number => ((Math.round(deg) % 360) + 360) % 360;

/** A throwaway map holding just these objects: for geometry, validation and thumbnails. */
export function segmentMap(objects: MapObject[], base?: Pick<DelveMap, 'style' | 'seed' | 'roughness'>): DelveMap {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: 'segment',
    name: 'Segment',
    grid: { type: 'square' },
    ...(base?.style ? { style: base.style } : {}),
    ...(base?.seed !== undefined ? { seed: base.seed } : {}),
    ...(base?.roughness ? { roughness: base.roughness } : {}),
    objects,
  };
}

function unionBounds(list: readonly (Bounds | null)[]): Bounds | null {
  const bs = list.filter((b): b is Bounds => b !== null);
  if (!bs.length) return null;
  return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) };
}

const within = (b: Bounds, box: Bounds): boolean => b.x0 >= box.x0 - EPS && b.y0 >= box.y0 - EPS && b.x1 <= box.x1 + EPS && b.y1 <= box.y1 + EPS;
const overlapsBox = (a: Bounds, b: Bounds): boolean => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
/** Two footprints overlap by more than a sliver (touching edges don't count). */
const footprintsOverlap = (a: Bounds, b: Bounds): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.05 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.05;

/** Where an object sits, without the pick padding objectBounds gives doors and the text estimate of labels. */
function tightBounds(o: MapObject, map: DelveMap): Bounds | null {
  if (o.type === 'door') {
    const [a, b] = doorSegment(o);
    return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
  }
  if (o.type === 'label') return { x0: o.at[0], y0: o.at[1], x1: o.at[0], y1: o.at[1] };
  return objectBounds(o, map);
}

function ringArea(ring: readonly Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return Math.abs(a / 2);
}

/** A ring as the simplest shape: an axis-aligned four-corner ring becomes a rect. */
function ringShape(ring: Ring): Shape {
  if (ring.length === 4) {
    const xs = [...new Set(ring.map((p) => p[0]))];
    const ys = [...new Set(ring.map((p) => p[1]))];
    if (xs.length === 2 && ys.length === 2) {
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      return { rect: [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0] };
    }
  }
  return { poly: ring };
}

function terrainPiece(t: Terrain, poly: Polygon, id: string): Terrain {
  const { holes: _old, ...rest } = t;
  return { ...rest, id, shape: ringShape(poly.outer), ...(poly.holes.length ? { holes: poly.holes } : {}) };
}

// ---------- turning and moving objects ----------

function transformShape(s: Shape, f: Xf): Shape {
  if ('rect' in s) {
    const [x, y, w, h] = s.rect;
    const a = f([x, y]);
    const b = f([x + w, y + h]);
    return { rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), r6(Math.abs(b[0] - a[0])), r6(Math.abs(b[1] - a[1]))] };
  }
  if ('circle' in s) {
    const [cx, cy] = f([s.circle[0], s.circle[1]]);
    return { circle: [cx, cy, s.circle[2]] };
  }
  return { poly: s.poly.map(f) };
}

const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';

/**
 * A copy of o with every point run through f; `turns` quarter turns clockwise
 * also turn props and pictures, the way up of stairs, and which way doors run.
 * Works on any object with a shape, holes, a path or an `at` point.
 */
function transformObject(o: MapObject, f: Xf, turns = 0): MapObject {
  const g: Xf = (p) => {
    const [x, y] = f(p);
    return [r6(x), r6(y)];
  };
  const src = o as unknown as Loose;
  const out = structuredClone(src);
  if (src.shape && typeof src.shape === 'object') out.shape = transformShape(src.shape as Shape, g);
  if (Array.isArray(src.holes)) out.holes = (src.holes as Point[][]).map((ring) => ring.map(g));
  if (Array.isArray(src.path)) out.path = (src.path as Point[]).map(g);
  if (o.type === 'door') {
    const [a, b] = doorSegment(o).map(g) as [Point, Point];
    out.at = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
    out.along = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'x' : 'y';
  } else if (isPoint(src.at)) out.at = g(src.at);
  if (turns) {
    if (o.type === 'stairs') out.direction = DIRS[(DIRS.indexOf(o.direction) + turns) % 4];
    if (TURNS_WITH_ROTATION.has(o.type) || typeof src.rotation === 'number') {
      const r = fold((typeof src.rotation === 'number' ? src.rotation : 0) + 90 * turns);
      if (r) out.rotation = r;
      else delete out.rotation;
    }
  }
  return out as unknown as MapObject;
}

/** 0, 90, 180 or 270 degrees (or -90…) as quarter turns clockwise. */
export function quarterTurns(rotation: number): 0 | 1 | 2 | 3 {
  const q = Math.round(rotation / 90);
  if (!Number.isFinite(rotation) || Math.abs(rotation / 90 - q) > 1e-9) throw new ValidationError(['rotation must be 0, 90, 180 or 270 degrees']);
  return (((q % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/** A point of a w × h box after q quarter turns clockwise (y grows down), in the turned box. */
function turnFn(q: number, w: number, h: number): Xf {
  if (q === 1) return ([x, y]) => [h - y, x];
  if (q === 2) return ([x, y]) => [w - x, h - y];
  if (q === 3) return ([x, y]) => [y, w - x];
  return (p) => p;
}

/** The segment turned clockwise about its centre by 0, 90, 180 or 270 degrees; its top-left stays at 0,0. */
export function turnSegment(segment: SegmentContent, rotation: number): SegmentContent {
  const q = quarterTurns(rotation);
  const [w, h] = segment.size;
  if (!q) return { size: [w, h], objects: segment.objects.map((o) => structuredClone(o)) };
  const f = turnFn(q, w, h);
  return { size: q % 2 ? [h, w] : [w, h], objects: segment.objects.map((o) => transformObject(o, f, q)) };
}

// ---------- saving ----------

/** A corridor whose room(s) stay behind keeps its current route as a fixed path. Null if it has no route. */
function detach(o: MapObject, chosen: ReadonlySet<string>, map: DelveMap): MapObject | null {
  if (o.type !== 'corridor') return o;
  const keep = (id: string | undefined) => id !== undefined && chosen.has(id);
  if (keep(o.from) && keep(o.to)) return o;
  const path = corridorPath(o, roomsById(map));
  if (!path) return null;
  const { from, to, ...rest } = o;
  return { ...rest, ...(keep(from) ? { from } : {}), ...(keep(to) ? { to } : {}), path } satisfies Corridor;
}

function pickIds(map: DelveMap, ids: readonly string[]): MapObject[] {
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const missing = [...new Set(ids)].filter((id) => !byId.has(id));
  if (missing.length) throw new ValidationError([`no object with id ${missing.map((s) => JSON.stringify(s)).join(', ')} on this map`]);
  const chosen = new Set(withAttachedDoors(map, ids));
  const isRoom = (id: string | undefined) => id !== undefined && chosen.has(id) && byId.get(id)?.type === 'room';
  for (const o of map.objects) if (o.type === 'corridor' && isRoom(o.from) && isRoom(o.to)) chosen.add(o.id);

  // Whatever stands in the picked rooms and corridors comes along: props,
  // terrain, labels, markers, cutouts, stairs, pictures.
  const rooms = roomsById(map);
  const floor: PathsD = [];
  for (const o of map.objects) {
    if (!chosen.has(o.id)) continue;
    if (o.type === 'room') floor.push(shapePath(o.shape));
    else if (o.type === 'corridor') {
      const path = corridorPath(o, rooms);
      if (path) floor.push(...corridorOutline(path, o.width));
    }
  }
  if (floor.length) {
    const polys = polygonsOf(floor);
    const pts = floor.flat();
    const reach: Bounds = { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
    // open areas lie across a picked room's edge (the open end of a corridor): they come along when they touch its floor
    const touching = inflatePathsD(floor, 0.25, JoinType.Miter, EndType.Polygon, 2, PRECISION);
    for (const o of map.objects) {
      if (o.type !== 'opening' || chosen.has(o.id)) continue;
      if (intersectD([shapePath(o.shape)], touching, FillRule.NonZero, PRECISION).length) chosen.add(o.id);
    }
    for (const o of map.objects) {
      if (chosen.has(o.id) || o.type === 'room' || o.type === 'corridor' || o.type === 'opening') continue;
      const b = objectBounds(o, map);
      if (!b || !insidePolygons(polys, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2])) continue;
      // an area must fit the picked floor too: a forest filled around the rooms isn't "in" them
      if ('shape' in o && !within(b, reach)) continue;
      chosen.add(o.id);
    }
  }
  return map.objects.flatMap((o) => {
    if (!chosen.has(o.id)) return [];
    const d = detach(o, chosen, map);
    return d ? [d] : [];
  });
}

/** Terrain cut to a box: one piece per separate part. */
function clipTerrain(t: Terrain, box: Bounds): Terrain[] {
  const rect: PathD = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  const parts = polygonsOf(intersectD(terrainArea(t), [rect], FillRule.NonZero, PRECISION)).filter((p) => ringArea(p.outer) > 1e-3);
  return parts.map((p, k) => terrainPiece(t, p, k ? `${t.id.slice(0, 56)}-${k + 1}` : t.id));
}

function pickRect(map: DelveMap, rect: readonly [number, number, number, number]): MapObject[] {
  const [x, y, w, h] = rect;
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) throw new ValidationError(['rect: [x, y, width, height] with a width and height greater than 0']);
  const box: Bounds = { x0: x, y0: y, x1: x + w, y1: y + h };
  const out: MapObject[] = [];
  for (const o of map.objects) {
    if (o.type === 'terrain') {
      const b = shapeBounds(o.shape);
      if (within(b, box)) out.push(o);
      else if (overlapsBox(b, box)) out.push(...clipTerrain(o, box));
      continue;
    }
    const b = tightBounds(o, map);
    if (b && within(b, box)) out.push(o);
  }
  const chosen = new Set(out.map((o) => o.id));
  // doors on the walls of rooms that stay behind stay with them
  const kept = map.objects.filter((o) => o.type === 'room' && chosen.has(o.id)).map((o) => o.id);
  const left = map.objects.filter((o) => o.type === 'room' && !chosen.has(o.id)).map((o) => o.id);
  const own = new Set(withAttachedDoors(map, kept));
  const stray = new Set(withAttachedDoors(map, left));
  return out.flatMap((o) => {
    if (o.type === 'door' && stray.has(o.id) && !own.has(o.id)) return [];
    const d = detach(o, chosen, map);
    return d ? [d] : [];
  });
}

/**
 * Collect a segment from a map. By ids: the objects, plus for rooms the doors
 * on their edges and everything whose centre stands inside them (props,
 * terrain, labels, markers, cutouts, stairs, pictures), and every corridor whose
 * two rooms are both in. By rect: every object that lies inside it, with
 * terrain cut to it. A picked corridor whose rooms aren't both in keeps its
 * current route as a fixed path; unpicked corridors to rooms outside stay behind.
 * The segment's box is whole squares, so placing it keeps everything on the grid.
 */
export function collectSegment(map: DelveMap, pick: SegmentPick): SegmentContent {
  const byRect = 'rect' in pick;
  const picked = byRect ? pickRect(map, pick.rect) : pickIds(map, pick.ids);
  if (!picked.length) {
    throw new ValidationError([byRect ? 'nothing to save: no object lies completely inside that area' : 'nothing to save: pick at least one object']);
  }
  const own = segmentMap(picked);
  const content = unionBounds(picked.map((o) => tightBounds(o, own)));
  const box = byRect ? { x0: pick.rect[0], y0: pick.rect[1], x1: pick.rect[0] + pick.rect[2], y1: pick.rect[1] + pick.rect[3] } : content;
  if (!box) throw new ValidationError(['nothing to save: the picked objects have no size']);
  const x0 = Math.floor(box.x0 + EPS);
  const y0 = Math.floor(box.y0 + EPS);
  const x1 = Math.max(x0 + 1, Math.ceil(box.x1 - EPS));
  const y1 = Math.max(y0 + 1, Math.ceil(box.y1 - EPS));
  const objects = picked.map((o) => transformObject(o, ([px, py]) => [px - x0, py - y0]));
  // the segment must make sense on its own (ids unique, corridors reach their rooms)
  validateMap(segmentMap(objects));
  return { size: [x1 - x0, y1 - y0], objects };
}

// ---------- counting, for lists and summaries ----------

const NOUNS: Record<string, [string, string]> = {
  room: ['room', 'rooms'],
  corridor: ['corridor', 'corridors'],
  cutout: ['cutout', 'cutouts'],
  door: ['door', 'doors'],
  stairs: ['stairs', 'stairs'],
  label: ['label', 'labels'],
  prop: ['prop', 'props'],
  terrain: ['terrain area', 'terrain areas'],
  marker: ['GM marker', 'GM markers'],
  image: ['picture', 'pictures'],
  opening: ['open area', 'open areas'],
};

/** How many objects of each type. */
export function segmentCounts(objects: readonly MapObject[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of objects) out[o.type] = (out[o.type] ?? 0) + 1;
  return out;
}

/** "5 rooms, 4 corridors, 20 props". */
export function countsText(counts: Readonly<Record<string, number>>): string {
  const order = Object.keys(NOUNS);
  const keys = Object.keys(counts).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys.map((k) => `${counts[k]} ${(NOUNS[k] ?? [k, k])[counts[k] === 1 ? 0 : 1]}`).join(', ') || 'nothing';
}

// ---------- placing ----------

export interface PlaceResult {
  /** Add ops for the copy, to send as one request (one undo step). */
  ops: Op[];
  /** The new objects' ids, in the order they are added. */
  ids: string[];
  /** The new rooms and their numbers, which carry on from the map's. */
  rooms: { id: string; label?: string }[];
  /** Where the copy's top-left corner went (whole squares) and its size after turning. */
  at: Point;
  size: [number, number];
  bounds: Bounds | null;
  /** Rooms already on the map that the copy overlaps (they merge where they touch). */
  overlaps: string[];
}

function samePath(a: readonly Point[], b: readonly Point[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  const eq = (p: Point, q: Point) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
  return a.every((p, i) => eq(p, b[i]!)) || a.every((p, i) => eq(p, b[b.length - 1 - i]!));
}

const prefixOf = (o: MapObject): string => PREFIX[o.type] ?? (o.id.replace(/\d+$/, '').slice(0, 40) || 'o');

/**
 * Ops that add a copy of the segment with its top-left corner at `at`
 * (snapped to whole squares), turned clockwise by `rotation` (0, 90, 180,
 * 270). Every object gets a fresh id after the highest on the map, numbered
 * rooms continue the map's room numbers (in their old order), and corridors
 * point at the copies of their rooms. An auto-routed corridor that would route
 * differently once turned keeps the turned route as a fixed path, so it still
 * meets the doors at its ends.
 */
export function placeSegmentOps(map: DelveMap, segment: SegmentContent, at: Point, rotation = 0): PlaceResult {
  if (!segment.objects.length) throw new ValidationError(['the segment is empty']);
  if (!isPoint(at) || !at.every(Number.isFinite)) throw new ValidationError(['at must be [x, y] in squares']);
  const q = quarterTurns(rotation);
  const [w, h] = segment.size;
  const origin: Point = [r6(Math.round(at[0])), r6(Math.round(at[1]))];
  const turn = turnFn(q, w, h);
  const place: Xf = (p) => {
    const [x, y] = turn(p);
    return [r6(x + origin[0]), r6(y + origin[1])];
  };
  const turned = turnSegment(segment, rotation);
  const copies = turned.objects.map((o) => transformObject(o, ([x, y]) => [x + origin[0], y + origin[1]]) as MapObject & Loose);

  // fresh ids, counted per prefix after the highest already on the map
  const counter = new Map<string, number>();
  const rename = new Map<string, string>();
  const newIds = copies.map((o) => {
    const prefix = prefixOf(o);
    const k = counter.get(prefix) ?? 0;
    counter.set(prefix, k + 1);
    const id = nextId(map, prefix, k);
    if (!rename.has(o.id)) rename.set(o.id, id);
    return id;
  });

  // room numbers carry on from the map's
  let next = Number(nextLabel(map));
  copies
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.type === 'room' && /^\d+$/.test(o.label ?? ''))
    .sort((a, b) => Number((a.o as Room).label) - Number((b.o as Room).label) || a.i - b.i)
    .forEach(({ o }) => ((o as Room).label = String(next++)));

  copies.forEach((o, i) => (o.id = newIds[i]!));
  for (const o of copies) {
    if (o.type !== 'corridor') continue;
    for (const end of ['from', 'to'] as const) {
      const ref = o[end];
      if (ref === undefined) continue;
      const id = rename.get(ref);
      if (id) o[end] = id;
      else delete o[end];
    }
  }

  // auto routes: keep the turned route where the copy would route differently
  const before = roomsById(segmentMap(segment.objects));
  const after = roomsById(segmentMap(copies));
  copies.forEach((o, i) => {
    const src = segment.objects[i];
    if (o.type !== 'corridor' || o.path || !o.from || !o.to || src?.type !== 'corridor') return;
    const route = corridorPath(src, before);
    if (!route) return;
    const want = route.map(place);
    if (!samePath(want, corridorPath(o, after))) o.path = want;
  });
  const added = copies.filter((o) => !(o.type === 'corridor' && !o.path && (!o.from || !o.to)));

  const all = { ...map, objects: [...map.objects, ...added] };
  const newRooms = added.filter((o): o is Room => o.type === 'room');
  const overlaps = map.objects
    .filter((o): o is Room => o.type === 'room')
    .filter((r) => newRooms.some((n) => overlapsBox(shapeBounds(r.shape), shapeBounds(n.shape))))
    .map((r) => r.id);
  return {
    ops: added.map((object) => ({ op: 'add', object })),
    ids: added.map((o) => o.id),
    rooms: newRooms.map((r) => ({ id: r.id, ...(r.label ? { label: r.label } : {}) })),
    at: origin,
    size: turned.size,
    bounds: unionBounds(added.map((o) => objectBounds(o, all))),
    overlaps,
  };
}

// ---------- filling ----------

export interface FillOptions {
  /** How far (in squares) tiled things keep from the map's rooms and corridors. Default 0.5. */
  margin?: number;
  /** Jitter each prop a little and give nature props a random turn, so the fill doesn't look stamped. Default true. */
  vary?: boolean;
  /** Same seed, same fill. */
  seed?: number;
}

export interface FillResult {
  /** Terrain goes in under the map's own terrain (a river stays on top of the new grass); props on top. */
  ops: Op[];
  ids: string[];
  props: number;
  terrain: number;
  /** Tiled props left out: on or near the floor, outside the area, on another prop or on other terrain. */
  skipped: number;
  /** Kinds of objects in the segment a fill doesn't repeat (rooms, doors, labels…): place those instead. */
  left: string[];
  /** How many copies of the segment were laid side by side. */
  tiles: number;
}

/** Nature props (trees, rocks, plants) and decals turn freely; furniture keeps its facing. */
function turnsFreely(asset: string): boolean {
  const c = assetInfo(asset)?.category;
  return c === 'nature' || c === 'decals';
}

/** The part of the region that is at least `margin` squares from the map's rooms and corridors. */
export function fillArea(map: DelveMap, region: Shape, margin = 0.5): PathsD {
  const area = [shapePath(region)];
  const { add } = floorParts(map); // cutouts don't count: a pit in a room is still the room
  if (!add.length) return area;
  const floor = unionD(add, [], FillRule.NonZero, PRECISION);
  // rough walls bulge out of the floor's outline, so keep clear of the bulges too
  const d = Math.max(0, margin) + maxBulge(map);
  const grown = d > 0 ? inflatePathsD(floor, d, JoinType.Miter, EndType.Polygon, 2, PRECISION) : floor;
  return differenceD(area, grown, FillRule.NonZero, PRECISION);
}

/** Does the segment a–b touch the (closed) box? Liang–Barsky. */
function segmentHitsBox(ax: number, ay: number, bx: number, by: number, box: Bounds): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - box.x0) && clip(dx, box.x1 - ax) && clip(-dy, ay - box.y0) && clip(dy, box.y1 - ay);
}

/** Even-odd point test over flat paths (outer rings and holes). */
function inPaths(paths: PathsD, x: number, y: number): boolean {
  let inside = false;
  for (const ring of paths) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Is the whole box inside the area? No edge of the area may cross it, and its centre must be in. */
function boxInside(b: Bounds, area: PathsD): boolean {
  const box: Bounds = { x0: b.x0 + EPS, y0: b.y0 + EPS, x1: b.x1 - EPS, y1: b.y1 - EPS };
  for (const ring of area) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const c = ring[(i + 1) % ring.length]!;
      if (segmentHitsBox(a.x, a.y, c.x, c.y, box)) return false;
    }
  }
  return inPaths(area, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
}

const shiftPaths = (paths: PathsD, dx: number, dy: number): PathsD => paths.map((ring) => ring.map((p) => ({ x: p.x + dx, y: p.y + dy })));

/**
 * Tile the segment's props and terrain over a region, e.g. "fill the land
 * around these rooms with the Mixed Forest segment". Copies are laid side by
 * side from the region's top-left corner. A prop is left out when its
 * footprint would reach within `margin` of the map's rooms or corridors, stick
 * out of the region, overlap a prop already on the map (or one from another
 * copy), or stand on the map's own terrain of another kind (no trees in the
 * river). Terrain: per tile kind, the union of the copies, cut to the region
 * minus the floor grown by the margin; the rooms become holes in it.
 */
export function fillSegmentOps(map: DelveMap, segment: SegmentContent, region: Shape, opts: FillOptions = {}): FillResult {
  const [w, h] = segment.size;
  if (!(w > 0 && h > 0)) throw new ValidationError(['the segment has no size']);
  const props = segment.objects.filter((o): o is Prop => o.type === 'prop');
  const tiles = segment.objects.filter((o): o is Terrain => o.type === 'terrain');
  const left = [...new Set(segment.objects.filter((o) => o.type !== 'prop' && o.type !== 'terrain').map((o) => o.type))];
  if (!props.length && !tiles.length) {
    throw new ValidationError([`a fill repeats props and terrain, and this segment has neither (it has ${countsText(segmentCounts(segment.objects))}); place it instead`]);
  }
  const rb = shapeBounds(region);
  const x0 = Math.floor(rb.x0);
  const y0 = Math.floor(rb.y0);
  const nx = Math.max(1, Math.ceil((rb.x1 - x0) / w - EPS));
  const ny = Math.max(1, Math.ceil((rb.y1 - y0) / h - EPS));
  if (nx * ny > MAX_TILES) {
    throw new ValidationError([`that area would take ${nx * ny} copies of a ${w}×${h} segment (at most ${MAX_TILES}): use a smaller area or a bigger segment`]);
  }
  const allowed = fillArea(map, region, Math.max(0, opts.margin ?? 0.5));
  const vary = opts.vary ?? true;
  const rand = rng(opts.seed ?? 1);
  const ownKinds = new Set(tiles.map((t) => t.asset));
  const foreign = map.objects.filter((o): o is Terrain => o.type === 'terrain' && !ownKinds.has(o.asset)).map((t) => polygonsOf(terrainArea(t)));
  const taken = map.objects.flatMap((o) => (o.type === 'prop' ? [propBounds(o)] : []));

  const placed: { b: Bounds; tile: number }[] = [];
  const newProps: Prop[] = [];
  const areas = new Map<string, { paths: PathsD; name?: string }>();
  let skipped = 0;
  let tile = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++, tile++) {
      const ox = x0 + i * w;
      const oy = y0 + j * h;
      for (const p of props) {
        let at: Point = [r6(p.at[0] + ox), r6(p.at[1] + oy)];
        let rotation = p.rotation ?? 0;
        if (vary) {
          at = [r2(at[0] + (rand() - 0.5) * 0.6), r2(at[1] + (rand() - 0.5) * 0.6)];
          if (turnsFreely(p.asset)) rotation = Math.floor(rand() * 360);
        }
        const { rotation: _r, ...rest } = p;
        const copy: Prop = { ...structuredClone(rest), at, ...(fold(rotation) ? { rotation: fold(rotation) } : {}) };
        const b = propBounds(copy);
        const blocked =
          !boxInside(b, allowed) ||
          taken.some((t) => footprintsOverlap(t, b)) ||
          placed.some((o) => o.tile !== tile && footprintsOverlap(o.b, b)) ||
          foreign.some((f) => insidePolygons(f, at));
        if (blocked) {
          skipped++;
          continue;
        }
        placed.push({ b, tile });
        newProps.push(copy);
      }
      for (const t of tiles) {
        const e = areas.get(t.asset) ?? { paths: [], ...(t.name ? { name: t.name } : {}) };
        e.paths.push(...shiftPaths(terrainArea(t), ox, oy));
        areas.set(t.asset, e);
      }
    }
  }

  const newTerrain: Terrain[] = [];
  for (const [asset, e] of areas) {
    const joined = unionD(e.paths, [], FillRule.NonZero, PRECISION);
    for (const poly of polygonsOf(intersectD(joined, allowed, FillRule.NonZero, PRECISION))) {
      // leave out slivers too thin to read as ground
      if (ringArea(poly.outer) - poly.holes.reduce((s, r) => s + ringArea(r), 0) < 0.25) continue;
      newTerrain.push({ id: '', type: 'terrain', asset, shape: ringShape(poly.outer), ...(poly.holes.length ? { holes: poly.holes } : {}), ...(e.name ? { name: e.name } : {}) });
    }
  }
  newTerrain.forEach((t, k) => (t.id = nextId(map, 't', k)));
  newProps.forEach((p, k) => (p.id = nextId(map, 'i', k)));
  return {
    ops: [...newTerrain.map((object, index): Op => ({ op: 'add', object, index })), ...newProps.map((object): Op => ({ op: 'add', object }))],
    ids: [...newTerrain, ...newProps].map((o) => o.id),
    props: newProps.length,
    terrain: newTerrain.length,
    skipped,
    left,
    tiles: nx * ny,
  };
}

/** The region "around the rooms": the bounds of the map's rooms, corridors, doors, stairs and cutouts (or of everything, if it has none), grown by `squares` and snapped to whole squares. */
export function regionAround(map: DelveMap, squares = 5): Shape | null {
  const built = map.objects.filter((o) => BUILT.has(o.type));
  const b = unionBounds((built.length ? built : map.objects).map((o) => tightBounds(o, map)));
  if (!b) return null;
  const n = Math.max(0, squares);
  const x0 = Math.floor(b.x0 - n);
  const y0 = Math.floor(b.y0 - n);
  return { rect: [x0, y0, Math.max(1, Math.ceil(b.x1 + n) - x0), Math.max(1, Math.ceil(b.y1 + n) - y0)] };
}
