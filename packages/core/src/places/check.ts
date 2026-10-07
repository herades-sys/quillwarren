// Checking a map's layout: rooms that overlap or touch (they merge), corridors
// through rooms they don't join, doors that aren't on a wall, props half
// outside their room, on top of each other or in a doorway, height areas off
// the ground. MCP check_map lists them; every building tool ends its reply
// with a short check of what it just made (checkObjects).
import { assetInfo, propBounds } from '../assets/catalog.ts';
import { isObstacle, propsOverlap } from '../placement.ts';
import { corridorPath, endMouth, roomsById } from '../geometry/corridors.ts';
import { doorCentre } from '../geometry/doors.ts';
import { floorPaths } from '../geometry/floor.ts';
import { pointInShape, shapeBounds, shapePath, type Bounds } from '../geometry/shapes.ts';
import { groundPaths } from '../heights.ts';
import type { DelveMap, Door, MapObject, Point, Prop, Room } from '../schema.ts';
import { boxArea, boxGap, boxOverlap, boxPath, fmt, intersectArea, objectArea, pathsArea, squares, standsUp, type ObjectArea } from './common.ts';
import { doorwayZones } from './props.ts';
import { corridorThrough } from './rooms.ts';
import { EndType, inflatePathsD, JoinType } from 'clipper2-ts';
import { PRECISION } from '../geometry/shapes.ts';

export type ProblemKind =
  | 'rooms-overlap'
  | 'rooms-touch'
  | 'corridor-through-room'
  | 'corridor-duplicate'
  | 'corridor-unconnected'
  | 'door-off-wall'
  | 'prop-outside-room'
  | 'prop-stray'
  | 'prop-overlap'
  | 'prop-in-doorway'
  | 'height-off-ground';

export interface Problem {
  kind: ProblemKind;
  /** The objects it is about; the first is the one to fix. */
  ids: string[];
  text: string;
}

/** Categories of things that belong outdoors or anywhere: they may stand outside the rooms. */
const OUTDOOR = new Set(['nature', 'trees', 'plants', 'rocks', 'ruins', 'camp', 'water', 'cartography', 'symbols', 'climb', 'market', 'portals', 'magic', 'arcane', 'decals', 'carpets', 'traps', 'trapdoors', 'light']);

const roomList = (map: DelveMap): Room[] => map.objects.filter((o): o is Room => o.type === 'room');
const label = (map: DelveMap, id: string) => {
  const o = map.objects.find((x) => x.id === id);
  if (o?.type === 'prop') return `${id} (${assetInfo(o.asset)?.name ?? o.asset})`;
  return id;
};

/** The side of `room` a box sticks out past: "north", "south and east"… */
function sticksOut(fp: Bounds, room: Bounds): string {
  const s = [fp.y0 < room.y0 - 1e-6 ? 'north' : '', fp.y1 > room.y1 + 1e-6 ? 'south' : '', fp.x1 > room.x1 + 1e-6 ? 'east' : '', fp.x0 < room.x0 - 1e-6 ? 'west' : ''].filter(Boolean);
  return s.length ? `the ${s.join(' and ')} wall` : 'its wall';
}

/** The room whose shape holds p (smallest first). */
function roomHolding(map: DelveMap, p: Point): Room | undefined {
  return roomList(map)
    .filter((r) => pointInShape(r.shape, p))
    .sort((a, b) => boxArea(shapeBounds(a.shape)) - boxArea(shapeBounds(b.shape)))[0];
}

interface Report {
  problems: Problem[];
  /** What is fine, in a few words ("inside r2, no overlaps, doorways clear"). */
  fine: string[];
}

