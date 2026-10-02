// Corridors between rooms of any shape: hexagons, octagons, triangles,
// circles, ovals, polygons and freehand outlines (Corridor.route "outline").
//
// A corridor leaves a room through a mouth: a stretch of the room's real
// outline as wide as the corridor. Good mouths sit square to a straight wall,
// near its middle and away from its corners; a corridor may also meet a
// slanted or curved wall at a slant (up to about 30°) or run into an obtuse
// corner along its bisector (a hexagon's point). The corridor's end reaches a
// little way into the room, past the lowest point of the mouth, so the floor
// joins without gaps, notches or slivers.
//
// Between the two mouths the route stays on the grid where it can (straight,
// L or Z, every bend on half squares). A corridor leaving a slanted wall runs
// square off it for a short stub first and then turns onto the grid; between
// two diagonal walls (an octagon's sides) it may run at 45°, and between two
// parallel slanted walls straight across. Every candidate route gets a cost
// (length, bends, slanted runs, how good its mouths are) and the cheapest one
// that keeps clear of both rooms wins.
import type { Point, Shape } from '../schema.ts';
import { shapeBounds, shapePath, type Bounds } from './shapes.ts';

/** The two corners of a corridor's mouth on a room's wall: a door across the mouth runs from one to the other. */
export type Mouth = [Point, Point];

export interface OutlineRoute {
  /** The centerline, from inside the first room to inside the second. */
  path: Point[];
  /** Where it meets each room's outline (first room, second room). */
  mouths: [Mouth, Mouth];
}

// ---------- tuning ----------

/** Vertices turning more than this are corners (walls end there). */
const CORNER_DEG = 30;
/** A mouth may take in an obtuse corner (a hexagon's point), never one turning more than this (a box corner). */
const TIP_DEG = 80;
/** The rock between a corridor's side and the wall beside its mouth must open at least this wide (no slivers). */
const MIN_WEDGE_DEG = 50;
/**
 * Second-best mouths and legs (steeper slants into a wall, rock wedges down to
 * 40°, legs only a quarter square clear of the wall) compete too, at this
 * extra cost: a short corridor that meets a wall a little awkwardly beats one
 * that goes all the way round.
 */
const RELAX = 2.5;
const minWedge = (relax: boolean): number => (relax ? 40 : MIN_WEDGE_DEG);
/** How far the corridor's end reaches into a room past the mouth's lowest point (none on a straight wall along the grid). */
const REACH = 0.1;
/** Room parts this close beside the corridor, just past its mouth, rule the mouth out. */
const BESIDE = 0.5;
/** A stub off a slanted wall costs this much more than meeting the wall straight on. */
const STUB = 0.6;
/** A corridor side running on (nearly) the line of a room's wall close by makes a notch: this much extra. */
const FLUSH = 2.5;

const DEG = Math.PI / 180;
const S2 = Math.SQRT1_2;
/** The free directions a route may run in: the axes (0–3), then the diagonals (4–7). */
const DIRS: readonly Point[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [S2, S2],
  [-S2, S2],
  [-S2, -S2],
  [S2, -S2],
];
const opposite = (gi: number): number => (gi < 4 ? (gi + 2) % 4 : 4 + ((gi - 2) % 4));

const maxDepth = (w: number): number => Math.max(0.75, 0.6 * w);
/** How far a corridor runs out of a wall before it may bend by phi (radians): clear of the wall by about a square at 90°. */
const minLeg = (phi: number, w: number, relax: boolean): number => (w / 2) * Math.tan(phi / 2) + (relax ? 0.25 : 0.5 + 0.5 * Math.sin(phi));
const turnCost = (phi: number): number => 0.5 + (2 * phi) / (Math.PI / 2);

const r6 = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r; // no -0
};
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point, k = 1): Point => [a[0] + b[0] * k, a[1] + b[1] * k];
const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- room outlines ----------

interface Geo {
  ring: Point[];
  /** Turn at each vertex, in degrees (0 on a straight line). */
  turn: number[];
  /** 1 when the ring's signed area is positive. */
  sign: number;
  bounds: Bounds;
}

function geoOf(shape: Shape): Geo {
  const raw = shapePath(shape).map((p) => [p.x, p.y] as Point);
  const ring = raw.filter((p, i) => dist(p, raw[(i + 1) % raw.length]!) > 1e-9);
  const n = ring.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const turn = ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n]!;
    const c = ring[(i + 1) % n]!;
    const u = sub(p, a);
    const v = sub(c, p);
    const cos = dot(u, v) / (Math.hypot(...u) * Math.hypot(...v));
    return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
  });
  return { ring, turn, sign: area > 0 ? 1 : -1, bounds: shapeBounds(shape) };
}

