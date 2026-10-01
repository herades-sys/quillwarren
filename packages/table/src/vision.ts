// Line-of-sight geometry for Delve Table (docs/TABLE.md, "Vision and light"):
// the visibility polygon from a point among wall segments, circles, and the
// polygon algebra (union, intersection, difference via clipper2-ts) that turns
// them into what a party sees. Pure: no Node or DOM APIs, so the server and the
// browser share it. Coordinates are cells (page coordinates), y down.
//
// Polygons are {outer, holes} with [x, y] rings, the same shape as @delve/core's
// Polygon, so either side can take the other's.
import {
  areaD,
  areaPathsD,
  booleanOpDWithPolyTree,
  ClipType,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  PolyTreeD,
  simplifyPathD,
  type PathD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts';

export type Pt = [number, number];
export type Seg = [Pt, Pt];
export type Ring = Pt[];
export interface Poly {
  outer: Ring;
  holes: Ring[];
}
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Decimal places Clipper keeps (0.0001 cells). */
const PRECISION = 4;
/** Rays just either side of each wall end, in radians. */
const ANGLE_EPS = 1e-5;
/** How far past a segment's end a ray still counts as hitting it (closes cracks at shared corners). */
const U_EPS = 1e-9;
/** A viewer closer than this to a wall is moved off it first: on the line it would see both sides. */
const ON_WALL = 1e-6;
const BUCKETS = 512;
const TWO_PI = Math.PI * 2;

// ---------- the visibility polygon ----------

const bucketOf = (angle: number): number => {
  const k = Math.floor(((angle + Math.PI) / TWO_PI) * BUCKETS);
  return ((k % BUCKETS) + BUCKETS) % BUCKETS;
};

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Everything visible from `origin` among the blocking segments, inside `box`
 * (which bounds the result; use it to cull walls too far away to matter).
 *
 * Rays go to every wall end and just either side of it (± 1e-5 rad); each stops
 * at the nearest wall it meets. Walls are only tested against rays in their own
 * angular range (512 buckets), so a page of a few hundred walls stays in the
 * low milliseconds. Robust with collinear and touching walls: a ray through a
 * shared corner hits both walls there (no crack), and a wall seen edge-on has
 * no width, so it hides nothing behind its end. A viewer standing exactly on a
 * wall is nudged 1e-4 off it (towards +x+y first), so it sees one side only.
 *
 * Returns one ring (positive area, i.e. counter-clockwise in Clipper's sense), or
 * an empty ring if the origin is outside the box.
 */
export function visibilityPolygon(origin: Pt, segments: readonly Seg[], box: Box): Ring {
  let [ox, oy] = origin;
  if (!(ox > box.x0 && ox < box.x1 && oy > box.y0 && oy < box.y1)) return [];

  // walls that can matter: inside the box (bounding boxes overlap), and longer than nothing
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (const [a, b] of segments) {
    if (Math.max(a[0], b[0]) < box.x0 || Math.min(a[0], b[0]) > box.x1 || Math.max(a[1], b[1]) < box.y0 || Math.min(a[1], b[1]) > box.y1) continue;
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) continue;
    ax.push(a[0]);
    ay.push(a[1]);
    bx.push(b[0]);
    by.push(b[1]);
  }
  const walls = ax.length;
  const onWall = (x: number, y: number): boolean => {
    for (let i = 0; i < walls; i++) if (distToSeg(x, y, ax[i]!, ay[i]!, bx[i]!, by[i]!) < ON_WALL) return true;
    return false;
  };
  if (onWall(ox, oy)) {
    const nudge = 1e-4;
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0.3], [-0.3, 1]] as const) {
      if (!onWall(ox + dx * nudge, oy + dy * nudge)) {
        ox += dx * nudge;
        oy += dy * nudge;
        break;
      }
    }
  }
  // the box itself, so every ray ends somewhere
  const corners: Pt[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    ax.push(a[0]);
    ay.push(a[1]);
    bx.push(b[0]);
    by.push(b[1]);
  }
  const n = ax.length;

  // each wall goes into the buckets of the angles it covers as seen from the origin
  const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);
  const tol = ANGLE_EPS * 4 + TWO_PI / BUCKETS;
  for (let i = 0; i < n; i++) {
    const a1 = Math.atan2(ay[i]! - oy, ax[i]! - ox);
    const a2 = Math.atan2(by[i]! - oy, bx[i]! - ox);
    let d = a2 - a1;
    if (d > Math.PI) d -= TWO_PI;
    else if (d <= -Math.PI) d += TWO_PI;
    const start = d < 0 ? a2 : a1;
    const span = Math.abs(d);
    const first = bucketOf(start - tol);
    const count = Math.min(BUCKETS, Math.ceil(((span + 2 * tol) / TWO_PI) * BUCKETS) + 1);
    for (let k = 0; k < count; k++) buckets[(first + k) % BUCKETS]!.push(i);
  }

  // one ray to each distinct wall end, and one just either side
  const seen = new Set<string>();
  const rays: { angle: number; dx: number; dy: number }[] = [];
  const cos = Math.cos(ANGLE_EPS);
  const sin = Math.sin(ANGLE_EPS);
  const addEnd = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dx = x - ox;
    const dy = y - oy;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return;
    const angle = Math.atan2(dy, dx);
    rays.push({ angle, dx, dy });
    rays.push({ angle: angle - ANGLE_EPS, dx: dx * cos + dy * sin, dy: -dx * sin + dy * cos });
    rays.push({ angle: angle + ANGLE_EPS, dx: dx * cos - dy * sin, dy: dx * sin + dy * cos });
  };
  for (let i = 0; i < n; i++) {
    addEnd(ax[i]!, ay[i]!);
    addEnd(bx[i]!, by[i]!);
  }
  for (const r of rays) if (r.angle < -Math.PI) r.angle += TWO_PI;
  for (const r of rays) if (r.angle >= Math.PI) r.angle -= TWO_PI;
  rays.sort((p, q) => p.angle - q.angle);

  const out: Ring = [];
  for (const r of rays) {
    let best = Infinity;
    for (const i of buckets[bucketOf(r.angle)]!) {
      const sx = bx[i]! - ax[i]!;
      const sy = by[i]! - ay[i]!;
      const denom = r.dx * sy - r.dy * sx;
      if (Math.abs(denom) < 1e-15) continue; // parallel: a wall seen edge-on hides nothing
      const wx = ax[i]! - ox;
      const wy = ay[i]! - oy;
      const t = (wx * sy - wy * sx) / denom;
      if (t <= 1e-12 || t >= best) continue;
      const u = (wx * r.dy - wy * r.dx) / denom;
      if (u < -U_EPS || u > 1 + U_EPS) continue;
      best = t;
    }
    if (best === Infinity) continue;
    const x = ox + r.dx * best;
    const y = oy + r.dy * best;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) continue;
    out.push([x, y]);
  }
  if (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
  }
  if (out.length < 3) return [];
  // drop points on a straight line between their neighbours (the ± rays along one wall)
  const ring = fromPath(simplifyPathD(toPath(out), 1e-5, true), 9);
  return ringArea(ring) < 0 ? ring.reverse() : ring;
}

