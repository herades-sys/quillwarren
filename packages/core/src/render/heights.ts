// Drawing height areas (core heights.ts) the cartographic way, in the style's own
// inks: a firm line with short ticks on the low side for cliffs and ledges, a
// band of rock face (hachures fanning down, stipple, a few boulders, a ragged
// foot) for rock edges, a thin line for steps; flat plateaus a shade lighter
// (raised) or darker (sunken). Hills and ramps follow the ground's real shape
// (core surface.ts): a hillshade lit from the north-west in a few soft vector
// steps, thin wobbly contour lines with a heavier one every fifth, and light
// hachures down the steepest parts. GM view only: the height labels ("+10 ft",
// on a hill at its top). Every jitter comes from the seeded RNG keyed by
// position, so redraws never shift. No filters at all (resvg panics on
// feDisplacementMap at some sizes).
import { differenceD, FillRule, intersectD, unionD, type PathsD } from 'clipper2-ts';
import { clipPolylines, insidePolygons } from '../geometry/objects.ts';
import { polygonsOf } from '../geometry/floor.ts';
import { fromPath, pointInRing, pointsBounds, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon } from '../geometry/shapes.ts';
import { cutSegments } from '../geometry/openings.ts';
import type { Polyline } from '../geometry/walls.ts';
import { groundPaths, heightPlan, heightText, rockWidth, stairsUphill, type HeightEdgeLine, type HeightPlan } from '../heights.ts';
import type { DelveMap, Point, Stairs } from '../schema.ts';
import { heightProfile, heightSurface, isolines, sampleSurface, valueNoise, type HeightSurface, type PostGrid } from '../surface.ts';
import type { SquareUnit } from '../units.ts';
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

// ---------- relief: hills and ramps ----------

/** Contours every 1, 2 or 5 (times a power of ten) of the map's units, about six over the biggest rise; at least half a metre or a foot. */
export function contourInterval(rise: number, unit: SquareUnit): number {
  const raw = Math.max(rise / 6, unit.name === 'm' ? 0.5 : 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 5, 10]) if (k * p >= raw - 1e-9) return k * p;
  return 10 * p;
}

/** A contour softened (twice cut at the corners) and given a slight hand wobble, the same wherever it is drawn from. */
function soften(line: { points: Point[]; closed: boolean }, seed: number): Polyline {
  let pts = line.points;
  for (let it = 0; it < 2 && pts.length > 2; it++) {
    const out: Point[] = line.closed ? [] : [pts[0]!];
    const n = pts.length;
    for (let i = 0; i < (line.closed ? n : n - 1); i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!line.closed) out.push(pts[n - 1]!);
    pts = out;
  }
  const n = pts.length;
  const wobbled = pts.map((p, i): Point => {
    const a = pts[(i + n - 1) % n]!;
    const b = pts[(i + 1) % n]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    const w = 0.05 * valueNoise(seed, p[0] / 0.9, p[1] / 0.9);
    return [r6(p[0] - (ty / l) * w), r6(p[1] + (tx / l) * w)];
  });
  return { points: wobbled, closed: line.closed };
}

interface ReliefOptions {
  style: Style;
  seed: number;
  cut: (paths: PathsD) => PathsD;
  cutLines: (lines: Polyline[]) => Polyline[];
  shown: (q: Point) => boolean;
  onStairs: (q: Point) => boolean;
}

/** Shading steps: how far a slope turns toward the light (or away) from flat ground, and how strongly each step shades. */
const LIGHT_STEPS = [0.03, 0.07, 0.11, 0.16, 0.21, 0.27];
const DARK_STEPS = [0.03, 0.07, 0.12, 0.18, 0.25, 0.33];

/**
 * Hills and ramps from the ground's real shape (surface.ts): the hillshade (lit
 * from the north-west, 45° up) as a few posterised vector steps, contours with
 * a heavier one every fifth, light hachures down the steepest parts, and where
 * each hill is highest (its GM tag goes there).
 */