/** The outward normal of edge i. */
function outward(g: Geo, i: number): Point {
  const a = g.ring[i]!;
  const b = g.ring[(i + 1) % g.ring.length]!;
  const len = dist(a, b);
  const dx = (b[0] - a[0]) / len;
  const dy = (b[1] - a[1]) / len;
  return g.sign > 0 ? [dy, -dx] : [-dy, dx];
}

/** A room seen along direction d (outward): u across, v along d. Exact on the axes. */
interface Frame {
  d: Point;
  n: Point;
  us: number[];
  vs: number[];
  lo: number;
  hi: number;
}

function frameOf(g: Geo, d: Point): Frame {
  const n: Point = [-d[1] || 0, d[0]];
  const us = g.ring.map((p) => p[0] * n[0] + p[1] * n[1]);
  const vs = g.ring.map((p) => p[0] * d[0] + p[1] * d[1]);
  return { d, n, us, vs, lo: Math.min(...us), hi: Math.max(...us) };
}

const toXY = (f: Frame, u: number, v: number): Point => [u * f.n[0] + v * f.d[0], u * f.n[1] + v * f.d[1]];

/** Where the line at lateral u leaves the room last (top), the crossing below it, and the edge of the top one. */
function crossing(g: Geo, f: Frame, u: number): { top: number; below: number; edge: number } | null {
  const n = g.ring.length;
  let top = -Infinity;
  let below = -Infinity;
  let edge = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ua = f.us[i]!;
    const ub = f.us[j]!;
    if ((ua <= u && u < ub) || (ub <= u && u < ua)) {
      const v = f.vs[i]! + ((u - ua) / (ub - ua)) * (f.vs[j]! - f.vs[i]!);
      if (v > top) {
        below = top;
        top = v;
        edge = i;
      } else if (v > below) below = v;
    }
  }
  return edge < 0 ? null : { top, below, edge };
}

const edgeV = (f: Frame, i: number, j: number, u: number): number => {
  const ua = f.us[i]!;
  const ub = f.us[j]!;
  return ub === ua ? Math.max(f.vs[i]!, f.vs[j]!) : f.vs[i]! + ((u - ua) / (ub - ua)) * (f.vs[j]! - f.vs[i]!);
};

/**
 * The wall beside a mouth, walking away from it along the outline from the
 * side exit `from` (side -1: towards lower u): the angle between the corridor's
 * side and that wall (under 90° the rock between them is a wedge), and how far
 * the wall runs before its next corner.
 */
function besideWall(g: Geo, f: Frame, edge: number, from: Point, side: number): { angle: number; clear: number; dir: Point; corner: number; cornerV: number } {
  const n = g.ring.length;
  const j = (edge + 1) % n;
  const away = side < 0 ? f.us[j]! < f.us[edge]! : f.us[j]! > f.us[edge]!;
  const step = away ? 1 : -1;
  let k = away ? j : edge;
  let at = from;
  let angle = -1;
  let dir: Point = [0, 0];
  let clear = 0;
  let corner = 0;
  let cornerV = -Infinity;
  let counting = true;
  for (let guard = 0; guard < n + 1 && (angle < 0 || counting); guard++) {
    const q = g.ring[k]!;
    const len = dist(q, at);
    if (len > 1e-9 && angle < 0) {
      const t = sub(q, at);
      const across = dot(t, f.n) * side;
      dir = [t[0] / len, t[1] / len];
      angle = across <= 0 ? 180 : Math.acos(Math.max(-1, Math.min(1, dot(t, f.d) / len))) / DEG;
    }
    if (counting) {
      clear += len;
      if (g.turn[k]! > CORNER_DEG || clear >= 10) {
        counting = false;
        corner = clear >= 10 ? 0 : g.turn[k]!;
        cornerV = f.vs[k]!;
      }
    }
    at = q;
    k = (k + step + n) % n;
  }
  return { angle: angle < 0 ? 180 : angle, clear: Math.min(clear, 10), dir, corner, cornerV };
}

interface MouthInfo {
  f: Frame;
  /** How far the mouth's two corners lie apart along the corridor (0 square to a straight wall). */
  depth: number;
  /** The corridor's lateral position (its centerline) in the frame. */
  c: number;
  p0: Point;
  p1: Point;
  /** The walls beside the mouth, leaving p0 and p1: their direction, how far they run to the next corner, and their wedge penalty. */
  walls: [{ dir: Point; clear: number }, { dir: Point; clear: number }];
  wedgeCost: number;
  /** The centerline's first point, inside the room. */
  start: Point;
  /** Where the centerline leaves the room. */
  exit: Point;
  cost: number;
}