function propReport(map: DelveMap, p: Prop, areas: Map<string, ObjectArea>, ground?: ReturnType<typeof groundPaths>): Report {
  const problems: Problem[] = [];
  const fine: string[] = [];
  const fp = propBounds(p);
  const name = label(map, p.id);
  const info = assetInfo(p.asset);
  const standing = standsUp(p.asset);
  const room = roomHolding(map, p.at);
  const area = (id: string) => {
    let a = areas.get(id);
    if (!a) {
      a = objectArea(map, id)!;
      areas.set(id, a);
    }
    return a;
  };
  if (room) {
    const inside = boxArea(fp) > 0 ? intersectArea(boxPath(fp), area(room.id).paths) / boxArea(fp) : 1;
    if (inside < 0.97) {
      const out = 1 - inside;
      const share = out >= 0.4 ? 'half' : `${Math.round(out * 100)} %`;
      problems.push({ kind: 'prop-outside-room', ids: [p.id, room.id], text: `${share} of ${name} is outside ${room.id}: it sticks out past ${sticksOut(fp, shapeBounds(room.shape))}` });
    } else fine.push(`inside ${room.id}`);
    if (standing) {
      const zones = doorwayZones(map, area(room.id), 1);
      const hit = zones.find((z) => boxOverlap(z.b, fp) > 0.05);
      if (hit) problems.push({ kind: 'prop-in-doorway', ids: [p.id, hit.id], text: `${name} stands in the doorway of ${hit.id}` });
      else if (zones.length) fine.push('doorways clear');
    }
  } else {
    const into = roomList(map).find((r) => intersectArea(boxPath(fp), area(r.id).paths) > 0.05 * boxArea(fp));
    if (into) problems.push({ kind: 'prop-outside-room', ids: [p.id, into.id], text: `${name} stands across the wall of ${into.id}, mostly outside it` });
    else {
      const g = ground ?? groundPaths(map);
      const onGround = g.length > 0 && intersectArea(boxPath(fp), g) > 0.5 * boxArea(fp);
      if (onGround) fine.push('outdoors, on the terrain');
      else if (info && !OUTDOOR.has(info.category) && !info.canopy) problems.push({ kind: 'prop-stray', ids: [p.id], text: `${name} stands outside every room (on bare rock)` });
      else fine.push('outside the rooms');
    }
  }
  if (standing) {
    const hits = map.objects.filter(
      (o): o is Prop =>
        o.type === 'prop' && o.id !== p.id && standsUp(o.asset) && boxOverlap(propBounds(o), fp) > 1e-6 && (isObstacle(o.asset) && isObstacle(p.asset) ? propsOverlap(o, p) : boxOverlap(propBounds(o), fp) > 0.25),
    );
    if (hits.length) problems.push({ kind: 'prop-overlap', ids: [p.id, ...hits.map((h) => h.id)], text: `${name} overlaps ${hits.slice(0, 4).map((h) => label(map, h.id)).join(', ')}${hits.length > 4 ? ` and ${hits.length - 4} more` : ''}` });
    else fine.push('no overlaps');
  }
  return { problems, fine };
}

/** Does the rooms' outline of a touching pair meet (no gap at all)? */
function touching(a: ObjectArea, b: ObjectArea): boolean {
  if (boxGap(a.bounds, b.bounds) > 1e-6) return false;
  const grown = inflatePathsD(a.paths, 0.01, JoinType.Miter, EndType.Polygon, 2, PRECISION);
  return intersectArea(grown, b.paths) > 1e-6;
}

function roomReport(map: DelveMap, r: Room, areas: Map<string, ObjectArea>): Report {
  const problems: Problem[] = [];
  const fine: string[] = [];
  const me = objectArea(map, r.id)!;
  areas.set(r.id, me);
  let nearest: { id: string; gap: number } | null = null;
  for (const o of roomList(map)) {
    if (o.id === r.id) continue;
    const other = areas.get(o.id) ?? objectArea(map, o.id)!;
    areas.set(o.id, other);
    const gap = boxGap(me.bounds, other.bounds);
    if (gap <= 1e-6) {
      const shared = intersectArea(me.paths, other.paths);
      if (shared > 0.01) problems.push({ kind: 'rooms-overlap', ids: [r.id, o.id], text: `${r.id} and ${o.id} overlap (${fmt(shared)} sq): they merge into one space with no wall between` });
      else if (touching(me, other)) problems.push({ kind: 'rooms-touch', ids: [r.id, o.id], text: `${r.id} touches ${o.id}: no wall between them, so they are one space (leave a gap of 1 square or more and connect them)` });
    }
    if (!nearest || gap < nearest.gap) nearest = { id: o.id, gap };
  }
  const through = map.objects.filter((o) => o.type === 'corridor' && o.from !== r.id && o.to !== r.id).flatMap((c) => {
    const path = corridorPath(c as Extract<MapObject, { type: 'corridor' }>, roomsById(map));
    const corridor = c as Extract<MapObject, { type: 'corridor' }>;
    return path && corridorThrough(map, path, corridor.width, [corridor.from ?? '', corridor.to ?? '']).includes(r.id) && (corridor.from || !endsAt(path, r)) ? [c.id] : [];
  });
  for (const c of through) problems.push({ kind: 'corridor-through-room', ids: [c, r.id], text: `corridor ${c} runs through ${r.id}` });
  if (!problems.length) fine.push(nearest ? `clear of other rooms (nearest ${nearest.id}, ${squares(nearest.gap)} away)` : 'the only room');
  return { problems, fine };
}

