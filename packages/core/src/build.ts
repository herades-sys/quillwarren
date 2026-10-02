// Building helpers shared by the MCP tools and the editor: fresh ids, the next
// room number, and "connect these rooms" as ops.
import { corridorPath, roomsById } from './geometry/corridors.ts';
import { doorCentre, doorFromCentre } from './geometry/doors.ts';
import { shapeBounds } from './geometry/shapes.ts';
import type { Op } from './ops.ts';
import type { Corridor, DelveMap, Door, Point } from './schema.ts';

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
  const corridor: Corridor = { id: opts.id ?? nextId(map, 'c'), type: 'corridor', from, to, width };
  const path = corridorPath(corridor, rooms);
  if (!path) throw new ConnectError(`${from} and ${to} overlap, so there is nothing to connect`);
  const ends = opts.doors === 'both' ? (['start', 'end'] as const) : opts.doors === 'from' ? (['start'] as const) : opts.doors === 'to' ? (['end'] as const) : [];
  const doorIds = ends.map((_, i) => nextId(map, 'd', i));
  const ops: Op[] = [{ op: 'add', object: corridor }];
  ends.forEach((end, i) => {
    ops.push({ op: 'add', object: { id: doorIds[i]!, type: 'door', ...doorAtEnd(path, end, width), width, style: opts.doorStyle ?? 'normal' } });
  });
  return { ops, corridor, path, doorIds };
}
