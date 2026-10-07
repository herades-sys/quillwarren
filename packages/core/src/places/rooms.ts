// Rooms by meaning: MCP add_room {"beside": "r1", "side": "east"} finds a free
// spot on that side of room 1 (a gap of 2 squares unless asked, nothing
// overlapped, a square clear of every other room and corridor), and connect
// routes corridors that keep out of the rooms they don't join (routeAround:
// a search over half squares, a square clear of every room, few bends).
import { corridorOutline } from '../geometry/corridors.ts';
import { shapeBounds, type Bounds } from '../geometry/shapes.ts';
import type { DelveMap, Point, Room } from '../schema.ts';
import { ValidationError } from '../validate.ts';
import { boxGap, boxPath, boxText, fmt, inflateBox, intersectArea, objectArea, objectTitle, SIDE_VECTOR, squares, type Side } from './common.ts';

/** Squares kept between a new room (or a rerouted corridor) and every other room. */
export const ROOM_CLEARANCE = 1;

export interface BesideRequest {
  beside: string;
  side: Side;
  w: number;
  h: number;
  /** Squares between the two rooms (default 2). */
  gap?: number;
  /** Width of the corridor that will join them: the rooms then overlap by at least this much, so it runs straight. */
  corridorWidth?: number;
}

export interface BesideResult {
  rect: [number, number, number, number];
  gap: number;
  /** "east of room 1 Entrance hall (r1), 2 squares from it (x 15–21, y 26–30)". */
  text: string;
}

const rooms = (map: DelveMap): Room[] => map.objects.filter((o): o is Room => o.type === 'room');

/** Corridor outlines on the map (as flat paths), for keeping new rooms off them. */
function corridorPaths(map: DelveMap) {
  return map.objects.flatMap((o) => (o.type === 'corridor' ? (objectArea(map, o.id)?.paths ?? []) : []));
}

const snap = (v: number, whole: boolean) => (whole ? Math.round(v) : Math.round(v * 2) / 2);

/**
 * A free rectangle w × h on one side of a room: lined up with it (centred, so
 * a corridor runs straight between them), else slid along that side, else
 * further out. Throws a ValidationError when nothing within 12 more squares is free.
 */
export function besideRect(map: DelveMap, req: BesideRequest): BesideResult {
  const base = map.objects.find((o) => o.id === req.beside);
  if (!base || base.type !== 'room') {
    const list = rooms(map).map((r) => r.id);
    // a first room made beside one that doesn't exist yet: say how to start
    const first = list.length ? '' : ': the map has no rooms yet, so make the first one with rect [x, y, width, height], then add the others beside it';
    throw new ValidationError([`beside: there is no room "${req.beside}" (rooms: ${list.join(', ') || 'none yet'})${first}`]);
  }
  const b = shapeBounds(base.shape);
  const { w, h } = req;
  const gap = req.gap ?? 2;
  if (gap < 0) throw new ValidationError(['gap: 0 or more squares']);
  const cw = req.corridorWidth ?? 0;
  const others = rooms(map).filter((r) => r.id !== base.id);
  const halls = corridorPaths(map);
  const whole = [b.x0, b.y0, b.x1, b.y1, w, h].every((v) => Number.isInteger(v));
  const horizontal = req.side === 'east' || req.side === 'west';
  // centred on the room's middle across the side
  const centre = horizontal ? snap((b.y0 + b.y1) / 2 - h / 2, whole) : snap((b.x0 + b.x1) / 2 - w / 2, whole);
  const free = (r: Bounds) =>
    others.every((o) => boxGap(r, shapeBounds(o.shape)) >= ROOM_CLEARANCE - 1e-9) &&
    boxGap(r, b) >= Math.min(gap, ROOM_CLEARANCE) - 1e-9 &&
    (!halls.length || intersectArea(boxPath(inflateBox(r, 0.5)), halls) < 1e-6);
  const overlapAcross = (r: Bounds) => (horizontal ? Math.min(r.y1, b.y1) - Math.max(r.y0, b.y0) : Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0));
  const rectAt = (g: number, shift: number): Bounds => {
    const s = centre + shift;
    switch (req.side) {
      case 'east':
        return { x0: b.x1 + g, x1: b.x1 + g + w, y0: s, y1: s + h };
      case 'west':
        return { x0: b.x0 - g - w, x1: b.x0 - g, y0: s, y1: s + h };
      case 'north':
        return { x0: s, x1: s + w, y0: b.y0 - g - h, y1: b.y0 - g };
      case 'south':
        return { x0: s, x1: s + w, y0: b.y1 + g, y1: b.y1 + g + h };
    }
  };
  const reach = (horizontal ? b.y1 - b.y0 + h : b.x1 - b.x0 + w) + 6;
  const step = whole ? 1 : 0.5;
  // first lined up enough for a straight corridor, then still overlapping it a little, then anywhere on that side;
  // within each, the cheapest: every square further out or slid along counts, further out a little more
  const passes: ((r: Bounds) => boolean)[] = [...(cw > 0 ? [(r: Bounds) => overlapAcross(r) >= cw - 1e-9] : []), (r) => overlapAcross(r) > 1e-9, () => true];
  for (const pass of passes) {
    let top: { r: Bounds; g: number; shift: number; cost: number } | null = null;
    for (let g = gap; g <= gap + 12; g += step) {
      for (let k = 0; k <= reach / step; k++) {
        for (const shift of k === 0 ? [0] : [k * step, -k * step]) {
          const cost = (g - gap) * 1.5 + Math.abs(shift);
          if (top && cost >= top.cost) continue;
          const r = rectAt(g, shift);
          if (!pass(r) || !free(r)) continue;
          top = { r, g, shift, cost };
        }
      }
    }
    if (!top) continue;
    const { r, g, shift } = top;
    const moved = shift === 0 ? '' : `, slid ${squares(Math.abs(shift))} ${horizontal ? (shift > 0 ? 'south' : 'north') : shift > 0 ? 'east' : 'west'} to keep clear`;
    const farther = g > gap ? ' (nearer spots are taken)' : '';
    return { rect: [r.x0, r.y0, w, h], gap: g, text: `${req.side} of ${objectTitle(base)}, ${squares(g)} from it${farther}${moved} (${boxText(r)})` };
  }
  throw new ValidationError([`beside: no free ${fmt(w)}×${fmt(h)} spot ${req.side} of ${req.beside} within ${fmt(gap + 12)} squares; try another side or a smaller size`]);
}

