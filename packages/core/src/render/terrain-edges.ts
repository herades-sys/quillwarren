// Terrain edges: where terrain areas meet, their outlines are ragged and one
// fades into the other across a band, instead of meeting at a straight polygon
// edge. Plain vector geometry only (no masks, no filters), so resvg draws it
// safely and fast:
//
// - Every area is still drawn whole and in map order, so what covers what is as
//   before (a pond drawn over a field is still a pond). Each area softens its
//   own outline against what lies under it there: the topmost earlier area at
//   that point of the outline, or nothing (bare floor or the background). Where
//   a later area lies over the outline, the later one does the softening.
// - Where an outline is soft, a noise field says where the area shows: all of
//   it inside, none outside, and across the fade in patches and tongues that
//   thin out evenly over its width. The field is sampled on a lattice of 0.1
//   squares along the outline only and cut with marching squares into the
//   opaque core and two soft rims around every patch, drawn see-through
//   (fill-opacity) over what lies under them. A ragged edge is the same field
//   with only a small wobble.
// - The area under a soft edge runs on under it, so no gap ever opens.
// - Of two areas fading into each other, the one with the higher stack (by
//   material: water lowest, then sand and mud, dirt and gravel, grass, snow,
//   indoor floors; or the area's own `stack`) lies on top: it forms the patches,
//   the other shows in the cracks between them. The pair of materials also
//   picks the details along the edge: a light wet shoreline with foam and
//   pebbles, grass tufts over a road with dirt specks in the grass, a few
//   patches elsewhere.
// - Near walls (the floor's outline) every edge stays as drawn, so a texture
//   never wobbles past a wall or fades through it into the next room.
// Everything is seeded (map seed + area id) and cached per terrain state, so
// redraws never shift and only terrain (or wall) edits work it out again.
import { EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathD, type PathsD } from 'clipper2-ts';
import { assetInfo } from '../assets/catalog.ts';
import { polygonsOf } from '../geometry/floor.ts';
import { terrainArea } from '../geometry/terrain.ts';
import { toPath, type Polygon, type Ring } from '../geometry/shapes.ts';
import type { Polyline } from '../geometry/walls.ts';
import { FADE_WIDTH_MAX, FADE_WIDTH_MIN, type Point, type Terrain, type TerrainEdge } from '../schema.ts';
import { hashString } from './rng.ts';

// ---------- materials: stacking, default edges, details ----------

/** What a terrain is made of, for its stack, its default edge and the details where it meets another. */
export type TerrainMaterial = 'deep' | 'water' | 'shallow' | 'ice' | 'lava' | 'wet' | 'sand' | 'earth' | 'stone' | 'green' | 'snow' | 'floor' | 'chasm';

const MATERIALS: Record<string, TerrainMaterial> = {
  // the ink tiles
  'water-deep': 'deep',
  'water-shallow': 'shallow',
  lava: 'lava',
  grass: 'green',
  moss: 'green',
  dirt: 'earth',
  mud: 'wet',
  swamp: 'wet',
  sand: 'sand',
  snow: 'snow',
  ice: 'snow',
  'cave-floor': 'stone',
  'rubble-field': 'stone',
  chasm: 'chasm',
  flagstones: 'floor',
  cobblestones: 'floor',
  'wood-planks': 'floor',
  carpet: 'floor',
  // colour ground
  'c-ground-grass-short': 'green',
  'c-ground-grass-long': 'green',
  'c-ground-meadow': 'green',
  'c-ground-grass-dry': 'green',
  'c-ground-forest-floor': 'green',
  'c-ground-pine-needles': 'green',
  'c-ground-moss': 'green',
  'c-ground-dirt': 'earth',
  'c-ground-cracked-earth': 'earth',
  'c-ground-farmland': 'earth',
  'c-ground-ash': 'earth',
  'c-ground-gravel': 'stone',
  'c-ground-rocky': 'stone',
  'c-ground-cobblestone': 'stone',
  'c-ground-paving': 'stone',
  'c-ground-mud': 'wet',
  'c-ground-swamp': 'wet',
  'c-ground-sand': 'sand',
  'c-ground-dunes': 'sand',
  'c-ground-beach-pebbles': 'sand',
  'c-ground-snow': 'snow',
  'c-ground-ice': 'snow',
  // colour water
  'c-water-deep': 'deep',
  'c-water-sea-calm': 'deep',
  'c-water-sea-choppy': 'deep',
  'c-water-sea-storm': 'deep',
  'c-water-calm': 'water',
  'c-water-river': 'water',
  'c-water-rapids': 'water',
  'c-water-pond': 'water',
  'c-water-murky': 'water',
  'c-water-flood': 'water',
  'c-water-thin-ice': 'ice',
  'c-water-shallow': 'shallow',
  'c-lava-flow': 'lava',
};

/** A terrain's material: from the table above, colour floors are floors, anything else unknown stays crisp like a floor. */
export function terrainMaterial(asset: string): TerrainMaterial {
  const m = MATERIALS[asset];
  if (m) return m;
  const info = assetInfo(asset);
  return info?.tags.includes('water') && info.category !== 'floors' ? 'water' : 'floor';
}

/** The default stack by material: the higher lies on top where two areas fade into each other. */
export const MATERIAL_STACK: Record<TerrainMaterial, number> = { chasm: 0, deep: 0, water: 1, ice: 1, lava: 1, shallow: 2, wet: 3, sand: 3, earth: 4, stone: 4, green: 5, snow: 6, floor: 7 };

/** The edge an area has unless it sets its own: indoor floors stay hard, a chasm is ragged, natural ground and water fade. */
export function defaultTerrainEdge(asset: string): TerrainEdge {
  const m = terrainMaterial(asset);
  return m === 'floor' ? 'hard' : m === 'chasm' ? 'ragged' : 'fade';
}

/** The fade width unless an area sets one, in squares. */
export const DEFAULT_FADE_WIDTH = 0.75;

/** An area's edge settings with the defaults filled in. */
export interface TerrainEdgeSettings {
  edge: TerrainEdge;
  /** The area sets its edge itself (it then wins over a neighbour's default). */
  ownEdge: boolean;
  /** Its own fade width, if it sets one. */
  fadeWidth?: number;
  details: boolean;
  stack: number;
  material: TerrainMaterial;
}

export function terrainEdgeSettings(t: Pick<Terrain, 'asset' | 'edge' | 'fadeWidth' | 'edgeDetails' | 'stack'>): TerrainEdgeSettings {
  const material = terrainMaterial(t.asset);
  return {
    edge: t.edge ?? defaultTerrainEdge(t.asset),
    ownEdge: t.edge !== undefined,
    ...(t.fadeWidth !== undefined ? { fadeWidth: Math.max(FADE_WIDTH_MIN, Math.min(FADE_WIDTH_MAX, t.fadeWidth)) } : {}),
    details: t.edgeDetails ?? true,
    stack: t.stack ?? MATERIAL_STACK[material],
    material,
  };
}

const HARDNESS: Record<TerrainEdge, number> = { hard: 0, ragged: 1, fade: 2 };

/**
 * How two areas meet (b null: the area against nothing). The same texture joins
 * without a seam (hard). An edge an area sets itself wins over a default; else
 * the harder of the two. Against nothing an area is at most ragged: no fading into paper.
 */
export function pairEdge(a: Pick<Terrain, 'asset'> & TerrainEdgeSettings, b: (Pick<Terrain, 'asset'> & TerrainEdgeSettings) | null): TerrainEdge {
  if (!b) return a.edge === 'hard' ? 'hard' : 'ragged';
  if (a.asset === b.asset) return 'hard';
  if (a.ownEdge !== b.ownEdge) return a.ownEdge ? a.edge : b.edge;
  return HARDNESS[a.edge] <= HARDNESS[b.edge] ? a.edge : b.edge;
}

