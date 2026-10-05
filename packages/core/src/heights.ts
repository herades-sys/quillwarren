// Height areas: raised and sunken ground within one map (docs/API.md, "Heights
// within a map"). A `height` object changes the height of the ground under its
// shape: the map's floor (rooms and corridors) and its terrain. Where areas
// overlap the last one wins, so a hill can carry a higher crest. Everything here
// is pure: the renderer draws the plan (render/heights.ts), the walkable map says
// which edges block movement (Delve Table's "Respect heights"), and the 3D views
// drape the floor over the ground's real shape (heightScene, from surface.ts:
// hills rounded, slopes as ramps).
import { differenceD, FillRule, intersectD, unionD, type PathsD } from 'clipper2-ts';
import { assetInfo, propBounds, propHidden } from './assets/catalog.ts';
import { floorPaths, polygonsOf } from './geometry/floor.ts';
import { clipPolylines } from './geometry/objects.ts';
import { fromPath, pointInRing, pointsBounds, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon, type Ring } from './geometry/shapes.ts';
import { terrainArea } from './geometry/terrain.ts';
import { computeWalls, doorSegment, type Segment } from './geometry/walls.ts';
import { MINUS } from './floors.ts';
import { STAIR_PROPS } from './levels.ts';
import { resolveStyle } from './render/style.ts';
import { heightProfile, heightSurface, sampleSurface } from './surface.ts';
import type { DelveMap, Door, HeightArea, HeightEdge, Point } from './schema.ts';
import { parseSquareUnit, type SquareUnit } from './units.ts';

export type HeightView = 'gm' | 'players';

/** The edges a token can't walk over (a crossing of stairs or a ladder makes them passable there). */
export const BLOCKING_EDGES: ReadonlySet<HeightEdge> = new Set<HeightEdge>(['cliff', 'rock']);

/** One area's ground: its shape on the floor and terrain, minus the areas drawn after it. */
export interface HeightRegion {
  area: HeightArea;
  height: number;
  polygons: Polygon[];
  paths: PathsD;
}

/**
 * A run of edge between two heights. Walking along `points`, the low side is
 * on your right (y grows down: going east, the low side is south).
 */
export interface HeightEdgeLine {
  points: Point[];
  closed: boolean;
  /** The heights either side, in the map's units. */
  high: number;
  low: number;
  kind: HeightEdge;
  /** The area whose edge this is (the one drawn later), and the one on the other side (null: the plain ground). */
  owner: string;
  other: string | null;
  /** On the floor of rooms and corridors (else outdoors, on terrain). */
  indoors: boolean;
}

export interface HeightPlan {
  unit: SquareUnit;
  /** The areas that count in this view, in map order. */
  areas: HeightArea[];
  regions: HeightRegion[];
  /** Where no area is: the plain ground, at height 0. */
  base: { polygons: Polygon[]; paths: PathsD };
  ground: Polygon[];
  edges: HeightEdgeLine[];
  /** The height at p (0 on plain ground), or null off the ground (outside every room, corridor and terrain). */
  at(p: Point): number | null;
  /** The area that sets the height at p, or null (plain ground, or off the ground). */
  areaAt(p: Point): HeightArea | null;
}

export interface HeightOptions {
  /** 'players' leaves hidden areas out. Default 'gm'. */
  view?: HeightView;
  /** The floor as flat paths (the renderer passes its rough floor). Default: floorPaths(map). */
  floor?: PathsD;
}

/** How far apart the edge is probed, in squares. */
const STEP = 0.25;
/** How far off the edge a probe looks. */
const OUT = 0.01;

/** The height areas that count in a view (hidden ones are the GM's only), in map order. */
export function heightAreas(map: DelveMap, view: HeightView = 'gm'): HeightArea[] {
  return map.objects.filter((o): o is HeightArea => o.type === 'height' && (view === 'gm' || !o.hidden));
}

export const hasHeights = (map: DelveMap, view: HeightView = 'gm'): boolean => map.objects.some((o) => o.type === 'height' && (view === 'gm' || !o.hidden));