/** A drawn corridor (no from/to) that ends at this room counts as its own. */
function endsAt(path: readonly Point[], r: Room): boolean {
  const b = shapeBounds(r.shape);
  return [path[0]!, path[path.length - 1]!].some((p) => boxGap({ x0: p[0], y0: p[1], x1: p[0], y1: p[1] }, b) <= 1.5);
}

function corridorReport(map: DelveMap, c: Extract<MapObject, { type: 'corridor' }>): Report {
  const path = corridorPath(c, roomsById(map));
  if (!path) return { problems: [{ kind: 'corridor-unconnected', ids: [c.id], text: `corridor ${c.id} is not connected (a room it joins is gone)` }], fine: [] };
  const own = [c.from ?? '', c.to ?? ''];
  const hits = corridorThrough(map, path, c.width, own).filter((id) => {
    if (c.from) return true;
    const r = map.objects.find((o) => o.id === id) as Room;
    return !endsAt(path, r);
  });
  const problems: Problem[] = [];
  if (hits.length) problems.push({ kind: 'corridor-through-room', ids: [c.id, ...hits], text: `corridor ${c.id} runs through ${hits.join(', ')}` });
  const twin = doubledBy(map, c);
  if (twin) problems.push({ kind: 'corridor-duplicate', ids: [c.id, twin], text: `corridors ${[c.id, twin].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(' and ')} both join ${c.from} and ${c.to} along the same way: one of them is left over (delete it)` });
  if (problems.length) return { problems, fine: [] };
  return { problems: [], fine: ['clear of the rooms it does not join'] };
}

/** Another corridor joining the same two rooms over mostly the same floor (a second connect for a join that was already made). */
function doubledBy(map: DelveMap, c: Extract<MapObject, { type: 'corridor' }>): string | undefined {
  if (!c.from || !c.to) return undefined;
  const pair = [c.from, c.to].sort().join(' ');
  const mine = objectArea(map, c.id);
  if (!mine) return undefined;
  for (const o of map.objects) {
    if (o.type !== 'corridor' || o.id === c.id || !o.from || !o.to || [o.from, o.to].sort().join(' ') !== pair) continue;
    const other = objectArea(map, o.id);
    if (!other) continue;
    const shared = intersectArea(mine.paths, other.paths);
    if (shared > 0.5 * Math.min(pathsArea(mine.paths), pathsArea(other.paths))) return o.id;
  }
  return undefined;
}

const distToRing = (p: Point, ring: readonly Point[]): number => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return best;
};

/** Which wall of a box room a point on its outline is on. */
function wallWord(p: Point, b: Bounds): string {
  const d: [string, number][] = [
    ['north', Math.abs(p[1] - b.y0)],
    ['south', Math.abs(p[1] - b.y1)],
    ['west', Math.abs(p[0] - b.x0)],
    ['east', Math.abs(p[0] - b.x1)],
  ];
  return d.sort((a, c) => a[1] - c[1])[0]![0];
}

function doorReport(map: DelveMap, d: Door): Report {
  const m = doorCentre(d);
  const rooms = roomList(map);
  const walls = rooms.filter((r) => distToRing(m, shapePath(r.shape).map((q) => [q.x, q.y] as Point)) <= 0.3);
  const byId = roomsById(map);
  const mouths = map.objects.filter((o): o is Extract<MapObject, { type: 'corridor' }> => o.type === 'corridor').filter((c) => {
    const path = corridorPath(c, byId);
    if (!path || path.length < 2) return false;
    return (['start', 'end'] as const).some((e) => distToRing(m, endMouth(path, e, c.width)) <= 0.3);
  });
  if (walls.length) {
    const r = walls[0]!;
    const where = 'rect' in r.shape ? `the ${wallWord(m, shapeBounds(r.shape))} wall of ${r.id}` : `the wall of ${r.id}`;
    return { problems: [], fine: [`on ${where}${walls.length > 1 ? `, between ${walls.map((w) => w.id).join(' and ')}` : mouths.length ? `, across the mouth of ${mouths[0]!.id}` : ''}`] };
  }
  if (mouths.length) return { problems: [], fine: [`across corridor ${mouths[0]!.id}`] };
  const inside = roomHolding(map, m);
  const text = inside
    ? `door ${d.id} is not on a wall: it floats inside ${inside.id}, ${squares(distToRing(m, shapePath(inside.shape).map((q) => [q.x, q.y] as Point)))} from its nearest wall (add_door with room and wall puts one on a wall)`
    : `door ${d.id} is not on a wall: it stands outside every room and corridor`;
  return { problems: [{ kind: 'door-off-wall', ids: [d.id], text }], fine: [] };
}