/** The mouth of a corridor w wide leaving the room along f.d with its centerline at lateral c, or null if it can't leave cleanly there. */
function mouthAt(g: Geo, f: Frame, c: number, w: number, axis: boolean, relax = false): MouthInfo | null {
  const u0 = c - w / 2;
  const u1 = c + w / 2;
  const e = 1e-7;
  const lo = crossing(g, f, u0 + e);
  const hi = crossing(g, f, u1 - e);
  if (!lo || !hi) return null;
  let vmin = Math.min(lo.top, hi.top);
  let vmax = Math.max(lo.top, hi.top);
  let entry = Math.max(lo.below, hi.below);
  for (let k = 0; k < g.ring.length; k++) {
    const uk = f.us[k]!;
    if (uk <= u0 + 1e-6 || uk >= u1 - 1e-6) continue;
    for (const s of [uk - e, uk + e]) {
      const x = crossing(g, f, s);
      if (!x) return null;
      vmin = Math.min(vmin, x.top);
      vmax = Math.max(vmax, x.top);
      entry = Math.max(entry, x.below);
    }
  }
  // a sharp point met head on (a triangle's tip on the centerline): the room opens into the corridor like a funnel
  const onAxis = (k: number) => Math.abs(f.us[k]! - c) < 0.02 && g.turn[k]! > 100 && g.turn[k]! <= 135 && Math.abs(lo.top - hi.top) < 0.05;
  let point = false;
  for (let k = 0; k < g.ring.length; k++) if (g.turn[k]! > TIP_DEG && f.vs[k]! >= vmax - 1e-9 && onAxis(k)) point = true;
  const depth = vmax - vmin;
  if (depth > (point || relax ? w : maxDepth(w))) return null;
  const reach = axis && depth < 1e-9 ? 0 : REACH;
  const vEnd = vmin - reach;
  // the room must be solid under the corridor's end (not a sliver of floor, no rock in the way)
  if (entry > vEnd - 0.02) return null;
  const n = g.ring.length;
  // the vertices on the mouth itself: no box corners (or rock spikes), only obtuse points like a hexagon's
  let corners = 0;
  for (let k = 0; k < n; k++) {
    if (f.us[k]! <= u0 + 1e-6 || f.us[k]! >= u1 - 1e-6 || f.vs[k]! < vEnd) continue;
    if (g.turn[k]! > TIP_DEG && !(point && onAxis(k))) return null;
    if (g.turn[k]! > CORNER_DEG) corners++;
  }
  const p0 = toXY(f, u0, edgeV(f, lo.edge, (lo.edge + 1) % n, u0));
  const p1 = toXY(f, u1, edgeV(f, hi.edge, (hi.edge + 1) % n, u1));
  const w0 = besideWall(g, f, lo.edge, p0, -1);
  const w1 = besideWall(g, f, hi.edge, p1, 1);
  if (w0.angle < minWedge(relax) || w1.angle < minWedge(relax)) return null;
  // nothing of the room right beside or ahead of the corridor once it is out
  for (let k = 0; k < n; k++) {
    const uk = f.us[k]!;
    const vk = f.vs[k]!;
    if (uk > u0 - BESIDE && uk < u1 + BESIDE && vk > vmax + 0.6 && vk < vmax + 3) return null;
  }
  const wedge = (a: number) => (a < 90 ? 1.5 * ((90 - a) / 40) ** 2 : 0);
  // a sliver of wall left between the corridor and a corner reads as a jog (none at all is fine)
  // (and twice that to an acute corner that juts out past the mouth: it would stand beside the corridor like an ear)
  const tight = (room: number, corner: number, cornerV: number) => {
    const lim = corner > 90 && cornerV > vmax + 0.05 ? 2 : 1;
    return room < 1e-3 ? 0.8 : room < lim ? 2.5 * (1 - room / lim) : 0;
  };
  const wedgeCost = wedge(w0.angle) + wedge(w1.angle);
  let cost = 0.8 * depth + wedgeCost + tight(w0.clear, w0.corner, w0.cornerV) + tight(w1.clear, w1.corner, w1.cornerV) + 1.0 * corners;
  // near the middle of its wall
  if (w0.clear < 10 && w1.clear < 10) cost += (1.2 * Math.abs(w0.clear - w1.clear)) / (w0.clear + w1.clear + w);
  const walls: MouthInfo['walls'] = [
    { dir: w0.dir, clear: w0.clear },
    { dir: w1.dir, clear: w1.clear },
  ];
  return { f, depth, c, p0, p1, walls, wedgeCost, start: toXY(f, c, vEnd), exit: toXY(f, c, vmax), cost };
}

// ---------- ports: where a route may start from a room ----------