/** The ground heights live on: the floor (rooms and corridors minus cutouts) and every terrain area. */
export function groundPaths(map: DelveMap, floor: PathsD = floorPaths(map)): PathsD {
  const terrain = map.objects.flatMap((o) => (o.type === 'terrain' ? terrainArea(o) : []));
  return terrain.length ? unionD([...floor, ...terrain], [], FillRule.NonZero, PRECISION) : floor;
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/** A height as shown: "+10 ft", "−5 ft", "0 m". */
export function heightText(height: number, unit?: SquareUnit | string): string {
  const u = typeof unit === 'object' ? unit : parseSquareUnit(unit);
  const sign = height > 0 ? '+' : height < 0 ? MINUS : '';
  return `${sign}${fmt(Math.abs(height))} ${u.name}`;
}

/** The edge an area gets where it isn't set: a cliff for a drop of a square's size or more (a ledge line indoors, a rock face outdoors), else a step. */
export function defaultEdge(drop: number, unit: SquareUnit, indoors: boolean): HeightEdge {
  return Math.abs(drop) >= unit.size - 1e-9 ? (indoors ? 'cliff' : 'rock') : 'step';
}

/** A rock face's width in squares: about one square per 10 ft (two squares' drop), from half a square to three. */
export function rockWidth(drop: number, unit: SquareUnit): number {
  return Math.min(3, Math.max(0.5, (Math.abs(drop) / unit.size) * 0.5));
}

/**
 * How far a slope runs on its low side, in squares: two and a half squares per
 * square of rise (about 22° on average, a hillside you walk up), from 1 to 8.
 * Below a square a ramp reads as a step; past 8 a big rise would eat the map, so
 * it gets steeper instead (a 5 m rise on a 1 m grid ramps over 8 squares).
 * In 3D and on the 2D map's contours, ramps narrow where something is in the
 * way (surface.ts).
 */
export function slopeRun(drop: number, unit: SquareUnit): number {
  return Math.min(8, Math.max(1, (Math.abs(drop) / unit.size) * 2.5));
}

interface Boxed {
  p: Polygon;
  b: Bounds;
}
const boxed = (polys: readonly Polygon[]): Boxed[] => polys.map((p) => ({ p, b: pointsBounds(p.outer) }));
const inBox = (b: Bounds, [x, y]: Point): boolean => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const inBoxed = (list: readonly Boxed[], q: Point): boolean => list.some(({ p, b }) => inBox(b, q) && pointInRing(q, p.outer) && !p.holes.some((h) => pointInRing(q, h)));

const same = (a: Point, b: Point): boolean => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

interface Piece {
  a: Point;
  b: Point;
  key: string;
  nb: number;
  indoors: boolean;
  /** The outward normal of the region points to the right of a → b. */
  outRight: boolean;
}

/** Everything about the heights of a map: where each area's ground is, and the edges between heights. */
export function heightPlan(map: DelveMap, opts: HeightOptions = {}): HeightPlan {
  const unit = parseSquareUnit(map.grid.unit);
  const areas = heightAreas(map, opts.view ?? 'gm');
  const floorFlat = opts.floor ?? floorPaths(map);
  const groundFlat = groundPaths(map, floorFlat);
  const ground = polygonsOf(groundFlat);
  const groundBoxed = boxed(ground);
  const floorBoxed = boxed(polygonsOf(floorFlat));
  // the areas as rings, the way Clipper sees them (a circle is a 64-gon)
  const rings: Ring[] = areas.map((a) => fromPath(shapePath(a.shape)));
  const ringBoxes = rings.map(pointsBounds);
  const shapes: PathsD = areas.map((a) => shapePath(a.shape));

  const regions: HeightRegion[] = areas.map((area, i) => {
    let paths = groundFlat.length ? intersectD([shapes[i]!], groundFlat, FillRule.NonZero, PRECISION) : [];
    const later = shapes.slice(i + 1);
    if (paths.length && later.length) paths = differenceD(paths, later, FillRule.NonZero, PRECISION);
    return { area, height: area.height, paths, polygons: polygonsOf(paths) };
  });
  const basePaths = groundFlat.length && shapes.length ? differenceD(groundFlat, shapes, FillRule.NonZero, PRECISION) : groundFlat;
  const base = { paths: basePaths, polygons: polygonsOf(basePaths) };

  /** -1 plain ground, i the area that sets the height, null off the ground. */
  const regionAt = (q: Point): number | null => {
    if (!inBoxed(groundBoxed, q)) return null;
    for (let i = areas.length - 1; i >= 0; i--) if (inBox(ringBoxes[i]!, q) && pointInRing(q, rings[i]!)) return i;
    return -1;
  };
  const heightOf = (i: number): number => (i < 0 ? 0 : areas[i]!.height);

  const edges: HeightEdgeLine[] = [];
  regions.forEach((r, i) => {
    const mine = boxed(r.polygons);
    for (const poly of r.polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        const pieces: (Piece | null)[] = [];
        for (let s = 0; s < ring.length; s++) {
          const a = ring[s]!;
          const b = ring[(s + 1) % ring.length]!;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-9) continue;
          const nx = -(b[1] - a[1]) / len;
          const ny = (b[0] - a[0]) / len;
          const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const outRight = !inBoxed(mine, [mid[0] + nx * 1e-3, mid[1] + ny * 1e-3]);
          const ox = outRight ? nx : -nx;
          const oy = outRight ? ny : -ny;
          const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const probe = (t: number): { key: string; nb: number; indoors: boolean } | null => {
            const p = at(t);
            const q: Point = [p[0] + ox * OUT, p[1] + oy * OUT];
            const nb = regionAt(q);
            // off the ground (a wall) or the edge of an area drawn later (that one draws it): no edge here
            if (nb === null || nb >= i) return null;
            const drop = r.height - heightOf(nb);
            if (Math.abs(drop) < 1e-9) return null;
            const indoors = inBoxed(floorBoxed, q) || inBoxed(floorBoxed, [p[0] - ox * OUT, p[1] - oy * OUT]);
            const kind = r.area.edge ?? defaultEdge(drop, unit, indoors);
            return { key: `${nb}|${kind}|${indoors ? 1 : 0}`, nb, indoors };
          };
          const n = Math.max(1, Math.ceil(len / STEP));
          const keyAt = (t: number) => probe(t)?.key ?? '';
          const cuts: { t: number; info: ReturnType<typeof probe> }[] = [{ t: 0, info: probe(0.5 / n) }];
          let prev = cuts[0]!.info?.key ?? '';
          for (let k = 1; k < n; k++) {
            const info = probe((k + 0.5) / n);
            const key = info?.key ?? '';
            if (key === prev) continue;
            // where exactly the edge changes: halve the gap between the two probes
            let lo = (k - 0.5) / n;
            let hi = (k + 0.5) / n;
            for (let it = 0; it < 12; it++) {
              const m = (lo + hi) / 2;
              if (keyAt(m) === prev) lo = m;
              else hi = m;
            }
            cuts.push({ t: (lo + hi) / 2, info });
            prev = key;
          }
          cuts.forEach((c, k) => {
            const t1 = k + 1 < cuts.length ? cuts[k + 1]!.t : 1;
            if (!c.info || t1 - c.t < 1e-9) {
              pieces.push(null);
              return;
            }
            pieces.push({ a: at(c.t), b: at(t1), key: c.info.key, nb: c.info.nb, indoors: c.info.indoors, outRight });
          });
        }
        // join the pieces into runs, round the ring's start
        const runs: Piece[][] = [];
        let cur: Piece[] = [];
        for (const p of pieces) {
          const last = cur[cur.length - 1];
          if (p && last && p.key === last.key && same(p.a, last.b)) cur.push(p);
          else {
            if (cur.length) runs.push(cur);
            cur = p ? [p] : [];
          }
        }
        if (cur.length) runs.push(cur);
        let closed = false;
        if (runs.length > 1) {
          const first = runs[0]!;
          const last = runs[runs.length - 1]!;
          if (first[0]!.key === last[0]!.key && same(last[last.length - 1]!.b, first[0]!.a) && pieces[0] && pieces[pieces.length - 1]) {
            runs[0] = [...last, ...first];
            runs.pop();
          }
        } else if (runs.length === 1 && pieces.every(Boolean)) {
          const run = runs[0]!;
          closed = same(run[run.length - 1]!.b, run[0]!.a);
        }
        for (const run of runs) {
          const head = run[0]!;
          const drop = r.height - heightOf(head.nb);
          // the low side goes on the right: outward when this area is the higher one
          const flip = head.outRight !== drop > 0;
          const seq = flip ? [...run].reverse().map((p) => ({ ...p, a: p.b, b: p.a })) : run;
          const points: Point[] = [seq[0]!.a];
          for (const p of seq) points.push(p.b);
          if (closed && runs.length === 1) points.pop();
          edges.push({
            points,
            closed: closed && runs.length === 1,
            high: Math.max(r.height, heightOf(head.nb)),
            low: Math.min(r.height, heightOf(head.nb)),
            kind: head.key.split('|')[1] as HeightEdge,
            owner: r.area.id,
            other: head.nb < 0 ? null : areas[head.nb]!.id,
            indoors: head.indoors,
          });
        }
      }
    }
  });

  return {
    unit,
    areas,
    regions,
    base,
    ground,
    edges,
    at(p) {
      const i = regionAt(p);
      return i === null ? null : heightOf(i);
    },
    areaAt(p) {
      const i = regionAt(p);
      return i === null || i < 0 ? null : areas[i]!;
    },
  };
}