/** The fade width of a pair: the wider one either area sets, else the default. */
export const pairWidth = (a: TerrainEdgeSettings, b: TerrainEdgeSettings): number => Math.max(a.fadeWidth ?? 0, b.fadeWidth ?? 0) || DEFAULT_FADE_WIDTH;

/** An area's edge in words, for MCP replies and describe_map: "fades over 0.75 squares into the terrain under it (by material)". */
export function terrainEdgeText(t: Pick<Terrain, 'asset' | 'edge' | 'fadeWidth' | 'edgeDetails' | 'stack'>): string {
  const s = terrainEdgeSettings(t);
  const how =
    s.edge === 'fade'
      ? `fades over ${Math.round((s.fadeWidth ?? DEFAULT_FADE_WIDTH) * 100) / 100} squares into the terrain under it (ragged against bare ground)`
      : s.edge === 'ragged'
        ? 'a ragged edge'
        : 'a hard edge';
  return `${how}${s.ownEdge ? '' : ' (by material)'}${t.stack !== undefined ? `, stack ${t.stack}` : ''}${s.details ? '' : ', no edge details'}`;
}

const WATERY: ReadonlySet<TerrainMaterial> = new Set(['deep', 'water', 'shallow']);
const LAND: ReadonlySet<TerrainMaterial> = new Set(['wet', 'sand', 'earth', 'stone', 'green', 'snow']);
const BARE: ReadonlySet<TerrainMaterial> = new Set(['wet', 'sand', 'earth', 'stone']);

/** The details along an edge between two materials: a shoreline, lava's crust, grass tufts over bare ground, a few patches, or none (floors, chasms, the same ground). */
export type EdgeRecipe = 'shore' | 'lava' | 'tufts' | 'patches';

export function edgeRecipe(a: TerrainMaterial, b: TerrainMaterial): EdgeRecipe | null {
  if (a === 'floor' || b === 'floor' || a === 'chasm' || b === 'chasm') return null;
  if ((WATERY.has(a) && LAND.has(b)) || (WATERY.has(b) && LAND.has(a))) return 'shore';
  if ((a === 'lava' && LAND.has(b)) || (b === 'lava' && LAND.has(a))) return 'lava';
  if ((a === 'green' && BARE.has(b)) || (b === 'green' && BARE.has(a))) return 'tufts';
  return 'patches';
}

// ---------- the colours of the details ----------

/** A colour of a detail, before a style is known: one of a texture's tones, or a fixed part (foam, pebbles, glow, crust). */
export interface Tone {
  asset: string;
  tone: 'main' | 'dark' | 'light' | 'foam' | 'stone' | 'stone-dark' | 'glow' | 'crust';
}

/** Colour textures' own tones (palette names): their ground colour, a darker and a lighter one. */
const TONES: Record<string, [string, string, string]> = {
  'c-ground-grass-short': ['leaf', 'leaf-dark', 'leaf-light'],
  'c-ground-grass-long': ['leaf-dark', 'leaf-deep', 'leaf'],
  'c-ground-meadow': ['leaf', 'leaf-dark', 'leaf-light'],
  'c-ground-grass-dry': ['straw', 'wood', 'cream'],
  'c-ground-forest-floor': ['earth', 'bark-dark', 'wood'],
  'c-ground-pine-needles': ['wood', 'bark-dark', 'wood-light'],
  'c-ground-moss': ['leaf-dark', 'leaf-deep', 'moss'],
  'c-ground-dirt': ['wood', 'bark', 'wood-light'],
  'c-ground-cracked-earth': ['bark', 'bark-dark', 'wood'],
  'c-ground-farmland': ['earth', 'bark', 'wood'],
  'c-ground-ash': ['stone-dark', 'black', 'stone'],
  'c-ground-gravel': ['stone', 'stone-dark', 'stone-light'],
  'c-ground-rocky': ['earth', 'stone-dark', 'stone-light'],
  'c-ground-cobblestone': ['stone-dark', 'black', 'stone-light'],
  'c-ground-paving': ['earth', 'stone-dark', 'stone-pale'],
  'c-ground-mud': ['earth', 'bark-dark', 'wood'],
  'c-ground-swamp': ['moss', 'leaf-dark', 'leaf-light'],
  'c-ground-sand': ['sand', 'wood-light', 'cream'],
  'c-ground-dunes': ['sand', 'wood-light', 'cream'],
  'c-ground-beach-pebbles': ['sand', 'stone', 'cream'],
  'c-ground-snow': ['snow', 'ice', 'paper'],
  'c-ground-ice': ['ice', 'water-light', 'snow'],
  'c-water-deep': ['water-deep', 'blue', 'water'],
  'c-water-sea-calm': ['water', 'water-deep', 'water-light'],
  'c-water-sea-choppy': ['water-deep', 'blue', 'water-light'],
  'c-water-sea-storm': ['water-deep', 'blue', 'water-light'],
  'c-water-calm': ['water', 'water-deep', 'water-light'],
  'c-water-river': ['water', 'water-deep', 'water-light'],
  'c-water-rapids': ['water', 'water-deep', 'snow'],
  'c-water-pond': ['water-deep', 'leaf-dark', 'water'],
  'c-water-murky': ['needle-dark', 'leaf-deep', 'needle-light'],
  'c-water-flood': ['wood', 'bark-dark', 'cream'],
  'c-water-thin-ice': ['ice', 'water', 'snow'],
  'c-water-shallow': ['water-light', 'water', 'ice'],
  'c-lava-flow': ['flame', 'ember', 'flame-core'],
};

/** The fixed parts in palette names (colour textures); ink tiles take them from the style's inks. */
const FIXED: Record<Exclude<Tone['tone'], 'main' | 'dark' | 'light'>, string> = { foam: 'snow', stone: 'stone-light', 'stone-dark': 'stone-dark', glow: 'flame-core', crust: 'black' };

/** A colour texture's tone as a palette name (null for ink tiles: their tones come from the tint and the style). */
export function tonePaletteName(t: Tone): string | null {
  if (assetInfo(t.asset)?.palette !== 'colour') return null;
  if (t.tone === 'main' || t.tone === 'dark' || t.tone === 'light') return (TONES[t.asset] ?? ['stone', 'stone-dark', 'stone-light'])[t.tone === 'main' ? 0 : t.tone === 'dark' ? 1 : 2];
  return FIXED[t.tone];
}

// ---------- the result ----------

/** One kind of detail of one area, in one colour: filled shapes (maybe outlined), strokes or dots. */
export type EdgeDetail =
  | { kind: 'fill'; tone: Tone; alpha: number; polygons: Polygon[]; outline?: { tone: Tone; width: number } }
  | { kind: 'stroke'; tone: Tone; alpha: number; width: number; lines: Polyline[] }
  | { kind: 'dots'; tone: Tone; alpha: number; radius: number; points: Point[] };

export interface AreaEdges {
  /** What is drawn opaque: null when the area draws exactly as before (no soft edge of its own and nothing fading over it). */
  core: Polygon[] | null;
  /** The soft rims around the core's patches, each drawn see-through with its alpha (the same texture over itself, so they add up). */
  fades: { alpha: number; polygons: Polygon[] }[];
  details: EdgeDetail[];
}

export interface TerrainEdges {
  /** By terrain id. */
  areas: Map<string, AreaEdges>;
}

// ---------- noise ----------