interface Port {
  m: MouthInfo;
  /** Where the free part of the route starts, heading g. */
  K: Point;
  gi: number;
  /** Bends between the exit and K: a stub's turn. */
  lead: Point[];
  stub: boolean;
  cost: number;
  /** K's lateral across g, for lining up straight runs. */
  key: number;
}

interface Wall {
  f: Frame;
  /** Valid mouths along it, by lateral. */
  cs: number[];
}

interface RoomPorts {
  g: Geo;
  ports: Port[];
  /** Slanted walls (off the axes and diagonals), for straight runs between parallel walls. */
  walls: Wall[];
}

const depth = (m: MouthInfo): number => m.depth;

const keyOf = (p: Point, gi: number): number => {
  const d = DIRS[gi]!;
  return r6(p[0] * -d[1] + p[1] * d[0]);
};

/** The half-square lattice for a corridor w wide: its edges on half squares; `whole` too when they land on whole squares. */
const lattice = (v: number, w: number): { on: boolean; whole: boolean } => {
  const k = (v - w / 2) * 2;
  const on = Math.abs(k - Math.round(k)) < 1e-6;
  return { on, whole: on && Math.round(k) % 2 === 0 };
};

function directPort(m: MouthInfo, gi: number, w: number): Port {
  let cost = m.cost;
  if (gi < 4) {
    const across = m.exit[gi % 2 === 0 ? 1 : 0];
    if (!lattice(across, w).whole) cost += 0.3;
  } else cost += depth(m) > 0.15 ? 1.2 : 0.2; // a diagonal run is for diagonal (or round) walls
  return { m, K: m.exit, gi, lead: [], stub: false, cost, key: keyOf(m.exit, gi) };
}

/** A mouth off the grid squares off onto it: a short stub along the mouth's direction, then a bend onto axis gi. */
function stubPorts(m: MouthInfo, w: number, relax: boolean): Port[] {
  const out: Port[] = [];
  const d = m.f.d;
  for (let gi = 0; gi < 4; gi++) {
    const g = DIRS[gi]!;
    const cos = dot(d, g);
    if (cos < 0.02) continue; // more than ~89° off
    const phi = Math.acos(Math.min(1, cos));
    const tmin = minLeg(phi, w, relax);
    // after the bend the corridor runs along g at a fixed y (g along x) or x (g along y)
    const ax = gi % 2 === 0 ? 1 : 0;
    const s = d[ax];
    if (Math.abs(s) < 1e-9) continue;
    const from = m.exit[ax] + tmin * s;
    // the lattice values beyond `from`, moving the way the stub goes
    const k0 = s > 0 ? Math.ceil((from - w / 2) * 2 - 1e-9) : Math.floor((from - w / 2) * 2 + 1e-9);
    for (let i = 0; i < 4; i++) {
      const v = (k0 + (s > 0 ? i : -i)) / 2 + w / 2;
      const t = (v - m.exit[ax]) / s;
      const K: Point = ax === 1 ? [r6(m.exit[0] + t * d[0]), v] : [v, r6(m.exit[1] + t * d[1])];
      const cost = m.cost + STUB + (lattice(v, w).whole ? 0 : 0.3);
      out.push({ m, K, gi, lead: [K], stub: true, cost, key: keyOf(K, gi) });
    }
  }
  return out;
}

const portCache = new Map<string, RoomPorts>();

function roomPorts(shape: Shape, w: number, relax: boolean): RoomPorts {
  const key = `${JSON.stringify(shape)}|${w}|${relax ? 1 : 0}`;
  const hit = portCache.get(key);
  if (hit) return hit;
  const g = geoOf(shape);
  const ports: Port[] = [];
  const walls: Wall[] = [];
  // sweeps along the axes and diagonals, on the half-square lattice
  DIRS.forEach((d, gi) => {
    const f = frameOf(g, d);
    const axis = gi < 4;
    const cs: number[] = [];
    if (axis) {
      const ax = gi % 2 === 0 ? 1 : 0; // the coordinate across the corridor
      const sign = f.n[ax]!;
      const b0 = ax === 1 ? g.bounds.y0 : g.bounds.x0;
      const b1 = ax === 1 ? g.bounds.y1 : g.bounds.x1;
      for (let k = Math.ceil(b0 * 2 - 1e-9); k / 2 + w <= b1 + 1e-9; k++) cs.push((k / 2 + w / 2) * sign);
    } else {
      const step = S2 / 2;
      for (let k = Math.ceil((f.lo + w / 2) / step - 1e-9); k * step <= f.hi - w / 2 + 1e-9; k++) cs.push(k * step);
    }
    for (const c of cs) {
      const m = mouthAt(g, f, c, w, axis, relax);
      if (!m) continue;
      ports.push(directPort(m, gi, w));
      if (!axis) ports.push(...stubPorts(m, w, relax));
    }
  });
  // square off each slanted wall
  const n = g.ring.length;
  for (let i = 0; i < n; i++) {
    const d = outward(g, i);
    if (DIRS.some((q) => dot(q, d) > Math.cos(0.5 * DEG))) continue;
    const a = g.ring[i]!;
    const b = g.ring[(i + 1) % n]!;
    const len = dist(a, b);
    const f = frameOf(g, d);
    const along: number[] = [];
    if (len >= w + 0.5) {
      const margin = Math.min(0.5, (len - w) / 4);
      for (let s = w / 2 + margin; s <= len - w / 2 - margin + 1e-9; s += 0.25) along.push(s);
      along.push(len / 2);
    } else along.push(len / 2);
    const cs: number[] = [];
    for (const s of along) {
      const p = add(a, sub(b, a), s / len);
      const c = dot(p, f.n);
      const m = mouthAt(g, f, c, w, false, relax);
      if (!m) continue;
      cs.push(c);
      ports.push(...stubPorts(m, w, relax));
    }
    if (cs.length) walls.push({ f, cs });
  }
  const out = { g, ports, walls };
  if (portCache.size > 400) portCache.delete(portCache.keys().next().value!);
  portCache.set(key, out);
  return out;
}

