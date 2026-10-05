// The ground's real shape under height areas (docs/API.md, "Heights within a
// map", "The surface"). The plan (heights.ts) gives every area one height, which
// says what's walkable and which edges block; the surface is the ground itself:
// hills rounded, slopes as ramps, cliffs as sharp cuts. The 2D map draws its
// hillshade and contours from it (render/heights.ts) and both 3D views drape the
// floor picture over it (heightScene).
//
// How it's built: the areas apply in map order, as in the plan. The ground starts
// at 0, and each area pulls it toward its own height by a weight f from 0 to 1:
// h ← h + (height − h) · f. So an area stands at its own height (a plateau: f = 1
// inside), a hill rises out of whatever it stands on toward its top, and nested
// hills give a second rise up to the inner one's height (heights don't add).
//   - plateau: f = 1 inside. With a slope edge the ramp lies on the low side: a
//     raised one keeps its whole top and ramps down outside; a sunken one keeps
//     its rim at the outline and ramps down inside.
//   - hill: f rises from the foot to 1 at the area's deepest part (distance from
//     the outline over the area's depth, eased), so long, thin areas become
//     ridges; a seeded warp sets the top a little off-centre and a seeded
//     exponent keeps the slopes from being a perfect dome. A hill with a slope
//     edge spreads its foot outside its outline when the area is too small for
//     the slope (see slopeRun); one with a sheer edge starts at 40 % of its rise.
//   - Ramps and hill feet narrow where something is in the way (another height
//     area, a wall, the ground's edge), never below a square.
// Sheer edges (cliff, rock, step) and the ground's outline cut the ground into
// pieces; within a piece the surface is smooth, and each piece is evaluated as
// if its own side of every cut went on (heightIn), so the faces between pieces
// get both heights exactly.
import { differenceD, FillRule, intersectD, unionD, type PathD, type PathsD } from 'clipper2-ts';
import { floorPaths, polygonsOf } from './geometry/floor.ts';
import { pointInRing, pointsBounds, PRECISION, shapePath, toPath, type Bounds, type Polygon, type Ring } from './geometry/shapes.ts';
import { groundPaths, heightPlan, slopeRun, type HeightOptions, type HeightPlan } from './heights.ts';
import { hashInts, hashString } from './render/rng.ts';
import type { DelveMap, HeightArea, HeightProfile, Point } from './schema.ts';
import type { SquareUnit } from './units.ts';

/** An area's profile: as set, else a hill for a slope edge and a plateau for the rest. */
export function heightProfile(a: Pick<HeightArea, 'profile' | 'edge'>): HeightProfile {
  return a.profile ?? (a.edge === 'slope' ? 'hill' : 'plateau');
}

/** Smoothstep: eased at both ends, so a ramp meets the ground and the top without a kink. */
export const ease = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Ramps and hill feet are never narrowed below this (squares), unless the slope itself is shorter. */
export const MIN_BAND = 1;
/** A sheer-edged hill starts at this share of its rise at its outline (a rocky knoll), then rounds off. */
export const HILL_LIP = 0.4;

const hash01 = (seed: number, i: number, j: number): number => {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

/** Smooth value noise in [-0.5, 0.5] on a unit lattice, seeded. */
export function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(seed, ix, iy);
  const b = hash01(seed, ix + 1, iy);
  const c = hash01(seed, ix, iy + 1);
  const d = hash01(seed, ix + 1, iy + 1);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy - 0.5;
}

