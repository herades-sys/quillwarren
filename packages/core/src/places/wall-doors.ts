// Doors by meaning: MCP add_door {"room": "r2", "wall": "north"} puts the door
// in the middle of room 2's north wall, or the free stretch of it nearest the
// middle (corridor mouths, merged rooms and other doors take parts of a wall).
// Box rooms get a plain door on whole or half squares; other shapes a door
// centred on their most northern (eastern…) wall, turned to match it.
import { doorCentre, doorOnWall, doorSegment } from '../geometry/doors.ts';
import { computeFloor } from '../geometry/floor.ts';
import { pointInShape, shapeBounds, shapePath, type Polygon } from '../geometry/shapes.ts';
import { boundarySegments, placeDoorBetween, type Segment } from '../geometry/walls.ts';
import type { DelveMap, Door, Point } from '../schema.ts';
import { ValidationError } from '../validate.ts';
import { fmt, objectArea, objectTitle, SIDE_VECTOR, squares, type Side } from './common.ts';

export interface WallDoor {
  line: Pick<Door, 'at' | 'along' | 'angle'>;
  width: number;
  /** "on the north wall of room 2 Crossroads (r2), leads outside". */
  text: string;
}

const EPS = 1e-6;

/** What lies on the other side of a door from `room`: another room, a corridor, or nothing (outside). */
export function doorLeadsTo(map: DelveMap, roomId: string, mid: Point, out: Point): string {
  const p: Point = [mid[0] + out[0] * 0.5, mid[1] + out[1] * 0.5];
  for (const o of map.objects) {
    if (o.id === roomId) continue;
    if (o.type === 'room' && pointInShape(o.shape, p)) return `into ${objectTitle(o)}`;
  }
  for (const o of map.objects) {
    if (o.type !== 'corridor') continue;
    const a = objectArea(map, o.id);
    if (a && a.polygons.some((g) => pointInShape({ poly: g.outer }, p))) return `onto corridor ${o.id}`;
  }
  return 'leads outside';
}

const fits = (f: () => unknown): boolean => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};

/** Intervals [lo, hi] minus `cut` intervals. */
function subtract(pieces: [number, number][], cut: [number, number][]): [number, number][] {
  let out = pieces;
  for (const [c0, c1] of cut) {
    out = out.flatMap(([a, b]) => {
      if (c1 <= a || c0 >= b) return [[a, b] as [number, number]];
      const keep: [number, number][] = [];
      if (c0 > a) keep.push([a, c0]);
      if (c1 < b) keep.push([c1, b]);
      return keep;
    });
  }
  return out;
}

/**
 * A door `width` squares long on one wall of a room. Throws a ValidationError
 * naming the room and wall when that wall has no free stretch long enough.
 */
