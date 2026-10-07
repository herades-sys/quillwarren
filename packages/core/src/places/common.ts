// Shared by the "place by meaning" helpers (places/*.ts): the map's box, the
// area an object covers, compass words and small geometry. North is always the
// top of the map (small y), east the right (big x).
import { areaPathsD, differenceD, FillRule, intersectD, unionD, type PathsD } from 'clipper2-ts';
import { assetInfo, propBounds, propLayer } from '../assets/catalog.ts';
import { corridorOutline, corridorPath, roomsById } from '../geometry/corridors.ts';
import { doorCentre, doorSegment } from '../geometry/doors.ts';
import { floorParts, polygonsOf } from '../geometry/floor.ts';
import { pointInRing, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon } from '../geometry/shapes.ts';
import { imageBounds } from '../images.ts';
import type { DelveMap, MapObject, Point, Shape } from '../schema.ts';
import { ValidationError } from '../validate.ts';

export const SIDES = ['north', 'south', 'east', 'west'] as const;
export type Side = (typeof SIDES)[number];
export const CORNERS = ['ne', 'nw', 'se', 'sw'] as const;
export type Corner = (typeof CORNERS)[number];

export const CORNER_WORDS: Record<Corner, string> = { ne: 'north-east', nw: 'north-west', se: 'south-east', sw: 'south-west' };

/** The outward direction of a side, y down. */
export const SIDE_VECTOR: Record<Side, Point> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** "north", "N", "top"… as a side; undefined for anything else. */
export function sideOf(word: string): Side | undefined {
  const w = word.trim().toLowerCase();
  if (/^(n|north|northern|top|up)$/.test(w)) return 'north';
  if (/^(s|south|southern|bottom|down)$/.test(w)) return 'south';
  if (/^(e|east|eastern|right)$/.test(w)) return 'east';
  if (/^(w|west|western|left)$/.test(w)) return 'west';
  return undefined;
}

/** "ne", "north-east", "northeast", "top right"… as a corner; undefined for anything else. */
export function cornerOf(word: string): Corner | undefined {
  const w = word.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const table: Record<string, Corner> = {
    ne: 'ne', northeast: 'ne', topright: 'ne', righttop: 'ne', en: 'ne', eastnorth: 'ne',
    nw: 'nw', northwest: 'nw', topleft: 'nw', lefttop: 'nw', wn: 'nw', westnorth: 'nw',
    se: 'se', southeast: 'se', bottomright: 'se', rightbottom: 'se', es: 'se', eastsouth: 'se',
    sw: 'sw', southwest: 'sw', bottomleft: 'sw', leftbottom: 'sw', ws: 'sw', westsouth: 'sw',
  };
  return table[w];
}

export const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};
export const fmt = (v: number): string => String(r2(v));
export const span = (a: number, b: number): string => `${fmt(a)}–${fmt(b)}`;
/** "1 square", "2.5 squares". */
export const squares = (v: number): string => `${fmt(v)} square${r2(v) === 1 ? '' : 's'}`;
export const boxText = (b: Bounds): string => `x ${span(b.x0, b.x1)}, y ${span(b.y0, b.y1)}`;

export const boxW = (b: Bounds): number => b.x1 - b.x0;
export const boxH = (b: Bounds): number => b.y1 - b.y0;
export const boxCentre = (b: Bounds): Point => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
export const boxArea = (b: Bounds): number => Math.max(0, boxW(b)) * Math.max(0, boxH(b));
export const boxPath = (b: Bounds): PathsD => [toPath([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]])];
export const rectShape = (b: Bounds): Shape => ({ rect: [r2(b.x0), r2(b.y0), r2(boxW(b)), r2(boxH(b))] });
export function unionBox(list: readonly Bounds[]): Bounds | null {
  if (!list.length) return null;
  return { x0: Math.min(...list.map((b) => b.x0)), y0: Math.min(...list.map((b) => b.y0)), x1: Math.max(...list.map((b) => b.x1)), y1: Math.max(...list.map((b) => b.y1)) };
}
/** How much two boxes overlap (area). */
export function boxOverlap(a: Bounds, b: Bounds): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}
/** The gap between two boxes (0 when they touch or overlap). */
export function boxGap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}
export const inflateBox = (b: Bounds, d: number): Bounds => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

/** Area of flat clipper paths (outer rings positive, holes negative). */
export const pathsArea = (p: PathsD): number => Math.abs(areaPathsD(p));
export const intersectArea = (a: PathsD, b: PathsD): number => (a.length && b.length ? pathsArea(intersectD(a, b, FillRule.NonZero, PRECISION)) : 0);
export const minus = (a: PathsD, b: PathsD): PathsD => (b.length ? differenceD(a, b, FillRule.NonZero, PRECISION) : a);
export const union = (a: PathsD): PathsD => unionD(a, [], FillRule.NonZero, PRECISION);