/** A lattice value in [-1, 1]. */
function lattice(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ Math.imul(x | 0, 0x27d4eb2d), 0x165667b1) ^ Math.imul(y | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth value noise in [-1, 1]. */
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, ix, iy);
  const b = lattice(seed, ix + 1, iy);
  const c = lattice(seed, ix, iy + 1);
  const d = lattice(seed, ix + 1, iy + 1);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

/** A ragged edge: swells about a square long, smaller bumps and a little grit. */
const raggedNoise = (x: number, y: number, seed: number): number => 0.5 * noise(x * 0.9, y * 0.9, seed) + 0.32 * noise(x * 2.2, y * 2.2, seed + 1) + 0.18 * noise(x * 5, y * 5, seed + 2);

/**
 * A fade: long tongues, rounded patches ("billows": broad where the noise is
 * high, thin cracks where it is low) and some grit, tongues and patches larger
 * for wider fades. The area on top forms the patches; the one under it shows in
 * the cracks. Spread out to about evenly from -1 to 1 (the mix itself mostly
 * stays near 0), so the patches thin out evenly over the whole width.
 */
function fadeNoise(x: number, y: number, seed: number, width: number): number {
  const ft = 1 / (0.5 + 0.5 * width);
  const fp = 2.5 / (1 + 0.12 * width);
  const billow = (2 * Math.abs(noise(x * fp, y * fp, seed + 3)) - 0.7) / 1.3;
  return Math.tanh(3.5 * (0.35 * noise(x * ft, y * ft, seed + 4) + 0.45 * billow + 0.2 * noise(x * 5.5, y * 5.5, seed + 5)));
}

// ---------- constants ----------

/** The lattice the soft edges are sampled on, in squares (7 px at Roll20's 70 per square). */
const H = 0.1;
/** Cells per block side: the lattice is only sampled in blocks near soft edges. */
const B = 8;
/** Outline points at most this far apart. */
const STEP = 0.2;
/** How far a ragged edge wanders, in squares. */
const RAGGED = 0.14;
/**
 * The levels a soft edge is cut into: a soft rim around every patch (drawn
 * see-through, `off` squares out from the opaque edge) and the opaque core last.
 * Alone the outer rim shows 30 % of the area, with the inner one 65 %.
 */
const LEVELS = [
  { off: 0.11, alpha: 0.3 },
  { off: 0.05, alpha: 0.5 },
  { off: 0, alpha: 1 },
] as const;
/** Within this far of a wall every edge stays as drawn; full softness from WALL_CLEAR + WALL_RAMP on. */
const WALL_CLEAR = 0.12;
const WALL_RAMP = 0.45;
/** Bits of a level smaller than this (square squares) are left out. */
const MIN_AREA = 0.003;
/** Contours are simplified to within this, in squares. */
const SIMPLIFY = 0.012;

/** The noise amplitude of a fade of this width: the patches thin out across the width. */
const fadeAmp = (width: number): number => 1.05 * (width / 2) + 0.04;
/** How much wider the see-through rims are for a fade half `hw` wide (1 up to the default fade). */
const rimScale = (hw: number): number => 1 + 0.6 * Math.max(0, hw - DEFAULT_FADE_WIDTH / 2);
/** How far past the outline an edge's patches (and their rims) may reach. */
const reachOf = (p: { amp: number; hw: number }): number => p.amp * 1.05 + LEVELS[0].off * rimScale(p.hw) + 2.5 * H;

// ---------- areas and their outlines ----------

interface Area {
  index: number;
  t: Terrain;
  s: TerrainEdgeSettings;
  seed: number;
  paths: PathsD;
  polys: Polygon[];
  rings: Ring[];
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** One point of an area's outline: where it is, its outward normal, what lies under it there, and how soft the edge is. */
interface OutlinePoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  /** The area under it here (its index), -1 nothing, -2 a later area lies over the outline here. */
  below: number;
  /** Half the fade's width (0: no fade), the noise amplitude (0: hard), and +1 / -1: this area lies on top / under. */
  hw: number;
  amp: number;
  sign: number;
  /** The fade width this point's noise is shaped for. */
  width: number;
  /** Details here (only on soft edges against another area). */
  recipe: EdgeRecipe | null;
}