// ---------- corridors that keep out of rooms ----------

/** The rooms (other than its own two) a corridor along `path` runs through. */
export function corridorThrough(map: DelveMap, path: readonly Point[], width: number, own: readonly string[]): string[] {
  if (path.length < 2) return [];
  const outline = corridorOutline(path, width);
  return rooms(map)
    .filter((r) => !own.includes(r.id) && intersectArea(outline, objectArea(map, r.id)!.paths) > 0.05)
    .map((r) => r.id);
}

class Heap<T> {
  private items: { k: number; v: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(k: number, v: T): void {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: Point[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const STEP = 0.5;
const BEND = 2;

/**
 * A corridor path from room `from` to room `to` that keeps a square clear of
 * every room (its own two only at its mouths, which leave them square to the
 * wall), with as few bends as it can: a search over half squares. Box-shaped
 * rooms only (others use their bounding box). Null when there is no way.
 */
export function routeAround(map: DelveMap, from: string, to: string, width: number): Point[] | null {
  const all = rooms(map);
  const A = all.find((r) => r.id === from);
  const B = all.find((r) => r.id === to);
  if (!A || !B) return null;
  const a = shapeBounds(A.shape);
  const b = shapeBounds(B.shape);
  const boxes = all.map((r) => shapeBounds(r.shape));
  const world = inflateBox(boxes.reduce((u, x) => ({ x0: Math.min(u.x0, x.x0), y0: Math.min(u.y0, x.y0), x1: Math.max(u.x1, x.x1), y1: Math.max(u.y1, x.y1) })), width + 6);
  const hw = width / 2;
  const nx = Math.ceil((world.x1 - world.x0) / STEP) + 1;
  const ny = Math.ceil((world.y1 - world.y0) / STEP) + 1;
  if (nx * ny > 250_000) return null;
  const ox = Math.floor(world.x0 * 2) / 2;
  const oy = Math.floor(world.y0 * 2) / 2;
  const xAt = (i: number) => ox + i * STEP;
  const yAt = (j: number) => oy + j * STEP;
  const cross = (x: number, y: number): Bounds => ({ x0: x - hw, y0: y - hw, x1: x + hw, y1: y + hw });
  const blocked = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const q = cross(xAt(i), yAt(j));
      if (boxes.some((r) => boxGap(q, r) < ROOM_CLEARANCE - 1e-9)) blocked[i * ny + j] = 1;
    }
  }
  // corridors already there: crossing one is allowed, but costs (it would join them)
  const halls = corridorPaths(map);
  const busyCache = new Int8Array(nx * ny);
  const busy = (i: number, j: number): boolean => {
    if (!halls.length) return false;
    const k = i * ny + j;
    if (!busyCache[k]) busyCache[k] = intersectArea(boxPath(cross(xAt(i), yAt(j))), halls) > 0.01 ? 2 : 1;
    return busyCache[k] === 2;
  };

  interface Mouth {
    mouth: Point;
    cell: [number, number];
    out: number;
  }
  const others = boxes.filter((_, k) => all[k] !== A && all[k] !== B);
  /** The mouths along each side of a room: the wall point and the first cell a square out, if the stem between is clear. */
  const mouths = (r: Bounds): Mouth[] => {
    const out: Mouth[] = [];
    const sides: [Side, number][] = [
      ['east', 0],
      ['south', 1],
      ['west', 2],
      ['north', 3],
    ];
    for (const [side, d] of sides) {
      const [vx, vy] = SIDE_VECTOR[side];
      const along = side === 'north' || side === 'south';
      // half a square off the corners where the wall is long enough
      const corner = (along ? r.x1 - r.x0 : r.y1 - r.y0) >= width + 1 ? 0.5 : 0;
      const lo = (along ? r.x0 : r.y0) + hw + corner;
      const hi = (along ? r.x1 : r.y1) - hw - corner;
      for (let t = Math.ceil(lo * 2) / 2; t <= hi + 1e-9; t += STEP) {
        const wall: Point = along ? [t, side === 'north' ? r.y0 : r.y1] : [side === 'west' ? r.x0 : r.x1, t];
        const reach = hw + ROOM_CLEARANCE;
        const c: Point = [wall[0] + vx * reach, wall[1] + vy * reach];
        const i = Math.round((c[0] - ox) / STEP);
        const j = Math.round((c[1] - oy) / STEP);
        if (i < 0 || j < 0 || i >= nx || j >= ny || Math.abs(xAt(i) - c[0]) > 1e-9 || Math.abs(yAt(j) - c[1]) > 1e-9) continue;
        if (blocked[i * ny + j]) continue;
        const stem: Bounds = { x0: Math.min(wall[0], c[0]) - (along ? hw : 0), x1: Math.max(wall[0], c[0]) + (along ? hw : 0), y0: Math.min(wall[1], c[1]) - (along ? 0 : hw), y1: Math.max(wall[1], c[1]) + (along ? 0 : hw) };
        if (others.some((o) => boxGap(stem, o) < ROOM_CLEARANCE - 1e-9)) continue;
        out.push({ mouth: wall, cell: [i, j], out: d });
      }
    }
    return out;
  };
  const starts = mouths(a);
  const ends = mouths(b);
  if (!starts.length || !ends.length) return null;
  const goal = new Map<number, Mouth[]>();
  for (const e of ends) {
    const k = e.cell[0] * ny + e.cell[1];
    goal.set(k, [...(goal.get(k) ?? []), e]);
  }
  const key = (i: number, j: number, d: number) => (i * ny + j) * 4 + d;
  const cost = new Float64Array(nx * ny * 4).fill(Infinity);
  const prev = new Int32Array(nx * ny * 4).fill(-1);
  const startOf = new Map<number, Mouth>();
  const heap = new Heap<number>();
  for (const s of starts) {
    const k = key(s.cell[0], s.cell[1], s.out);
    if (ROOM_CLEARANCE < cost[k]!) {
      cost[k] = ROOM_CLEARANCE;
      startOf.set(k, s);
      heap.push(ROOM_CLEARANCE, k);
    }
  }
  let best: { k: number; total: number; end: Mouth } | null = null;
  while (heap.size) {
    const { k: c, v: s } = heap.pop()!;
    if (c > cost[s]! + 1e-9) continue;
    if (best && c >= best.total) break;
    const d = s % 4;
    const cell = (s - d) / 4;
    const i = Math.floor(cell / ny);
    const j = cell % ny;
    for (const e of goal.get(cell) ?? []) {
      const inward = (e.out + 2) % 4;
      const total = c + ROOM_CLEARANCE + (d === inward ? 0 : BEND);
      if (!best || total < best.total) best = { k: s, total, end: e };
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const ni = i + DIRS[nd]![0];
      const nj = j + DIRS[nd]![1];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || blocked[ni * ny + nj]) continue;
      const step = STEP * (busy(ni, nj) ? 4 : 1) + (nd === d ? 0 : BEND);
      const nk = key(ni, nj, nd);
      if (c + step < cost[nk]! - 1e-9) {
        cost[nk] = c + step;
        prev[nk] = s;
        heap.push(c + step, nk);
      }
    }
  }
  if (!best) return null;
  const cells: Point[] = [];
  let s = best.k;
  let first = s;
  while (s >= 0) {
    const cell = (s - (s % 4)) / 4;
    cells.push([xAt(Math.floor(cell / ny)), yAt(cell % ny)]);
    first = s;
    s = prev[s]!;
  }
  cells.reverse();
  const start = startOf.get(first)!;
  const pts: Point[] = [start.mouth, ...cells, best.end.mouth];
  // keep the corners only
  const out: Point[] = [pts[0]!];
  for (let k = 1; k < pts.length - 1; k++) {
    const p = out[out.length - 1]!;
    const q = pts[k]!;
    const n = pts[k + 1]!;
    const straight = (Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(q[0] - n[0]) < 1e-9) || (Math.abs(p[1] - q[1]) < 1e-9 && Math.abs(q[1] - n[1]) < 1e-9);
    if (!straight) out.push(q);
  }
  out.push(pts[pts.length - 1]!);
  return out.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Point);
}