/** One area as the surface sees it. */
export interface SurfaceArea {
  area: HeightArea;
  /** Its height, in the map's units. */
  height: number;
  hill: boolean;
  /** Its edge is a cliff, rock face or step: a cut, not a ramp. */
  sheer: boolean;
  /** Higher than the ground around it (by the plan's edges): its ramp or foot goes outside, else inside. */
  raised: boolean;
  /** The outline its profile is measured from: the shape, with a hill's corners rounded off (so its slopes have no creases). */
  ring: Ring;
  /** The shape's box. */
  box: Bounds;
  /** A hill's depth (squares): the distance from its outline to its deepest point, and that point (0 and the box's middle for a flat area). */
  depth: number;
  top: Point;
  /** The width of its ramp or hill foot along the outline (by arc length), or null. */
  band: { at: Float64Array; width: Float64Array } | null;
  bandMax: number;
  /** Where its weight isn't just 0 or 1: its outline's box plus an outside band. Null: a flat plateau with a sheer edge. */
  zone: Bounds | null;
  seed: number;
  // the outline's segments, for distances
  ax: Float64Array;
  ay: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  len: Float64Array;
  cum: Float64Array;
  total: number;
}

/** A piece of the ground where the surface varies, cut off by sheer edges and the ground's outline. */
export interface SurfacePiece {
  paths: PathsD;
  polygons: Polygon[];
  bounds: Bounds;
  /** The sheer areas (indices into `areas`) it lies in. */
  inside: ReadonlySet<number>;
}

export interface HeightSurface {
  plan: HeightPlan;
  unit: SquareUnit;
  /** Every area in this view, in map order. */
  areas: SurfaceArea[];
  /** Where the surface isn't flat (hills, ramps), as boxes; elsewhere it is the plan's height. */
  zones: Bounds[];
  zonePaths: PathsD;
  /** The ground within the zones, in pieces. */
  pieces: SurfacePiece[];
  /** The height (map units) at p as seen from piece i, carrying on smoothly a little past its outline. */
  heightIn(piece: number, p: Point): number;
  /** The piece at p, or -1 (outside the zones, or off the ground). */
  pieceAt(p: Point): number;
  /** The height (map units) at p: 0 off the ground. */
  at(p: Point): number;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** How much of the gap a ramp may take toward this: all of it, or half when a ramp comes from there too. */
  share: number;
  own: boolean;
}

const inBox = (b: Bounds, x: number, y: number): boolean => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const grow = (b: Bounds, d: number): Bounds => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
const boxPath = (b: Bounds): PathD => [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
const boxesMeet = (a: Bounds, b: Bounds): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** The nearest point of an area's outline: its distance and where along the outline it is. */
function nearest(a: SurfaceArea, x: number, y: number): { d: number; arc: number } {
  let best = Infinity;
  let arc = 0;
  for (let k = 0; k < a.len.length; k++) {
    const l = a.len[k]!;
    const px = x - a.ax[k]!;
    const py = y - a.ay[k]!;
    let t = l > 0 ? (px * a.dx[k]! + py * a.dy[k]!) / (l * l) : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - a.dx[k]! * t;
    const ey = py - a.dy[k]! * t;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      arc = a.cum[k]! + t * l;
    }
  }
  return { d: Math.sqrt(best), arc };
}

/** The band's width at a place along the outline. */
function bandAt(a: SurfaceArea, arc: number): number {
  const b = a.band;
  if (!b) return 0;
  const at = b.at;
  let lo = 0;
  let hi = at.length - 1;
  if (arc <= at[0]!) return b.width[0]!;
  if (arc >= at[hi]!) return b.width[hi]!;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (at[m]! <= arc) lo = m;
    else hi = m;
  }
  const t = (arc - at[lo]!) / (at[hi]! - at[lo]! || 1);
  return b.width[lo]! + (b.width[hi]! - b.width[lo]!) * t;
}

function segmentsOf(ring: Ring): Pick<SurfaceArea, 'ax' | 'ay' | 'dx' | 'dy' | 'len' | 'cum' | 'total'> {
  const n = ring.length;
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const len = new Float64Array(n);
  const cum = new Float64Array(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % n]!;
    ax[k] = a[0];
    ay[k] = a[1];
    dx[k] = b[0] - a[0];
    dy[k] = b[1] - a[1];
    len[k] = Math.hypot(dx[k]!, dy[k]!);
    cum[k] = total;
    total += len[k]!;
  }
  return { ax, ay, dx, dy, len, cum, total };
}

