// Fog of war. What the players have seen is kept in map.fog: revealed rooms
// and corridors (by id) plus extra `show` areas, minus `hide` areas. The
// visible area grows a little past the floor edge so walls and doors show.
import { differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, unionD, type PathsD } from 'clipper2-ts';
import { propBounds } from './assets/catalog.ts';
import { imageBounds } from './images.ts';
import { corridorOutline, corridorPath, roomsById } from './geometry/corridors.ts';
import { floorPaths, polygonsOf } from './geometry/floor.ts';
import { maxBulge } from './geometry/rough.ts';
import { terrainArea } from './geometry/terrain.ts';
import { PRECISION, shapeBounds, shapePath, type Bounds, type Polygon } from './geometry/shapes.ts';
import type { DelveMap, Fog, MapObject, Shape } from './schema.ts';
import { ValidationError } from './validate.ts';

/** How far past a revealed room's edge the players see: enough for its walls and doors. */
const MARGIN = 0.3;

function outlineOf(o: MapObject, map: DelveMap): PathsD {
  if (o.type === 'terrain') return terrainArea(o); // without its holes (the rooms inside a forest)
  if ('shape' in o) return [shapePath(o.shape)];
  if (o.type === 'corridor') {
    const path = corridorPath(o, roomsById(map));
    return path ? corridorOutline(path, o.width) : [];
  }
  return [];
}

/** The area the players can see, as flat Clipper paths. */
export function visiblePaths(map: DelveMap): PathsD {
  const fog = map.fog;
  if (!fog) return [];
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const add: PathsD = [];
  for (const id of fog.revealed ?? []) {
    const o = byId.get(id);
    if (o) add.push(...outlineOf(o, map));
  }
  for (const s of fog.show ?? []) add.push(shapePath(s));
  if (!add.length) return [];
  const grown = inflatePathsD(unionD(add, [], FillRule.NonZero, PRECISION), MARGIN + maxBulge(map), JoinType.Round, EndType.Polygon, 2, PRECISION);
  const hide = (fog.hide ?? []).map(shapePath);
  return hide.length ? differenceD(grown, hide, FillRule.NonZero, PRECISION) : grown;
}

/** The part of the floor the players have seen (the whole floor when fog is off): the 3D players' view builds slabs from it. */
export function visibleFloor(map: DelveMap): Polygon[] {
  const floor = floorPaths(map);
  if (!map.fog?.on) return polygonsOf(floor);
  const vis = visiblePaths(map);
  return vis.length ? polygonsOf(intersectD(floor, vis, FillRule.NonZero, PRECISION)) : [];
}

/** What the players can see, as polygons: the players' view draws only inside these. */
export function visiblePolygons(map: DelveMap): Polygon[] {
  return polygonsOf(visiblePaths(map));
}

const box = (b: Bounds) => [
  { x: b.x0, y: b.y0 },
  { x: b.x1, y: b.y0 },
  { x: b.x1, y: b.y1 },
  { x: b.x0, y: b.y1 },
];

/**
 * What the GM view shades: everything drawn (floor with its hatching band,
 * terrain, props) that the players haven't seen. Empty when fog is off.
 */
export function fogShade(map: DelveMap, reach: number): Polygon[] {
  if (!map.fog?.on) return [];
  const content: PathsD = [];
  const floor = floorPaths(map);
  if (floor.length) content.push(...inflatePathsD(floor, reach + 0.1, JoinType.Round, EndType.Polygon, 2, PRECISION));
  for (const o of map.objects) {
    if (o.type === 'terrain') content.push(shapePath(o.shape));
    else if (o.type === 'prop') content.push(box(propBounds(o)));
    else if (o.type === 'image') content.push(box(imageBounds(o)));
  }
  return content.length ? polygonsOf(content, visiblePaths(map)) : [];
}

