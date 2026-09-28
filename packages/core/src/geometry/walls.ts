// Walls follow the floor's edge. A door lying on that edge opens a gap in it;
// a door across an interior opening (a corridor mouth) leaves walls alone.
import type { DelveMap, Door, Point } from '../schema.ts';
import { computeFloor } from './floor.ts';
import { EPS, type Polygon } from './shapes.ts';

export type Segment = [Point, Point];

export function doorSegment(d: Door): Segment {
  const [x, y] = d.at;
  return d.along === 'x'
    ? [
        [x, y],
        [x + d.width, y],
      ]
    : [
        [x, y],
        [x, y + d.width],
      ];
}

/** Every edge of every floor ring, holes included. */
export function boundarySegments(floor: readonly Polygon[]): Segment[] {
  const out: Segment[] = [];
  for (const poly of floor) {
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < ring.length; i++) out.push([ring[i]!, ring[(i + 1) % ring.length]!]);
    }
  }
  return out;
}

type Axis = { axis: 0 | 1; fixed: number; lo: number; hi: number };

function axisOf([a, b]: Segment): Axis | null {
  if (Math.abs(a[1] - b[1]) < EPS) return { axis: 0, fixed: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) };
  if (Math.abs(a[0] - b[0]) < EPS) return { axis: 1, fixed: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) };
  return null;
}

/** Length along which two axis-aligned segments lie on top of each other. */
export function collinearOverlap(s: Segment, t: Segment): number {
  const a = axisOf(s);
  const b = axisOf(t);
  if (!a || !b || a.axis !== b.axis || Math.abs(a.fixed - b.fixed) > EPS) return 0;
  return Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
}

function subtract(seg: Segment, gaps: readonly Segment[]): Segment[] {
  const s = axisOf(seg);
  if (!s) return [seg];
  let pieces: [number, number][] = [[s.lo, s.hi]];
  for (const gap of gaps) {
    const g = axisOf(gap);
    if (!g || g.axis !== s.axis || Math.abs(g.fixed - s.fixed) > EPS) continue;
    pieces = pieces.flatMap(([lo, hi]): [number, number][] => {
      if (g.hi <= lo + EPS || g.lo >= hi - EPS) return [[lo, hi]];
      const keep: [number, number][] = [];
      if (g.lo - lo > EPS) keep.push([lo, g.lo]);
      if (hi - g.hi > EPS) keep.push([g.hi, hi]);
      return keep;
    });
  }
  const forward = seg[0][s.axis] <= seg[1][s.axis];
  const at = (v: number): Point => (s.axis === 0 ? [v, s.fixed] : [s.fixed, v]);
  const out = pieces.map(([lo, hi]): Segment => (forward ? [at(lo), at(hi)] : [at(hi), at(lo)]));
  return forward ? out : out.reverse();
}

/** Wall segments: the floor boundary with door openings removed. */
export function computeWalls(map: DelveMap, floor: readonly Polygon[] = computeFloor(map)): Segment[] {
  const doors = map.objects.filter((o): o is Door => o.type === 'door').map(doorSegment);
  return boundarySegments(floor).flatMap((seg) => subtract(seg, doors));
}

export interface Polyline {
  points: Point[];
  closed: boolean;
}

const same = (a: Point, b: Point): boolean => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** Join a ring's consecutive segments into polylines, wrapping round the ring's start. */
function chain(segs: readonly Segment[]): Polyline[] {
  if (!segs.length) return [];
  const lines: Point[][] = [];
  let cur: Point[] = [segs[0]![0], segs[0]![1]];
  for (const [a, b] of segs.slice(1)) {
    if (same(a, cur.at(-1)!)) cur.push(b);
    else {
      lines.push(cur);
      cur = [a, b];
    }
  }
  lines.push(cur);
  if (lines.length > 1 && same(lines.at(-1)!.at(-1)!, lines[0]![0]!)) {
    const last = lines.pop()!;
    lines[0] = [...last, ...lines[0]!.slice(1)];
  }
  return lines.map((pts) =>
    lines.length === 1 && pts.length > 2 && same(pts[0]!, pts.at(-1)!)
      ? { points: pts.slice(0, -1), closed: true }
      : { points: pts, closed: false },
  );
}

/**
 * Walls as polylines for drawing: closed rings where no door interrupts them,
 * open runs between door gaps. `cuts` decides which doors open a gap (the
 * players' view keeps secret doors shut).
 */
export function wallPolylines(
  map: DelveMap,
  floor: readonly Polygon[] = computeFloor(map),
  cuts: (d: Door) => boolean = () => true,
): Polyline[] {
  const gaps = map.objects.filter((o): o is Door => o.type === 'door' && cuts(o)).map(doorSegment);
  const out: Polyline[] = [];
  for (const poly of floor) {
    for (const ring of [poly.outer, ...poly.holes]) {
      const segs: Segment[] = [];
      for (let i = 0; i < ring.length; i++) segs.push(...subtract([ring[i]!, ring[(i + 1) % ring.length]!], gaps));
      out.push(...chain(segs));
    }
  }
  return out;
}

export function segmentLength([a, b]: Segment): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