// ---------- shapes ----------

/** A circle as a polygon with corners on it (so it lies just inside), about 0.35 cells per side. */
export function circle(c: Pt, r: number, minSteps = 16): Ring {
  if (!(r > 0)) return [];
  const steps = Math.max(minSteps, Math.min(128, Math.ceil((TWO_PI * r) / 0.35)));
  const out: Ring = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TWO_PI;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return ringArea(out) < 0 ? out.reverse() : out;
}

export const boxRing = (b: Box): Ring => {
  const r: Ring = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1],
  ];
  return ringArea(r) < 0 ? r.reverse() : r;
};

export const ringPoly = (ring: Ring): Poly[] => (ring.length >= 3 ? [{ outer: ring, holes: [] }] : []);

/**
 * A rectangle (top-left x, y, size w × h, turned `rotation` degrees clockwise
 * about its centre) as its four corners.
 */
export function rectCorners(x: number, y: number, w: number, h: number, rotation = 0): Pt[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([dx, dy]) => [cx + dx! * c - dy! * s, cy + dx! * s + dy! * c] as Pt);
}

/**
 * Sample points spread over a rectangle, kept `inset` cells in from its edges
 * (at most a quarter of its size), about 4 per cell. A footprint "overlaps" a
 * region when one of these is inside it: touching along an edge, or poking 0.2
 * cells past a wall, doesn't count.
 */