export function doorOnRoomWall(map: DelveMap, roomId: string, side: Side, width: number, opts: { suggest?: boolean } = {}): WallDoor {
  const room = map.objects.find((o) => o.id === roomId);
  if (!room || room.type !== 'room') throw new ValidationError([`room: there is no room "${roomId}"`]);
  const floor = computeFloor(map);
  const segs = boundarySegments(floor);
  const title = objectTitle(room);
  const out = SIDE_VECTOR[side];
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  if ('rect' in room.shape) {
    const b = shapeBounds(room.shape);
    const horizontal = side === 'north' || side === 'south';
    const line = side === 'north' ? b.y0 : side === 'south' ? b.y1 : side === 'west' ? b.x0 : b.x1;
    const lo = horizontal ? b.x0 : b.y0;
    const hi = horizontal ? b.x1 : b.y1;
    const fixed = horizontal ? 1 : 0;
    const run = horizontal ? 0 : 1;
    // the wall that is really there along this side: corridor mouths and rooms built onto it leave gaps
    const pieces: [number, number][] = [];
    for (const [p, q] of segs) {
      if (Math.abs(p[fixed] - line) > EPS || Math.abs(q[fixed] - line) > EPS) continue;
      const a = Math.max(lo, Math.min(p[run], q[run]));
      const c = Math.min(hi, Math.max(p[run], q[run]));
      if (c - a > EPS) pieces.push([a, c]);
    }
    const taken: [number, number][] = doors.flatMap((d) => {
      const [p, q] = doorSegment(d);
      if (Math.abs(p[fixed] - line) > 0.05 || Math.abs(q[fixed] - line) > 0.05) return [];
      return [[Math.min(p[run], q[run]) - 0.5, Math.max(p[run], q[run]) + 0.5] as [number, number]];
    });
    const mid = (lo + hi) / 2;
    const pick = (margin: number): number | null => {
      let best: number | null = null;
      for (const [a0, a1] of subtract(pieces, taken)) {
        // half a square off corners, corridor mouths and other doors where the stretch is long enough
        const a = a0 + margin;
        const c = a1 - margin;
        if (c - a < width - EPS) continue;
        const want = Math.min(c - width, Math.max(a, mid - width / 2));
        for (const s of [Math.round(want * 2) / 2, want]) {
          if (s < a - EPS || s + width > c + EPS) continue;
          if (best === null || Math.abs(s + width / 2 - mid) < Math.abs(best + width / 2 - mid) - EPS) best = s;
          break;
        }
      }
      return best;
    };
    const s = pick(0.5) ?? pick(0);
    if (s === null) {
      const why = pieces.length ? 'corridors, rooms built onto it or other doors take the rest of it' : 'there is no wall there (a corridor or another room opens onto that whole side)';
      // what to do instead: a door already in that wall can change its style, and other walls may be free
      const there = doors.filter((d) => {
        const [p, q] = doorSegment(d);
        return Math.abs(p[fixed] - line) <= 0.05 && Math.abs(q[fixed] - line) <= 0.05 && Math.max(p[run], q[run]) > lo - EPS && Math.min(p[run], q[run]) < hi + EPS;
      });
      const restyle = there.length ? ` Door ${there.map((d) => `${d.id} (${d.style ?? 'normal'})`).join(', ')} is in that wall already: update {"id": "${there[0]!.id}", "set": {"style": "secret"}} changes its style.` : '';
      const free = opts.suggest === false ? [] : (['north', 'south', 'east', 'west'] as const).filter((w) => w !== side && fits(() => doorOnRoomWall(map, roomId, w, width, { suggest: false })));
      const other = free.length ? ` Free walls of ${roomId}: ${free.join(', ')}.` : '';
      throw new ValidationError([`wall: no free stretch of ${squares(width)} on the ${side} wall of ${roomId}: ${why}.${restyle}${other}`]);
    }
    const at: Point = horizontal ? [s, line] : [line, s];
    const lineOut = { at, along: horizontal ? ('x' as const) : ('y' as const) };
    const centre = doorCentre({ ...lineOut, width });
    const middle = Math.abs(s + width / 2 - mid) < 0.51;
    return { line: lineOut, width, text: `on the ${side} wall of ${title}${middle ? ', in its middle' : `, ${squares(Math.abs(s + width / 2 - mid))} off its middle (the middle is taken)`}, ${doorLeadsTo(map, roomId, centre, out)}` };
  }
  // other shapes: the wall stretch on this room's outline that lies furthest that way
  const ring = shapePath(room.shape).map((p) => [p.x, p.y] as Point);
  const onOutline = (m: Point) =>
    ring.some((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const t = Math.max(0, Math.min(1, ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(m[0] - p[0] - dx * t, m[1] - p[1] - dy * t) < 0.02;
    });
  const near = (m: Point) => doors.some((d) => Math.hypot(doorCentre(d)[0] - m[0], doorCentre(d)[1] - m[1]) < width + 0.5);
  let best: { s: Segment; m: Point; score: number } | null = null;
  for (const s of segs) {
    const [p, q] = s;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < EPS) continue;
    const m: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (!onOutline(m) || near(m)) continue;
    let n: Point = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
    if (pointInShape(room.shape, [m[0] + n[0] * 0.1, m[1] + n[1] * 0.1])) n = [-n[0], -n[1]];
    const facing = n[0] * out[0] + n[1] * out[1];
    if (facing < 0.5) continue;
    const score = (m[0] * out[0] + m[1] * out[1]) * 10 + facing + Math.min(len, width) * 2;
    if (!best || score > best.score) best = { s, m, score };
  }
  if (!best) throw new ValidationError([`wall: ${roomId} has no free wall facing ${side}`]);
  const ends = doorOnWall(floor as Polygon[], best.m, width);
  if (!ends) throw new ValidationError([`wall: ${roomId} has no free wall facing ${side}`]);
  const placed = placeDoorBetween(floor, ends[0], ends[1]);
  const centre: Point = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
  return { line: { at: placed.at, along: placed.along, ...(placed.angle !== undefined ? { angle: placed.angle } : {}) }, width: placed.width, text: `on the ${side} wall of ${title}, ${doorLeadsTo(map, roomId, centre, out)}` };
}