// ---------- routes ----------

interface Candidate {
  cost: number;
  relax: boolean;
  a: { m: MouthInfo };
  b: { m: MouthInfo };
  /** From A's exit to B's exit. */
  outer: Point[];
}

/** Cost of the part outside the rooms: length (diagonals a bit dearer, other slants more) plus every bend. */
function pathCost(pts: readonly Point[]): number {
  let cost = 0;
  for (let i = 1; i < pts.length; i++) {
    const v = sub(pts[i]!, pts[i - 1]!);
    const len = Math.hypot(...v);
    if (len < 1e-9) continue;
    const ax = Math.abs(v[0]) < 1e-9 || Math.abs(v[1]) < 1e-9;
    const diag = Math.abs(Math.abs(v[0]) - Math.abs(v[1])) < 1e-6;
    cost += len * (ax ? 1 : diag ? 1.2 : 1.5);
    if (i + 1 < pts.length) {
      const u = sub(pts[i + 1]!, pts[i]!);
      const lu = Math.hypot(...u);
      if (lu < 1e-9) continue;
      const phi = Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * len))));
      if (phi > 1e-6) cost += turnCost(phi);
    }
  }
  return cost;
}

/** Points without repeats or straight-through corners. */
function tidy(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length && dist(out.at(-1)!, p) < 1e-9) continue;
    while (out.length >= 2) {
      const a = out.at(-2)!;
      const b = out.at(-1)!;
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      const back = dot(sub(b, a), sub(p, b)) < 0;
      if (Math.abs(cross) > 1e-9 * Math.max(1, dist(a, b), dist(b, p)) || back) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * Does the band along a→b (half wide either side, stretched by extA and extB
 * past its ends) cut into the ring? Touching doesn't count.
 */
function bandHits(ring: readonly Point[], a: Point, b: Point, half: number, extA: number, extB: number): boolean {
  const len = dist(a, b);
  if (len < 1e-9) return false;
  const u: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const n: Point = [-u[1], u[0]];
  const o = add(a, u, -extA);
  const s1 = len + extA + extB;
  const h = half - 1e-6;
  const loc = (p: Point): Point => {
    const q = sub(p, o);
    return [dot(q, u), dot(q, n)];
  };
  const pts = ring.map(loc);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    // Liang–Barsky against the box [1e-6, s1 - 1e-6] × [-h, h]
    let t0 = 0;
    let t1 = 1;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    // keep the part with p·t <= q for each side of the box
    const clip = (p: number, q: number): boolean => {
      if (Math.abs(p) < 1e-15) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    if (clip(-dx, p[0] - 1e-6) && clip(dx, s1 - 1e-6 - p[0]) && clip(-dy, p[1] + h) && clip(dy, h - p[1]) && t1 - t0 > 1e-9) return true;
  }
  // the band wholly inside the room
  const mid = add(o, u, s1 / 2);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > mid[1] !== yj > mid[1] && mid[0] < ((xj - xi) * (mid[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does the route (A's exit to B's exit) keep clear of both rooms? */
function clear(outer: readonly Point[], rings: readonly (readonly Point[])[], w: number): boolean {
  for (let i = 1; i < outer.length; i++) {
    const a = outer[i - 1]!;
    const b = outer[i]!;
    // past the mouths by a hair; at bends the miter corner reaches half the width on
    const extA = i === 1 ? -0.01 : w / 2;
    const extB = i === outer.length - 1 ? -0.01 : w / 2;
    if (dist(a, b) + extA + extB <= 1e-6) continue;
    for (const ring of rings) if (bandHits(ring, a, b, w / 2, extA, extB)) return false;
  }
  return true;
}

/**
 * Notches: a corridor side running on the line of a nearby room wall (within
 * a third of a square, parallel, and less than 2.5 squares further along it),
 * like a corridor flush with the top of the room it just left.
 */
function flush(outer: readonly Point[], rings: readonly (readonly Point[])[], w: number): number {
  let pen = 0;
  const sin = Math.sin(3 * DEG);
  for (let i = 1; i < outer.length; i++) {
    const a = outer[i - 1]!;
    const len = dist(a, outer[i]!);
    if (len < 1e-6) continue;
    const u: Point = [(outer[i]![0] - a[0]) / len, (outer[i]![1] - a[1]) / len];
    const n: Point = [-u[1], u[0]];
    for (const side of [-w / 2, w / 2]) {
      const o = add(a, n, side);
      let hit = false;
      for (const ring of rings) {
        for (let k = 0; k < ring.length && !hit; k++) {
          const p = ring[k]!;
          const q = ring[(k + 1) % ring.length]!;
          const e = sub(q, p);
          const el = Math.hypot(...e);
          if (el < 0.25 || Math.abs(e[0] * u[1] - e[1] * u[0]) / el > sin) continue;
          if (Math.abs(dot(sub(p, o), n)) > 0.35) continue;
          const e0 = dot(sub(p, o), u);
          const e1 = dot(sub(q, o), u);
          const gap = Math.max(0, Math.min(e0, e1) - len, -Math.max(e0, e1));
          if (gap < 2.5) hit = true;
        }
      }
      if (hit) pen += FLUSH;
    }
  }
  return pen;
}

/** A polyline offset sideways by o (left of the way it runs), with miter corners: one side of a corridor. */
function offsetLine(pts: readonly Point[], o: number): Point[] {
  const legs: { a: Point; u: Point }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const len = dist(pts[i - 1]!, pts[i]!);
    if (len > 1e-9) legs.push({ a: pts[i - 1]!, u: [(pts[i]![0] - pts[i - 1]![0]) / len, (pts[i]![1] - pts[i - 1]![1]) / len] });
  }
  if (!legs.length) return [];
  const off = (p: Point, u: Point): Point => [p[0] - u[1] * o, p[1] + u[0] * o];
  const out: Point[] = [off(legs[0]!.a, legs[0]!.u)];
  for (let i = 1; i < legs.length; i++) {
    const p = off(legs[i - 1]!.a, legs[i - 1]!.u);
    const q = off(legs[i]!.a, legs[i]!.u);
    const st = meet(p, legs[i - 1]!.u, q, legs[i]!.u);
    out.push(st ? add(p, legs[i - 1]!.u, st[0]) : q);
  }
  out.push(off(pts.at(-1)!, legs.at(-1)!.u));
  return out;
}

/**
 * The narrowest rock wedge at a mouth's two corners, in degrees: between the
 * wall leaving the corner and the corridor's side as it really runs (a bend
 * soon after the mouth can turn the side towards the wall), as far as that
 * wall runs before its next corner. `outer` starts at this mouth's exit.
 */
function sideWedge(outer: readonly Point[], m: MouthInfo, w: number): number {
  let worst = 180;
  ([m.p0, m.p1] as const).forEach((P, k) => {
    const wall = m.walls[k]!;
    const reach = Math.min(4, wall.clear + 0.5);
    const side = offsetLine(outer, (k === 0 ? -1 : 1) * (w / 2));
    let walked = 0;
    for (let i = 1; i < side.length && walked < reach + 1; i++) {
      const a = side[i - 1]!;
      const b = side[i]!;
      const len = dist(a, b);
      const steps = Math.max(1, Math.ceil(len / 0.2));
      for (let j = 1; j <= steps; j++) {
        const q = add(a, sub(b, a), j / steps);
        const dq = dist(q, P);
        if (dq < 0.05 || dq > reach) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(sub(q, P), wall.dir) / dq))) / DEG;
        worst = Math.min(worst, ang);
      }
      walked += len;
    }
  });
  return worst;
}

/** Do the two outlines overlap (cross, or one inside the other)? */
function overlapping(a: Geo, b: Geo): boolean {
  const A = a.bounds;
  const B = b.bounds;
  if (A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0) return false;
  for (let i = 0; i < a.ring.length; i++) {
    if (bandHits(b.ring, a.ring[i]!, a.ring[(i + 1) % a.ring.length]!, 1e-6 + 1e-7, 0, 0)) return true;
  }
  const inRing = (p: Point, ring: readonly Point[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return inRing(a.ring[0]!, b.ring) || inRing(b.ring[0]!, a.ring);
}

/** Where lines p + s·u and q + t·v meet: [s, t], or null if parallel. */
function meet(p: Point, u: Point, q: Point, v: Point): [number, number] | null {
  const den = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(den) < 1e-12) return null;
  const r = sub(q, p);
  return [(r[0] * v[1] - r[1] * v[0]) / den, (r[0] * u[1] - r[1] * u[0]) / den];
}

function candidates(A: RoomPorts, B: RoomPorts, w: number, relax: boolean): Candidate[] {
  const out: Candidate[] = [];
  const pa = A.ports;
  const pb = B.ports;
  const outerOf = (a: Port, mid: Point[], b: Port): Point[] => [a.m.exit, ...a.lead, ...mid, ...[...b.lead].reverse(), b.m.exit];
  const push = (a: Port, mid: Point[], b: Port, extra = 0) => {
    const outer = outerOf(a, mid, b);
    out.push({ cost: a.cost + b.cost + extra + pathCost(outer) + (relax ? RELAX : 0), relax, a, b, outer });
  };
  const free = (p: Port, phi: number) => (p.stub ? Math.max(w, 1) : minLeg(phi, w, relax));

  // straight: facing each other on one line
  const byKey = new Map<string, Port[]>();
  for (const p of pb) {
    const k = `${p.gi}|${p.key}`;
    const list = byKey.get(k);
    if (list) list.push(p);
    else byKey.set(k, [p]);
  }
  for (const a of pa) {
    const list = byKey.get(`${opposite(a.gi)}|${r6(-a.key)}`);
    if (!list) continue;
    const g = DIRS[a.gi]!;
    for (const b of list) {
      const gap = dot(sub(b.K, a.K), g);
      if (gap <= 1e-6) continue;
      if ((a.stub && gap < Math.max(w, 1)) || (b.stub && gap < Math.max(w, 1))) continue;
      push(a, [], b);
    }
  }

  // straight across two parallel slanted walls
  for (const wa of A.walls) {
    for (const wb of B.walls) {
      if (dot(wa.f.d, wb.f.d) > -1 + 1e-9) continue;
      // B's laterals in A's frame: u_A = -u_B
      const lo = Math.max(Math.min(...wa.cs), -Math.max(...wb.cs));
      const hi = Math.min(Math.max(...wa.cs), -Math.min(...wb.cs));
      if (hi < lo - 1e-9) continue;
      const c = (lo + hi) / 2;
      const ma = mouthAt(A.g, wa.f, c, w, false, relax);
      const mb = mouthAt(B.g, wb.f, -c, w, false, relax);
      if (!ma || !mb) continue;
      if (dot(sub(mb.exit, ma.exit), wa.f.d) <= 1e-6) continue;
      const outer = [ma.exit, mb.exit];
      out.push({ cost: ma.cost + mb.cost + pathCost(outer) + (relax ? RELAX : 0), relax, a: { m: ma }, b: { m: mb }, outer });
    }
  }

  // L and Z: from each room's best few ports per direction
  const best = (ports: Port[], other: Bounds): Port[][] => {
    const cx = (other.x0 + other.x1) / 2;
    const cy = (other.y0 + other.y1) / 2;
    const groups: Port[][] = DIRS.map(() => []);
    for (const p of ports) {
      // only ports heading towards the other room
      const g = DIRS[p.gi]!;
      if (Math.max(...[other.x0, other.x1].flatMap((x) => [other.y0, other.y1].map((y) => dot(sub([x, y], p.K), g)))) < 1) continue;
      groups[p.gi]!.push(p);
    }
    const score = (p: Port) => p.cost + 0.15 * Math.hypot(p.K[0] - cx, p.K[1] - cy);
    return groups.map((list) => list.sort((x, y) => score(x) - score(y)).slice(0, 8));
  };
  const ga = best(pa, B.g.bounds);
  const gb = best(pb, A.g.bounds);
  for (let ia = 0; ia < 8; ia++) {
    for (let ib = 0; ib < 8; ib++) {
      const u = DIRS[ia]!;
      const v = DIRS[ib]!;
      const cos = dot(u, v);
      const inTurn = -cos; // cosine of the bend between leaving A along u and entering B along -v
      if (Math.abs(cos) < 1e-9 || (Math.abs(inTurn - S2) < 1e-9 && (ia >= 4) !== (ib >= 4))) {
        // L: one bend (square, or 45° between an axis and a diagonal)
        const phi = Math.acos(Math.max(-1, Math.min(1, inTurn)));
        for (const a of ga[ia]!) {
          for (const b of gb[ib]!) {
            const st = meet(a.K, u, b.K, v);
            if (!st) continue;
            const [s, t] = st;
            if (s < free(a, phi) - 1e-9 || t < free(b, phi) - 1e-9) continue;
            const C = add(a.K, u, s);
            push(a, [[r6(C[0]), r6(C[1])]], b);
          }
        }
      } else if (cos < -1 + 1e-9 && ia < 4) {
        // Z: facing, off one line: out, across, in
        const half = Math.PI / 2;
        for (const a of ga[ia]!) {
          for (const b of gb[ib]!) {
            const gap = dot(sub(b.K, a.K), u);
            const s0 = free(a, half);
            const s1 = gap - free(b, half);
            if (s1 < s0 - 1e-9) continue;
            const jog = Math.abs(a.key + b.key);
            if (jog < 1e-6) continue; // that's a straight one
            // the cross leg on whole squares if it fits, else half squares, else halfway
            const ax = ia % 2 === 0 ? 0 : 1; // coordinate along the corridor
            const base = a.K[ax];
            const sign = u[ax]!;
            const want = base + sign * (gap / 2);
            const at = (s: number) => base + sign * s;
            const range = [at(s0), at(s1)].sort((x, y) => x - y) as [number, number];
            let pick: number | null = null;
            for (const unit of [1, 0.5]) {
              const k = Math.round((want - w / 2) / unit) * unit + w / 2;
              for (const cand of [k, k - unit, k + unit]) {
                if (cand >= range[0] - 1e-9 && cand <= range[1] + 1e-9 && (pick === null || Math.abs(cand - want) < Math.abs(pick - want))) pick = cand;
              }
              if (pick !== null) break;
            }
            const mid = pick ?? want;
            const s = (mid - base) * sign;
            const M1 = add(a.K, u, s);
            const M2: Point = ax === 0 ? [M1[0], b.K[1]] : [b.K[0], M1[1]];
            push(a, [M1, M2].map(([x, y]) => [r6(x), r6(y)] as Point), b, jog < w ? 1.5 : 0);
          }
        }
      }
    }
  }
  return out;
}

const routeCache = new Map<string, OutlineRoute | null>();

/**
 * A corridor w squares wide from room a to room b, meeting their real
 * outlines; null when the rooms overlap or no clean route exists.
 */
export function outlineRoute(a: Shape, b: Shape, w: number): OutlineRoute | null {
  const key = `${JSON.stringify(a)}|${JSON.stringify(b)}|${w}`;
  if (routeCache.has(key)) return routeCache.get(key)!;
  const found = solve(a, b, w);
  if (routeCache.size > 2000) routeCache.delete(routeCache.keys().next().value!);
  routeCache.set(key, found);
  return found;
}

function solve(sa: Shape, sb: Shape, w: number): OutlineRoute | null {
  const strictA = roomPorts(sa, w, false);
  const strictB = roomPorts(sb, w, false);
  if (overlapping(strictA.g, strictB.g)) return null;
  const rings = [strictA.g.ring, strictB.g.ring];
  const list = [...candidates(strictA, strictB, w, false), ...candidates(roomPorts(sa, w, true), roomPorts(sb, w, true), w, true)].sort((x, y) => x.cost - y.cost);
  // the cheapest clear route, counting notches; checked in order until no later one can be cheaper
  let pick: Candidate | null = null;
  let best = Infinity;
  for (const c of list) {
    if (c.cost >= best) break;
    if (!clear(c.outer, rings, w)) continue;
    // rock wedges against the corridor's real sides, at both ends
    const wa = sideWedge(c.outer, c.a.m, w);
    const wb = sideWedge([...c.outer].reverse(), c.b.m, w);
    if (Math.min(wa, wb) < minWedge(c.relax)) continue;
    const wedge = (x: number) => (x < 90 ? 1.5 * ((90 - x) / 40) ** 2 : 0);
    const total = c.cost + flush(c.outer, rings, w) + Math.max(0, wedge(wa) + wedge(wb) - c.a.m.wedgeCost - c.b.m.wedgeCost);
    if (total < best) {
      best = total;
      pick = c;
    }
  }
  if (!pick) return null;
  const path = tidy([pick.a.m.start, ...pick.outer, pick.b.m.start]).map(([x, y]) => [r6(x), r6(y)] as Point);
  return { path, mouths: [mouthOf(pick.a.m), mouthOf(pick.b.m)] };
}

const mouthOf = (m: MouthInfo): Mouth => [
  [r6(m.p0[0]), r6(m.p0[1])],
  [r6(m.p1[0]), r6(m.p1[1])],
];
