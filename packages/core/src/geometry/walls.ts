// Walls follow the floor's edge. A door lying on that edge opens a gap in it;
// a door across an interior opening (a corridor mouth) leaves walls alone.
// Doors without an angle cut only wall exactly on their line, as always;
// turned doors cut whatever wall runs along them (geometry/doors.ts), so they
// also sit in slanted, curved and rough walls.
import type { DelveMap, Door, Point } from '../schema.ts';
import { cutTurnedGaps, doorBetween, doorFromCentre, doorSegment, doorSlot, isTurned, slotCover, type Segment } from './doors.ts';
import { computeFloor } from './floor.ts';
import { cutSegments, floorTest, openWallRings } from './openings.ts';
import { EPS, type Polygon } from './shapes.ts';

export { doorSegment, type Segment };

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

/** A wall segment with the gaps of these doors taken out: exact ones for doors without an angle, slots for turned ones. */
function gapsOf(doors: readonly Door[]): (seg: Segment) => Segment[] {
  const exact = doors.filter((d) => !isTurned(d)).map(doorSegment);
  const slots = doors.filter(isTurned).map(doorSlot);
  return slots.length ? (seg) => subtract(seg, exact).flatMap((s) => cutTurnedGaps(s, slots)) : (seg) => subtract(seg, exact);
}

/** Wall segments: the floor boundary with door openings removed, and whatever lies inside an opening with `walls`. */
export function computeWalls(map: DelveMap, floor: readonly Polygon[] = computeFloor(map)): Segment[] {
  const gaps = gapsOf(map.objects.filter((o): o is Door => o.type === 'door'));
  return cutSegments(boundarySegments(floor).flatMap(gaps), openWallRings(map), floorTest(floor));
}

/**
 * A door's `at`, `along` and `angle` from its middle, turn and width, as the
 * editor and MCP make new doors: the old form (no angle) on a quarter turn
 * whose exact cut opens the same gap a turned door would (a straight wall
 * along x or y, or no wall at all, as across a corridor mouth); turned
 * otherwise, so a door on a circle's top still cuts its curve.
 */
export function placeDoor(floor: readonly Polygon[], centre: Point, deg: number, width: number): Pick<Door, 'at' | 'along' | 'angle'> {
  const plain = doorFromCentre(centre, deg, width, false);
  if (plain.angle !== undefined) return plain;
  const edge = boundarySegments(floor);
  const line = { ...plain, width };
  const exact = edge.reduce((sum, s) => sum + collinearOverlap(s, doorSegment(line)), 0);
  const slot = slotCover(edge, doorSlot({ ...line, angle: plain.along === 'x' ? 0 : 90 })).reduce((sum, [lo, hi]) => sum + hi - lo, 0);
  return Math.abs(exact - slot) < 0.02 ? plain : doorFromCentre(centre, deg, width, true);
}

/** A door from end `a` to end `b` (as placeDoor decides its form). */
export function placeDoorBetween(floor: readonly Polygon[], a: Point, b: Point): Pick<Door, 'at' | 'along' | 'angle' | 'width'> {
  const { width } = doorBetween(a, b);
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return { ...placeDoor(floor, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], deg, width), width };
}

/** Does a door lie on the floor's edge (`edge`: its boundary segments)? On it along its line, or for a turned door, along its slot. */
export function onEdge(edge: readonly Segment[], d: Door): boolean {
  if (!isTurned(d)) return edge.some((s) => collinearOverlap(s, doorSegment(d)) > 1e-6);
  return slotCover(edge, doorSlot(d)).length > 0;
}

/**
 * The lines a shut secret door draws in the players' view, where it opens no
 * gap: its own line, across whatever opening it closes. A turned door leaves
 * out the stretches where the wall it sits in already runs (a curved wall stays
 * one clean curve, without the door's straight chord beside it).
 */
export function shutDoorLines(doors: readonly Door[], floor: readonly Polygon[]): Segment[] {
  const edge = doors.some(isTurned) ? boundarySegments(floor) : [];
  return doors.flatMap((d): Segment[] => {
    if (!isTurned(d)) return [doorSegment(d)];
    const s = doorSlot(d);
    const at = (k: number): Point => [s.a[0] + s.u[0] * k, s.a[1] + s.u[1] * k];
    const out: Segment[] = [];
    let from = 0;
    for (const [lo, hi] of [...slotCover(edge, s), [d.width, d.width] as [number, number]]) {
      if (lo - from > 0.05) out.push([at(from), at(lo)]);
      from = Math.max(from, hi);
    }
    return out;
  });
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
 * players' view keeps secret doors shut). Openings with `walls` leave out the
 * walls inside them.
 */
export function wallPolylines(
  map: DelveMap,
  floor: readonly Polygon[] = computeFloor(map),
  cuts: (d: Door) => boolean = () => true,
): Polyline[] {
  const gaps = gapsOf(map.objects.filter((o): o is Door => o.type === 'door' && cuts(o)));
  const open = openWallRings(map);
  const floorAt = floorTest(floor);
  const out: Polyline[] = [];
  for (const poly of floor) {
    for (const ring of [poly.outer, ...poly.holes]) {
      const segs: Segment[] = [];
      for (let i = 0; i < ring.length; i++) segs.push(...gaps([ring[i]!, ring[(i + 1) % ring.length]!]));
      out.push(...chain(open.length ? cutSegments(segs, open, floorAt) : segs));
    }
  }
  return out;
}

export function segmentLength([a, b]: Segment): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