/** A ring with its corners cut (Chaikin): each pass keeps the points a quarter and three quarters along every side. */
function rounded(ring: Ring, passes: number): Ring {
  let r = ring;
  for (let k = 0; k < passes; k++) {
    const out: Ring = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    r = out;
  }
  return r;
}

/** Twice the ring's signed area (positive: the inside is left of each edge). */
const signedArea2 = (ring: Ring): number => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
};

/** The deepest point inside a ring and its distance from the outline (sampled). */
function deepest(a: Pick<SurfaceArea, 'ax' | 'ay' | 'dx' | 'dy' | 'len' | 'cum' | 'ring' | 'box'>): { depth: number; top: Point } {
  const b = a.box;
  const step = Math.max(0.12, Math.min(b.x1 - b.x0, b.y1 - b.y0) / 40);
  let depth = 0;
  let top: Point = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  for (let y = b.y0 + step / 2; y < b.y1; y += step) {
    for (let x = b.x0 + step / 2; x < b.x1; x += step) {
      if (!pointInRing([x, y], a.ring)) continue;
      const d = nearest(a as SurfaceArea, x, y).d;
      if (d > depth) {
        depth = d;
        top = [x, y];
      }
    }
  }
  return { depth: Math.max(depth, 0.25), top };
}

/**
 * How wide a ramp or hill foot can be along an area's outline, out to `target`
 * squares on its low side: rays from points along the outline (straight out
 * and fanned to the sides) find the nearest thing in the way; half that gap
 * when a ramp comes from there too. Smoothed along the outline.
 */
function bandWidths(a: SurfaceArea, target: number, obstacles: readonly Seg[]): { at: Float64Array; width: Float64Array } {
  const outward = a.raised;
  // positive area: the inside is left of each edge, so (dy, -dx) points out
  const sign = signedArea2(a.ring) > 0 ? 1 : -1;
  const normal = (k: number): [number, number] => {
    const l = a.len[k]! || 1;
    const s = (outward ? 1 : -1) * sign;
    return [(a.dy[k]! / l) * s, (-a.dx[k]! / l) * s];
  };
  const n = a.len.length;
  const at: number[] = [];
  const width: number[] = [];
  const fan = [0, 0.45, -0.45, 0.9, -0.9];
  for (let k = 0; k < n; k++) {
    const l = a.len[k]!;
    const parts = Math.max(1, Math.ceil(l / 0.5));
    for (let m = 0; m < parts; m++) {
      const t = m / parts;
      const ox = a.ax[k]! + a.dx[k]! * t;
      const oy = a.ay[k]! + a.dy[k]! * t;
      let [nx, ny] = normal(k);
      if (m === 0) {
        const [px, py] = normal((k + n - 1) % n);
        const ll = Math.hypot(nx + px, ny + py) || 1;
        nx = (nx + px) / ll;
        ny = (ny + py) / ll;
      }
      let gap = target;
      for (const th of fan) {
        const c = Math.cos(th);
        const s = Math.sin(th);
        const rx = nx * c - ny * s;
        const ry = nx * s + ny * c;
        for (const o of obstacles) {
          const ex = o.bx - o.ax;
          const ey = o.by - o.ay;
          const den = rx * ey - ry * ex;
          if (Math.abs(den) < 1e-12) continue;
          const qx = o.ax - ox;
          const qy = o.ay - oy;
          const tt = (qx * ey - qy * ex) / den;
          if (tt <= (o.own ? 0.05 : 1e-6) || tt * c * o.share >= gap) continue;
          // the area's own outline is in the way only straight across (its ramp there comes back this way); round a corner the nearer side wins anyway
          if (o.own && (th !== 0 || ((outward ? 1 : -1) * sign * den) / (Math.hypot(ex, ey) || 1) > -0.3)) continue;
          const u = (qx * ry - qy * rx) / den;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          gap = tt * c * o.share;
        }
      }
      at.push(a.cum[k]! + l * t);
      width.push(Math.min(target, Math.max(gap, Math.min(target, MIN_BAND))));
    }
  }
  // round the ring: the first sample again at the far end
  at.push(a.total);
  width.push(width[0]!);
  // smooth: the narrowest within a square either way, then the mean over a square either way
  const count = at.length - 1; // the last sample is the first again
  const near = (i: number, r: number, f: (j: number) => void) => {
    f(i);
    for (const dir of [1, -1]) {
      for (let step = 1; step < count; step++) {
        const j = (((i + dir * step) % count) + count) % count;
        const d = Math.abs(at[j]! - at[i]!);
        if (Math.min(d, a.total - d) > r) break;
        f(j);
      }
    }
  };
  const lowest = new Float64Array(at.length);
  for (let i = 0; i < count; i++) {
    let w = Infinity;
    near(i, 1, (j) => (w = Math.min(w, width[j]!)));
    lowest[i] = w;
  }
  const smooth = new Float64Array(at.length);
  for (let i = 0; i < count; i++) {
    let s = 0;
    let c = 0;
    near(i, 1, (j) => ((s += lowest[j]!), c++));
    smooth[i] = s / c;
  }
  smooth[count] = smooth[0]!;
  return { at: Float64Array.from(at), width: smooth };
}