const ringArea = (r: readonly Point[]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

function inRings(rings: readonly Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Segments in a grid of 1-square cells, for nearest-distance queries. */
class SegmentGrid {
  private cells = new Map<number, number[]>();
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly bx: Float64Array;
  readonly by: Float64Array;
  constructor(ax: Float64Array, ay: Float64Array, bx: Float64Array, by: Float64Array) {
    this.ax = ax;
    this.ay = ay;
    this.bx = bx;
    this.by = by;
    for (let i = 0; i < ax.length; i++) {
      const x0 = Math.floor(Math.min(ax[i]!, bx[i]!));
      const x1 = Math.floor(Math.max(ax[i]!, bx[i]!));
      const y0 = Math.floor(Math.min(ay[i]!, by[i]!));
      const y1 = Math.floor(Math.max(ay[i]!, by[i]!));
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const k = cellKey(cx, cy);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }
  /** The segments in the cells that touch the box. */
  near(x0: number, y0: number, x1: number, y1: number): number[] {
    const out = new Set<number>();
    for (let cx = Math.floor(x0); cx <= Math.floor(x1); cx++)
      for (let cy = Math.floor(y0); cy <= Math.floor(y1); cy++) for (const i of this.cells.get(cellKey(cx, cy)) ?? []) out.add(i);
    return [...out];
  }
  /** The distance from (x, y) to the nearest segment, up to `max`. */
  distance(x: number, y: number, max: number): number {
    let best = max * max;
    for (const i of this.near(x - max, y - max, x + max, y + max)) {
      const d = segDist2(x, y, this.ax[i]!, this.ay[i]!, this.bx[i]!, this.by[i]!);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
}

const cellKey = (cx: number, cy: number): number => (cx + 0x8000) * 0x10000 + (cy + 0x8000);

function segDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - x;
  const ey = ay + dy * t - y;
  return ex * ex + ey * ey;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The outline of an area cut into short steps, each point with its outward normal (holes' too). */
function outlineOf(area: Area): { points: OutlinePoint[]; closed: true }[] {
  const out: { points: OutlinePoint[]; closed: true }[] = [];
  for (const poly of area.polys) {
    for (const [k, ring] of [poly.outer, ...poly.holes].entries()) {
      if (ring.length < 3) continue;
      // a ring of positive area has its inside at (-ty, tx) of each edge's direction (tx, ty);
      // outward from the area is away from an outer ring's inside and into a hole's
      const away = (k === 0) === ringArea(ring) > 0;
      const pts: OutlinePoint[] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-9) continue;
        const steps = Math.max(1, Math.ceil(len / STEP));
        const tx = (b[0] - a[0]) / len;
        const ty = (b[1] - a[1]) / len;
        const nx = away ? ty : -ty;
        const ny = away ? -tx : tx;
        for (let s = 0; s < steps; s++) {
          pts.push({ x: a[0] + ((b[0] - a[0]) * s) / steps, y: a[1] + ((b[1] - a[1]) * s) / steps, nx, ny, below: -1, hw: 0, amp: 0, sign: 1, width: DEFAULT_FADE_WIDTH, recipe: null });
        }
      }
      // corners: the normal halfway between the two edges'
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const prev = pts[(i - 1 + pts.length) % pts.length]!;
        if (prev.nx === p.nx && prev.ny === p.ny) continue;
        const mx = prev.nx + p.nx;
        const my = prev.ny + p.ny;
        const ml = Math.hypot(mx, my);
        if (ml > 1e-6) pts[i] = { ...p, nx: mx / ml, ny: my / ml };
      }
      if (pts.length >= 3) out.push({ points: pts, closed: true });
    }
  }
  return out;
}

// ---------- the soft edges of one area ----------

interface FieldResult {
  /** Rings of each level (LEVELS order), in squares. */
  levels: Ring[][];
}

/**
 * Sample the area's field near its outline and cut it into the levels. The
 * field at p is -s(p) (s: signed distance to the outline, < 0 inside) plus the
 * nearest outline point's noise, shifted out a little for the see-through rims.
 */
function softLevels(area: Area, outline: { points: OutlinePoint[] }[]): FieldResult {
  // the outline's segments, each with the values of its two ends
  const segs: { a: OutlinePoint; b: OutlinePoint }[] = [];
  for (const ring of outline) for (let i = 0; i < ring.points.length; i++) segs.push({ a: ring.points[i]!, b: ring.points[(i + 1) % ring.points.length]! });
  const n = segs.length;
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  const reach = new Float64Array(n);
  let maxReach = 0;
  segs.forEach((s, i) => {
    ax[i] = s.a.x;
    ay[i] = s.a.y;
    bx[i] = s.b.x;
    by[i] = s.b.y;
    const r = Math.max(reachOf(s.a), reachOf(s.b));
    reach[i] = r;
    if (r > maxReach) maxReach = r;
  });
  const grid = new SegmentGrid(ax, ay, bx, by);

  // the blocks of the lattice within reach of the outline
  const BS = B * H;
  const blocks = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = reach[i]!;
    const x0 = Math.floor((Math.min(ax[i]!, bx[i]!) - r) / BS);
    const x1 = Math.floor((Math.max(ax[i]!, bx[i]!) + r) / BS);
    const y0 = Math.floor((Math.min(ay[i]!, by[i]!) - r) / BS);
    const y1 = Math.floor((Math.max(ay[i]!, by[i]!) + r) / BS);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) blocks.add(cellKey(x, y));
  }

  // inside or not, row by row: where the area's rings cross each lattice row
  const rows = new Map<number, Float64Array>();
  const crossings = (j: number): Float64Array => {
    let row = rows.get(j);
    if (row) return row;
    const y = j * H;
    const xs: number[] = [];
    for (const ring of area.rings) {
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xi, yi] = ring[i]!;
        const [xk, yk] = ring[k]!;
        if (yi > y !== yk > y) xs.push(((xk - xi) * (y - yi)) / (yk - yi) + xi);
      }
    }
    row = Float64Array.from(xs).sort();
    rows.set(j, row);
    return row;
  };
  const inside = (row: Float64Array, x: number): boolean => {
    let lo = 0;
    let hi = row.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return (lo & 1) === 1;
  };

  const K = LEVELS.length;
  const next: Map<number, number>[] = LEVELS.map(() => new Map());
  const at: Map<number, Point>[] = LEVELS.map(() => new Map());
  const S = B + 1;
  const vals: Float64Array[] = LEVELS.map(() => new Float64Array(S * S));
  const BIG = 1e3;

  for (const key of blocks) {
    const bi = Math.floor(key / 0x10000) - 0x8000;
    const bj = (key % 0x10000) - 0x8000;
    const i0 = bi * B;
    const j0 = bj * B;
    // the segments in reach of the block, nearest first by how near they can come: a sample stops looking
    // once the rest can't come nearer than the nearest found so far
    const bx0 = i0 * H;
    const by0 = j0 * H;
    const bx1 = (i0 + B) * H;
    const by1 = (j0 + B) * H;
    const near: [number, number][] = [];
    let blockReach = 0;
    for (const s of grid.near(bx0 - maxReach, by0 - maxReach, bx1 + maxReach, by1 + maxReach)) {
      const gx = Math.max(0, Math.min(ax[s]!, bx[s]!) - bx1, bx0 - Math.max(ax[s]!, bx[s]!));
      const gy = Math.max(0, Math.min(ay[s]!, by[s]!) - by1, by0 - Math.max(ay[s]!, by[s]!));
      const lb = gx * gx + gy * gy;
      if (lb < reach[s]! * reach[s]!) {
        near.push([lb, s]);
        if (reach[s]! > blockReach) blockReach = reach[s]!;
      }
    }
    near.sort((p, q) => p[0] - q[0]);
    const cand = Int32Array.from(near, (p) => p[1]);
    const bound = Float64Array.from(near, (p) => p[0]);
    // the field at every lattice point of the block (shared edges are worked out the same way by both blocks)
    for (let v = 0; v <= B; v++) {
      const j = j0 + v;
      const y = j * H;
      const row = crossings(j);
      for (let u = 0; u <= B; u++) {
        const i = i0 + u;
        const x = i * H;
        // farther from the outline than any edge here reaches: plainly inside or outside
        let best = blockReach * blockReach;
        let bs = -1;
        let bt = 0;
        for (let c = 0; c < cand.length; c++) {
          if (bound[c]! >= best) break;
          const s = cand[c]!;
          const dx = bx[s]! - ax[s]!;
          const dy = by[s]! - ay[s]!;
          const l2 = dx * dx + dy * dy;
          let t = l2 > 0 ? ((x - ax[s]!) * dx + (y - ay[s]!) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax[s]! + dx * t - x;
          const ey = ay[s]! + dy * t - y;
          const d2 = ex * ex + ey * ey;
          if (d2 < best) {
            best = d2;
            bs = s;
            bt = t;
          }
        }
        const isIn = inside(row, x);
        const o = v * S + u;
        if (bs < 0) {
          for (let k = 0; k < K; k++) vals[k]![o] = isIn ? BIG : -BIG;
          continue;
        }
        const seg = segs[bs]!;
        const d = Math.sqrt(best);
        const hw = seg.a.hw + (seg.b.hw - seg.a.hw) * bt;
        const amp = seg.a.amp + (seg.b.amp - seg.a.amp) * bt;
        const sign = seg.a.sign + (seg.b.sign - seg.a.sign) * bt;
        const width = seg.a.width + (seg.b.width - seg.a.width) * bt;
        let base = isIn ? d : -d;
        let soft = 0;
        if (amp > 0) {
          // ragged wobble where there is no band, the fade's tongues and patches where there is
          const f = smoothstep(hw / 0.15);
          const nz = (f < 1 ? (1 - f) * raggedNoise(x, y, area.seed) : 0) + (f > 0 ? f * fadeNoise(x, y, area.seed, width) : 0);
          base += sign * amp * nz;
          // the rims widen with the fade, so a long fade is softer as well as patchier
          soft = smoothstep(amp / 0.05) * rimScale(hw);
        }
        // the rims a little irregular (and each its own way), so they read as a soft brush, not an outline
        const grit = soft > 0 ? 0.025 * noise(x * 6, y * 6, area.seed + 11) : 0;
        for (let k = 0; k < K; k++) vals[k]![o] = base + (LEVELS[k]!.off + (k === K - 1 ? 0 : k === 0 ? grit : -0.7 * grit)) * soft;
      }
    }
    for (let k = 0; k < K; k++) marchBlock(vals[k]!, i0, j0, next[k]!, at[k]!);
  }
  return { levels: LEVELS.map((_, k) => traceRings(next[k]!, at[k]!)) };
}

// ---------- marching squares ----------

const OFF = 1 << 20;
const SPAN = 1 << 21;
/** A lattice edge: from (i, j) right (vertical false) or down (vertical true). */
const edgeKey = (i: number, j: number, vertical: boolean): number => ((i + OFF) * SPAN + (j + OFF)) * 2 + (vertical ? 1 : 0);

/**
 * One block's contour pieces at value 0: each runs from where the boundary
 * walk around a cell leaves the area to where it comes back, so every ring
 * has the area on the same side. Crossings are worked out per lattice edge,
 * the same way from both cells that share it.
 */