export function rectSamples(x: number, y: number, w: number, h: number, rotation = 0, inset = 0.2): Pt[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ix = Math.min(inset, w / 4);
  const iy = Math.min(inset, h / 4);
  const nx = Math.max(2, Math.min(24, Math.ceil(w * 4)));
  const ny = Math.max(2, Math.min(24, Math.ceil(h * 4)));
  const out: Pt[] = [];
  for (let i = 0; i < nx; i++) {
    const dx = -w / 2 + ix + ((w - 2 * ix) * i) / (nx - 1);
    for (let j = 0; j < ny; j++) {
      const dy = -h / 2 + iy + ((h - 2 * iy) * j) / (ny - 1);
      out.push([cx + dx * c - dy * s, cy + dx * s + dy * c]);
    }
  }
  return out;
}

// ---------- polygon algebra ----------

const toPath = (ring: readonly Pt[]): PathD => ring.map(([x, y]) => ({ x, y }));

function fromPath(path: PathD, decimals = PRECISION): Ring {
  const k = 10 ** decimals;
  return path.map((p) => [Math.round(p.x * k) / k + 0, Math.round(p.y * k) / k + 0] as Pt);
}

export const ringArea = (ring: readonly Pt[]): number => areaD(toPath(ring));

/** Flat Clipper paths: outer rings and holes, orientations as stored (outer positive, holes negative). */
export const toPaths = (polys: readonly Poly[]): PathsD => polys.flatMap((p) => [p.outer, ...p.holes].map(toPath));

function collect(node: PolyPathD, out: Poly[]): void {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i);
    const holes: Ring[] = [];
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j);
      if (hole.poly && hole.poly.length >= 3) holes.push(fromPath(hole.poly));
      collect(hole, out); // islands inside a hole
    }
    if (outer.poly && outer.poly.length >= 3) out.push({ outer: fromPath(outer.poly), holes });
  }
}

function op(type: ClipType, subject: PathsD, clip: PathsD): Poly[] {
  if (!subject.length && type !== ClipType.Union) return [];
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(type, subject, clip, tree, FillRule.NonZero, PRECISION);
  const out: Poly[] = [];
  collect(tree, out);
  return out;
}

export function union(...sets: readonly (readonly Poly[])[]): Poly[] {
  const all = sets.flatMap((s) => toPaths(s));
  return all.length ? op(ClipType.Union, all, []) : [];
}

export function intersect(a: readonly Poly[], b: readonly Poly[]): Poly[] {
  if (!a.length || !b.length) return [];
  return op(ClipType.Intersection, toPaths(a), toPaths(b));
}

export function difference(a: readonly Poly[], b: readonly Poly[]): Poly[] {
  if (!a.length) return [];
  if (!b.length) return union(a);
  return op(ClipType.Difference, toPaths(a), toPaths(b));
}

/** Grow (or with d < 0 shrink) polygons by d cells, with round corners. */
export function inflate(polys: readonly Poly[], d: number): Poly[] {
  if (!polys.length) return [];
  return op(ClipType.Union, inflatePathsD(toPaths(polys), d, JoinType.Round, EndType.Polygon, 2, PRECISION), []);
}