/** What the players have seen, as a box (for fitting the players' screen), or null if nothing yet. */
export function revealedBounds(map: DelveMap): Bounds | null {
  const paths = visiblePaths(map);
  const pts = paths.flat();
  if (!pts.length) return null;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    x0: r(Math.min(...pts.map((p) => p.x))),
    y0: r(Math.min(...pts.map((p) => p.y))),
    x1: r(Math.max(...pts.map((p) => p.x))),
    y1: r(Math.max(...pts.map((p) => p.y))),
  };
}

export interface FogChange {
  on?: boolean;
  /** Rooms or corridors (any object with an area) to reveal, or to cover again. */
  reveal?: string[];
  cover?: string[];
  revealArea?: Shape;
  coverArea?: Shape;
  /** Every room and corridor. */
  revealAll?: boolean;
  /** Forget everything that was revealed. */
  reset?: boolean;
}

const overlaps = (a: Bounds, b: Bounds) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The fog after a change. Revealing turns fog on unless `on` says otherwise; revealing something clears cover-ups over it. */
export function updateFog(map: DelveMap, c: FogChange): Fog {
  const cur = map.fog ?? { on: false };
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const unknown = [...(c.reveal ?? []), ...(c.cover ?? [])].filter((id) => {
    const o = byId.get(id);
    return !o || !outlineOf(o, map).length;
  });
  if (unknown.length) throw new ValidationError([`fog: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a room, corridor or area' : 'are not rooms, corridors or areas'} on this map`]);

  let revealed = c.reset ? [] : [...(cur.revealed ?? [])];
  let show = c.reset ? [] : [...(cur.show ?? [])];
  let hide = c.reset ? [] : [...(cur.hide ?? [])];
  const uncover = (b: Bounds) => (hide = hide.filter((h) => !overlaps(shapeBounds(h), b)));

  if (c.revealAll) {
    revealed = map.objects.filter((o) => o.type === 'room' || o.type === 'corridor').map((o) => o.id);
    hide = [];
  }
  for (const id of c.reveal ?? []) {
    if (!revealed.includes(id)) revealed.push(id);
    const o = byId.get(id)!;
    for (const p of outlineOf(o, map)) {
      const xs = p.map((q) => q.x);
      const ys = p.map((q) => q.y);
      uncover({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  // A corridor between two revealed rooms has been walked (or seen) too.
  if (c.reveal?.length) {
    for (const o of map.objects) {
      if (o.type === 'corridor' && o.from && o.to && revealed.includes(o.from) && revealed.includes(o.to) && !revealed.includes(o.id)) revealed.push(o.id);
    }
  }
  if (c.cover?.length) revealed = revealed.filter((id) => !c.cover!.includes(id));
  if (c.revealArea) {
    show.push(c.revealArea);
    uncover(shapeBounds(c.revealArea));
  }
  if (c.coverArea) hide.push(c.coverArea);

  const revealing = Boolean(c.reveal?.length || c.revealArea || c.revealAll);
  const on = c.on ?? (revealing ? true : cur.on);
  // drop ids of objects that no longer exist, so the list doesn't collect junk
  revealed = revealed.filter((id) => byId.has(id));
  return {
    on,
    ...(revealed.length ? { revealed } : {}),
    ...(show.length ? { show } : {}),
    ...(hide.length ? { hide } : {}),
  };
}

/** One line for people and Claude. */
export function fogSummary(map: DelveMap): string | null {
  const f = map.fog;
  if (!f) return null;
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const names = (f.revealed ?? []).map((id) => {
    const o = byId.get(id);
    return o && 'label' in o && o.label ? `${o.label} ${o.name ?? ''}`.trim() + ` [${id}]` : id;
  });
  const extra = [f.show?.length ? `${f.show.length} extra area${f.show.length === 1 ? '' : 's'}` : '', f.hide?.length ? `${f.hide.length} covered area${f.hide.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `Fog of war: ${f.on ? 'on' : 'off'}. Revealed: ${names.length ? names.join(', ') : 'nothing'}${extra.length ? `; ${extra.join(', ')}` : ''}.`;
}