/** The surface's weight for one area at p (`inside`: p counts as inside its outline). */
function weight(a: SurfaceArea, x: number, y: number, inside: boolean): number {
  if (!a.hill) {
    if (a.sheer) return inside ? 1 : 0;
    if (a.raised) {
      if (inside) return 1;
      if (!a.zone || !inBox(a.zone, x, y)) return 0;
      const n = nearest(a, x, y);
      const w = bandAt(a, n.arc);
      return n.d < w ? ease(1 - n.d / w) : 0;
    }
    if (!inside) return 0;
    const n = nearest(a, x, y);
    const w = bandAt(a, n.arc);
    return n.d >= w ? 1 : ease(n.d / w);
  }
  // a hill
  if (!inside && (a.sheer || !a.band || !a.zone || !inBox(a.zone, x, y))) return 0;
  const n = nearest(a, x, y);
  const b = a.raised && !a.sheer ? bandAt(a, n.arc) : 0;
  // a sheer hill's cut follows its shape, its slopes the rounded outline: in a cut-off corner it starts at its lip
  let s = !inside ? -n.d : a.sheer && !pointInRing([x, y], a.ring) ? 0 : n.d;
  if (s <= -b) return 0;
  const D = a.depth;
  if (inside) {
    // a seeded warp, stronger toward the middle: the top sits a little off-centre
    const k = ease(s / (0.5 * D));
    if (k > 0) {
      const cell = 1.2 * D;
      const wx = x + 0.5 * D * k * valueNoise(a.seed, x / cell, y / cell);
      const wy = y + 0.5 * D * k * valueNoise(a.seed ^ 0x5bd1e995, x / cell, y / cell);
      s = pointInRing([wx, wy], a.ring) ? nearest(a, wx, wy).d : 0;
    }
  }
  let f = ease((s + b) / (D + b));
  // uneven slopes: the curve's exponent wanders a little (the foot and the top stay put)
  if (f > 0 && f < 1) f = Math.pow(f, Math.exp(0.4 * valueNoise(a.seed + 7, x / (0.7 * D), y / (0.7 * D))));
  return a.sheer ? HILL_LIP + (1 - HILL_LIP) * f : f;
}

export interface SurfaceOptions extends HeightOptions {
  plan?: HeightPlan;
}

