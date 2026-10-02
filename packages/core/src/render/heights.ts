// Drawing height areas (core heights.ts) the cartographic way, in the style's own
// inks: a firm line with short ticks on the low side for cliffs and ledges, a
// band of rock face (hachures fanning down, stipple, a few boulders, a ragged
// foot) for rock edges, soft contours with light hachures for slopes, a thin
// line for steps; sunken ground a shade darker, raised ground a shade lighter.
// GM view only: the height labels ("+10 ft"). Every jitter comes from the
// seeded RNG keyed by position, so redraws never shift. No filters at all
// (resvg panics on feDisplacementMap at some sizes).
import { differenceD, FillRule, intersectD, unionD, type PathsD } from 'clipper2-ts';
import { clipPolylines, insidePolygons } from '../geometry/objects.ts';
import { polygonsOf } from '../geometry/floor.ts';
import { fromPath, pointInRing, pointsBounds, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon } from '../geometry/shapes.ts';
import { cutSegments } from '../geometry/openings.ts';
import type { Polyline } from '../geometry/walls.ts';
import { groundPaths, heightPlan, heightText, rockWidth, slopeRun, stairsUphill, type HeightEdgeLine, type HeightPlan } from '../heights.ts';
import type { DelveMap, Point, Stairs } from '../schema.ts';
import { hashInts, rng } from './rng.ts';
import type { Layer, View } from './scene.ts';
import type { Style } from './style.ts';

export interface HeightDrawing {
  /** Lighter and darker ground, over the floor and terrain, under the grid. */
  tone: Layer[];
  /** The edges and the stairs' arrows, over the stairs, under the walls. */
  edges: Layer[];
  /** GM view: "+10 ft" tags. */
  labels: Layer | null;
  /** The clip the edges are drawn in (the ground, cut to what the players have seen). */
  clip: Polygon[];
}

export interface HeightDrawInput {
  map: DelveMap;
  style: Style;
  view: View;
  seed: number;
  /** The floor as the scene draws it (rough walls included), as flat paths. */
  floor: PathsD;
  /** With fog in the players' view: what they have seen. */
  seen: Polygon[] | null;
  stairs: readonly Stairs[];
}

/** Height labels are tags this many squares tall. */
export const HEIGHT_TAG_SIZE = 0.42;
export const HEIGHT_CLIP = 'height-ground';

type Sample = { p: Point; n: Point; t: Point; s: number };

const open = (points: Point[]): Polyline => ({ points, closed: false });
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

/** Evenly spaced points along a polyline, each with its tangent and the normal to its low (right) side. */
function resample(points: readonly Point[], closed: boolean, ds: number): Sample[] {
  const pts = closed ? [...points, points[0]!] : [...points];
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    lens.push(l);
    total += l;
  }
  if (total < 1e-9) return [];
  const count = Math.max(1, Math.round(total / ds));
  const step = total / count;
  const pos: { p: Point; s: number }[] = [];
  let seg = 0;
  let acc = 0;
  for (let k = 0; k <= (closed ? count - 1 : count); k++) {
    const s = Math.min(total, k * step);
    while (seg < lens.length - 1 && acc + lens[seg]! < s - 1e-12) acc += lens[seg++]!;
    const l = lens[seg]! || 1;
    const u = Math.max(0, Math.min(1, (s - acc) / l));
    const a = pts[seg]!;
    const b = pts[seg + 1]!;
    pos.push({ p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], s });
  }
  return pos.map((q, k) => {
    const prev = pos[k - 1] ?? (closed ? pos[pos.length - 1]! : q);
    const next = pos[k + 1] ?? (closed ? pos[0]! : q);
    let tx = next.p[0] - prev.p[0];
    let ty = next.p[1] - prev.p[1];
    let l = Math.hypot(tx, ty);
    if (l < 1e-9) {
      // a one-sample line: the first segment's direction
      tx = pts[1]![0] - pts[0]![0];
      ty = pts[1]![1] - pts[0]![1];
      l = Math.hypot(tx, ty) || 1;
    }
    tx /= l;
    ty /= l;
    return { p: q.p, s: q.s, t: [tx, ty], n: [-ty, tx] };
  });
}