function heightReport(map: DelveMap, h: Extract<MapObject, { type: 'height' }>, ground?: ReturnType<typeof groundPaths>): Report {
  const g = ground ?? groundPaths(map);
  const a = objectArea(map, h.id)!;
  const total = pathsArea(a.paths);
  const on = g.length ? intersectArea(a.paths, g) : 0;
  if (total > 0 && on / total < 0.5) {
    return { problems: [{ kind: 'height-off-ground', ids: [h.id], text: `only ${Math.round((100 * on) / total)} % of height area ${h.id} lies on floor or terrain; elsewhere it changes nothing (paint terrain there first)` }], fine: [] };
  }
  return { problems: [], fine: [total > 0 && on / total < 0.97 ? `${Math.round((100 * on) / total)} % on floor or terrain` : 'on the ground'] };
}

/**
 * How an area sits with the other terrain and the height areas, so a path drawn
 * in the wrong place shows: "on t1", "off the other terrain (nearest t1, 0.5
 * squares away)", "reaches h1", "does not reach h1 (20.5 squares away)".
 */
function areaRelations(map: DelveMap, self: ObjectArea): string[] {
  const out: string[] = [];
  const own = pathsArea(self.paths);
  const grown = inflatePathsD(self.paths, 0.01, JoinType.Miter, EndType.Polygon, 2, PRECISION);
  const others = (type: 'terrain' | 'height') =>
    map.objects
      .filter((o) => o.type === type && o.id !== self.id)
      .map((o) => {
        const a = objectArea(map, o.id)!;
        return { id: o.id, share: own > 0 ? intersectArea(self.paths, a.paths) / own : 0, meets: intersectArea(grown, a.paths) > 1e-6, gap: boxGap(self.bounds, a.bounds) };
      })
      .sort((a, b) => a.gap - b.gap);
  const terrain = others('terrain');
  if (terrain.length) {
    const on = terrain.filter((x) => x.share > 0.02).sort((a, b) => b.share - a.share);
    const beside = terrain.filter((x) => x.meets && x.share <= 0.02);
    if (on.length) out.push(on.slice(0, 3).map((x) => (x.share >= 0.97 ? `on ${x.id}` : `${Math.round(x.share * 100)} % on ${x.id}`)).join(', '));
    else if (beside.length) out.push(`beside ${beside.slice(0, 3).map((x) => x.id).join(', ')}, not on ${beside.length > 1 ? 'them' : 'it'}`);
    else out.push(`off the other terrain (nearest ${terrain[0]!.id}, ${squares(terrain[0]!.gap)} away)`);
  }
  for (const h of others('height').slice(0, 3)) out.push(h.meets ? `reaches ${h.id}` : `does not reach ${h.id} (${squares(h.gap)} away)`);
  return out;
}

function terrainReport(map: DelveMap, t: Extract<MapObject, { type: 'terrain' }>): Report {
  const a = objectArea(map, t.id)!;
  const floor = floorPaths(map);
  const own = pathsArea(a.paths);
  const onFloor = floor.length ? intersectArea(a.paths, floor) : 0;
  const rooms = roomList(map).filter((r) => boxOverlap(shapeBounds(r.shape), a.bounds) > 0);
  const covered = rooms
    .map((r) => {
      const ra = objectArea(map, r.id)!;
      const share = intersectArea(a.paths, ra.paths) / Math.max(1e-9, pathsArea(ra.paths));
      return { id: r.id, share };
    })
    .filter((x) => x.share > 0.02);
  const relations = areaRelations(map, a);
  if (!covered.length) return { problems: [], fine: [onFloor > 0.05 * own ? 'on the floor' : 'outdoors, outside the rooms', ...relations] };
  return { problems: [], fine: [covered.map((c) => (c.share > 0.97 ? `covers all of ${c.id}` : `covers ${Math.round(c.share * 100)} % of ${c.id}`)).join(', '), ...relations] };
}

function labelReport(map: DelveMap, o: { at: Point }): Report {
  const r = roomHolding(map, o.at);
  return { problems: [], fine: [r ? `in ${r.id}` : 'outside the rooms'] };
}