/** The surface of a map's ground in one view (the plan's areas, hidden ones only for the GM). */
export function heightSurface(map: DelveMap, opts: SurfaceOptions = {}): HeightSurface {
  const floor = opts.floor ?? floorPaths(map);
  const plan = opts.plan ?? heightPlan(map, { view: opts.view ?? 'gm', floor });
  const unit = plan.unit;
  const mapSeed = map.seed ?? hashString(map.id);

  // raised or sunken, by the plan's edges: the longer run of edge decides
  const lean = new Map<string, number>();
  const rise = new Map<string, number>();
  for (const e of plan.edges) {
    let len = 0;
    for (let i = 0; i + 1 < e.points.length + (e.closed ? 1 : 0); i++) {
      const p = e.points[i]!;
      const q = e.points[(i + 1) % e.points.length]!;
      len += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    for (const id of [e.owner, e.other]) {
      if (id === null) continue;
      const area = plan.areas.find((a) => a.id === id)!;
      const up = Math.abs(area.height - e.high) < 1e-9;
      lean.set(id, (lean.get(id) ?? 0) + (up ? len : -len));
      rise.set(id, Math.max(rise.get(id) ?? 0, e.high - e.low));
    }
  }

  const areas: SurfaceArea[] = plan.areas.map((area) => {
    const shape: Ring = shapePath(area.shape).map((p) => [p.x, p.y] as Point);
    const hill = heightProfile(area) === 'hill';
    // a hill's corners rounded off (twice cut a quarter in from each corner); circles are round already
    const ring = hill && !('circle' in area.shape) ? rounded(shape, 2) : shape;
    const segs = segmentsOf(ring);
    const box = pointsBounds(shape);
    const base = { ring, box, ...segs };
    // only a hill is shaped by its depth (a flat area just needs its outline)
    const { depth, top } = hill ? deepest(base) : { depth: 0, top: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] as Point };
    const sheer = area.edge !== 'slope';
    const raised = (lean.get(area.id) ?? area.height) > 0;
    return { area, height: area.height, hill, sheer, raised, depth, top, band: null, bandMax: 0, zone: null, seed: hashInts(mapSeed, hashString(area.id)), ...base };
  });

  // ramps and hill feet: how wide, and where each area's weight varies
  const groundRings: Ring[] = plan.ground.flatMap((p) => [p.outer, ...p.holes]);
  const ringSegs = (ring: Ring, share: number, own: boolean): Seg[] =>
    ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      return { ax: a[0], ay: a[1], bx: b[0], by: b[1], share, own };
    });
  const bandsOut = (a: SurfaceArea) => !a.sheer && (a.hill ? a.raised : true);
  areas.forEach((a, i) => {
    if (a.sheer && !a.hill) return;
    const R = slopeRun(rise.get(a.area.id) ?? Math.abs(a.height), unit);
    const target = a.sheer ? 0 : a.hill ? (a.raised ? Math.max(0, R - a.depth) : 0) : R;
    if (target > 1e-6) {
      const reach = grow(a.box, target + 0.5);
      const near = (r: Ring) => boxesMeet(pointsBounds(r), reach);
      const obstacles: Seg[] = [
        ...ringSegs(a.ring, 0.5, true),
        ...groundRings.filter(near).flatMap((r) => ringSegs(r, 1, false)),
        ...areas.filter((o, j) => j !== i && near(o.ring)).flatMap((o) => ringSegs(o.ring, bandsOut(o) ? 0.5 : 1, false)),
      ].filter((s) => inBox(reach, s.ax, s.ay) || inBox(reach, s.bx, s.by) || boxesMeet(pointsBounds([[s.ax, s.ay], [s.bx, s.by]]), reach));
      a.band = bandWidths(a, target, obstacles);
      a.bandMax = Math.max(...a.band.width);
    }
    a.zone = a.raised && a.bandMax > 0 ? grow(a.box, a.bandMax + 0.05) : a.box;
  });

  // the zones, joined where they meet; the ground inside them cut by sheer edges
  const zones = areas.flatMap((a) => (a.zone ? [grow(a.zone, 0.5)] : []));
  const zonePaths: PathsD = zones.length ? unionD(zones.map(boxPath), [], FillRule.NonZero, PRECISION) : [];
  const ground = groundPaths(map, floor);
  let pieces: { paths: PathsD; inside: number[] }[] = [];
  if (zonePaths.length && ground.length) {
    for (const cluster of polygonsOf(zonePaths)) {
      const cut = intersectD(ground, [cluster.outer, ...cluster.holes].map(toPath), FillRule.NonZero, PRECISION);
      if (cut.length) pieces.push({ paths: cut, inside: [] });
    }
    areas.forEach((a, k) => {
      if (!a.sheer) return;
      const shape = [shapePath(a.area.shape)];
      const next: typeof pieces = [];
      for (const p of pieces) {
        if (!boxesMeet(pointsBounds(p.paths.flatMap((q) => q.map((v) => [v.x, v.y] as Point))), a.box)) {
          next.push(p);
          continue;
        }
        const inPart = intersectD(p.paths, shape, FillRule.NonZero, PRECISION);
        const outPart = differenceD(p.paths, shape, FillRule.NonZero, PRECISION);
        if (inPart.length) next.push({ paths: inPart, inside: [...p.inside, k] });
        if (outPart.length) next.push({ paths: outPart, inside: p.inside });
      }
      pieces = next;
    });
  }
  const surfacePieces: SurfacePiece[] = pieces.flatMap((p) => {
    // each connected part on its own: a cut can leave two parts apart
    return polygonsOf(p.paths).map((poly) => ({
      paths: [poly.outer, ...poly.holes].map(toPath),
      polygons: [poly],
      bounds: pointsBounds(poly.outer),
      inside: new Set(p.inside),
    }));
  });

  const heightIn = (i: number, p: Point): number => {
    const piece = surfacePieces[i]!;
    const [x, y] = p;
    let h = 0;
    for (let k = 0; k < areas.length; k++) {
      const a = areas[k]!;
      const inside = a.sheer ? piece.inside.has(k) : inBox(a.box, x, y) && pointInRing(p, a.ring);
      if (!inside && (!a.zone || !inBox(a.zone, x, y))) continue;
      const f = weight(a, x, y, inside);
      if (f > 0) h += (a.height - h) * f;
    }
    return h;
  };
  const inPoly = (poly: Polygon, p: Point) => pointInRing(p, poly.outer) && !poly.holes.some((r) => pointInRing(p, r));
  const pieceAt = (p: Point): number => surfacePieces.findIndex((q) => inBox(q.bounds, p[0], p[1]) && q.polygons.some((poly) => inPoly(poly, p)));

  return {
    plan,
    unit,
    areas,
    zones,
    zonePaths,
    pieces: surfacePieces,
    heightIn,
    pieceAt,
    at(p) {
      const i = pieceAt(p);
      return i >= 0 ? heightIn(i, p) : (plan.at(p) ?? 0);
    },
  };
}

