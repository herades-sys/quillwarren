// Watabou's Medieval Fantasy City Generator (MFCG) JSON export -> a Delve map.
// The export (v0.11) is a GeoJSON-style FeatureCollection in metres with
// y pointing north; Delve's y points south, so the map is flipped on import.
// Buildings become rooms (pulled apart a little so each keeps its walls),
// city walls become wall strips with round towers and gaps at the gates,
// and roads, water, plazas, fields and parks become terrain. The import is
// cropped to the city itself, not the whole landscape around it.
import { EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathD, type PathsD } from 'clipper2-ts';
import { PRECISION } from '../geometry/shapes.ts';
import { FORMAT, FORMAT_VERSION, type DelveMap, type MapObject, type Point } from '../schema.ts';
import { validateMap } from '../validate.ts';

export class CityImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CityImportError';
  }
}

export interface CityImportOptions {
  id: string;
  name?: string;
  seed?: number;
  /** Feet per grid square (default 10: a whole town fits on one map). 5 is true Delve scale. */
  feetPerSquare?: number;
  /** Style preset (default clean: hatching around hundreds of houses gets busy). */
  style?: string;
}

export interface CityImportResult {
  map: DelveMap;
  notes: string[];
}

type Json = Record<string, unknown>;
type Ring = [number, number][];

const METRES_PER_FOOT = 0.3048;

const isRing = (v: unknown): v is Ring => Array.isArray(v) && v.length >= 3 && v.every((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number');

/** The outer rings of a Polygon / MultiPolygon, or of every polygon in a GeometryCollection. */
function polygonsIn(g: Json | undefined): Ring[] {
  if (!g) return [];
  const c = g.coordinates as unknown;
  if (g.type === 'Polygon' && Array.isArray(c) && isRing(c[0])) return [c[0]];
  if (g.type === 'MultiPolygon' && Array.isArray(c)) return c.flatMap((poly) => (Array.isArray(poly) && isRing(poly[0]) ? [poly[0]] : []));
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) return (g.geometries as Json[]).flatMap(polygonsIn);
  return [];
}

/** LineStrings (with their width, if given) in a geometry or collection. */
function linesIn(g: Json | undefined): { points: Ring; width?: number; closed: boolean }[] {
  if (!g) return [];
  const c = g.coordinates as unknown;
  const width = typeof g.width === 'number' ? g.width : undefined;
  if (g.type === 'LineString' && Array.isArray(c) && c.length >= 2) return [{ points: c as Ring, ...(width ? { width } : {}), closed: false }];
  if (g.type === 'Polygon' && Array.isArray(c) && isRing(c[0])) return [{ points: c[0], ...(width ? { width } : {}), closed: true }];
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) return (g.geometries as Json[]).flatMap(linesIn);
  return [];
}

const toPath = (r: Ring): PathD => r.map(([x, y]) => ({ x, y }));
const area = (p: PathD) => Math.abs(p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * a.y, 0)) / 2;

function bufferLine(points: Ring, width: number, closed: boolean): PathsD {
  return inflatePathsD([toPath(points)], width / 2, JoinType.Round, closed ? EndType.Joined : EndType.Round, 2, PRECISION);
}