function reportFor(map: DelveMap, o: MapObject, areas: Map<string, ObjectArea>, ground?: ReturnType<typeof groundPaths>): Report {
  switch (o.type) {
    case 'prop':
      return propReport(map, o, areas, ground);
    case 'room':
      return roomReport(map, o, areas);
    case 'corridor':
      return corridorReport(map, o);
    case 'door':
      return doorReport(map, o);
    case 'height':
      return heightReport(map, o, ground);
    case 'terrain':
      return terrainReport(map, o);
    case 'label':
    case 'marker':
      return labelReport(map, o);
    default:
      return { problems: [], fine: [] };
  }
}

const same = (a: Problem, b: Problem) => a.kind === b.kind && a.ids.length === b.ids.length && [...a.ids].sort().join() === [...b.ids].sort().join();

/** Every layout problem on the map, the worst kinds first. */
export function checkMap(map: DelveMap): Problem[] {
  const areas = new Map<string, ObjectArea>();
  const ground = groundPaths(map);
  const out: Problem[] = [];
  for (const o of map.objects) {
    if (o.type === 'label' || o.type === 'marker' || o.type === 'terrain') continue;
    for (const p of reportFor(map, o, areas, ground).problems) if (!out.some((q) => same(p, q))) out.push(p);
  }
  // one problem seen from both sides ("c3 runs through r1" and "c3 runs through r1, r2"; "i2 overlaps i1" and "i1 overlaps i2, i3"): keep the fuller one
  const covered = (p: Problem, q: Problem) => p !== q && p.kind === q.kind && p.ids.every((id) => q.ids.includes(id)) && (q.ids.length > p.ids.length || out.indexOf(q) < out.indexOf(p));
  const kept = out.filter((p) => !out.some((q) => covered(p, q)));
  const order: ProblemKind[] = ['rooms-overlap', 'corridor-through-room', 'corridor-duplicate', 'door-off-wall', 'rooms-touch', 'corridor-unconnected', 'prop-outside-room', 'prop-overlap', 'prop-in-doorway', 'prop-stray', 'height-off-ground'];
  return kept.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** check_map's reply. */
export function checkMapText(map: DelveMap, max = 40): string {
  const problems = checkMap(map);
  const count = (t: MapObject['type']) => map.objects.filter((o) => o.type === t).length;
  const checked = `${count('room')} rooms, ${count('corridor')} corridors, ${count('door')} doors, ${count('prop')} props, ${count('height')} height areas checked`;
  if (!problems.length) return `No problems found (${checked}): no rooms overlap or touch, corridors keep out of other rooms, doors are on walls, props stand inside their rooms, apart and out of doorways.`;
  const lines = problems.slice(0, max).map((p) => `- ${p.text}`);
  if (problems.length > max) lines.push(`- … and ${problems.length - max} more`);
  return `${problems.length} problem${problems.length === 1 ? '' : 's'} (${checked}):\n${lines.join('\n')}`;
}

/**
 * The short check a building tool ends its reply with, for the objects it just
 * made: "Check: inside r2, no overlaps, doorways clear." or the warnings.
 */
export function checkObjects(map: DelveMap, ids: readonly string[]): string {
  const areas = new Map<string, ObjectArea>();
  const objects = ids.map((id) => map.objects.find((o) => o.id === id)).filter((o): o is MapObject => Boolean(o));
  if (!objects.length) return '';
  const ground = objects.some((o) => o.type === 'prop' || o.type === 'height') ? groundPaths(map) : undefined;
  const reports = objects.map((o) => ({ o, r: reportFor(map, o, areas, ground) }));
  const problems: Problem[] = [];
  for (const { r } of reports) for (const p of r.problems) if (!problems.some((q) => same(p, q))) problems.push(p);
  if (objects.length === 1) {
    const r = reports[0]!.r;
    if (!problems.length) return r.fine.length ? `Check: ${r.fine.join(', ')}.` : '';
    return `Check: WARNING: ${problems.map((p) => p.text).join('; ')}.${r.fine.length ? ` Otherwise ${r.fine.join(', ')}.` : ''}`;
  }
  if (!problems.length) {
    // many objects: say what holds for all of them, in a few words
    const common = reports[0]!.r.fine.map((f) => f.replace(/ \(nearest .*\)$/, '')).filter((f) => reports.every(({ r }) => r.fine.some((g) => g.replace(/ \(nearest .*\)$/, '') === f)));
    return `Check: all ${objects.length} fine${common.length ? `: ${common.join(', ')}` : ''}.`;
  }
  const shown = problems.slice(0, 6).map((p) => p.text);
  return `Check: WARNING: ${shown.join('; ')}${problems.length > 6 ? `; and ${problems.length - 6} more (check_map lists them)` : ''}.`;
}