// ---------- where you can go ----------

export type CrossingKind = 'stairs' | 'ladder' | 'slope' | 'step';

export interface EdgeSegment {
  a: Point;
  b: Point;
  high: number;
  low: number;
  owner: string;
  other: string | null;
}

export interface HeightCrossing extends EdgeSegment {
  kind: CrossingKind;
  /** The stairs or ladder that crosses here. */
  id?: string;
}

export interface Walkable {
  /** The ground by height (0 is the plain ground), for tinting. */
  bands: { height: number; polygons: Polygon[] }[];
  /** Cliff and rock-face edges where nothing crosses them: they block movement. */
  blocked: EdgeSegment[];
  /** Where an edge can be crossed: stairs or a ladder over a cliff, and every slope and step. */
  crossings: HeightCrossing[];
  /** The walls and shut doors (as the map has them), which block movement as before. */
  walls: Segment[];
}

export interface WalkableOptions {
  view?: HeightView;
  /** Is this door open? Default: the map's `open`. Archways are always open. */
  doorOpen?: (d: Door) => boolean;
  plan?: HeightPlan;
}

/** What crosses a cliff: stairs (their shape) and ladders and spiral stairs (their footprint). */
export function crossers(map: DelveMap, view: HeightView = 'gm'): { id: string; kind: 'stairs' | 'ladder'; ring: Ring }[] {
  const out: { id: string; kind: 'stairs' | 'ladder'; ring: Ring }[] = [];
  for (const o of map.objects) {
    if (o.type === 'stairs') out.push({ id: o.id, kind: 'stairs', ring: fromPath(shapePath(o.shape)) });
    else if (o.type === 'prop' && (STAIR_PROPS[o.asset] === 'ladder' || STAIR_PROPS[o.asset] === 'spiral') && (view === 'gm' || !propHidden(o))) {
      const b = propBounds(o);
      out.push({ id: o.id, kind: 'ladder', ring: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] });
    }
  }
  return out;
}

