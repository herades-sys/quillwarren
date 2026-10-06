// Areas by meaning: "a band along the north edge", "the south-west corner",
// "all of room 5", "a ring around r3", "a strip from the east edge to the
// hill". MCP add_terrain, add_height, add_props_along and add_label take such
// a region instead of raw shapes or paths; this turns one into geometry the
// tools can use, and a sentence saying where it is. North is the top of the
// map (small y), east the right (big x).
import { EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathsD } from 'clipper2-ts';
import { PRECISION, shapeArea, shapeBounds, shapePath, toPath, type Bounds, type Polygon } from '../geometry/shapes.ts';
import { polygonsOf } from '../geometry/floor.ts';
import type { DelveMap, Point, Shape } from '../schema.ts';
import { halfSquares, lengthInSquares, parseSquareUnit, type Length } from '../units.ts';
import { ValidationError } from '../validate.ts';
import {
  boxCentre,
  boxH,
  boxPath,
  boxText,
  boxW,
  CORNER_WORDS,
  cornerOf,
  fmt,
  hasOpenGround,
  mapBox,
  minus,
  needArea,
  objectArea,
  polygonPaths,
  r2,
  sideOf,
  type Corner,
  type ObjectArea,
  type Side,
} from './common.ts';

/** A region as the tools take it (one of edge, corner, in, around or between; in also goes with edge or corner). */
export interface RegionSpec {
  /** A band along this edge of the map, or of the room or area given by in. */
  edge?: string;
  /** How deep the band is (default 3 squares on the map, 2 in a room). */
  depth?: Length;
  /** A square in this corner: ne, nw, se or sw. */
  corner?: string;
  /** Its side (default about a third of the map, up to 3 squares in a room). */
  size?: Length;
  /** A room or area id: all of it, or with edge / corner, part of it. */
  in?: string;
  /** A ring around this object. */
  around?: string;
  /** How far the ring reaches out (default 2 squares). */
  margin?: Length;
  /** A strip between two things: object ids, map edges ("east") or points [x, y]. */
  between?: readonly (string | Point)[];
  /** The strip's width (default 2 squares). */
  width?: Length;
  /**
   * Map edges only: true puts the band just outside the map's box, false inside
   * it. Default: inside on maps with open ground (terrain outside the rooms),
   * outside on a map of rooms only (north of the rooms, not over them).
   */
  outside?: boolean;
  /** A plain shape is a region too (models write {"region": {"rect": [0, 0, 30, 20]}}): rect [x, y, w, h], poly or circle. */
  rect?: readonly number[];
  poly?: readonly (readonly number[])[];
  circle?: readonly number[];
}

export type RegionKind = 'edge' | 'corner' | 'in' | 'around' | 'between' | 'shape';

export interface Region {
  kind: RegionKind;
  polygons: Polygon[];
  paths: PathsD;
  bounds: Bounds;
  /** As one shape: the largest piece's outline (a rect when it is one). */
  shape: Shape;
  /** That piece's holes (terrain keeps them; a ring around a room has one). */
  holes: Point[][];
  /** Between: the centre line, from the first thing to the second. */
  line?: [Point, Point];
  /** With in: the room or area it lies in. */
  within?: ObjectArea;
  /** Props filled into it keep off rooms and corridors (every region but in). */
  offFloor: boolean;
  /** Where it is, for the reply: "a 3-square band along the north edge of the map (x 0–20, y -3.5–-0.5)". */
  text: string;
  /** Unit conversions made ("5 m = 3.33 squares"). */
  notes: string[];
}

const DEFAULT_DEPTH_MAP = 3;
const DEFAULT_DEPTH_IN = 2;
const DEFAULT_MARGIN = 2;
const DEFAULT_WIDTH = 2;
/** Between a map-level band outside the rooms and their walls. */
const OUTSIDE_GAP = 0.5;

/** A polygon's outer ring as a shape: a rect when it is an axis-aligned rectangle. */
export function ringShape(ring: readonly Point[]): Shape {
  const pts = ring.map(([x, y]) => [r2(x), r2(y)] as Point);
  if (pts.length === 4) {
    const xs = [...new Set(pts.map((p) => p[0]))];
    const ys = [...new Set(pts.map((p) => p[1]))];
    if (xs.length === 2 && ys.length === 2) {
      const [x0, x1] = xs.sort((a, b) => a - b) as [number, number];
      const [y0, y1] = ys.sort((a, b) => a - b) as [number, number];
      return { rect: [x0, y0, r2(x1 - x0), r2(y1 - y0)] };
    }
  }
  return { poly: pts };
}