export function fromWatabou(input: unknown, opts: CityImportOptions): CityImportResult {
  const doc = input as { type?: unknown; features?: unknown };
  if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) {
    throw new CityImportError('this is not a Watabou city export (expected a FeatureCollection from the Medieval Fantasy City Generator)');
  }
  const features = doc.features as Json[];
  const byId = (id: string) => features.find((f) => f.id === id);
  const values = byId('values') ?? {};
  if (values.generator !== undefined && values.generator !== 'mfcg') {
    throw new CityImportError(`this export is from Watabou's "${String(values.generator)}" generator; only city exports (mfcg) are supported so far`);
  }
  const roadWidth = typeof values.roadWidth === 'number' ? values.roadWidth : 8;
  if (roadWidth < 0.01) throw new CityImportError('this export uses the old degree-based format; export it again from a current version of the generator');
  const towerRadius = typeof values.towerRadius === 'number' ? values.towerRadius : 7.6;
  const wallThickness = typeof values.wallThickness === 'number' ? values.wallThickness : 7.6;

  const buildings = polygonsIn(byId('buildings'));
  const prisms = polygonsIn(byId('prisms'));
  if (!buildings.length) throw new CityImportError('the export has no buildings');
  const squares = polygonsIn(byId('squares'));
  const walls = linesIn(byId('walls'));

  // Crop to the city: buildings, landmarks, walls and plazas, plus 30 m around.
  const pts = [...buildings, ...prisms, ...squares, ...walls.map((w) => w.points)].flat();
  const pad = 30;
  const crop = {
    x0: Math.min(...pts.map((p) => p[0])) - pad,
    y0: Math.min(...pts.map((p) => p[1])) - pad,
    x1: Math.max(...pts.map((p) => p[0])) + pad,
    y1: Math.max(...pts.map((p) => p[1])) + pad,
  };
  const cropPath: PathsD = [[{ x: crop.x0, y: crop.y0 }, { x: crop.x1, y: crop.y0 }, { x: crop.x1, y: crop.y1 }, { x: crop.x0, y: crop.y1 }]];
  const clip = (paths: PathsD): PathD[] => intersectD(paths, cropPath, FillRule.NonZero, PRECISION).filter((p) => p.length >= 3 && area(p) > 1);

  const feet = opts.feetPerSquare && opts.feetPerSquare > 0 ? opts.feetPerSquare : 10;
  const m = feet * METRES_PER_FOOT; // metres per square
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // metres (y north) -> squares (y south), origin at the crop's top-left
  const T = (x: number, y: number): Point => [r2((x - crop.x0) / m), r2((crop.y1 - y) / m)];
  const poly = (p: PathD): Point[] => {
    const out: Point[] = [];
    for (const q of p) {
      const t = T(q.x, q.y);
      const last = out.at(-1);
      if (!last || Math.hypot(t[0] - last[0], t[1] - last[1]) > 0.02) out.push(t);
    }
    return out.length >= 3 ? out : [];
  };

  const objects: MapObject[] = [];
  const counters = new Map<string, number>();
  const nextId = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}${n}`;
  };
  const addRoom = (points: Point[], name?: string) => {
    if (points.length >= 3) objects.push({ id: nextId('r'), type: 'room', shape: { poly: points }, ...(name ? { name } : {}) });
  };
  const addTerrain = (paths: PathD[], asset: string, name?: string) => {
    for (const p of paths) {
      const points = poly(p);
      if (points.length >= 3) objects.push({ id: nextId('t'), type: 'terrain', asset, shape: { poly: points }, ...(name ? { name } : {}) });
    }
  };

  // Terrain first, so it sits under everything in the object list.
  const water = polygonsIn(byId('water'));
  addTerrain(clip(water.map(toPath)), 'water-deep', 'Water');
  const rivers = linesIn(byId('rivers'));
  for (const r of rivers) addTerrain(clip(bufferLine(r.points, r.width ?? 20, false)), 'water-deep', 'River');
  addTerrain(clip(polygonsIn(byId('fields')).map(toPath)), 'dirt', 'Field');
  addTerrain(clip(polygonsIn(byId('greens')).map(toPath)), 'grass', 'Park');
  const roads = linesIn(byId('roads'));
  for (const r of roads) addTerrain(clip(bufferLine(r.points, r.width ?? roadWidth, false)), 'cobblestones', 'Road');
  addTerrain(clip(squares.map(toPath)), 'flagstones', 'Square');
  const planks = byId('planks');
  addTerrain(clip([...polygonsIn(planks).map(toPath), ...linesIn(planks).flatMap((l) => bufferLine(l.points, l.width ?? 3, l.closed))]), 'wood-planks', 'Pier');

  // Buildings: pulled in by 0.4 m so neighbours don't merge into one block.
  let houses = 0;
  for (const b of buildings) {
    const shrunk = inflatePathsD([toPath(b)], -0.4, JoinType.Miter, EndType.Polygon, 2, PRECISION);
    for (const p of clip(shrunk.length ? shrunk : [toPath(b)])) {
      const pts2 = poly(p);
      if (pts2.length >= 3) {
        addRoom(pts2);
        houses++;
      }
    }
  }
  for (const p of prisms) for (const c of clip([toPath(p)])) addRoom(poly(c), 'Landmark');

  // City and castle walls: a strip per wall side, a round tower at each corner,
  // and a gap where a road passes through a corner (a gate).
  const nearRoad = (x: number, y: number) =>
    roads.some((r) => r.points.some(([rx, ry]) => Math.hypot(rx - x, ry - y) < 1.5));
  let towers = 0;
  let gates = 0;
  for (const w of walls) {
    const ring = w.points;
    const width = w.width ?? wallThickness;
    const n = ring.length;
    const gate = ring.map(([x, y]) => nearRoad(x, y));
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      const cutA = gate[i] ? roadWidth / 2 + 2 : 0;
      const cutB = gate[(i + 1) % n] ? roadWidth / 2 + 2 : 0;
      if (cutA + cutB >= len) continue;
      const s: [number, number] = [a[0] + ux * cutA, a[1] + uy * cutA];
      const e: [number, number] = [b[0] - ux * cutB, b[1] - uy * cutB];
      const nx = -uy * (width / 2);
      const ny = ux * (width / 2);
      for (const c of clip([toPath([[s[0] + nx, s[1] + ny], [e[0] + nx, e[1] + ny], [e[0] - nx, e[1] - ny], [s[0] - nx, s[1] - ny]])])) addRoom(poly(c), 'City wall');
    }
    ring.forEach(([x, y], i) => {
      if (gate[i]) {
        gates++;
        // a gatehouse block on each side of the road, like the generator draws them
        const side = width * 1.3;
        for (const [nx2, ny2] of [ring[(i - 1 + n) % n]!, ring[(i + 1) % n]!]) {
          const len = Math.hypot(nx2 - x, ny2 - y);
          if (len < 1) continue;
          const ux = (nx2 - x) / len;
          const uy = (ny2 - y) / len;
          const d = roadWidth / 2 + side / 2 + 0.5;
          const cx = x + ux * d;
          const cy = y + uy * d;
          const h2 = side / 2;
          const corners: Ring = [
            [cx + (ux - uy) * h2, cy + (uy + ux) * h2],
            [cx + (-ux - uy) * h2, cy + (-uy + ux) * h2],
            [cx + (-ux + uy) * h2, cy + (-uy - ux) * h2],
            [cx + (ux + uy) * h2, cy + (uy - ux) * h2],
          ];
          for (const c of clip([toPath(corners)])) addRoom(poly(c), 'Gatehouse');
        }
        return;
      }
      const [cx, cy] = T(x, y);
      objects.push({ id: nextId('r'), type: 'room', shape: { circle: [cx, cy, r2(towerRadius / m)] }, name: 'Tower' });
      towers++;
    });
  }

  // Trees and district names.
  const trees = byId('trees')?.coordinates;
  let treeCount = 0;
  if (Array.isArray(trees)) {
    for (const p of trees as [number, number][]) {
      if (!Array.isArray(p) || p[0] < crop.x0 || p[0] > crop.x1 || p[1] < crop.y0 || p[1] > crop.y1) continue;
      if (treeCount >= 600) break;
      objects.push({ id: nextId('i'), type: 'prop', asset: 'tree', at: T(p[0], p[1]), scale: 0.8 });
      treeCount++;
    }
  }
  const districts = byId('districts');
  const named = Array.isArray(districts?.geometries) ? (districts!.geometries as Json[]) : [];
  for (const d of named) {
    const ring = polygonsIn(d)[0];
    if (!ring || typeof d.name !== 'string' || !d.name.trim()) continue;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    objects.push({ id: nextId('l'), type: 'label', text: d.name.trim().slice(0, 200), at: T(cx, cy), size: r2(Math.max(0.9, 12 / m)) });
  }

  const w = Math.ceil((crop.x1 - crop.x0) / m);
  const h = Math.ceil((crop.y1 - crop.y0) / m);
  objects.push({ id: nextId('i'), type: 'prop', asset: 'compass-rose', at: [w - 2, 2] });

  const map: DelveMap = {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: opts.id,
    name: (opts.name ?? 'Imported city').trim().slice(0, 200) || 'Imported city',
    grid: { type: 'square', unit: `${feet} ft` },
    style: { preset: opts.style ?? 'clean' },
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    objects,
  };
  const notes = [
    `${houses} buildings${prisms.length ? `, ${prisms.length} landmark${prisms.length === 1 ? '' : 's'}` : ''}${walls.length ? `, ${walls.length === 1 ? 'a wall' : `${walls.length} walls`} with ${towers} towers and ${gates} gate${gates === 1 ? '' : 's'}` : ''}.`,
    `Terrain: ${[roads.length && `${roads.length} road${roads.length === 1 ? '' : 's'}`, rivers.length && 'river', water.length && 'water', squares.length && 'square', polygonsIn(byId('fields')).length && 'fields', polygonsIn(byId('greens')).length && 'parks'].filter(Boolean).join(', ') || 'none'}${treeCount ? `; ${treeCount} trees` : ''}${named.length ? `; ${named.length} district names` : ''}.`,
    `Scale: 1 square = ${feet} ft, so the city is ${w} × ${h} squares. Streets inside the walls are the gaps between buildings (the export has no street shapes).`,
  ];
  return { map: validateMap(map), notes };
}