/** A segment split where it crosses the rings: the parts inside one (with its index) and the parts outside (-1). */
function splitByRings(a: Point, b: Point, rings: readonly Ring[]): { a: Point; b: Point; ring: number }[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ts = [0, 1];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
      const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const at = (t: number): Point => [a[0] + dx * t, a[1] + dy * t];
  const out: { a: Point; b: Point; ring: number }[] = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k]!;
    const t1 = ts[k + 1]!;
    if (t1 - t0 < 1e-9) continue;
    const m = at((t0 + t1) / 2);
    const ring = rings.findIndex((r) => pointInRing(m, r));
    const last = out[out.length - 1];
    if (last && last.ring === ring) last.b = at(t1);
    else out.push({ a: at(t0), b: at(t1), ring });
  }
  return out;
}

const segmentsOf = (e: HeightEdgeLine): [Point, Point][] => {
  const out: [Point, Point][] = [];
  const n = e.points.length;
  for (let i = 0; i < (e.closed ? n : n - 1); i++) out.push([e.points[i]!, e.points[(i + 1) % n]!]);
  return out;
};

/**
 * Which boundaries block movement: cliff and rock-face edges, except where
 * stairs or a ladder cross them, plus the walls and shut doors as before.
 * Slopes and steps are walked over.
 */