/** Smooth value noise in [-0.5, 0.5], keyed by position, so a ragged edge stays put wherever it is drawn from. */
function noise(seed: number, x: number, y: number, cell: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const v = (i: number, j: number) => rng(hashInts(seed, i, j))() - 0.5;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

const randAt = (seed: number, tag: number, [x, y]: Point) => rng(hashInts(seed, tag, Math.round(x * 1000), Math.round(y * 1000)));

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const v = m ? parseInt(m[1]!, 16) : 0x999999;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
/** a mixed toward b by k (0: a, 1: b). */
function mix(a: string, b: string, k: number): string {
  const x = hex(a);
  const y = hex(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * k).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

interface Boxed {
  p: Polygon;
  b: Bounds;
}
const boxed = (polys: readonly Polygon[]): Boxed[] => polys.map((p) => ({ p, b: pointsBounds(p.outer) }));
const inside = (list: readonly Boxed[], q: Point): boolean =>
  list.some(({ p, b }) => q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1 && pointInRing(q, p.outer) && !p.holes.some((h) => pointInRing(q, h)));

/** A point inside the polygons, well away from their edges (for a label). */
export function labelPoint(polys: readonly Polygon[], avoid: readonly Point[] = []): Point | null {
  const area = (p: Polygon) => {
    const b = pointsBounds(p.outer);
    return (b.x1 - b.x0) * (b.y1 - b.y0);
  };
  const big = [...polys].sort((a, b) => area(b) - area(a))[0];
  if (!big) return null;
  const b = pointsBounds(big.outer);
  const rings = [big.outer, ...big.holes];
  const dist = (q: Point) => {
    let d = Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const c = ring[(i + 1) % ring.length]!;
        const dx = c[0] - a[0];
        const dy = c[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
        d = Math.min(d, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
      }
    }
    return d;
  };
  const one = [big];
  const centre: Point = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const clear = (q: Point) => avoid.every((a) => Math.abs(a[0] - q[0]) > 1.4 || Math.abs(a[1] - q[1]) > 0.75);
  let best: Point | null = insidePolygons(one, centre) && clear(centre) ? centre : null;
  let bestD = best ? dist(best) : -1;
  const stepv = Math.max(0.25, Math.max(b.x1 - b.x0, b.y1 - b.y0) / 18);
  for (let x = b.x0 + stepv / 2; x < b.x1; x += stepv) {
    for (let y = b.y0 + stepv / 2; y < b.y1; y += stepv) {
      const q: Point = [x, y];
      if (!insidePolygons(one, q) || !clear(q)) continue;
      // a little preference for the middle, so a plain rectangle gets its label in the centre
      const d = dist(q) - 1e-3 * Math.hypot(x - centre[0], y - centre[1]);
      if (d > bestD + 1e-9) {
        best = q;
        bestD = d;
      }
    }
  }
  if (!best && avoid.length) return labelPoint(polys);
  return best ? [r6(best[0]), r6(best[1])] : null;
}

/** The layers for a map's height areas, or null when it has none in this view. */
export function heightDrawing(input: HeightDrawInput, plan: HeightPlan = heightPlan(input.map, { view: input.view, floor: input.floor })): HeightDrawing | null {
  const { style, seed, seen } = input;
  if (!plan.areas.length) return null;
  const ink = style.walls.color;
  const shade = style.shading?.color ?? style.props.shade;
  const unit = plan.unit;
  const seenB = seen ? boxed(seen) : null;
  const shown = (q: Point) => !seenB || inside(seenB, q);
  const seenPaths: PathsD | null = seen ? seen.flatMap((p) => [p.outer, ...p.holes].map(toPath)) : null;
  const cut = (paths: PathsD): PathsD => (seenPaths ? intersectD(paths, seenPaths, FillRule.NonZero, PRECISION) : paths);
  const cutLines = (lines: Polyline[]): Polyline[] => (seen ? clipPolylines(lines, seen) : lines);

  // where each side of an edge is: an area's ground, or the plain ground ('')
  const sides = new Map<string, { boxed: Boxed[]; paths: PathsD }>([['', { boxed: boxed(plan.base.polygons), paths: plan.base.paths }]]);
  for (const r of plan.regions) sides.set(r.area.id, { boxed: boxed(r.polygons), paths: r.paths });
  const heightOf = (id: string | null) => (id === null ? 0 : (plan.regions.find((r) => r.area.id === id)?.height ?? 0));
  const lowSide = (e: HeightEdgeLine) => {
    const id = heightOf(e.owner) <= heightOf(e.other) ? e.owner : (e.other ?? '');
    return sides.get(id) ?? sides.get('')!;
  };
  const groundB = boxed(plan.ground);
  const onGround = (q: Point) => inside(groundB, q);

  // ---------- tone ----------
  const tone: Layer[] = [];
  for (const r of plan.regions) {
    if (Math.abs(r.height) < 1e-9 || !r.paths.length) continue;
    const polygons = seenPaths ? polygonsOf(cut(r.paths)) : r.polygons;
    if (!polygons.length) continue;
    const sq = Math.abs(r.height) / unit.size;
    if (r.height > 0) tone.push({ name: `height-tone:${r.area.id}`, kind: 'fill', polygons, color: '#FFFFFF', opacity: r6(Math.min(0.4, 0.1 * sq)) });
    else tone.push({ name: `height-tone:${r.area.id}`, kind: 'fill', polygons, color: ink, opacity: r6(Math.min(0.3, 0.06 * sq)) });
  }

  // ---------- edges ----------
  const cliffLines: Polyline[] = [];
  const cliffTicks: Polyline[] = [];
  const slopeLines: Polyline[] = [];
  const slopeTicks: Polygon[] = [];
  // stairs across an edge replace it there: no line, no ticks, no rock under the steps
  const stairRings = input.stairs.map((s) => fromPath(shapePath(s.shape)));
  const onStairs = (q: Point) => stairRings.some((ring) => pointInRing(q, ring));
  const offStairs = (lines: Polyline[]): Polyline[] => {
    if (!stairRings.length) return lines;
    const segs: [Point, Point][] = [];
    for (const l of lines) {
      const n = l.points.length;
      for (let i = 0; i < (l.closed ? n : n - 1); i++) segs.push([l.points[i]!, l.points[(i + 1) % n]!]);
    }
    return cutSegments(segs, stairRings).map((s) => open([s[0], s[1]]));
  };
  const stepLines: Polyline[] = [];
  const stepTicks: Polyline[] = [];
  const rockTops: Polyline[] = [];
  const rockFeet: Polyline[] = [];
  const rockBand: PathsD = [];
  const rockWedges: Polygon[] = [];
  const rockStones: Polygon[] = [];
  const rockDots: Point[] = [];

  for (const e of plan.edges) {
    const line = { points: e.points, closed: e.closed };
    const low = lowSide(e).boxed;
    const drop = e.high - e.low;
    const sq = drop / unit.size;
    if (e.kind === 'cliff') {
      cliffLines.push(line);
      const len = Math.min(0.4, 0.2 + 0.04 * sq);
      resample(e.points, e.closed, 0.2).forEach((sm, k) => {
        const r = randAt(seed, 21, sm.p);
        const l = len * (k % 2 ? 0.55 : 1) * (0.85 + 0.3 * r());
        const a: Point = [sm.p[0] + sm.n[0] * 0.03, sm.p[1] + sm.n[1] * 0.03];
        const b: Point = [sm.p[0] + sm.n[0] * (0.03 + l), sm.p[1] + sm.n[1] * (0.03 + l)];
        if (inside(low, b) && shown(b) && !onStairs(sm.p)) cliffTicks.push(open([a, b]));
      });
    } else if (e.kind === 'step') {
      stepLines.push(line);
      resample(e.points, e.closed, 0.4).forEach((sm) => {
        const a: Point = [sm.p[0] + sm.n[0] * 0.025, sm.p[1] + sm.n[1] * 0.025];
        const b: Point = [sm.p[0] + sm.n[0] * 0.11, sm.p[1] + sm.n[1] * 0.11];
        if (inside(low, b) && shown(b) && !onStairs(sm.p)) stepTicks.push(open([a, b]));
      });
    } else if (e.kind === 'slope') {
      slopeLines.push(line);
      const run = slopeRun(drop, unit);
      resample(e.points, e.closed, 0.22).forEach((sm, k) => {
        if (onStairs(sm.p)) return;
        const r = randAt(seed, 31, sm.p);
        // short hachures down the slope, thick at the top: long and short in turn
        const l = run * (k % 2 ? 0.22 : 0.48) * (0.8 + 0.35 * r());
        const a: Point = [sm.p[0] + sm.n[0] * 0.05, sm.p[1] + sm.n[1] * 0.05];
        const b: Point = [sm.p[0] + sm.n[0] * l, sm.p[1] + sm.n[1] * l];
        if (inside(low, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) && inside(low, a) && shown(a)) {
          // stop where the low ground ends (a wall, another height)
          let end = b;
          if (!inside(low, b)) {
            let lo = 0;
            let hi = 1;
            for (let it = 0; it < 8; it++) {
              const m = (lo + hi) / 2;
              if (inside(low, [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m])) lo = m;
              else hi = m;
            }
            end = [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
          }
          const hw = 0.014 + 0.006 * r();
          slopeTicks.push({ outer: [[a[0] + sm.t[0] * hw, a[1] + sm.t[1] * hw], end, [a[0] - sm.t[0] * hw, a[1] - sm.t[1] * hw]], holes: [] });
        }
      });
    } else {
      // a rock face: a band on the low side, as wide as the drop, ragged at its foot, narrowing to points where it ends
      rockTops.push(line);
      const w = rockWidth(drop, unit);
      const S = resample(e.points, e.closed, 0.1);
      if (S.length < 2) continue;
      const L = S[S.length - 1]!.s;
      const free = (sm: Sample, dir: number) => {
        // an end that runs out on open ground narrows to a point; one at a wall or the map's edge doesn't
        const q: Point = [sm.p[0] + sm.t[0] * 0.1 * dir, sm.p[1] + sm.t[1] * 0.1 * dir];
        return onGround(q) && onGround([q[0] + sm.n[0] * 0.25, q[1] + sm.n[1] * 0.25]);
      };
      const taperA = !e.closed && free(S[0]!, -1);
      const taperB = !e.closed && free(S[S.length - 1]!, 1);
      const T = Math.min(w * 1.6, L / 2);
      const ease = (x: number) => (x >= 1 ? 1 : Math.pow(Math.sin((Math.max(0, x) * Math.PI) / 2), 0.8));
      const widths = S.map((sm) => {
        let f = 1;
        if (taperA) f = Math.min(f, ease(sm.s / T));
        if (taperB) f = Math.min(f, ease((L - sm.s) / T));
        const ragged = 0.7 * noise(seed + 101, sm.p[0], sm.p[1], 0.55) + 0.3 * noise(seed + 103, sm.p[0], sm.p[1], 0.18);
        return Math.max(0, f * w * (1 + ragged * 0.75));
      });
      const feet: Point[] = S.map((sm, k) => [sm.p[0] + sm.n[0] * widths[k]!, sm.p[1] + sm.n[1] * widths[k]!]);
      const quads = S.length - (e.closed ? 0 : 1);
      const mine: PathsD = [];
      for (let k = 0; k < quads; k++) {
        const j = (k + 1) % S.length;
        const q: Point[] = [S[k]!.p, S[j]!.p, feet[j]!, feet[k]!];
        // every quad the same way round, so overlapping ones add up instead of cancelling
        let a2 = 0;
        for (let i = 0; i < 4; i++) a2 += q[i]![0] * q[(i + 1) % 4]![1] - q[(i + 1) % 4]![0] * q[i]![1];
        if (Math.abs(a2) > 1e-12) mine.push(toPath(a2 < 0 ? q.reverse() : q));
      }
      // the band only covers the low ground beside it (not walls, not another height)
      if (mine.length) {
        const low2 = lowSide(e).paths;
        const piece = intersectD(unionD(mine, [], FillRule.NonZero, PRECISION), low2, FillRule.NonZero, PRECISION);
        rockBand.push(...piece);
      }
      rockFeet.push(open(e.closed ? [...feet, feet[0]!] : feet));
      S.forEach((sm, k) => {
        const wk = widths[k]!;
        if (wk < 0.06) return;
        const r = randAt(seed, 41, sm.p);
        // hachures: thin wedges from the top of the face, long and short in turn, fanning down
        const len = wk * (k % 2 ? 0.4 + 0.3 * r() : 0.78 + 0.2 * r());
        const ang = (r() - 0.5) * 0.35;
        const dx = sm.n[0] * Math.cos(ang) - sm.n[1] * Math.sin(ang);
        const dy = sm.n[0] * Math.sin(ang) + sm.n[1] * Math.cos(ang);
        const hw = 0.016 + 0.008 * r();
        const top: Point = [sm.p[0] + sm.n[0] * 0.02, sm.p[1] + sm.n[1] * 0.02];
        const tip: Point = [top[0] + dx * len, top[1] + dy * len];
        if (inside(low, tip) && inside(low, top) && shown(tip) && !onStairs(top) && !onStairs(tip)) {
          rockWedges.push({ outer: [[top[0] + sm.t[0] * hw, top[1] + sm.t[1] * hw], tip, [top[0] - sm.t[0] * hw, top[1] - sm.t[1] * hw]], holes: [] });
        }
        // stipple toward the foot
        if (r() < 0.7) {
          const d = wk * (0.35 + 0.6 * r());
          const off = (r() - 0.5) * 0.1;
          const q: Point = [sm.p[0] + sm.n[0] * d + sm.t[0] * off, sm.p[1] + sm.n[1] * d + sm.t[1] * off];
          if (inside(low, q) && shown(q) && !onStairs(q)) rockDots.push([r6(q[0]), r6(q[1])]);
        }
        // now and then a boulder at the foot
        if (r() < 0.11 && wk > 0.25) {
          const d = wk * (0.6 + 0.35 * r());
          const c: Point = [sm.p[0] + sm.n[0] * d, sm.p[1] + sm.n[1] * d];
          const rad = (0.05 + 0.08 * r()) * Math.min(1.2, 0.6 + w * 0.4);
          const n = 6;
          const turn = r() * Math.PI * 2;
          const ring: Point[] = [];
          for (let i = 0; i < n; i++) {
            const a = turn + (i / n) * Math.PI * 2;
            const rr = rad * (0.72 + 0.4 * r());
            ring.push([r6(c[0] + Math.cos(a) * rr), r6(c[1] + Math.sin(a) * rr)]);
          }
          if (ring.every((q) => inside(low, q) && !onStairs(q)) && shown(c)) rockStones.push({ outer: ring, holes: [] });
        }
      });
    }
  }

  const edges: Layer[] = [];
  const clip = HEIGHT_CLIP;
  if (rockBand.length) {
    const joined = unionD(rockBand, [], FillRule.NonZero, PRECISION);
    const band = cut(stairRings.length ? differenceD(joined, stairRings.map(toPath), FillRule.NonZero, PRECISION) : joined);
    const polygons = polygonsOf(band);
    if (polygons.length) edges.push({ name: 'height-rock', kind: 'fill', polygons, color: shade, opacity: 0.9, clip });
    if (rockWedges.length) edges.push({ name: 'height-rock-hachures', kind: 'fill', polygons: rockWedges, color: ink, opacity: 0.85, clip });
    if (rockDots.length) edges.push({ name: 'height-rock-stipple', kind: 'dots', points: rockDots, radius: 0.017, color: ink, opacity: 0.7, clip });
    if (rockStones.length) edges.push({ name: 'height-rock-stones', kind: 'fill', polygons: rockStones, color: mix(shade, style.floor.color, 0.45), stroke: { color: ink, width: 0.018 }, clip });
    const feet = cutLines(offStairs(rockFeet));
    if (feet.length) edges.push({ name: 'height-rock-foot', kind: 'stroke', lines: feet, color: ink, width: 0.022, cap: 'round', join: 'round', opacity: 0.7, clip });
    const tops = cutLines(offStairs(rockTops));
    if (tops.length) edges.push({ name: 'height-rock-top', kind: 'stroke', lines: tops, color: ink, width: style.walls.width * 0.55, cap: 'round', join: 'round', clip });
  }
  const slopes = cutLines(offStairs(slopeLines));
  if (slopes.length) edges.push({ name: 'height-slopes', kind: 'stroke', lines: slopes, color: ink, width: style.walls.width * 0.22, cap: 'round', join: 'round', opacity: 0.55, clip });
  if (slopeTicks.length) edges.push({ name: 'height-slope-hachures', kind: 'fill', polygons: slopeTicks, color: ink, opacity: 0.5, clip });
  const steps = cutLines(offStairs(stepLines));
  if (steps.length) edges.push({ name: 'height-steps', kind: 'stroke', lines: steps, color: ink, width: style.walls.width * 0.3, cap: 'round', join: 'round', opacity: 0.9, clip });
  if (stepTicks.length) edges.push({ name: 'height-step-ticks', kind: 'stroke', lines: stepTicks, color: ink, width: 0.02, cap: 'round', join: 'round', opacity: 0.8, clip });
  const cliffs = cutLines(offStairs(cliffLines));
  if (cliffs.length) edges.push({ name: 'height-cliffs', kind: 'stroke', lines: cliffs, color: ink, width: style.walls.width * 0.5, cap: 'round', join: 'round', clip });
  if (cliffTicks.length) edges.push({ name: 'height-cliff-ticks', kind: 'stroke', lines: cliffTicks, color: ink, width: 0.03, cap: 'round', join: 'round', clip });

  // ---------- stairs between heights: an arrow up the flight ----------
  const arrows: Polyline[] = [];
  for (const s of input.stairs) {
    const b = shapeBounds(s.shape);
    const dir = stairsUphill(plan, b);
    if (!dir) continue;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const ns = dir === 'n' || dir === 's';
    const run = ns ? b.y1 - b.y0 : b.x1 - b.x0;
    const across = ns ? b.x1 - b.x0 : b.y1 - b.y0;
    const sign = dir === 's' || dir === 'e' ? 1 : -1;
    const from = -sign * run * 0.32;
    const to = sign * run * 0.36;
    const at = (v: number, side = 0): Point => (ns ? [r6(cx + side), r6(cy + v)] : [r6(cx + v), r6(cy + side)]);
    const head = Math.min(0.3, across * 0.28, run * 0.25);
    if (!shown([cx, cy])) continue;
    arrows.push(open([at(from), at(to)]), open([at(to - sign * head, -head * 0.75), at(to), at(to - sign * head, head * 0.75)]));
  }
  if (arrows.length) edges.push({ name: 'stairs-arrows', kind: 'stroke', lines: arrows, color: style.stairs.color, width: style.stairs.width * 1.5, cap: 'round', join: 'round' });

  // ---------- GM labels ----------
  let labels: Layer | null = null;
  if (input.view === 'gm') {
    const items: { text: string; at: Point }[] = [];
    // not on a room number or a stair label
    const avoid: Point[] = input.map.objects.flatMap((o): Point[] => {
      if (!((o.type === 'room' && o.label) || o.type === 'stairs')) return [];
      const b = shapeBounds(o.shape);
      return [[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]];
    });
    for (const r of plan.regions) {
      const at = labelPoint(r.polygons, avoid);
      if (at) items.push({ text: heightText(r.height, unit), at });
    }
    if (items.length) labels = { name: 'height-labels', kind: 'tags', items, size: HEIGHT_TAG_SIZE, fill: '#1B1F24', color: '#FFFFFF', font: style.labels.numberFont };
  }

  const ground = cut(groundPaths(input.map, input.floor));
  return { tone, edges, labels, clip: polygonsOf(ground) };
}