function marchBlock(v: Float64Array, i0: number, j0: number, next: Map<number, number>, at: Map<number, Point>): void {
  const S = B + 1;
  const cross = (key: number, i: number, j: number, vertical: boolean, va: number, vb: number): void => {
    if (at.has(key)) return;
    const t = va / (va - vb);
    at.set(key, vertical ? [i * H, (j + t) * H] : [(i + t) * H, j * H]);
  };
  const keys = [0, 0, 0, 0];
  const exits = [false, false, false, false];
  for (let v0 = 0; v0 < B; v0++) {
    for (let u0 = 0; u0 < B; u0++) {
      const c0 = v[v0 * S + u0]!;
      const c1 = v[v0 * S + u0 + 1]!;
      const c2 = v[(v0 + 1) * S + u0 + 1]!;
      const c3 = v[(v0 + 1) * S + u0]!;
      const in0 = c0 >= 0;
      const in1 = c1 >= 0;
      const in2 = c2 >= 0;
      const in3 = c3 >= 0;
      if (in0 === in1 && in1 === in2 && in2 === in3) continue;
      const i = i0 + u0;
      const j = j0 + v0;
      // walk the cell's corners c0 (i, j) → c1 (i+1, j) → c2 (i+1, j+1) → c3 (i, j+1)
      let m = 0;
      if (in0 !== in1) {
        const key = edgeKey(i, j, false);
        cross(key, i, j, false, c0, c1);
        keys[m] = key;
        exits[m++] = in0;
      }
      if (in1 !== in2) {
        const key = edgeKey(i + 1, j, true);
        cross(key, i + 1, j, true, c1, c2);
        keys[m] = key;
        exits[m++] = in1;
      }
      if (in2 !== in3) {
        const key = edgeKey(i, j + 1, false);
        cross(key, i, j + 1, false, c3, c2);
        keys[m] = key;
        exits[m++] = in2;
      }
      if (in3 !== in0) {
        const key = edgeKey(i, j, true);
        cross(key, i, j, true, c0, c3);
        keys[m] = key;
        exits[m++] = in3;
      }
      if (m === 2) {
        if (exits[0]) next.set(keys[0]!, keys[1]!);
        else next.set(keys[1]!, keys[0]!);
      } else if (m === 4) {
        // a saddle: the middle decides whether the two inside corners join
        const joined = c0 + c1 + c2 + c3 >= 0;
        for (let q = 0; q < 4; q++) if (exits[q]) next.set(keys[q]!, keys[(q + (joined ? 1 : 3)) % 4]!);
      }
    }
  }
}

/** Join the contour pieces into closed rings (pieces that run off the sampled blocks are left out: there are none by construction). */
function traceRings(next: Map<number, number>, at: Map<number, Point>): Ring[] {
  const rings: Ring[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Ring = [];
    let k: number | undefined = start;
    let closed = false;
    while (k !== undefined && !seen.has(k)) {
      seen.add(k);
      ring.push(at.get(k)!);
      k = next.get(k);
      if (k === start) closed = true;
    }
    if (closed && ring.length >= 3) {
      const r = simplifyRing(ring, SIMPLIFY);
      if (r.length >= 3 && Math.abs(ringArea(r)) >= MIN_AREA) rings.push(r);
    }
  }
  return rings;
}