/** Is p inside these polygons (holes left out)? */
export function inPolygons(polys: readonly Polygon[], p: Point): boolean {
  return polys.some((g) => pointInRing(p, g.outer) && !g.holes.some((h) => pointInRing(p, h)));
}

/** Flat paths for polygons with holes (holes reversed, so NonZero cuts them). */
export function polygonPaths(polys: readonly Polygon[]): PathsD {
  const out: PathsD = [];
  for (const g of polys) {
    const outer = toPath(g.outer);
    out.push(areaPathsD([outer]) < 0 ? outer.reverse() : outer);
    for (const h of g.holes) {
      const hole = toPath(h);
      out.push(areaPathsD([hole]) > 0 ? hole.reverse() : hole);
    }
  }
  return out;
}

/** One object's place on the map: what it is, its outline and its box. */
export interface ObjectArea {
  id: string;
  object: MapObject;
  /** Rooms, terrain, heights, open areas, cutouts, stairs: their shape. */
  shape?: Shape;
  paths: PathsD;
  polygons: Polygon[];
  bounds: Bounds;
  /** "room 2 Crossroads (r2)", "Rectangular Table i1". */
  title: string;
}

const point = (p: Point, r = 0.25): Bounds => ({ x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r });

/** The area an object covers, or null for ids that aren't on the map (or corridors that reach no room). */
export function objectArea(map: DelveMap, id: string): ObjectArea | null {
  const o = map.objects.find((x) => x.id === id);
  if (!o) return null;
  const title = objectTitle(o);
  const fromShape = (shape: Shape, holes?: Point[][]): ObjectArea => {
    const paths: PathsD = [shapePath(shape), ...(holes ?? []).map((h) => toPath(h).reverse())];
    const polygons = polygonsOf([shapePath(shape)], (holes ?? []).map((h) => toPath(h)));
    return { id, object: o, shape, paths: polygonPaths(polygons), polygons, bounds: shapeBounds(shape), title };
  };
  const fromBox = (b: Bounds): ObjectArea => ({ id, object: o, paths: boxPath(b), polygons: [{ outer: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], holes: [] }], bounds: b, title });
  switch (o.type) {
    case 'room':
    case 'cutout':
    case 'stairs':
    case 'opening':
    case 'height':
      return fromShape(o.shape);
    case 'terrain':
      return fromShape(o.shape, o.holes);
    case 'corridor': {
      const path = corridorPath(o, roomsById(map));
      if (!path) return null;
      const outline = corridorOutline(path, o.width);
      const polygons = polygonsOf(outline);
      const pts = polygons.flatMap((g) => g.outer);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { id, object: o, paths: outline, polygons, bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, title };
    }
    case 'prop':
      return fromBox(propBounds(o));
    case 'image':
      return fromBox(imageBounds(o));
    case 'door': {
      const [a, b] = doorSegment(o);
      return fromBox({ x0: Math.min(a[0], b[0]) - 0.1, y0: Math.min(a[1], b[1]) - 0.1, x1: Math.max(a[0], b[0]) + 0.1, y1: Math.max(a[1], b[1]) + 0.1 });
    }
    case 'label':
    case 'marker':
    case 'inscription':
      return fromBox(point(o.at));
  }
}

/** What the ids of each prefix are, for saying which ones a map has. */
const ID_KINDS: Record<string, { type: MapObject['type']; words: string }> = {
  c: { type: 'corridor', words: 'corridors' },
  d: { type: 'door', words: 'doors' },
  i: { type: 'prop', words: 'props' },
  t: { type: 'terrain', words: 'terrain areas' },
  h: { type: 'height', words: 'height areas' },
  l: { type: 'label', words: 'labels' },
};

/** The area of an id, or a ValidationError that says what is there (the rooms, and the ids of the kind asked for). */
export function needArea(map: DelveMap, id: string, field: string): ObjectArea {
  const a = objectArea(map, id);
  if (!a) {
    const of = (type: MapObject['type']) => map.objects.filter((o) => o.type === type).map((o) => o.id);
    const rooms = of('room');
    const kind = ID_KINDS[/^([a-z])\d+$/.exec(String(id).trim())?.[1] ?? ''];
    const same = kind ? of(kind.type) : [];
    const parts = [
      ...(kind ? [`${kind.words}: ${same.length ? same.slice(0, 20).join(', ') : 'none yet'}`] : []),
      ...(rooms.length ? [`rooms: ${rooms.slice(0, 20).join(', ')}`] : []),
    ];
    throw new ValidationError([`${field}: there is no object "${id}" on this map${!map.objects.length ? ' (the map is empty)' : parts.length ? ` (${parts.join('; ')})` : ''}`]);
  }
  return a;
}

