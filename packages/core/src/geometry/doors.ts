// Doors at any angle. A door is a line from `at`, `width` squares long. The
// old doors run along x or y (`along`); `angle` turns one any way (degrees,
// clockwise from east because y grows down: 0 runs east like along "x", 90
// south like along "y"), so it can sit in a slanted or curved wall. Everything
// that needs a door's direction asks these helpers, so a door without an angle
// is drawn, cut and exported exactly as before.
import type { Door, Point } from '../schema.ts';
import { EPS, type Polygon } from './shapes.ts';

export type Segment = [Point, Point];

/** What a door's line is made of. */
export type DoorLine = Pick<Door, 'at' | 'along' | 'width' | 'angle'>;

/** Degrees folded into [0, 360). */
export function foldAngle(deg: number): number {
  const a = deg % 360;
  const r = a < 0 ? a + 360 : a;
  return r === 0 || r === 360 ? 0 : r; // no -0, and -1e-15 doesn't become 360
}

/** Does the door have its own angle? Turned doors cut their gap in whatever wall lies along them; the others only in walls exactly on their line, as always. */
export const isTurned = (d: Pick<Door, 'angle'>): boolean => d.angle !== undefined;

/** Which way a door runs, in degrees (0 east, 90 south): its own angle, else 0 for along "x" and 90 for along "y". */
export const doorAngle = (d: Pick<Door, 'along' | 'angle'>): number => (d.angle !== undefined ? foldAngle(d.angle) : d.along === 'x' ? 0 : 90);