/** Total area in cells². */
export const area = (polys: readonly Poly[]): number => Math.abs(areaPathsD(toPaths(polys)));

/** Fewer corners: drop those within `tol` cells of the line through their neighbours, then round to `decimals`. */
export function simplify(polys: readonly Poly[], tol: number, decimals = 3): Poly[] {
  const ring = (r: Ring): Ring | null => {
    const s = fromPath(simplifyPathD(toPath(r), tol, true), decimals);
    const clean: Ring = [];
    for (const p of s) {
      const last = clean[clean.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) clean.push(p);
    }
    if (clean.length > 2 && clean[0]![0] === clean[clean.length - 1]![0] && clean[0]![1] === clean[clean.length - 1]![1]) clean.pop();
    return clean.length >= 3 && Math.abs(ringArea(clean)) > 1e-6 ? clean : null;
  };
  const out: Poly[] = [];
  for (const p of polys) {
    const outer = ring(p.outer);
    if (!outer) continue;
    out.push({ outer, holes: p.holes.map(ring).filter((h): h is Ring => h !== null) });
  }
  return out;
}

/** The bounding box of polygons' outer rings, or null when there are none. */
export function bounds(polys: readonly Poly[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys) {
    for (const [x, y] of p.outer) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

function inRing(ring: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside one of the polygons (and not in one of its holes). */
export function pointIn(polys: readonly Poly[], p: Pt): boolean {
  for (const poly of polys) {
    if (inRing(poly.outer, p[0], p[1]) && !poly.holes.some((h) => inRing(h, p[0], p[1]))) return true;
  }
  return false;
}

/** Is any of the points inside the polygons? Polygons whose box misses the points' box are skipped. */
export function anyPointIn(polys: readonly Poly[], pts: readonly Pt[]): boolean {
  if (!polys.length || !pts.length) return false;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  for (const poly of polys) {
    const b = bounds([poly]);
    if (!b || b.x1 < pb.x0 || b.x0 > pb.x1 || b.y1 < pb.y0 || b.y0 > pb.y1) continue;
    for (const p of pts) if (pointIn([poly], p)) return true;
  }
  return false;
}

/**
 * Each segment as a thin rectangle `half` cells to either side and past its ends:
 * the strip a drawn wall (or a door leaf) covers.
 */
export function segmentStrips(segs: readonly Seg[], half: number): { box: Box; ring: Ring }[] {
  const out: { box: Box; ring: Ring }[] = [];
  for (const [a, b] of segs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(len > 0)) continue;
    const ux = ((b[0] - a[0]) / len) * half;
    const uy = ((b[1] - a[1]) / len) * half;
    const ring: Ring = [
      [a[0] - ux - uy, a[1] - uy + ux],
      [b[0] + ux - uy, b[1] + uy + ux],
      [b[0] + ux + uy, b[1] + uy - ux],
      [a[0] - ux + uy, a[1] - uy - ux],
    ];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    out.push({ box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, ring: ringArea(ring) < 0 ? ring.reverse() : ring });
  }
  return out;
}

/**
 * `region` plus the walls at its edge as they are drawn: the strips of the
 * walls within `reach` cells of it, cut to `reach` around it. A visibility
 * polygon stops exactly on the wall line; this lets the far half of the wall
 * stroke and a shut door's leaf show, and nothing of the floor behind them
 * beyond the strip's half width.
 */
export function withWalls(region: readonly Poly[], strips: readonly { box: Box; ring: Ring }[], reach: number): Poly[] {
  const b = bounds(region);
  if (!b) return [];
  const near = strips.filter((s) => s.box.x1 >= b.x0 - reach && s.box.x0 <= b.x1 + reach && s.box.y1 >= b.y0 - reach && s.box.y0 <= b.y1 + reach);
  if (!near.length) return union(region);
  const grown = inflate(region, reach);
  const edge = intersect(grown, near.map((s) => ({ outer: s.ring, holes: [] })));
  return union(region, edge);
}