function finish(kind: RegionKind, polygons: Polygon[], text: string, notes: string[], extra: Partial<Region> = {}): Region {
  const usable = polygons.filter((g) => g.outer.length >= 3);
  if (!usable.length) throw new ValidationError([`region: ${text} has no area left (it lies outside what it was cut to)`]);
  const area = (g: Polygon) => shapeArea({ poly: g.outer });
  const biggest = [...usable].sort((a, b) => area(b) - area(a))[0]!;
  const pts = usable.flatMap((g) => g.outer);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const bounds = { x0: r2(Math.min(...xs)), y0: r2(Math.min(...ys)), x1: r2(Math.max(...xs)), y1: r2(Math.max(...ys)) };
  return {
    kind,
    polygons: usable,
    paths: polygonPaths(usable),
    bounds,
    shape: ringShape(biggest.outer),
    holes: biggest.holes.map((h) => h.map(([x, y]) => [r2(x), r2(y)] as Point)),
    offFloor: kind !== 'in',
    text,
    notes,
    ...extra,
  };
}

/** Polygons of `paths` cut to an object's own area (a band inside a round room is round on one side). */
function cutTo(paths: PathsD, within: ObjectArea): Polygon[] {
  return polygonsOf(intersectD(paths, within.paths, FillRule.NonZero, PRECISION));
}

function bandBox(box: Bounds, side: Side, depth: number, outside: boolean): Bounds {
  const d = outside ? depth : Math.min(depth, side === 'north' || side === 'south' ? boxH(box) : boxW(box));
  const g = outside ? OUTSIDE_GAP : 0;
  switch (side) {
    case 'north':
      return outside ? { ...box, y0: box.y0 - g - d, y1: box.y0 - g } : { ...box, y1: box.y0 + d };
    case 'south':
      return outside ? { ...box, y0: box.y1 + g, y1: box.y1 + g + d } : { ...box, y0: box.y1 - d };
    case 'west':
      return outside ? { ...box, x0: box.x0 - g - d, x1: box.x0 - g } : { ...box, x1: box.x0 + d };
    case 'east':
      return outside ? { ...box, x0: box.x1 + g, x1: box.x1 + g + d } : { ...box, x0: box.x1 - d };
  }
}

function cornerBox(box: Bounds, c: Corner, size: number): Bounds {
  const s = Math.min(size, boxW(box), boxH(box));
  const x = c === 'ne' || c === 'se' ? [box.x1 - s, box.x1] : [box.x0, box.x0 + s];
  const y = c === 'ne' || c === 'nw' ? [box.y0, box.y0 + s] : [box.y1 - s, box.y1];
  return { x0: x[0]!, x1: x[1]!, y0: y[0]!, y1: y[1]! };
}

/** One end of a "between" strip: the centre of an object, a point, or a map edge (found once the other end is known). */
interface End {
  given: string | Point;
  p?: Point;
  side?: Side;
  area?: ObjectArea;
  text: string;
}