export function objectTitle(o: MapObject): string {
  if (o.type === 'room') {
    const named = [o.label, o.name].filter(Boolean).join(' ');
    return named ? `room ${named} (${o.id})` : `room ${o.id}`;
  }
  if (o.type === 'prop') return `${assetInfo(o.asset)?.name ?? o.asset} ${o.id}`;
  if (o.type === 'terrain') return `${assetInfo(o.asset)?.name ?? o.asset} ${o.id}`;
  return `${o.type === 'height' ? 'height area' : o.type} ${o.id}${'name' in o && o.name ? ` "${o.name}"` : ''}`;
}

/** Rooms, corridors, terrain, height areas and the map's own grid.bounds: where "the map" is. Null for an empty map. */
export function mapBox(map: DelveMap): Bounds | null {
  const gb = map.grid.bounds;
  const parts: Bounds[] = gb ? [{ x0: gb[0], y0: gb[1], x1: gb[0] + gb[2], y1: gb[1] + gb[3] }] : [];
  for (const o of map.objects) {
    if (o.type === 'room' || o.type === 'terrain' || o.type === 'height') parts.push(shapeBounds(o.shape));
    else if (o.type === 'corridor') {
      const a = objectArea(map, o.id);
      if (a) parts.push(a.bounds);
    }
  }
  return unionBox(parts);
}

/** The box around the rooms and corridors, or null when there are none. */
export function floorBox(map: DelveMap): Bounds | null {
  return unionBox(
    map.objects.flatMap((o) => {
      if (o.type === 'room') return [shapeBounds(o.shape)];
      if (o.type === 'corridor') {
        const a = objectArea(map, o.id);
        return a ? [a.bounds] : [];
      }
      return [];
    }),
  );
}

/**
 * Is there ground outside the rooms (terrain beyond the floor)? Outdoor maps
 * have it; a dungeon of rooms has none, so "the north edge of the map" there is
 * the strip just north of the rooms.
 */
export function hasOpenGround(map: DelveMap): boolean {
  const terrain = map.objects.flatMap((o) => (o.type === 'terrain' ? [shapePath(o.shape)] : []));
  if (!terrain.length) return false;
  // against the rooms' and corridors' own outlines (pillars and pits inside a room are no open ground)
  const built = floorParts(map).add;
  const ground = union(terrain);
  const open = pathsArea(minus(ground, built));
  return open >= 4 && open >= 0.1 * pathsArea(ground);
}

/**
 * Where a point lies on the map in plain words: "north-west", "north",
 * "middle"… (the map's box cut in thirds each way). North is the top (small y).
 */
export function compassWord(p: Point, box: Bounds): string {
  const third = (v: number, lo: number, hi: number) => (hi - lo < 1e-9 ? 1 : v < lo + (hi - lo) / 3 ? 0 : v > hi - (hi - lo) / 3 ? 2 : 1);
  const col = third(p[0], box.x0, box.x1);
  const row = third(p[1], box.y0, box.y1);
  const ns = ['north', '', 'south'][row]!;
  const ew = ['west', '', 'east'][col]!;
  return ns && ew ? `${ns}-${ew}` : ns || ew || 'middle';
}

/** "in the north-west of the map" / "in the middle of the map". */
export const compassPhrase = (p: Point, box: Bounds): string => {
  const w = compassWord(p, box);
  return w === 'middle' ? 'in the middle of the map' : `in the ${w} of the map`;
};

/** Floor-level props (rugs, decals, trapdoors) and GM symbols aren't in the way of furniture. */
export function standsUp(asset: string): boolean {
  const layer = propLayer(asset);
  return layer === 'props' || layer === 'canopy';
}
export const onFloorLayer = (asset: string): boolean => propLayer(asset) === 'decals';

/** The room whose shape holds p (the smallest when rooms overlap), or undefined. */
export function roomAt(map: DelveMap, p: Point): Extract<MapObject, { type: 'room' }> | undefined {
  let best: Extract<MapObject, { type: 'room' }> | undefined;
  let bestArea = Infinity;
  for (const o of map.objects) {
    if (o.type !== 'room') continue;
    const ring = shapePath(o.shape).map((q) => [q.x, q.y] as Point);
    if (!pointInRing(p, ring)) continue;
    const b = shapeBounds(o.shape);
    const a = boxArea(b);
    if (a < bestArea) {
      best = o;
      bestArea = a;
    }
  }
  return best;
}

/** Door middles and their direction across the wall, for keeping doorways clear. */
export function doorMiddle(d: Extract<MapObject, { type: 'door' }>): Point {
  return doorCentre(d);
}