/** Douglas–Peucker on a closed ring. */
function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length < 8) return ring;
  // split at the point farthest from the first, simplify both halves
  let far = 0;
  let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]![0] - ring[0]![0]) ** 2 + (ring[i]![1] - ring[0]![1]) ** 2;
    if (d > fd) [far, fd] = [i, d];
  }
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[far] = 1;
  const t2 = tol * tol;
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = ring[a]!;
    const pb = ring[b % ring.length]!;
    let best = -1;
    let bd = t2;
    for (let i = a + 1; i < b; i++) {
      const p = ring[i]!;
      const d = segDist2(p[0], p[1], pa[0], pa[1], pb[0], pb[1]);
      if (d > bd) [best, bd] = [i, d];
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

// ---------- details along the soft edges ----------

/** A small seeded random source per spot: the same spot gives the same detail whatever else changes. */
function spotRandom(seed: number, x: number, y: number, salt: number): () => number {
  let s = (Math.imul(seed ^ Math.imul(Math.round(x * 50), 0x27d4eb2d), 0x165667b1) ^ Math.imul(Math.round(y * 50), 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run {
  below: number;
  recipe: EdgeRecipe;
  points: OutlinePoint[];
}

/** Stretches of an outline with one area under them and details on. */
function detailRuns(outline: { points: OutlinePoint[] }[]): Run[] {
  const runs: Run[] = [];
  for (const ring of outline) {
    const pts = ring.points;
    const on = (p: OutlinePoint) => p.recipe !== null && p.amp > 0.02;
    // start where a run begins, so one running across the ring's start isn't split
    let start = pts.findIndex((p, i) => {
      const q = pts[(i - 1 + pts.length) % pts.length]!;
      return on(p) && (!on(q) || q.below !== p.below);
    });
    if (start < 0) {
      if (pts.every(on) && pts.every((p) => p.below === pts[0]!.below)) runs.push({ below: pts[0]!.below, recipe: pts[0]!.recipe!, points: [...pts, pts[0]!] });
      continue;
    }
    let run: Run | null = null;
    for (let k = 0; k <= pts.length; k++) {
      const p = pts[(start + k) % pts.length]!;
      if (on(p) && run && run.below === p.below) run.points.push(p);
      else {
        if (run && run.points.length > 1) runs.push(run);
        run = on(p) ? { below: p.below, recipe: p.recipe!, points: [p] } : null;
      }
    }
    if (run && run.points.length > 1) runs.push(run);
  }
  return runs;
}

/** A point along a run at arclength `l`: position, outward normal, the visible edge's offset, and the values there. */
function along(run: Run, cum: Float64Array, l: number, seed: number): { x: number; y: number; nx: number; ny: number; tx: number; ty: number; p: OutlinePoint; edge: number } {
  let k = 0;
  while (k < cum.length - 2 && cum[k + 1]! < l) k++;
  const a = run.points[k]!;
  const b = run.points[k + 1]!;
  const seg = cum[k + 1]! - cum[k]!;
  const t = seg > 0 ? (l - cum[k]!) / seg : 0;
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const tx = (b.x - a.x) / len;
  const ty = (b.y - a.y) / len;
  // where the edge runs: a ragged outline as the field moves it; a fade's patches come and go,
  // so along a fade the details follow only its long swells, a little off the drawn outline
  const f = smoothstep(a.hw / 0.15);
  const edge = (1 - f) * a.amp * raggedNoise(x, y, seed) + f * Math.min(a.amp, 0.3) * noise(x * 0.8, y * 0.8, seed + 4);
  return { x, y, nx: a.nx, ny: a.ny, tx, ty, p: a, edge: a.sign * edge };
}

/** A small rounded blob of `n` points around (x, y). */
function blob(x: number, y: number, r: number, rand: () => number, stretch = 1, angle = 0): Ring {
  const n = 7;
  const out: Ring = [];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.75 + 0.5 * rand());
    const px = Math.cos(a) * rr * stretch;
    const py = Math.sin(a) * rr;
    out.push([x + px * ca - py * sa, y + px * sa + py * ca]);
  }
  return out;
}

/** Collects one area's details, merged by kind and colour. */
class DetailSink {
  private fills = new Map<string, { tone: Tone; alpha: number; rings: Ring[]; outline?: { tone: Tone; width: number } }>();
  private strokes = new Map<string, { tone: Tone; alpha: number; width: number; lines: Polyline[] }>();
  private dots = new Map<string, { tone: Tone; alpha: number; radius: number; points: Point[] }>();
  fill(tone: Tone, alpha: number, ring: Ring, outline?: { tone: Tone; width: number }): void {
    const k = `${tone.asset}|${tone.tone}|${alpha}|${outline ? `${outline.tone.asset}|${outline.tone.tone}|${outline.width}` : ''}`;
    const f = this.fills.get(k);
    if (f) f.rings.push(ring);
    else this.fills.set(k, { tone, alpha, rings: [ring], ...(outline ? { outline } : {}) });
  }
  stroke(tone: Tone, alpha: number, width: number, line: Point[]): void {
    if (line.length < 2) return;
    const k = `${tone.asset}|${tone.tone}|${alpha}|${width}`;
    const s = this.strokes.get(k);
    if (s) s.lines.push({ points: line, closed: false });
    else this.strokes.set(k, { tone, alpha, width, lines: [{ points: line, closed: false }] });
  }
  dot(tone: Tone, alpha: number, radius: number, p: Point): void {
    const k = `${tone.asset}|${tone.tone}|${alpha}|${radius}`;
    const d = this.dots.get(k);
    if (d) d.points.push(p);
    else this.dots.set(k, { tone, alpha, radius, points: [p] });
  }
  done(): EdgeDetail[] {
    const out: EdgeDetail[] = [];
    // filled bits are merged, so overlapping ones neither cancel out (even-odd) nor darken twice
    for (const f of this.fills.values()) {
      const polygons = polygonsOf(f.rings.map((r) => toPath(ringArea(r) < 0 ? [...r].reverse() : r)));
      if (polygons.length) out.push({ kind: 'fill', tone: f.tone, alpha: f.alpha, polygons, ...(f.outline ? { outline: f.outline } : {}) });
    }
    for (const s of this.strokes.values()) out.push({ kind: 'stroke', tone: s.tone, alpha: s.alpha, width: s.width, lines: s.lines });
    for (const d of this.dots.values()) out.push({ kind: 'dots', tone: d.tone, alpha: d.alpha, radius: d.radius, points: d.points });
    return out;
  }
}

/** Details for one run: V is the area whose outline it is, E the one under it. */
function runDetails(run: Run, v: Area, e: Area, sink: DetailSink, isLater: (x: number, y: number) => boolean): void {
  const cum = new Float64Array(run.points.length);
  for (let i = 1; i < run.points.length; i++) cum[i] = cum[i - 1]! + Math.hypot(run.points[i]!.x - run.points[i - 1]!.x, run.points[i]!.y - run.points[i - 1]!.y);
  const total = cum[cum.length - 1]!;
  if (total < 0.3) return;
  const salt = (v.seed ^ Math.imul(e.seed, 31)) >>> 0;
  const mv = v.s.material;
  const me = e.s.material;
  // which way (along the outward normal: +1 into E, -1 into V) the material in question lies
  const sideOf = (pick: (m: TerrainMaterial) => boolean): number => (pick(mv) ? -1 : 1);
  const toneOf = (a: Area, tone: Tone['tone']): Tone => ({ asset: a.t.asset, tone });
  const pt = (q: { x: number; y: number; nx: number; ny: number; tx: number; ty: number; edge: number }, off: number, side = 0): Point => [q.x + q.nx * (q.edge + off) + q.tx * side, q.y + q.ny * (q.edge + off) + q.ty * side];
  const keep = (p: Point) => !isLater(p[0], p[1]);

  if (run.recipe === 'shore' || run.recipe === 'lava') {
    const lava = run.recipe === 'lava';
    const wSide = lava ? sideOf((m) => m === 'lava') : sideOf((m) => WATERY.has(m));
    const water = wSide < 0 ? v : e;
    const land = wSide < 0 ? e : v;
    // the wet band (lava: its dark crust on the land side) and the foam line (lava: its glow), in broken stretches
    const band: Point[][] = [];
    const foam: Point[][] = [];
    let cur: { inner: Point[]; outer: Point[] } | null = null;
    let line: Point[] | null = null;
    for (let l = 0; l <= total; l += 0.12) {
      const q = along(run, cum, l, v.seed);
      const r = spotRandom(salt, q.x, q.y, 1);
      const gap = noise(q.x * 1.3, q.y * 1.3, salt) < -0.35;
      if (!gap) {
        const w = (lava ? 0.07 : 0.1) + 0.08 * (0.5 + 0.5 * noise(q.x * 2.4, q.y * 2.4, salt + 1));
        const near = pt(q, (lava ? -wSide : wSide) * 0.01);
        const far = pt(q, (lava ? -wSide : wSide) * w);
        if (keep(near)) {
          cur ??= { inner: [], outer: [] };
          cur.inner.push(near);
          cur.outer.push(far);
        } else if (cur) band.push([...cur.inner, ...cur.outer.reverse()]), (cur = null);
      } else if (cur) band.push([...cur.inner, ...cur.outer.reverse()]), (cur = null);
      // a wide, gradual shore has no clear waterline: fewer and shorter bits of foam
      const dash = noise(q.x * 2.2, q.y * 2.2, salt + 2) > -0.1 + 0.45 * smoothstep(q.p.hw - 0.4);
      const fp = pt(q, wSide * (0.07 + 0.03 * noise(q.x * 4, q.y * 4, salt + 3)) + (r() - 0.5) * 0.01);
      if (dash && keep(fp)) (line ??= []).push(fp);
      else if (line) foam.push(line), (line = null);
    }
    if (cur && cur.inner.length > 1) band.push([...cur.inner, ...cur.outer.reverse()]);
    if (line) foam.push(line);
    for (const ring of band) if (ring.length >= 4) sink.fill(lava ? toneOf(land, 'crust') : toneOf(water, 'light'), lava ? 0.45 : 0.55, ring);
    for (const l of foam) sink.stroke(toneOf(water, lava ? 'glow' : 'foam'), 0.8, lava ? 0.03 : 0.028, l);
    if (lava) return;
    // pebbles on the land side, in little clusters
    for (let l = 0.2; l < total; ) {
      const q = along(run, cum, l, v.seed);
      const r = spotRandom(salt, q.x, q.y, 2);
      const count = 1 + Math.floor(r() * 3);
      for (let c = 0; c < count; c++) {
        const p = pt(q, -wSide * (0.06 + r() * 0.24), (r() - 0.5) * 0.35);
        if (!keep(p)) continue;
        const rad = 0.03 + r() * 0.035;
        sink.fill(toneOf(land, 'stone'), 1, blob(p[0], p[1], rad, r, 1.3, r() * Math.PI), { tone: toneOf(land, 'stone-dark'), width: 0.012 });
      }
      l += 0.5 + r() * 1.1;
    }
    return;
  }

  if (run.recipe === 'tufts') {
    const gSide = sideOf((m) => m === 'green');
    const green = gSide < 0 ? v : e;
    const bare = gSide < 0 ? e : v;
    // tufts of blades from the grass's edge, leaning out over the bare ground
    for (let l = 0.1; l < total; ) {
      const q = along(run, cum, l, v.seed);
      const r = spotRandom(salt, q.x, q.y, 3);
      const root = pt(q, -gSide * (r() * 0.08), (r() - 0.5) * 0.1);
      if (keep(root)) {
        const blades = 3 + Math.floor(r() * 3);
        // pointing out of the grass: along -gSide·n, fanned
        const base = Math.atan2(-gSide * q.ny, -gSide * q.nx);
        for (let b = 0; b < blades; b++) {
          const ang = base + (b / (blades - 1) - 0.5) * 1.6 + (r() - 0.5) * 0.4;
          const len = 0.08 + r() * 0.09;
          const sx = root[0] + (r() - 0.5) * 0.05;
          const sy = root[1] + (r() - 0.5) * 0.05;
          sink.stroke(toneOf(green, b % 2 ? 'dark' : 'main'), 0.95, 0.022, [
            [sx, sy],
            [sx + Math.cos(ang) * len * 0.55 + (r() - 0.5) * 0.02, sy + Math.sin(ang) * len * 0.55 + (r() - 0.5) * 0.02],
            [sx + Math.cos(ang) * len, sy + Math.sin(ang) * len],
          ]);
        }
      }
      l += 0.22 + r() * 0.45;
    }
    // specks of the bare ground spilt into the grass
    for (let l = 0.05; l < total; ) {
      const q = along(run, cum, l, v.seed);
      const r = spotRandom(salt, q.x, q.y, 4);
      const p = pt(q, gSide * (0.04 + r() ** 1.6 * 0.45), (r() - 0.5) * 0.2);
      if (keep(p)) sink.dot(toneOf(bare, r() < 0.5 ? 'main' : 'dark'), 0.85, r() < 0.6 ? 0.018 : 0.03, p);
      l += 0.1 + r() * 0.22;
    }
    return;
  }

  // patches: a few blobs of each ground on the other side of the edge
  for (let l = 0.3; l < total; ) {
    const q = along(run, cum, l, v.seed);
    const r = spotRandom(salt, q.x, q.y, 5);
    const into = r() < 0.5 ? 1 : -1;
    const p = pt(q, into * (0.08 + r() * 0.3), (r() - 0.5) * 0.3);
    if (keep(p)) sink.fill(toneOf(into > 0 ? v : e, 'main'), 0.7, blob(p[0], p[1], 0.05 + r() * 0.1, r, 1 + r() * 0.8, r() * Math.PI));
    l += 0.6 + r() * 1.2;
  }
}

// ---------- the whole map ----------

/**
 * The soft edges of every terrain area: by id, its opaque core, its see-through
 * fade bands and its details. `floor` is the floor as drawn (walls run along
 * its outline). Areas without a soft edge of their own and without anything
 * fading over them get core null (drawn exactly as before).
 *
 * Cached twice: the whole result per terrain and floor (any other edit costs
 * nothing), and each area's own work per what it depends on (itself, the areas
 * near its outline, the walls there), so moving one area works out only it and
 * its neighbours again.
 */
export function terrainEdges(terrain: readonly Terrain[], floor: readonly Polygon[], mapSeed: number): TerrainEdges {
  const key = JSON.stringify([mapSeed, terrain.map((t) => [t.id, t.asset, t.shape, t.holes ?? 0, t.edge ?? 0, t.fadeWidth ?? 0, t.edgeDetails ?? 0, t.stack ?? 0]), floor]);
  const hit = cacheGet(maps, key);
  if (hit) return hit;
  const result = computeEdges(terrain, floor, mapSeed);
  cachePut(maps, key, result, 8);
  return result;
}

/** Least recently used caches: the whole result per map state, each area's own work, each terrain's outline. */
const maps = new Map<string, TerrainEdges>();
const parts = new Map<string, AreaPart>();
const finals = new Map<string, AreaEdges>();
const shapes = new Map<string, Pick<Area, 'paths' | 'polys' | 'rings' | 'box'>>();

function cacheGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut<T>(cache: Map<string, T>, key: string, value: T, size: number): void {
  cache.set(key, value);
  while (cache.size > size) cache.delete(cache.keys().next().value!);
}

/** Forget everything cached (tests: a cold run must give exactly what a cached one does). */
export function clearTerrainEdgeCaches(): void {
  for (const c of [maps, parts, finals, shapes]) c.clear();
}

/** Two 32-bit hashes of a string: a short cache key. */
const digest = (s: string): string => `${hashString(s).toString(36)}.${hashString(`${s.length}:${s}`).toString(36)}`;

/** One area's own work: its levels (null: no soft edge), what runs under its soft edges (by the id of the area under), its details. */
interface AreaPart {
  key: string;
  core: PathsD | null;
  fades: AreaEdges['fades'];
  under: [string, PathsD][];
  details: EdgeDetail[];
}

/** How far around its outline an area's work looks: its widest possible fade's reach, the probes and the details. */
const LOOK = (maxWidth: number): number => fadeAmp(maxWidth) * 1.05 + LEVELS[0].off * rimScale(maxWidth / 2) + 1;
/** The coarse cells used to find the areas near an outline, in squares. */
const CELL = 4;

function computeEdges(terrain: readonly Terrain[], floor: readonly Polygon[], mapSeed: number): TerrainEdges {
  const areas: Area[] = terrain.map((t, index) => {
    const sk = JSON.stringify([t.shape, t.holes ?? 0]);
    let g = cacheGet(shapes, sk);
    if (!g) {
      const paths = terrainArea(t);
      const polys = polygonsOf(paths);
      const rings = polys.flatMap((p) => [p.outer, ...p.holes]);
      const pts = rings.flat();
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const box = pts.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : { x0: 0, y0: 0, x1: 0, y1: 0 };
      g = { paths, polys, rings, box };
      cachePut(shapes, sk, g, 4000);
    }
    return { index, t, s: terrainEdgeSettings(t), seed: (mapSeed ^ Math.imul(hashString(t.id), 0x9e3779b1)) >>> 0, ...g };
  });
  // the walls: the floor's outline
  const wallSegs: number[][] = [];
  for (const p of floor) for (const r of [p.outer, ...p.holes]) for (let i = 0; i < r.length; i++) wallSegs.push([r[i]![0], r[i]![1], r[(i + 1) % r.length]![0], r[(i + 1) % r.length]![1]]);
  const walls = new SegmentGrid(
    Float64Array.from(wallSegs, (s) => s[0]!),
    Float64Array.from(wallSegs, (s) => s[1]!),
    Float64Array.from(wallSegs, (s) => s[2]!),
    Float64Array.from(wallSegs, (s) => s[3]!),
  );
  // which areas lie near which coarse cells, to find each outline's neighbours
  const look = LOOK(Math.max(DEFAULT_FADE_WIDTH, ...areas.map((a) => a.s.fadeWidth ?? 0)));
  const byCell = new Map<number, number[]>();
  for (const a of areas) {
    for (let cx = Math.floor(a.box.x0 / CELL); cx <= Math.floor(a.box.x1 / CELL); cx++)
      for (let cy = Math.floor(a.box.y0 / CELL); cy <= Math.floor(a.box.y1 / CELL); cy++) {
        const k = cellKey(cx, cy);
        const list = byCell.get(k);
        if (list) list.push(a.index);
        else byCell.set(k, [a.index]);
      }
  }

  const result: TerrainEdges = { areas: new Map() };
  const own = areas.map((v) => {
    // the cells the outline passes through, widened by how far its work looks; the areas there and the walls there
    const cells = new Set<number>();
    const near = new Set<number>();
    const wallsNear = new Set<number>();
    for (const ring of v.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        for (let cx = Math.floor((Math.min(a[0], b[0]) - look) / CELL); cx <= Math.floor((Math.max(a[0], b[0]) + look) / CELL); cx++)
          for (let cy = Math.floor((Math.min(a[1], b[1]) - look) / CELL); cy <= Math.floor((Math.max(a[1], b[1]) + look) / CELL); cy++) cells.add(cellKey(cx, cy));
      }
    }
    for (const c of cells) {
      for (const k of byCell.get(c) ?? []) if (k !== v.index) near.add(k);
      const cx = Math.floor(c / 0x10000) - 0x8000;
      const cy = (c % 0x10000) - 0x8000;
      for (const s of walls.near(cx * CELL, cy * CELL, (cx + 1) * CELL - 1e-9, (cy + 1) * CELL - 1e-9)) wallsNear.add(s);
    }
    const others = [...near].sort((p, q) => p - q).map((k) => areas[k]!);
    const wallList = [...wallsNear].sort((p, q) => p - q).map((s) => [walls.ax[s], walls.ay[s], walls.bx[s], walls.by[s]]);
    const key = digest(
      JSON.stringify([
        v.seed,
        v.t.id,
        v.t.asset,
        v.t.shape,
        v.t.holes ?? 0,
        v.s,
        others.map((o) => [o.index < v.index ? 0 : 1, o.t.id, o.t.asset, o.t.shape, o.t.holes ?? 0, o.s]),
        wallList,
      ]),
    );
    let part = cacheGet(parts, key);
    if (!part) {
      part = areaPart(v, others, walls, key);
      cachePut(parts, key, part, 400);
    }
    return part;
  });

  // what runs under each area: the bits of later areas' soft edges that lie over it
  const under = new Map<string, { keys: string[]; paths: PathsD }>();
  for (const part of own) {
    for (const [id, paths] of part.under) {
      const u = under.get(id) ?? { keys: [], paths: [] };
      u.keys.push(part.key);
      u.paths.push(...paths);
      under.set(id, u);
    }
  }
  for (const v of areas) {
    const part = own[v.index]!;
    const extra = under.get(v.t.id);
    const fk = `${part.key}|${extra?.keys.join(',') ?? ''}`;
    let edges = cacheGet(finals, fk);
    if (!edges) {
      if (!part.core) edges = { core: extra ? polygonsOf([...v.paths, ...extra.paths]) : null, fades: [], details: [] };
      else edges = { core: polygonsOf(extra ? [...part.core, ...extra.paths] : part.core), fades: part.fades, details: part.details };
      cachePut(finals, fk, edges, 400);
    }
    result.areas.set(v.t.id, edges);
  }
  return result;
}

/** One area's own work: how soft each point of its outline is, its levels, what runs under it, its details. `others`: the areas near its outline, in map order. */
function areaPart(v: Area, others: readonly Area[], walls: SegmentGrid, key: string): AreaPart {
  /** The topmost of the other areas at (x, y), or null. */
  const topAt = (x: number, y: number): Area | null => {
    for (let k = others.length - 1; k >= 0; k--) {
      const a = others[k]!;
      if (x < a.box.x0 || x > a.box.x1 || y < a.box.y0 || y > a.box.y1) continue;
      if (inRings(a.rings, x, y)) return a;
    }
    return null;
  };
  const outline = outlineOf(v);
  for (const ring of outline) {
    for (const p of ring.points) {
      const e = topAt(p.x + p.nx * 0.05, p.y + p.ny * 0.05);
      // a later area lies over the outline here: it does the softening (its own edge is here) or hides it
      if (e && e.index > v.index) {
        p.below = -2;
        continue;
      }
      p.below = e ? e.index : -1;
      const mode = pairEdge({ asset: v.t.asset, ...v.s }, e ? { asset: e.t.asset, ...e.s } : null);
      if (mode === 'hard') continue;
      const width = e ? pairWidth(v.s, e.s) : DEFAULT_FADE_WIDTH;
      p.width = width;
      p.hw = mode === 'fade' ? width / 2 : 0;
      p.amp = mode === 'fade' ? fadeAmp(width) : RAGGED;
      p.sign = e && e.s.stack > v.s.stack ? -1 : 1;
      p.recipe = e && v.s.details && e.s.details ? edgeRecipe(v.s.material, e.s.material) : null;
    }
    // soften the changes along the outline (a fade turning into a hard edge), then keep clear of walls
    smoothAlong(ring.points);
    for (const p of ring.points) {
      const d = walls.distance(p.x, p.y, WALL_CLEAR + WALL_RAMP);
      const k = smoothstep((d - WALL_CLEAR) / WALL_RAMP);
      p.hw *= k;
      p.amp *= k;
    }
  }
  if (!outline.some((r) => r.points.some((p) => p.amp > 1e-4 || p.hw > 1e-4))) return { key, core: null, fades: [], under: [], details: [] };

  // where its soft edge lies over another area, that one runs on under it
  const byIndex = new Map(others.map((o) => [o.index, o]));
  const under: [string, PathsD][] = [];
  for (const ring of outline) {
    const pts = ring.points;
    let run: { below: number; line: PathD; reach: number } | null = null;
    const flush = () => {
      if (run && run.line.length > 1) {
        // (a coarser precision is plenty: this lies under the soft edge, never at a visible edge of its own)
        const band = inflatePathsD([run.line], run.reach, JoinType.Round, EndType.Round, 2, 3);
        const inside = intersectD(band, v.paths, FillRule.NonZero, 3);
        if (inside.length) under.push([byIndex.get(run.below)!.t.id, inside]);
      }
      run = null;
    };
    for (let k = 0; k <= pts.length; k++) {
      const p = pts[k % pts.length]!;
      const isSoft = p.below >= 0 && (p.amp > 1e-4 || p.hw > 1e-4);
      if (isSoft && run && run.below === p.below) {
        run.line.push({ x: p.x, y: p.y });
        run.reach = Math.max(run.reach, reachOf(p) + H);
      } else {
        flush();
        if (isSoft) run = { below: p.below, line: [{ x: p.x, y: p.y }], reach: reachOf(p) + H };
      }
    }
    flush();
  }

  const { levels } = softLevels(v, outline);
  const core = levels[levels.length - 1]!.map(toPath);
  const fades: AreaEdges['fades'] = [];
  for (let k = 0; k < LEVELS.length - 1; k++) {
    // the rims without the core (the texture over itself would only add to what's opaque already)
    const band = polygonsOf(levels[k]!.map(toPath), core);
    if (band.length) fades.push({ alpha: LEVELS[k]!.alpha, polygons: band });
  }
  // details, left out where a later area lies over them
  const sink = new DetailSink();
  const later = others.filter((a) => a.index > v.index);
  const isLater = (x: number, y: number) => later.some((a) => x >= a.box.x0 && x <= a.box.x1 && y >= a.box.y0 && y <= a.box.y1 && inRings(a.rings, x, y));
  for (const run of detailRuns(outline)) if (run.below >= 0) runDetails(run, v, byIndex.get(run.below)!, sink, isLater);
  return { key, core, fades, under, details: sink.done() };
}

/** A moving average of the softness along a closed outline (about half a square each way), so modes blend instead of jumping. */
function smoothAlong(pts: OutlinePoint[]): void {
  const n = pts.length;
  const w = Math.min(Math.floor(n / 2), Math.ceil(0.5 / STEP));
  if (w < 1) return;
  const keys = ['hw', 'amp', 'sign', 'width'] as const;
  const src = keys.map((k) => Float64Array.from(pts, (p) => p[k]));
  // a later area's points take their neighbours' values (they are drawn over anyway), so they don't pull the average down
  const hidden = pts.map((p) => p.below === -2);
  keys.forEach((k, ki) => {
    const a = src[ki]!;
    for (let i = 0; i < n; i++) {
      if (hidden[i]) continue;
      let sum = 0;
      let cnt = 0;
      for (let d = -w; d <= w; d++) {
        const j = (i + d + n) % n;
        if (hidden[j]) continue;
        sum += a[j]!;
        cnt++;
      }
      (pts[i]! as unknown as Record<string, number>)[k] = cnt ? sum / cnt : a[i]!;
    }
  });
}