function resolveEnd(map: DelveMap, e: string | Point): End {
  if (Array.isArray(e)) {
    if (e.length !== 2 || !e.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new ValidationError(['region.between: a point is [x, y]']);
    return { given: e, p: [e[0]!, e[1]!], text: `[${fmt(e[0]!)}, ${fmt(e[1]!)}]` };
  }
  const s = String(e).trim();
  const word = s.replace(/\s*(edge|side)(\s+of\s+the\s+map)?$/i, '').replace(/^(the|map)\s+/i, '');
  const side = sideOf(word);
  if (side && !objectArea(map, s)) return { given: e, side, text: `the ${side} edge of the map` };
  const area = needArea(map, s, 'region.between');
  return { given: e, p: boxCentre(area.bounds), area, text: area.title };
}

function edgePoint(box: Bounds, side: Side, toward: Point | undefined): Point {
  const t = toward ?? boxCentre(box);
  const clampX = Math.min(box.x1, Math.max(box.x0, t[0]));
  const clampY = Math.min(box.y1, Math.max(box.y0, t[1]));
  if (side === 'north') return [clampX, box.y0];
  if (side === 'south') return [clampX, box.y1];
  if (side === 'west') return [box.x0, clampY];
  return [box.x1, clampY];
}

/** The shape a region gives as rect, poly or circle, checked like a map shape. */
function plainShape(spec: RegionSpec): Shape {
  const nums = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (spec.rect !== undefined) {
    if (!nums(spec.rect, 4) || !(spec.rect[2]! > 0) || !(spec.rect[3]! > 0)) throw new ValidationError(['region.rect: [x, y, width, height] with width and height above 0']);
    return { rect: [spec.rect[0]!, spec.rect[1]!, spec.rect[2]!, spec.rect[3]!] };
  }
  if (spec.circle !== undefined) {
    if (!nums(spec.circle, 3) || !(spec.circle[2]! > 0)) throw new ValidationError(['region.circle: [centreX, centreY, radius] with a radius above 0']);
    return { circle: [spec.circle[0]!, spec.circle[1]!, spec.circle[2]!] };
  }
  const poly = spec.poly ?? [];
  if (poly.length < 3 || !poly.every((p) => nums(p, 2))) throw new ValidationError(['region.poly: at least 3 points [[x, y], ...]']);
  return { poly: poly.map((p) => [p[0]!, p[1]!] as Point) };
}

/** A strip `width` wide from a to b (butt ends). */
function strip(a: Point, b: Point, width: number): PathsD {
  return inflatePathsD([toPath([a, b])], width / 2, JoinType.Miter, EndType.Butt, 2, PRECISION);
}

/**
 * The geometry of a region on this map. Lengths may carry units ("2 m"); the
 * reply notes say what they came to. Throws a ValidationError for a region
 * that doesn't make sense (unknown ids, two kinds at once, an empty map).
 */
export function resolveRegion(map: DelveMap, spec: RegionSpec): Region {
  if (!spec || typeof spec !== 'object') throw new ValidationError(['region: an object such as {"edge": "north"}, {"corner": "sw"}, {"in": "r2"}, {"around": "r3"} or {"between": ["east", "h1"]}']);
  const unit = parseSquareUnit(map.grid.unit);
  const notes: string[] = [];
  const len = (v: Length | undefined, fallback: number, field: string): number => {
    if (v === undefined) return fallback;
    const { squares, note } = lengthInSquares(v, unit, `region.${field}`);
    if (note) notes.push(`${field} ${note}`);
    if (!(squares > 0)) throw new ValidationError([`region.${field}: must be more than 0`]);
    return squares;
  };
  const shapes = (['rect', 'poly', 'circle'] as const).filter((k) => spec[k] !== undefined);
  const kinds = (['edge', 'corner', 'around', 'between'] as const).filter((k) => spec[k] !== undefined);
  if (kinds.length + shapes.length > 1) throw new ValidationError([`region: give one of edge, corner, around, between or a shape, not ${[...kinds, ...shapes].join(' and ')}`]);
  if (!kinds.length && !shapes.length && spec.in === undefined) throw new ValidationError(['region: give edge, corner, in, around or between, e.g. {"edge": "north", "depth": 3}, or a shape such as {"rect": [x, y, width, height]}']);
  if (spec.in !== undefined && (spec.around !== undefined || spec.between !== undefined)) throw new ValidationError(['region: in goes alone or with edge, corner or a shape']);
  const within = spec.in !== undefined ? needArea(map, String(spec.in), 'region.in') : undefined;

  if (shapes.length) {
    // a plain shape: that area (cut to the room or area given by in)
    const shape = plainShape(spec);
    const paths = polygonPaths(polygonsOf([shapePath(shape)]));
    const polygons = within ? cutTo(paths, within) : polygonsOf(paths);
    return finish('shape', polygons, `the area ${boxText(shapeBounds(shape))}${within ? ` inside ${within.title}` : ''}`, notes, within ? { within } : {});
  }

  const kind: RegionKind = kinds[0] ?? 'in';
  if (kind === 'in') {
    return finish('in', within!.polygons, `all of ${within!.title} (${boxText(within!.bounds)})`, notes, { within });
  }

  if (kind === 'edge' || kind === 'corner') {
    const box = within ? within.bounds : mapBox(map);
    if (!box) throw new ValidationError(['region: the map is still empty, so it has no edges or corners yet: draw rooms or terrain first, or give a rect']);
    const of = within ? within.title : 'the map';
    if (kind === 'edge') {
      const side = sideOf(String(spec.edge));
      if (!side) throw new ValidationError([`region.edge: north, south, east or west, got ${JSON.stringify(spec.edge)}`]);
      const depth = halfSquares(len(spec.depth, within ? Math.min(DEFAULT_DEPTH_IN, (side === 'north' || side === 'south' ? boxH(box) : boxW(box)) / 2) : DEFAULT_DEPTH_MAP, 'depth'));
      const outside = !within && (spec.outside ?? !(hasOpenGround(map) || !map.objects.some((o) => o.type === 'room')));
      const b = bandBox(box, side, depth, outside);
      const polygons = within ? cutTo(boxPath(b), within) : polygonsOf(boxPath(b));
      const where = within ? `inside ${of}, along its ${side} wall` : outside ? `just outside the map's ${side} edge (${side} of everything on it)` : `along the ${side} edge of the map`;
      return finish('edge', polygons, `a ${fmt(depth)}-square band ${where} (${boxText(b)})`, notes, within ? { within } : {});
    }
    const corner = cornerOf(String(spec.corner));
    if (!corner) throw new ValidationError([`region.corner: ne, nw, se or sw, got ${JSON.stringify(spec.corner)}`]);
    const fallback = within ? Math.max(1, Math.min(3, Math.floor(Math.min(boxW(box), boxH(box)) / 2))) : Math.max(3, Math.round(Math.min(boxW(box), boxH(box)) / 3));
    const size = halfSquares(len(spec.size, fallback, 'size'));
    const b = cornerBox(box, corner, size);
    const polygons = within ? cutTo(boxPath(b), within) : polygonsOf(boxPath(b));
    return finish('corner', polygons, `the ${CORNER_WORDS[corner]} corner of ${of}, ${fmt(boxW(b))}×${fmt(boxH(b))} squares (${boxText(b)})`, notes, within ? { within } : {});
  }

  if (kind === 'around') {
    const target = needArea(map, String(spec.around), 'region.around');
    const margin = len(spec.margin, DEFAULT_MARGIN, 'margin');
    const grown = inflatePathsD(target.paths, margin, JoinType.Miter, EndType.Polygon, 2, PRECISION);
    const ring = minus(grown, target.paths);
    return finish('around', polygonsOf(ring), `a ${fmt(margin)}-square ring around ${target.title}`, notes);
  }

  // between
  const ends = spec.between ?? [];
  if (ends.length !== 2) throw new ValidationError(['region.between: two things, e.g. ["east", "h1"] (a map edge and a hill) or ["r1", "r4"]']);
  const a = resolveEnd(map, ends[0]!);
  const b = resolveEnd(map, ends[1]!);
  if (a.side || b.side) {
    const box = mapBox(map);
    if (!box) throw new ValidationError(['region.between: the map is still empty, so it has no edges yet']);
    if (a.side) a.p = edgePoint(box, a.side, b.p);
    if (b.side) b.p = edgePoint(box, b.side, a.p);
    a.text += a.side ? ` at [${fmt(a.p![0])}, ${fmt(a.p![1])}]` : '';
    b.text += b.side ? ` at [${fmt(b.p![0])}, ${fmt(b.p![1])}]` : '';
  }
  const pa = a.p!;
  const pb = b.p!;
  if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 0.5) throw new ValidationError(['region.between: the two ends are in the same place']);
  const width = halfSquares(len(spec.width, DEFAULT_WIDTH, 'width'));
  let paths = strip(pa, pb, width);
  // a path between rooms stops at their walls rather than running over their floor
  for (const e of [a, b]) if (e.area?.object.type === 'room') paths = minus(paths, e.area.paths);
  const polygons = polygonsOf(paths);
  return finish('between', polygons, `a ${fmt(width)}-square-wide strip from ${a.text} to ${b.text}`, notes, { line: [pa, pb] });
}

/** A ring of points around a polygon, for tests and labels: the middle of a region. */
export function regionCentre(r: Region): Point {
  if (r.line) return [r2((r.line[0][0] + r.line[1][0]) / 2), r2((r.line[0][1] + r.line[1][1]) / 2)];
  const c = boxCentre(r.bounds);
  return [r2(c[0]), r2(c[1])];
}