export function walkableMap(map: DelveMap, opts: WalkableOptions = {}): Walkable {
  const view = opts.view ?? 'gm';
  const plan = opts.plan ?? heightPlan(map, { view });
  const over = crossers(map, view);
  const rings = over.map((c) => c.ring);
  const blocked: EdgeSegment[] = [];
  const crossings: HeightCrossing[] = [];
  for (const e of plan.edges) {
    const base = { high: e.high, low: e.low, owner: e.owner, other: e.other };
    for (const [a, b] of segmentsOf(e)) {
      if (!BLOCKING_EDGES.has(e.kind)) {
        crossings.push({ a, b, ...base, kind: e.kind as CrossingKind });
        continue;
      }
      for (const part of splitByRings(a, b, rings)) {
        if (part.ring < 0) blocked.push({ a: part.a, b: part.b, ...base });
        else crossings.push({ a: part.a, b: part.b, ...base, kind: over[part.ring]!.kind, id: over[part.ring]!.id });
      }
    }
  }
  const open = (d: Door) => d.style === 'archway' || (opts.doorOpen ? opts.doorOpen(d) : Boolean(d.open));
  const walls: Segment[] = [...computeWalls(map), ...map.objects.filter((o): o is Door => o.type === 'door' && !open(o)).map(doorSegment)];
  // the ground by height, equal heights together
  const byHeight = new Map<number, PathsD>([[0, [...plan.base.paths]]]);
  for (const r of plan.regions) byHeight.set(r.height, [...(byHeight.get(r.height) ?? []), ...r.paths]);
  const bands = [...byHeight]
    .map(([height, paths]) => ({ height, polygons: polygonsOf(unionD(paths, [], FillRule.NonZero, PRECISION)) }))
    .filter((b) => b.polygons.length)
    .sort((x, y) => x.height - y.height);
  return { bands, blocked, crossings, walls };
}

/** The cliff edges that block a move, for a Delve Table page: GM only, in cells, with the drop in the map's units. Hidden areas aren't enforced. */
export function blockingEdges(map: DelveMap): { a: [number, number]; b: [number, number]; drop: number }[] {
  if (!hasHeights(map, 'players')) return [];
  const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
  return walkableMap(map, { view: 'players' }).blocked.map((s) => ({ a: [r(s.a[0]), r(s.a[1])], b: [r(s.b[0]), r(s.b[1])], drop: Math.round((s.high - s.low) * 100) / 100 }));
}

// ---------- stairs ----------

/** The way up a flight of stairs that runs between two heights (toward the higher end), or null when both ends are level. */
export function stairsUphill(plan: Pick<HeightPlan, 'at'>, b: Bounds): 'n' | 'e' | 's' | 'w' | null {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const inset = (v: number) => Math.min(0.25, v / 4);
  const ix = inset(b.x1 - b.x0);
  const iy = inset(b.y1 - b.y0);
  const h = (p: Point) => plan.at(p);
  const n = h([cx, b.y0 + iy]);
  const s = h([cx, b.y1 - iy]);
  const w = h([b.x0 + ix, cy]);
  const e = h([b.x1 - ix, cy]);
  const ns = n !== null && s !== null ? n - s : 0;
  const we = w !== null && e !== null ? w - e : 0;
  if (Math.abs(ns) < 1e-9 && Math.abs(we) < 1e-9) return null;
  return Math.abs(ns) >= Math.abs(we) ? (ns > 0 ? 'n' : 's') : we > 0 ? 'w' : 'e';
}

// ---------- 3D ----------

/** A polygon in squares (the shape of @delve/table's ScenePolygon). */
export interface Polygon3 {
  outer: [number, number][];
  holes: [number, number][][];
}

/** Heights on the scene's lattice (`HeightScene.step` squares from the map's origin): rows of columns from (i0, j0), as 16-bit steps between min and max, base64. */
export interface Grid3 {
  i0: number;
  j0: number;
  cols: number;
  rows: number;
  min: number;
  max: number;
  z: string;
}

/** The heights of a map for a 3D view, everything in squares (heights too: a 10 ft ledge on a 5 ft grid is 2 up). */
export interface HeightScene {
  /** Raised or sunken ground, by the plan's height (0 is left out: it is the plain ground). Which end of stairs is up. */
  bands: { h: number; polygons: Polygon3[] }[];
  /** The rest of the frame, at 0: the floor picture without the pieces. */
  base: Polygon3[];
  /** The edges between heights. Walking along points, the low side is on the right; `run` is how far a slope or rock face reaches out there on the 2D map. */
  edges: { points: [number, number][]; closed: boolean; hi: number; lo: number; kind: HeightEdge; run: number }[];
  /**
   * The ground as the 3D views drape it (surface.ts): pieces at one height, or
   * with a grid of heights where the surface varies (hills, ramps). Neighbouring
   * pieces at different heights meet in a sheer face. Off them the ground is at 0.
   */
  pieces: { polygons: Polygon3[]; h: number; grid?: Grid3 }[];
  /** The grids' lattice, in squares. */
  step: number;
  /** The colour rock faces are toned to (from the map's style). */
  rock: string;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const poly3 = (p: Polygon): Polygon3 => ({ outer: p.outer.map(([x, y]) => [r3(x), r3(y)]), holes: p.holes.map((h) => h.map(([x, y]) => [r3(x), r3(y)])) });

/** About this many lattice cells over all the grids of a map; the lattice gets coarser past it (at most 4 per square, at least 1 per 2). */
export const GRID_CELLS = 24_000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]! + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : '=') + (i + 2 < bytes.length ? B64[c & 63]! : '=');
  }
  return out;
}