/** A lattice of `step` squares from the map's origin, covering a box (a cell over on each side). */
export function latticeOver(b: Bounds, step: number): { i0: number; j0: number; cols: number; rows: number } {
  const i0 = Math.floor(b.x0 / step) - 1;
  const j0 = Math.floor(b.y0 / step) - 1;
  return { i0, j0, cols: Math.ceil(b.x1 / step) + 2 - i0, rows: Math.ceil(b.y1 / step) + 2 - j0 };
}

/** A grid of values on posts `step` apart, rows of columns, the first post at (x0, y0). */
export interface PostGrid {
  z: Float64Array;
  cols: number;
  rows: number;
  x0: number;
  y0: number;
  step: number;
}

// marching squares: for each case (corner bits 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left), the edges joined (0 top, 1 right, 2 bottom, 3 left)
const CASES: Record<number, [number, number][]> = {
  1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]],
  9: [[0, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[3, 0]],
};

/**
 * Where a grid crosses `level` (marching squares), joined into lines, closed
 * where they close. With `closed`, the world past the grid counts as far below
 * the level, so every line closes round the higher side (fills: even-odd).
 */
export function isolines(g: PostGrid, level: number, closed = false): { points: Point[]; closed: boolean }[] {
  const { z, cols, rows, x0, y0, step } = g;
  const LOW = -1e12;
  const at = (c: number, r: number): number => (c < 0 || r < 0 || c >= cols || r >= rows ? LOW : z[r * cols + c]!);
  // an edge's key and where the level crosses it: t along from its first post
  const point = (c: number, r: number, e: number): { key: string; p: Point } => {
    const [ca, ra, cb, rb] = e === 0 ? [c, r, c + 1, r] : e === 1 ? [c + 1, r, c + 1, r + 1] : e === 2 ? [c, r + 1, c + 1, r + 1] : [c, r, c, r + 1];
    const va = at(ca, ra);
    const vb = at(cb, rb);
    const t = Math.max(0, Math.min(1, (level - va) / (vb - va || 1)));
    return { key: `${ca},${ra},${cb},${rb}`, p: [x0 + (ca + (cb - ca) * t) * step, y0 + (ra + (rb - ra) * t) * step] };
  };
  const segs: { a: string; b: string; pa: Point; pb: Point }[] = [];
  const lo = closed ? -1 : 0;
  for (let r = lo; r < rows - (closed ? 0 : 1); r++) {
    for (let c = lo; c < cols - (closed ? 0 : 1); c++) {
      const v = [at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r + 1)];
      const idx = (v[0]! >= level ? 1 : 0) | (v[1]! >= level ? 2 : 0) | (v[2]! >= level ? 4 : 0) | (v[3]! >= level ? 8 : 0);
      let pairs = CASES[idx];
      if (idx === 5 || idx === 10) {
        // a saddle: the middle decides which corners join
        const mid = (v[0]! + v[1]! + v[2]! + v[3]!) / 4 >= level;
        pairs = (idx === 5) === mid ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      for (const [e1, e2] of pairs ?? []) {
        const a = point(c, r, e1);
        const b = point(c, r, e2);
        segs.push({ a: a.key, b: b.key, pa: a.p, pb: b.p });
      }
    }
  }
  // join the pieces end to end
  const byKey = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const k of [s.a, s.b]) byKey.set(k, [...(byKey.get(k) ?? []), i]);
  });
  const used = new Uint8Array(segs.length);
  const out: { points: Point[]; closed: boolean }[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i]!;
    const keys = [s.a, s.b];
    const pts: Point[] = [s.pa, s.pb];
    let shut = false;
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? keys[keys.length - 1]! : keys[0]!;
        const next = (byKey.get(end) ?? []).find((j) => !used[j]);
        if (next === undefined) {
          if (dir === 1 && end === keys[0] && keys.length > 2) shut = true;
          break;
        }
        used[next] = 1;
        const n = segs[next]!;
        const [k, p] = n.a === end ? [n.b, n.pb] : [n.a, n.pa];
        if (dir === 1) {
          keys.push(k);
          pts.push(p);
        } else {
          keys.unshift(k);
          pts.unshift(p);
        }
      }
      if (shut) break;
    }
    if (shut) {
      pts.pop();
      out.push({ points: pts, closed: true });
    } else out.push({ points: pts, closed: false });
  }
  return out;
}

/** A piece's surface sampled on the lattice over its box (rows of columns, map units). */
export function sampleSurface(s: HeightSurface, piece: number, step: number): { i0: number; j0: number; cols: number; rows: number; z: Float64Array } {
  const g = latticeOver(s.pieces[piece]!.bounds, step);
  const z = new Float64Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) z[r * g.cols + c] = s.heightIn(piece, [(g.i0 + c) * step, (g.j0 + r) * step]);
  return { ...g, z };
}