/** The unit vector of an angle, exact at quarter turns. */
export function angleVector(deg: number): Point {
  const a = foldAngle(deg);
  if (a === 0) return [1, 0];
  if (a === 90) return [0, 1];
  if (a === 180) return [-1, 0];
  if (a === 270) return [0, -1];
  const r = (a * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/** The axis nearest to an angle: every door keeps an `along`, for anything that reads only that. */
export function nearestAxis(deg: number): 'x' | 'y' {
  const a = foldAngle(deg) % 180;
  return a <= 45 || a >= 135 ? 'x' : 'y';
}

/** The unit vector a door runs along, from `at`. */
export const doorDirection = (d: Pick<Door, 'along' | 'angle'>): Point => angleVector(doorAngle(d));

/**
 * A unit vector across a door. Doors without an angle keep the ones they
 * always had ((0, 1) along x, (1, 0) along y), so the marks drawn across them
 * come out byte for byte as before; turned doors get the direction turned a
 * quarter clockwise.
 */
export function doorNormal(d: Pick<Door, 'along' | 'angle'>): Point {
  if (!isTurned(d)) return d.along === 'x' ? [0, 1] : [1, 0];
  const [ux, uy] = doorDirection(d);
  return [-uy, ux];
}

/** The door's line: from `at`, `width` squares along its direction. */
export function doorSegment(d: DoorLine): Segment {
  const [x, y] = d.at;
  if (!isTurned(d)) {
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
  const [ux, uy] = doorDirection(d);
  return [
    [x, y],
    [x + ux * d.width, y + uy * d.width],
  ];
}

/** The middle of a door's line. */
export function doorCentre(d: DoorLine): Point {
  const [a, b] = doorSegment(d);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

const r6 = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

/** A quarter turn (0, 90, 180, 270): the old along x / along y doors can hold it. */
export const quarterTurn = (deg: number): boolean => Math.abs(foldAngle(deg) / 90 - Math.round(foldAngle(deg) / 90)) < 1e-9;

/**
 * A door's `at`, `along` and `angle` from its middle, its turn and its width.
 * `turned: false` (only for quarter turns) gives an old-style door, `at` its
 * top-left end and no angle; otherwise the angle is kept, folded into
 * [0, 180) (a door is the same line either way round) and rounded to 0.01°.
 */
export function doorFromCentre(centre: Point, deg: number, width: number, turned = true): Pick<Door, 'at' | 'along' | 'angle'> {
  if (!turned && quarterTurn(deg)) {
    const along = nearestAxis(deg);
    return { at: along === 'x' ? [r6(centre[0] - width / 2), r6(centre[1])] : [r6(centre[0]), r6(centre[1] - width / 2)], along };
  }
  const angle = Math.round((foldAngle(deg) % 180) * 100) / 100 % 180;
  const [ux, uy] = angleVector(angle);
  return { at: [r6(centre[0] - (ux * width) / 2), r6(centre[1] - (uy * width) / 2)], along: nearestAxis(angle), angle };
}

/** A door from one end to the other (`a` to `b`), as doorFromCentre makes it. */
export function doorBetween(a: Point, b: Point, turned = true): Pick<Door, 'at' | 'along' | 'angle' | 'width'> {
  const width = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1e4) / 1e4;
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return { ...doorFromCentre([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], deg, width, turned), width };
}

// ---------- where a turned door cuts the wall ----------

/** How far either side of a turned door's line the wall it opens may run: curved and cave walls bow a little away from the straight door. */
export const gapReach = (d: Pick<Door, 'width'>): number => Math.min(0.6, 0.2 + 0.15 * d.width);

/** Walls more than this far off a turned door's direction are never in its gap (a corridor's side wall meeting its end). */
const MAX_SKEW = Math.cos((40 * Math.PI) / 180);

/** A turned door's slot: the band along its line that it opens in the wall. */
export interface DoorSlot {
  a: Point;
  b: Point;
  u: Point;
  n: Point;
  width: number;
  reach: number;
}

export function doorSlot(d: DoorLine): DoorSlot {
  const [a, b] = doorSegment(d);
  const [ux, uy] = doorDirection(d);
  return { a, b, u: [ux, uy], n: [-uy, ux], width: d.width, reach: gapReach(d) };
}

/**
 * The stretch of a wall segment inside a door's slot, as parameters [t0, t1]
 * along the segment (0 its start, 1 its end), or null: strictly between the
 * door's two ends, within `reach` of its line, and only for walls running
 * roughly the door's way.
 */
export function slotSpan([p, q]: Segment, s: DoorSlot): [number, number] | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  const du = dx * s.u[0] + dy * s.u[1];
  const dn = dx * s.n[0] + dy * s.n[1];
  if (Math.abs(du) / len < MAX_SKEW) return null;
  const pu = (p[0] - s.a[0]) * s.u[0] + (p[1] - s.a[1]) * s.u[1];
  const pn = (p[0] - s.a[0]) * s.n[0] + (p[1] - s.a[1]) * s.n[1];
  let lo = 0;
  let hi = 1;
  // keep lo <= t <= hi where min < v0 + t·dv < max
  const clamp = (v0: number, dv: number, min: number, max: number): boolean => {
    if (Math.abs(dv) < 1e-12) return v0 > min && v0 < max;
    let t0 = (min - v0) / dv;
    let t1 = (max - v0) / dv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    return lo < hi;
  };
  if (!clamp(pu, du, EPS, s.width - EPS)) return null;
  if (!clamp(pn, dn, -s.reach, s.reach)) return null;
  return (hi - lo) * len > EPS ? [lo, hi] : null;
}

/** Where along the door (0 at `at`, `width` at the other end) a point lies. */
export const alongSlot = (s: DoorSlot, p: Point): number => (p[0] - s.a[0]) * s.u[0] + (p[1] - s.a[1]) * s.u[1];

const lerp = ([p, q]: Segment, t: number): Point => (t <= 0 ? p : t >= 1 ? q : [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);

/** Any jamb longer than this is kept: even a hair-wide crack beside a door would let a ray of line of sight through (a door snapped onto its wall meets it end to end). */
const JAMB_MIN = 1e-9;

/**
 * A wall segment with turned doors' gaps taken out. Where the wall goes on
 * past a door's end line but off its line (a bowed or slanted wall), a short
 * jamb joins it to the door's end, so neither the picture nor line of sight
 * gets a crack beside the door.
 */
export function cutTurnedGaps(seg: Segment, slots: readonly DoorSlot[]): Segment[] {
  let pieces: [number, number][] = [[0, 1]];
  // the jambs at each piece's start and end, if any
  const jambAt = new Map<number, Point>();
  for (const s of slots) {
    const span = slotSpan(seg, s);
    if (!span) continue;
    const [t0, t1] = span;
    const end = (t: number): Point | null => {
      const p = lerp(seg, t);
      const k = alongSlot(s, p);
      const tip = k < s.width / 2 ? s.a : s.b;
      // only where the wall leaves through the door's end line, not along its side
      if (Math.min(Math.abs(k), Math.abs(k - s.width)) > 1e-4) return null;
      return Math.hypot(tip[0] - p[0], tip[1] - p[1]) >= JAMB_MIN ? tip : null;
    };
    pieces = pieces.flatMap(([lo, hi]): [number, number][] => {
      if (t1 <= lo || t0 >= hi) return [[lo, hi]];
      const keep: [number, number][] = [];
      if (t0 > lo) {
        keep.push([lo, t0]);
        const j = end(t0);
        if (j) jambAt.set(t0, j);
      }
      if (t1 < hi) {
        keep.push([t1, hi]);
        const j = end(t1);
        if (j) jambAt.set(t1, j);
      }
      return keep;
    });
  }
  const out: Segment[] = [];
  for (const [lo, hi] of pieces) {
    const a = lerp(seg, lo);
    const b = lerp(seg, hi);
    const ja = lo > 0 ? jambAt.get(lo) : undefined;
    const jb = hi < 1 ? jambAt.get(hi) : undefined;
    if (ja) out.push([ja, a]);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) out.push([a, b]);
    if (jb) out.push([b, jb]);
  }
  return out;
}

/** How much of a turned door's length runs along wall in `segs` (its slot's cover), as merged [from, to] stretches along the door. */
export function slotCover(segs: readonly Segment[], s: DoorSlot): [number, number][] {
  const spans: [number, number][] = [];
  for (const seg of segs) {
    const span = slotSpan(seg, s);
    if (!span) continue;
    const k0 = alongSlot(s, lerp(seg, span[0]));
    const k1 = alongSlot(s, lerp(seg, span[1]));
    spans.push([Math.max(0, Math.min(k0, k1)), Math.min(s.width, Math.max(k0, k1))]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp[0] <= last[1] + 0.02) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  return merged;
}

// ---------- putting a door on a wall ----------

/** The floor's edges as rings of points (outer rings and holes alike). */
const ringsOf = (floor: readonly Polygon[]): Point[][] => floor.flatMap((p) => [p.outer, ...p.holes]).filter((r) => r.length >= 2);

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The nearest point on segment a–b to p, and how far along (0–1) it is. */
function nearestOn(p: Point, a: Point, b: Point): { q: Point; t: number } {
  const [dx, dy] = sub(b, a);
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return { q: [a[0] + dx * t, a[1] + dy * t], t };
}

/** The wall point nearest to p within `reach` squares: its ring, segment and the point. */
export function nearestWall(floor: readonly Polygon[], p: Point, reach: number): { ring: Point[]; i: number; q: Point } | null {
  let best: { ring: Point[]; i: number; q: Point } | null = null;
  let bestD = reach;
  for (const ring of ringsOf(floor)) {
    for (let i = 0; i < ring.length; i++) {
      const { q } = nearestOn(p, ring[i]!, ring[(i + 1) % ring.length]!);
      const d = dist(p, q);
      if (d <= bestD) {
        bestD = d;
        best = { ring, i, q };
      }
    }
  }
  return best;
}

const round2 = ([a, b]: Segment): Segment => [[r6(a[0]), r6(a[1])], [r6(b[0]), r6(b[1])]];

/** The point `len` squares on round a ring from point q on its segment i (backwards for a negative len). */
function walk(ring: readonly Point[], i: number, q: Point, len: number): Point {
  const n = ring.length;
  let at = q;
  let seg = i;
  let left = Math.abs(len);
  const forward = len >= 0;
  for (let guard = 0; guard < n + 1; guard++) {
    const end = forward ? ring[(seg + 1) % n]! : ring[seg]!;
    const d = dist(at, end);
    if (d >= left) {
      const t = d ? left / d : 0;
      return [at[0] + (end[0] - at[0]) * t, at[1] + (end[1] - at[1]) * t];
    }
    left -= d;
    at = end;
    seg = forward ? (seg + 1) % n : (seg - 1 + n) % n;
  }
  return at;
}

/**
 * Where a door `width` squares wide goes on the wall nearest to p (within
 * `reach`): its two ends, both on the wall. On a straight stretch at least as
 * long as the door it is centred on the nearest point (slid back so it stays on
 * that stretch); on a curve or across a corner its ends are found by walking
 * round the wall either way until they are `width` apart, so the door is a
 * chord of the curve. Null when no wall is that close.
 */
export function doorOnWall(floor: readonly Polygon[], p: Point, width: number, reach = 1): Segment | null {
  const hit = nearestWall(floor, p, reach);
  if (!hit) return null;
  const { ring, i, q } = hit;
  const s0 = ring[i]!;
  const s1 = ring[(i + 1) % ring.length]!;
  const len = dist(s0, s1);
  if (len >= width - EPS) {
    const u: Point = [(s1[0] - s0[0]) / len, (s1[1] - s0[1]) / len];
    const k = Math.max(width / 2, Math.min(len - width / 2, (q[0] - s0[0]) * u[0] + (q[1] - s0[1]) * u[1]));
    return round2([
      [s0[0] + u[0] * (k - width / 2), s0[1] + u[1] * (k - width / 2)],
      [s0[0] + u[0] * (k + width / 2), s0[1] + u[1] * (k + width / 2)],
    ]);
  }
  // a chord: walk out until the ends are width apart (the chord only grows with the walk on a wall that bends one way)
  const ends = (l: number): Segment => [walk(ring, i, q, -l), walk(ring, i, q, l)];
  let lo = width / 2;
  let hi = width * 2;
  if (dist(...ends(hi)) < width) return round2(ends(hi)); // a tight corner: as close as it gets
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (dist(...ends(mid)) < width) lo = mid;
    else hi = mid;
  }
  return round2(ends(hi));
}