function relief(surf: HeightSurface, o: ReliefOptions): { shade: Layer[]; lines: Layer[]; peaks: Map<string, Point> } {
  const none = { shade: [], lines: [], peaks: new Map<string, Point>() };
  if (!surf.pieces.length) return none;
  const { style, seed } = o;
  const unit = surf.unit;
  const ink = style.walls.color;
  const paper = mix(style.props.paper, '#FFFFFF', 0.5);
  const zoneArea = surf.pieces.reduce((s, p) => s + (p.bounds.x1 - p.bounds.x0) * (p.bounds.y1 - p.bounds.y0), 0);
  const step = Math.min(1, Math.max(0.15, Math.sqrt(zoneArea / 30_000)));
  const grids: { piece: number; g: PostGrid }[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  surf.pieces.forEach((_, i) => {
    const s = sampleSurface(surf, i, step);
    let a = Infinity;
    let b = -Infinity;
    for (const v of s.z) {
      a = Math.min(a, v);
      b = Math.max(b, v);
    }
    if (b - a < 1e-6) return;
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
    grids.push({ piece: i, g: { z: s.z, cols: s.cols, rows: s.rows, x0: s.i0 * step, y0: s.j0 * step, step } });
  });
  if (!grids.length) return none;

  // ---------- hillshade ----------
  const L = [-0.5, -0.5, Math.SQRT1_2];
  const light: PathsD[] = LIGHT_STEPS.map(() => []);
  const dark: PathsD[] = DARK_STEPS.map(() => []);
  const slopes: { piece: number; dx: Float64Array; dy: Float64Array; g: PostGrid }[] = [];
  for (const { piece, g } of grids) {
    const { cols, rows, z } = g;
    const dx = new Float64Array(z.length);
    const dy = new Float64Array(z.length);
    const shade = new Float64Array(z.length);
    const k = 1 / unit.size; // heights in squares, so the slope is the real one
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const c0 = Math.max(0, c - 1);
        const c1 = Math.min(cols - 1, c + 1);
        const r0 = Math.max(0, r - 1);
        const r1 = Math.min(rows - 1, r + 1);
        dx[i] = ((z[r * cols + c1]! - z[r * cols + c0]!) * k) / ((c1 - c0) * step || 1);
        dy[i] = ((z[r1 * cols + c]! - z[r0 * cols + c]!) * k) / ((r1 - r0) * step || 1);
        const nl = Math.hypot(dx[i]!, dy[i]!, 1);
        shade[i] = (-dx[i]! * L[0]! - dy[i]! * L[1]! + L[2]!) / nl - L[2]!;
      }
    }
    slopes.push({ piece, dx, dy, g });
    const p = surf.pieces[piece]!;
    const fill = (z2: Float64Array, t: number, into: PathsD) => {
      const rings = isolines({ ...g, z: z2 }, t, true).filter((l) => l.points.length > 2);
      if (!rings.length) return;
      const area = unionD(rings.map((l) => toPath(l.points)), [], FillRule.EvenOdd, PRECISION);
      into.push(...o.cut(intersectD(area, p.paths, FillRule.NonZero, PRECISION)));
    };
    LIGHT_STEPS.forEach((t, s) => fill(shade, t, light[s]!));
    const neg = shade.map((v) => -v);
    DARK_STEPS.forEach((t, s) => fill(neg, t, dark[s]!));
  }
  const shadeLayers: Layer[] = [];
  light.forEach((paths, s) => {
    const polygons = polygonsOf(paths);
    if (polygons.length) shadeLayers.push({ name: `height-slope-light-${s + 1}`, kind: 'fill', polygons, color: paper, opacity: 0.035 });
  });
  dark.forEach((paths, s) => {
    const polygons = polygonsOf(paths);
    if (polygons.length) shadeLayers.push({ name: `height-slope-shadow-${s + 1}`, kind: 'fill', polygons, color: ink, opacity: 0.04 });
  });

  // ---------- contours ----------
  const interval = contourInterval(hi - lo, unit);
  const thin: Polyline[] = [];
  const bold: Polyline[] = [];
  for (let level = Math.floor(lo / interval + 1) * interval; level < hi - 1e-9; level += interval) {
    const index = Math.abs(Math.round(level / interval)) % 5 === 0;
    for (const { piece, g } of grids) {
      const lines = isolines(g, level).filter((l) => l.points.length > 2).map((l) => soften(l, seed + 211));
      const kept = o.cutLines(clipPolylines(lines, surf.pieces[piece]!.polygons, 0.08));
      (index ? bold : thin).push(...kept);
    }
  }
  const lineLayers: Layer[] = [];
  if (thin.length) lineLayers.push({ name: 'height-slope-contours', kind: 'stroke', lines: thin, color: ink, width: style.walls.width * 0.2, cap: 'round', join: 'round', opacity: 0.45 });
  if (bold.length) lineLayers.push({ name: 'height-slope-contours-index', kind: 'stroke', lines: bold, color: ink, width: style.walls.width * 0.36, cap: 'round', join: 'round', opacity: 0.55 });

  // ---------- hachures down the steepest parts ----------
  const wedges: Polygon[] = [];
  for (const { piece, dx, dy, g } of slopes) {
    const p = surf.pieces[piece]!;
    const b = p.bounds;
    const gap = 0.45;
    for (let y = Math.floor(b.y0 / gap) * gap; y < b.y1; y += gap) {
      for (let x = Math.floor(b.x0 / gap) * gap; x < b.x1; x += gap) {
        const r = randAt(seed, 61, [x, y]);
        const q: Point = [x + (r() - 0.5) * gap * 0.7, y + (r() - 0.5) * gap * 0.7];
        const c = Math.round((q[0] - g.x0) / g.step);
        const w = Math.round((q[1] - g.y0) / g.step);
        if (c < 0 || w < 0 || c >= g.cols || w >= g.rows) continue;
        const gx = dx[w * g.cols + c]!;
        const gy = dy[w * g.cols + c]!;
        const s = Math.hypot(gx, gy);
        if (s < 0.6 || r() < 0.35) continue;
        const len = Math.min(0.42, 0.14 + 0.16 * s) * (0.8 + 0.35 * r());
        const ux = -gx / s;
        const uy = -gy / s;
        const tip: Point = [q[0] + ux * len, q[1] + uy * len];
        if (!p.polygons.some((poly) => insidePolygons([poly], q) && insidePolygons([poly], tip)) || !o.shown(q) || o.onStairs(q) || o.onStairs(tip)) continue;
        const hw = 0.012 + 0.006 * r();
        wedges.push({ outer: [[r6(q[0] - uy * hw), r6(q[1] + ux * hw)], [r6(tip[0]), r6(tip[1])], [r6(q[0] + uy * hw), r6(q[1] - ux * hw)]], holes: [] });
      }
    }
  }
  if (wedges.length) lineLayers.push({ name: 'height-slope-hachures', kind: 'fill', polygons: wedges, color: ink, opacity: 0.3 });

  // ---------- each hill's top ----------
  const peaks = new Map<string, Point>();
  for (const r of surf.plan.regions) {
    if (heightProfile(r.area) !== 'hill' || !r.polygons.length) continue;
    const boxedR = boxed(r.polygons);
    let best = -Infinity;
    let at: Point | null = null;
    for (const { g } of grids) {
      for (let w = 0; w < g.rows; w++) {
        for (let c = 0; c < g.cols; c++) {
          const v = g.z[w * g.cols + c]!;
          if (v <= best) continue;
          const q: Point = [g.x0 + c * g.step, g.y0 + w * g.step];
          if (!inside(boxedR, q) || !o.shown(q)) continue;
          best = v;
          at = q;
        }
      }
    }
    if (at) peaks.set(r.area.id, [r6(at[0]), r6(at[1])]);
  }
  return { shade: shadeLayers, lines: lineLayers, peaks };
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

  // stairs across an edge replace it there: no line, no ticks, no rock under the steps
  const stairRings = input.stairs.map((s) => fromPath(shapePath(s.shape)));
  const onStairs = (q: Point) => stairRings.some((ring) => pointInRing(q, ring));

  // ---------- hills and ramps (the ground's real shape) ----------
  const surf = heightSurface(input.map, { view: input.view, floor: input.floor, plan });
  const shaped = relief(surf, { style, seed, cut, cutLines, shown, onStairs });

  // ---------- tone ----------
  const tone: Layer[] = [...shaped.shade];
  for (const r of plan.regions) {
    // hills get the hillshade instead
    if (Math.abs(r.height) < 1e-9 || !r.paths.length || heightProfile(r.area) === 'hill') continue;
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
      // the ramp itself is drawn by the relief (contours, shading, hachures); a flat plateau keeps a soft line at its brow, a hill none
      const owner = plan.areas.find((a) => a.id === e.owner);
      if (owner && heightProfile(owner) !== 'hill') slopeLines.push(line);
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

  const edges: Layer[] = [...shaped.lines];
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
  if (slopes.length) edges.push({ name: 'height-slopes', kind: 'stroke', lines: slopes, color: ink, width: style.walls.width * 0.2, cap: 'round', join: 'round', opacity: 0.4, clip });
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
      // a hill's tag sits on its top
      const peak = heightProfile(r.area) === 'hill' ? shaped.peaks.get(r.area.id) : undefined;
      const at = peak && avoid.every((a) => Math.abs(a[0] - peak[0]) > 1.4 || Math.abs(a[1] - peak[1]) > 0.75) ? peak : labelPoint(r.polygons, avoid);
      if (at) items.push({ text: heightText(r.height, unit), at });
    }
    if (items.length) labels = { name: 'height-labels', kind: 'tags', items, size: HEIGHT_TAG_SIZE, fill: '#1B1F24', color: '#FFFFFF', font: style.labels.numberFont };
  }

  const ground = cut(groundPaths(input.map, input.floor));
  return { tone, edges, labels, clip: polygonsOf(ground) };
}
