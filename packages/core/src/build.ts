// Building helpers shared by the MCP tools and the editor: fresh ids, the next
// room number, and "connect these rooms" as ops.
import { corridorPath, corridorRoute, roomsById } from './geometry/corridors.ts';
import { doorBetween, doorCentre, doorFromCentre, doorSegment } from './geometry/doors.ts';
import { pointInShape, shapeArea, shapeBounds, shapePath } from './geometry/shapes.ts';
import type { Op } from './ops.ts';
import type { Corridor, DelveMap, Door, Point, Room } from './schema.ts';

/** Next free id with this prefix: r1, r2, … (counts only ids shaped like prefix + number). */
export function nextId(map: DelveMap, prefix: string, skip = 0): string {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[^A-Za-z0-9_-]/g, '')}(\\d+)$`);
  for (const o of map.objects) {
    const m = re.exec(o.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1 + skip}`;
}

/** The room number after the highest numeric room label. */
export function nextLabel(map: DelveMap): string {
  let max = 0;
  for (const o of map.objects) if (o.type === 'room' && /^\d+$/.test(o.label ?? '')) max = Math.max(max, Number(o.label));
  return String(max + 1);
}

/** A door across the corridor mouth at one end of a routed path (turned square to the path where its end runs slantwise). */
export function doorAtEnd(path: readonly Point[], end: 'start' | 'end', width: number): Pick<Door, 'at' | 'along' | 'angle'> {
  const [p, q] = end === 'start' ? [path[0]!, path[1]!] : [path.at(-1)!, path.at(-2)!];
  if (p[0] !== q[0] && p[1] !== q[1]) return doorFromCentre(p, (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI + 90, width);
  return p[0] === q[0] ? { at: [p[0] - width / 2, p[1]], along: 'x' } : { at: [p[0], p[1] - width / 2], along: 'y' };
}

/**
 * The ids to move when moving `ids`: the objects themselves plus any door
 * whose midpoint sits on the edge (or inside) of a moved room, so corridor
 * doors and wall doors travel with their room.
 */
export function withAttachedDoors(map: DelveMap, ids: readonly string[]): string[] {
  const out = new Set(ids);
  const moved = map.objects.filter((o) => o.type === 'room' && out.has(o.id)) as Extract<DelveMap['objects'][number], { type: 'room' }>[];
  if (!moved.length) return [...out];
  const eps = 1e-6;
  for (const o of map.objects) {
    if (o.type !== 'door' || out.has(o.id)) continue;
    const mid = doorCentre(o);
    for (const r of moved) {
      const b = shapeBounds(r.shape);
      if (mid[0] >= b.x0 - eps && mid[0] <= b.x1 + eps && mid[1] >= b.y0 - eps && mid[1] <= b.y1 + eps) {
        out.add(o.id);
        break;
      }
    }
  }
  return [...out];
}

export interface ConnectOptions {
  width?: number;
  doors?: 'none' | 'from' | 'to' | 'both';
  doorStyle?: Door['style'];
  id?: string;
}

export interface ConnectPlan {
  ops: Op[];
  corridor: Corridor;
  path: Point[];
  doorIds: string[];
}

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectError';
  }
}

/** Ops that add an auto-routed corridor between two rooms, with doors across its mouths if asked. */
export function connectOps(map: DelveMap, from: string, to: string, opts: ConnectOptions = {}): ConnectPlan {
  const rooms = roomsById(map);
  for (const r of [from, to]) if (!rooms.has(r)) throw new ConnectError(`no room with id "${r}"`);
  if (from === to) throw new ConnectError('pick two different rooms');
  const width = opts.width ?? 2;
  // routed to the rooms' real outlines; doors go across its mouths, turned in slanted walls
  const corridor: Corridor = { id: opts.id ?? nextId(map, 'c'), type: 'corridor', from, to, width, route: 'outline' };
  const route = corridorRoute(corridor, rooms);
  if (!route) throw new ConnectError(`${from} and ${to} overlap, so there is nothing to connect`);
  const path = route.path;
  const ends = opts.doors === 'both' ? (['start', 'end'] as const) : opts.doors === 'from' ? (['start'] as const) : opts.doors === 'to' ? (['end'] as const) : [];
  const doorIds = ends.map((_, i) => nextId(map, 'd', i));
  const ops: Op[] = [{ op: 'add', object: corridor }];
  ends.forEach((end, i) => {
    ops.push({ op: 'add', object: { id: doorIds[i]!, type: 'door', ...mouthDoor(route.mouths[end === 'start' ? 0 : 1]), style: opts.doorStyle ?? 'normal' } });
  });
  return { ops, corridor, path, doorIds };
}

// ---------- doors across corridor mouths, rerouting to the rooms' real outlines ----------

/**
 * The door across a corridor's mouth, from one corner of it to the other
 * (core doorBetween): along x or y where the mouth lies on an axis (as doors
 * at box rooms always were), turned in a slanted or curved wall.
 */
export function mouthDoor([a, b]: readonly [Point, Point]): Pick<Door, 'at' | 'along' | 'angle' | 'width'> {
  return doorBetween(a, b, false);
}

export interface RerouteResult {
  /** One undo step: the corridors switched to outline routing, their doors moved to the new mouths. */
  ops: Op[];
  rerouted: { id: string; from: string; to: string; path: Point[]; doors: string[] }[];
  skipped: { id: string; reason: string }[];
}