/**
 * A grid as sent: only the posts near the piece (its polygons, two cells around),
 * so nothing beyond what the viewer may see goes out; the rest repeat `min`.
 */
function packGrid(g: { i0: number; j0: number; cols: number; rows: number; z: Float64Array }, step: number, polys: readonly Polygon[], scale: number): Grid3 {
  const { cols, rows } = g;
  const keep = new Uint8Array(cols * rows);
  // the posts of every cell the piece touches, and one cell around
  const mark = (x: number, y: number) => {
    const c0 = Math.floor(x / step) - g.i0;
    const r0 = Math.floor(y / step) - g.j0;
    for (let r = r0 - 1; r <= r0 + 2; r++) for (let c = c0 - 1; c <= c0 + 2; c++) if (r >= 0 && r < rows && c >= 0 && c < cols) keep[r * cols + c] = 1;
  };
  const boxes = polys.map((p) => pointsBounds(p.outer));
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const q: Point = [(g.i0 + c + 0.5) * step, (g.j0 + r + 0.5) * step];
      if (polys.some((p, k) => q[0] >= boxes[k]!.x0 && q[0] <= boxes[k]!.x1 && q[1] >= boxes[k]!.y0 && q[1] <= boxes[k]!.y1 && pointInRing(q, p.outer) && !p.holes.some((h) => pointInRing(q, h)))) mark(q[0], q[1]);
    }
  }
  for (const p of polys) {
    for (const ring of [p.outer, ...p.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (step / 2)));
        for (let k = 0; k <= n; k++) mark(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < g.z.length; k++) {
    if (!keep[k]) continue;
    lo = Math.min(lo, g.z[k]!);
    hi = Math.max(hi, g.z[k]!);
  }
  if (!(hi >= lo)) lo = hi = 0;
  const min = r3(lo / scale);
  const max = Math.max(min, r3(hi / scale));
  const span = max - min || 1;
  const bytes = new Uint8Array(cols * rows * 2);
  for (let k = 0; k < g.z.length; k++) {
    const v = keep[k] ? Math.round(((g.z[k]! / scale - min) / span) * 65535) : 0;
    const q = Math.max(0, Math.min(65535, v));
    bytes[k * 2] = q & 255;
    bytes[k * 2 + 1] = q >> 8;
  }
  return { i0: g.i0, j0: g.j0, cols, rows, min, max, z: base64(bytes) };
}

/** A map's rock tone in 3D: a weathered grey-brown, taken halfway toward the style's own shade colour. */
function rockTone(map: DelveMap): string {
  let shade = '#B7AD9B';
  try {
    shade = resolveStyle(map).props.shade;
  } catch {
    /* an unknown preset: the default tone */
  }
  const hex = (c: string) => {
    const v = parseInt(c.replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const a = hex('#857C70');
  const b = hex(/^#[0-9a-f]{6}$/i.test(shade) ? shade : '#B7AD9B');
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * 0.5).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The 3D view's heights: the draped ground (pieces), the bands and the rest of
 * the frame at 0, and the edges. `region` (players: what they may see) cuts all
 * of it to it, grids included. Null when the map has no height areas in this view.
 */
export function heightScene(map: DelveMap, opts: { view?: HeightView; frame: Bounds; region?: Polygon[] | 'all'; floor?: PathsD }): HeightScene | null {
  const view = opts.view ?? 'gm';
  if (!hasHeights(map, view)) return null;
  const floor = opts.floor ?? floorPaths(map);
  const plan = heightPlan(map, { view, floor });
  const unit = plan.unit;
  const sq = (v: number) => r3(v / unit.size);
  const region = opts.region && opts.region !== 'all' ? opts.region : null;
  const regionPaths = region ? region.flatMap((p) => [p.outer, ...p.holes].map(toPath)) : null;
  const f = opts.frame;
  const box = [toPath([[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]])];
  const cut = (p: PathsD): PathsD => {
    const inFrame = intersectD(p, box, FillRule.NonZero, PRECISION);
    return regionPaths && inFrame.length ? intersectD(inFrame, regionPaths, FillRule.NonZero, PRECISION) : inFrame;
  };
  const byHeight = new Map<number, PathsD>();
  for (const r of plan.regions) if (Math.abs(r.height) > 1e-9 && r.paths.length) byHeight.set(r.height, [...(byHeight.get(r.height) ?? []), ...r.paths]);
  const bands: HeightScene['bands'] = [];
  for (const [height, paths] of byHeight) {
    let p = unionD(paths, [], FillRule.NonZero, PRECISION);
    if (regionPaths) p = intersectD(p, regionPaths, FillRule.NonZero, PRECISION);
    if (!p.length) continue;
    bands.push({ h: sq(height), polygons: polygonsOf(p).map(poly3) });
  }
  bands.sort((a, b) => a.h - b.h);

  // the draped ground: flat where the plan says (outside the surface's zones), sampled where it varies
  const surf = heightSurface(map, { view, plan, floor });
  const flat = new Map<number, PathsD>();
  const addFlat = (height: number, paths: PathsD) => {
    const k = Math.round(height * 1e6) / 1e6;
    if (Math.abs(k) > 1e-9 && paths.length) flat.set(k, [...(flat.get(k) ?? []), ...paths]);
  };
  for (const r of plan.regions) addFlat(r.height, surf.zonePaths.length ? differenceD(r.paths, surf.zonePaths, FillRule.NonZero, PRECISION) : r.paths);
  const zoneArea = surf.pieces.reduce((s, p) => s + (p.bounds.x1 - p.bounds.x0) * (p.bounds.y1 - p.bounds.y0), 0);
  const step = Math.min(2, Math.max(0.25, Math.ceil(Math.sqrt(zoneArea / GRID_CELLS) * 16) / 16));
  const pieces: HeightScene['pieces'] = [];
  const all: PathsD = [];
  const varying: { paths: PathsD; g: ReturnType<typeof sampleSurface> }[] = [];
  surf.pieces.forEach((piece, i) => {
    const g = sampleSurface(surf, i, step);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of g.z) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) addFlat(lo, piece.paths);
    else varying.push({ paths: piece.paths, g });
  });
  for (const [height, paths] of flat) {
    const p = cut(unionD(paths, [], FillRule.NonZero, PRECISION));
    if (!p.length) continue;
    all.push(...p);
    pieces.push({ polygons: polygonsOf(p).map(poly3), h: sq(height) });
  }
  for (const { paths, g } of varying) {
    const p = cut(paths);
    if (!p.length) continue;
    all.push(...p);
    const polys = polygonsOf(p);
    const grid = packGrid(g, step, polys, unit.size);
    pieces.push({ polygons: polys.map(poly3), h: grid.min, grid });
  }
  const base = polygonsOf(all.length ? differenceD(box, all, FillRule.NonZero, PRECISION) : box).map(poly3);
  const edges: HeightScene['edges'] = [];
  for (const e of plan.edges) {
    const run = e.kind === 'rock' ? rockWidth(e.high - e.low, unit) : e.kind === 'slope' ? slopeRun(e.high - e.low, unit) : 0;
    const lines = region ? clipPolylines([{ points: e.points, closed: e.closed }], region) : [{ points: e.points, closed: e.closed }];
    for (const l of lines) {
      if (l.points.length < 2) continue;
      edges.push({ points: l.points.map(([x, y]) => [r3(x), r3(y)]), closed: l.closed, hi: sq(e.high), lo: sq(e.low), kind: e.kind, run: r3(run) });
    }
  }
  return { bands, base, edges, pieces, step, rock: rockTone(map) };
}

// ---------- in words (describeMap) ----------

const roomTitle = (r: { label?: string; name?: string; id: string }): string => [r.label, r.name].filter(Boolean).join(' ') || r.id;

function where(map: DelveMap, area: HeightArea): string {
  const b = shapeBoundsOf(area);
  const c: Point = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const overlap = (r: Bounds) => Math.max(0, Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0)) * Math.max(0, Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0));
  const rooms = map.objects
    .filter((o): o is Extract<DelveMap['objects'][number], { type: 'room' }> => o.type === 'room')
    .map((r) => ({ r, b: shapeBoundsOf(r), o: overlap(shapeBoundsOf(r)) }))
    .filter((x) => x.o > 1e-6)
    .sort((x, y) => y.o - x.o);
  const best = rooms[0];
  if (best) {
    const rb = best.b;
    const name = `room ${roomTitle(best.r)}`;
    if (best.o >= 0.8 * (rb.x1 - rb.x0) * (rb.y1 - rb.y0)) return `covers ${name}`;
    const w = rb.x1 - rb.x0;
    const h = rb.y1 - rb.y0;
    const ns = c[1] < rb.y0 + h / 3 ? 'north' : c[1] > rb.y1 - h / 3 ? 'south' : '';
    const ew = c[0] < rb.x0 + w / 3 ? 'west' : c[0] > rb.x1 - w / 3 ? 'east' : '';
    const side = ns && ew ? `${ns}-${ew}` : ns || ew;
    return side ? `along the ${side} side of ${name}` : `in the middle of ${name}`;
  }
  const t = [...map.objects].reverse().find((o) => o.type === 'terrain' && pointInRing(c, fromPath(shapePath(o.shape))));
  if (t && t.type === 'terrain') return `on ${t.name ?? assetName(t.asset)} (${t.id})`;
  return 'outside the rooms';
}