const distTo = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/** The room a corridor's end runs into: the smallest one around the point, else the nearest outline within reach. */
function roomAtEnd(rooms: readonly Room[], p: Point, reach: number): Room | undefined {
  const inside = rooms.filter((r) => pointInShape(r.shape, p)).sort((a, b) => shapeArea(a.shape) - shapeArea(b.shape));
  if (inside.length) return inside[0];
  let best: Room | undefined;
  let near = reach;
  for (const r of rooms) {
    const ring = shapePath(r.shape).map((q) => [q.x, q.y] as Point);
    for (let i = 0; i < ring.length; i++) {
      const d = distTo(p, ring[i]!, ring[(i + 1) % ring.length]!);
      if (d <= near) {
        near = d;
        best = r;
      }
    }
  }
  return best;
}

/**
 * The doors across a corridor's end: their middle within the corridor's width
 * of its last stretch, at most a couple of squares from the end, running
 * across it rather than along.
 */
function doorsAtEnd(doors: readonly Door[], path: readonly Point[], end: 'start' | 'end', width: number): Door[] {
  const [e, q] = end === 'start' ? [path[0]!, path[1]!] : [path.at(-1)!, path.at(-2)!];
  const len = Math.hypot(q[0] - e[0], q[1] - e[1]) || 1;
  const u: Point = [(q[0] - e[0]) / len, (q[1] - e[1]) / len];
  return doors.filter((d) => {
    const m = doorCentre(d);
    const [a, b] = doorSegment(d);
    const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const along = (m[0] - e[0]) * u[0] + (m[1] - e[1]) * u[1];
    const across = Math.abs((m[0] - e[0]) * -u[1] + (m[1] - e[1]) * u[0]);
    const square = Math.abs(((b[0] - a[0]) * u[0] + (b[1] - a[1]) * u[1]) / dl) < 0.5;
    return square && across <= width / 2 + 0.3 && along >= -1 && along <= Math.max(2, width + 1) && dl >= width / 2;
  });
}

/**
 * Re-route corridors (all of them, or `ids`) to their rooms' real outlines
 * (Corridor.route "outline"): a corridor with its own path goes back to
 * following its rooms (found from its ends when it has no from/to), and the
 * doors across its old ends move to the new mouths. Corridors that already
 * route that way only get their doors straightened out.
 */
export function rerouteOps(map: DelveMap, ids?: readonly string[]): RerouteResult {
  const rooms = roomsById(map);
  const roomList = [...rooms.values()];
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const out: RerouteResult = { ops: [], rerouted: [], skipped: [] };
  const want = ids ? new Set(ids) : null;
  if (want) for (const id of want) if (!map.objects.some((o) => o.id === id && o.type === 'corridor')) out.skipped.push({ id, reason: `no corridor with id "${id}"` });
  const taken = new Set<string>();
  for (const c of map.objects) {
    if (c.type !== 'corridor' || (want && !want.has(c.id))) continue;
    const old = corridorPath(c, rooms);
    let from = c.from && rooms.has(c.from) ? c.from : undefined;
    let to = c.to && rooms.has(c.to) ? c.to : undefined;
    // a corridor with its own path: the rooms its ends run into
    const ends = old && c.path ? [roomAtEnd(roomList, old[0]!, c.width / 2 + 1)?.id, roomAtEnd(roomList, old.at(-1)!, c.width / 2 + 1)?.id] : [from, to];
    if (old && (!from || !to)) {
      const other = (x: string | undefined) => ends.find((e) => e && e !== x);
      if (!from && !to) [from, to] = ends;
      else if (!to) to = other(from);
      else from = other(to);
    }
    if (!from || !to || from === to) {
      out.skipped.push({ id: c.id, reason: "it doesn't run between two rooms" });
      continue;
    }
    const next: Corridor = { ...c, from, to, route: 'outline' };
    delete next.path;
    const route = corridorRoute(next, rooms);
    if (!route) {
      out.skipped.push({ id: c.id, reason: `${from} and ${to} overlap` });
      continue;
    }
    const set: Record<string, unknown> = {};
    if (c.route !== 'outline') set.route = 'outline';
    if (c.from !== from) set.from = from;
    if (c.to !== to) set.to = to;
    if (Object.keys(set).length || c.path) out.ops.push({ op: 'update', id: c.id, ...(Object.keys(set).length ? { set } : {}), ...(c.path ? { unset: ['path'] } : {}) });
    const moved: string[] = [];
    if (old) {
      // the old path's first end may lie in `to` (a hand-made path drawn the other way)
      const flipped = ends[0] === to && ends[1] !== to;
      (['start', 'end'] as const).forEach((end, i) => {
        const mouth = route.mouths[flipped ? 1 - i : i]!;
        for (const d of doorsAtEnd(doors, old, end, c.width)) {
          if (taken.has(d.id)) continue;
          taken.add(d.id);
          const { angle, ...fields } = mouthDoor(mouth);
          if (fields.at[0] === d.at[0] && fields.at[1] === d.at[1] && fields.along === d.along && fields.width === d.width && angle === d.angle) continue;
          out.ops.push({ op: 'update', id: d.id, set: { ...fields, ...(angle !== undefined ? { angle } : {}) }, ...(angle === undefined && d.angle !== undefined ? { unset: ['angle'] } : {}) });
          moved.push(d.id);
        }
      });
    }
    out.rerouted.push({ id: c.id, from, to, path: route.path, doors: moved });
  }
  return out;
}