const shapeBoundsOf = (o: { shape: HeightArea['shape'] }): Bounds => shapeBounds(o.shape);
const assetName = (id: string): string => assetInfo(id)?.name ?? id;

const EDGE_WORDS: Record<HeightEdge, string> = { cliff: 'cliff edge', rock: 'rock face', slope: 'slope (walkable)', step: 'step (walkable)' };

/** The lines describeMap gives the heights: each area, where it is, its edge and how it is reached. */
export function describeHeights(map: DelveMap): string[] {
  const areas = heightAreas(map, 'gm');
  if (!areas.length) return [];
  const plan = heightPlan(map);
  const walk = walkableMap(map, { plan });
  const unit = plan.unit;
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const lines = [`Heights (relative to the floor, in ${unit.name}; a hill rises to its height toward the middle (a hollow sinks), the rest are flat; slopes and steps are walked over, cliff edges and rock faces only by stairs or a ladder):`];
  for (const a of areas) {
    const region = plan.regions.find((r) => r.area.id === a.id);
    const b = shapeBoundsOf(a);
    const size = 'rect' in a.shape ? `${fmt(b.x1 - b.x0)}×${fmt(b.y1 - b.y0)} sq at ${fmt(b.x0)},${fmt(b.y0)}` : 'circle' in a.shape ? `circle, radius ${fmt(a.shape.circle[2])} sq, centred at ${fmt(a.shape.circle[0])},${fmt(a.shape.circle[1])}` : `polygon, ${fmt(b.x1 - b.x0)}×${fmt(b.y1 - b.y0)} sq at ${fmt(b.x0)},${fmt(b.y0)}`;
    const mine = plan.edges.filter((e) => e.owner === a.id || e.other === a.id);
    const kinds = [...new Set(mine.map((e) => e.kind))];
    const edgeText = kinds.length ? kinds.map((k) => EDGE_WORDS[k]).join(' and ') : a.edge ? EDGE_WORDS[a.edge] : 'no edge';
    const via = new Map<string, string>();
    for (const c of walk.crossings) {
      if (!c.id || (c.owner !== a.id && c.other !== a.id)) continue;
      const o = byId.get(c.id);
      const what = o?.type === 'stairs' ? `stairs ${c.id} (up ${stairsUphill(plan, shapeBoundsOf(o)) ?? o.direction})` : `ladder ${c.id}`;
      via.set(c.id, what);
    }
    const blocked = walk.blocked.some((s) => s.owner === a.id || s.other === a.id);
    const walkable = mine.some((e) => !BLOCKING_EDGES.has(e.kind));
    let reach = '';
    if (via.size) reach = `; reached by ${[...via.values()].join(', ')}`;
    else if (blocked && !walkable) reach = '; no stairs or ladder: only by climbing, jumping or flying';
    const ground = region && region.polygons.length ? '' : ' (no floor or terrain under it, so it changes nothing yet)';
    lines.push(
      `  ${a.id}${a.name ? ` "${a.name}"` : ''}: ${heightText(a.height, unit)}${heightProfile(a) === 'hill' ? (a.height < 0 ? ' hollow' : ' hill') : ''}, ${edgeText}, ${size}, ${where(map, a)}${reach}${ground}${a.hidden ? ' (hidden from players)' : ''}`,
    );
  }
  return lines;
}
