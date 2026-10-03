// The handout's legend (map key): each kind of thing the players can see on the
// sheet, once, with a small picture in the same art and the parchment's colours
// as on the map, and its name in the sheet's hand. Entries come from the scene
// as the handout draws it (the players' view, with fog and crop applied), so
// nothing players can't see is listed: hidden traps, GM symbols and markers,
// secret doors and room numbers never reach that scene. legendLayout sizes the
// box in columns; handout.ts finds it a free corner of the sheet (placeLegend,
// with InkMask saying where the map has ink).
//
// Order: doors by style, stairs, then ladders and trapdoors (the ways through,
// which a map key traditionally opens with), then the ground (terrain by area,
// height edges), then props by how often they appear. So a capped legend drops
// the rarest props first, never a door or the water.
import { EndType, FillRule, inflatePathsD, intersectD, JoinType } from 'clipper2-ts';
import { assetInfo, groupVariants, propBounds, type AssetInfo } from '../assets/catalog.ts';
import { clipLinesToBox, cropScene } from '../crop.ts';
import { polygonsOf } from '../geometry/floor.ts';
import { insidePolygons } from '../geometry/objects.ts';
import { PRECISION, shapeBounds, toPath, type Bounds, type Polygon, type Ring } from '../geometry/shapes.ts';
import { doorSegment } from '../geometry/walls.ts';
import { visiblePaths } from '../fog.ts';
import { imageBounds } from '../images.ts';
import { STAIR_PROPS } from '../levels.ts';
import { HEIGHT_CLIP } from './heights.ts';
import { buildScene, type AssetItem, type Layer, type Scene } from './scene.ts';
import type { Style } from './style.ts';
import type { DelveMap, Door, HeightEdge, MapObject } from '../schema.ts';

export type LegendKind = 'door' | 'stairs' | 'way' | 'terrain' | 'height' | 'prop';

export interface LegendEntry {
  /** One per kind of thing: door:locked, stairs, prop:g:oak (a group), prop:barrel, terrain:lava, height:cliff. */
  key: string;
  kind: LegendKind;
  name: string;
  /** How many there are on the sheet (terrain: its area in squares). */
  count: number;
  /** The picture: a little scene in squares, drawn into the entry's icon box (square bounds). */
  icon: Scene;
}

/** At most this many entries; the rest are "and N more". */
export const LEGEND_CAP = 24;
/** Names longer than this are shortened (at a comma, else a word, with "…"). */
const NAME_MAX = 28;

type DoorStyle = NonNullable<Door['style']>;
const DOOR_NAMES: [DoorStyle, string][] = [
  ['normal', 'Door'],
  ['double', 'Double door'],
  ['locked', 'Locked door'],
  ['portcullis', 'Portcullis'],
  ['archway', 'Archway'],
];
const HEIGHT_NAMES: [HeightEdge, string][] = [
  ['cliff', 'Cliff'],
  ['rock', 'Rock face'],
  ['slope', 'Slope'],
  ['step', 'Step'],
];

/** Props that lead somewhere: ladders, trapdoors, hatches, spiral stairs (they go with the doors and stairs). */
const WAY = /\b(ladders?|trapdoors?|stairs?|staircase|hatch|manhole)\b/i;
const isWay = (info: AssetInfo): boolean => info.id in STAIR_PROPS || WAY.test(info.name);

// ---------- names ----------

const head = (name: string): string => name.split(/[,(]/)[0]!.trim();
const words = (name: string): string[] => name.split(/[\s,()]+/).filter(Boolean);

/** The first `count` words of a name, with its own punctuation ("Oak, autumn" from "Oak, autumn gold"). */
function firstWords(name: string, count: number): string {
  const re = /[^\s,()]+/g;
  let end = 0;
  for (let i = 0; i < count; i++) {
    const m = re.exec(name);
    if (!m) break;
    end = m.index + m[0].length;
  }
  return name.slice(0, end);
}

/** The words all the names start with, as the first one writes them; '' if none. */
function sharedStart(names: readonly string[]): string {
  const ws = names.map(words);
  let i = 0;
  while (ws[0]![i] && ws.every((w) => w[i]?.toLowerCase() === ws[0]![i]!.toLowerCase())) i++;
  return i ? firstWords(names[0]!, i) : '';
}

/**
 * A group's name in the catalog's words (`names`: its variants'):
 * - the words they all start with, when that is a variant's own name or what it
 *   is called before the first comma ("Oak" for Oak, Oak dense, Oak young;
 *   "Persian rug, red"; "Market stall"; "Trapdoor");
 * - else what most of them are called before the first comma ("Dead tree" for
 *   Dead tree, Dead tree big, Dead sapling; "Pine");
 * - else the group itself when it is one word ("Fur" for the bearskin, the wolf
 *   pelt and the sheepskin), else `fallback` (the variant there is most of).
 * A group of one keeps its full name.
 */
export function groupName(group: string, names: readonly string[], fallback = names[0] ?? group): string {
  if (names.length === 1) return names[0]!;
  const shared = sharedStart(names);
  if (shared && names.some((n) => n === shared || head(n) === shared)) return shared;
  const counts = new Map<string, number>();
  for (const n of names) counts.set(head(n), (counts.get(head(n)) ?? 0) + 1);
  const [best, count] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  if (count * 2 > names.length && best) return best;
  if (/^[a-z]+$/.test(group)) return group.charAt(0).toUpperCase() + group.slice(1);
  return fallback;
}

/** A name that fits a legend line: up to its first comma, else cut at a word, with "…". */
function shorten(name: string): string {
  if (name.length <= NAME_MAX) return name;
  if (head(name).length <= NAME_MAX && head(name)) return head(name);
  const cut = name.slice(0, NAME_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > NAME_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,]+$/, '')}…`;
}

// ---------- what is on the sheet ----------

const overlaps = (a: Bounds, b: Bounds, by = 0.1): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > by && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > by;
const boxRing = (b: Bounds): Ring => [
  [b.x0, b.y0],
  [b.x1, b.y0],
  [b.x1, b.y1],
  [b.x0, b.y1],
];

function ringArea(r: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}
const polygonsArea = (polys: readonly Polygon[]): number => polys.reduce((s, p) => s + ringArea(p.outer) - p.holes.reduce((h, r) => h + ringArea(r), 0), 0);

/** The part of the polygons inside the box. */
function within(polys: readonly Polygon[], b: Bounds): Polygon[] {
  const paths = polys.flatMap((p) => [p.outer, ...p.holes].map(toPath));
  return paths.length ? polygonsOf(intersectD(paths, [toPath(boxRing(b))], FillRule.NonZero, PRECISION)) : [];
}

/** Does this layer draw anything inside the box? */
function layerInside(l: Layer, b: Bounds): boolean {
  switch (l.kind) {
    case 'stroke':
      return clipLinesToBox(l.lines, b).length > 0;
    case 'fill':
    case 'pattern':
      return polygonsArea(within(l.polygons, b)) > 0.01;
    case 'dots':
      return l.points.some(([x, y]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    default:
      return false;
  }
}

export interface LegendInput {
  /** The handout's scene: the players' view, with fog and crop already applied. */
  scene: Scene;
  style: Style;
  /** The cropped part of the map, in squares: only what lies inside it is listed. */
  crop?: Bounds;
  /** Only what the players have seen (fog of war). */
  revealedOnly?: boolean;
}

/**
 * The legend's entries for a handout, in legend order (see the top of this file),
 * each with its picture. Nothing hidden from players is listed; with a crop, only
 * what lies inside it; with revealedOnly, only what the fog has let them see.
 */
export function legendEntries(map: DelveMap, input: LegendInput): LegendEntry[] {
  const { scene, style, crop } = input;
  const out: LegendEntry[] = [];

  // doors by style: the scene merges their leaves, so they come from the map with the scene's own tests
  const seenPolys = input.revealedOnly && map.fog?.on ? polygonsOf(visiblePaths(map)) : null;
  const doorCounts = new Map<DoorStyle, number>();
  for (const d of map.objects) {
    if (d.type !== 'door') continue;
    const kind = d.style ?? 'normal';
    if (kind === 'secret') continue; // plain wall for players
    const [a, b] = doorSegment(d);
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (seenPolys && !insidePolygons(seenPolys, mid)) continue;
    if (crop && !clipLinesToBox([{ points: [a, b], closed: false }], crop).some((l) => Math.hypot(l.points[1]![0] - l.points[0]![0], l.points[1]![1] - l.points[0]![1]) > 0.2)) continue;
    doorCounts.set(kind, (doorCounts.get(kind) ?? 0) + 1);
  }
  for (const [kind, name] of DOOR_NAMES) {
    const count = doorCounts.get(kind);
    if (count) out.push({ key: `door:${kind}`, kind: 'door', name, count, icon: sampleIcon(`door-${kind}`, style) });
  }

  // stairs: their layers in the scene (fog applied), inside the crop
  const byId = new Map<string, MapObject>(map.objects.map((o) => [o.id, o]));
  let stairs = 0;
  for (const l of scene.layers) {
    if (!l.name.startsWith('stairs:')) continue;
    const s = byId.get(l.name.slice('stairs:'.length));
    if (s?.type === 'stairs' && (!crop || overlaps(shapeBounds(s.shape), crop))) stairs++;
  }
  if (stairs) out.push({ key: 'stairs', kind: 'stairs', name: 'Stairs', count: stairs, icon: sampleIcon('stairs', style) });

  // props (with ladders and trapdoors), one entry per group of variants
  interface Tally {
    info: AssetInfo;
    count: number;
    assets: Map<string, { count: number; item: AssetItem; layer: Extract<Layer, { kind: 'assets' }> }>;
  }
  const props = new Map<string, Tally>();
  for (const l of scene.layers) {
    if (l.kind !== 'assets') continue;
    for (const it of l.items) {
      const info = assetInfo(it.asset);
      // map parts (a compass rose, a title cartouche) explain themselves
      if (!info || info.category === 'cartography' || (crop && !overlaps(propBounds(it), crop))) continue;
      const key = info.group && info.kind === 'prop' ? `prop:g:${info.group}` : `prop:${it.asset}`;
      const t = props.get(key) ?? { info, count: 0, assets: new Map() };
      t.count++;
      const a = t.assets.get(it.asset) ?? { count: 0, item: it, layer: l };
      a.count++;
      t.assets.set(it.asset, a);
      props.set(key, t);
    }
  }
  const propEntries: LegendEntry[] = [];
  for (const [key, t] of props) {
    // the picture: the variant there is most of
    const top = [...t.assets.values()].sort((a, b) => b.count - a.count)[0]!;
    const group = t.info.group && t.info.kind === 'prop' ? t.info.group : null;
    const name = group ? groupName(group, groupVariants(top.item.asset).map((id) => assetInfo(id)?.name ?? id), assetInfo(top.item.asset)?.name) : t.info.name;
    propEntries.push({ key, kind: isWay(assetInfo(top.item.asset) ?? t.info) ? 'way' : 'prop', name, count: t.count, icon: propIcon(top.item, top.layer) });
  }

  // terrain kinds and colour textures, by area
  const terrain = new Map<string, { count: number; layer: Extract<Layer, { kind: 'pattern' }> }>();
  for (const l of scene.layers) {
    if (l.kind !== 'pattern' || !l.name.startsWith('terrain:') || !assetInfo(l.tile)) continue;
    // what shows of it at least half a square deep (not a sliver at the fog's edge or under the hatching)
    const shown = crop ? within(l.polygons, crop) : l.polygons;
    const area = polygonsArea(shown);
    if (area < 0.05 || !inflatePathsD(shown.flatMap((p) => [p.outer, ...p.holes].map(toPath)), -0.25, JoinType.Miter, EndType.Polygon, 2, PRECISION).length) continue;
    const t = terrain.get(l.tile);
    terrain.set(l.tile, { count: (t?.count ?? 0) + area, layer: t?.layer ?? l });
  }
  const terrainEntries = [...terrain].map(([tile, t]): LegendEntry => ({ key: `terrain:${tile}`, kind: 'terrain', name: assetInfo(tile)!.name, count: Math.round(t.count * 100) / 100, icon: terrainIcon(t.layer, style) }));

  // height edges, by the layers the scene drew for them
  const heights = new Set<HeightEdge>();
  for (const l of scene.layers) {
    const kind = HEIGHT_NAMES.find(([k]) => l.name.startsWith(`height-${k}`))?.[0];
    if (kind && (!crop || layerInside(l, crop))) heights.add(kind);
  }

  const byCount = (a: LegendEntry, b: LegendEntry) => b.count - a.count || a.name.localeCompare(b.name);
  out.push(...propEntries.filter((e) => e.kind === 'way').sort(byCount));
  out.push(...terrainEntries.sort(byCount));
  for (const [kind, name] of HEIGHT_NAMES) if (heights.has(kind)) out.push({ key: `height:${kind}`, kind: 'height', name, count: 1, icon: sampleIcon(`height-${kind}`, style) });
  out.push(...propEntries.filter((e) => e.kind === 'prop').sort(byCount));

  // two different things under one name (the oak and the autumn oak groups): their fuller names
  const named = new Map<string, LegendEntry[]>();
  for (const e of out) named.set(e.name, [...(named.get(e.name) ?? []), e]);
  for (const same of named.values()) {
    if (same.length < 2) continue;
    for (const e of same) {
      if (!e.key.startsWith('prop:g:')) continue;
      const ids = groupVariants(props.get(e.key)!.assets.keys().next().value!);
      const shared = sharedStart(ids.map((id) => assetInfo(id)?.name ?? id));
      const top = [...props.get(e.key)!.assets.values()].sort((a, b) => b.count - a.count)[0]!;
      e.name = shared && shared !== e.name ? shared : (assetInfo(top.item.asset)?.name ?? e.name);
    }
  }
  for (const e of out) e.name = shorten(e.name);
  return out;
}

// ---------- pictures ----------

/** A prop at rotation 0 in a square a little bigger than its footprint, as the map draws it. */
function propIcon(it: AssetItem, l: Extract<Layer, { kind: 'assets' }>): Scene {
  const side = Math.max(it.w, it.h) * 1.08;
  return {
    bounds: { x0: -side / 2, y0: -side / 2, x1: side / 2, y1: side / 2 },
    clips: {},
    layers: [{ name: 'legend-prop', kind: 'assets', items: [{ ...it, at: [0, 0], rotation: 0, scale: 1 }], palette: l.palette, ...(l.colours ? { colours: l.colours } : {}) }],
  };
}

/** A swatch of one tile of the texture (an ink tile is 2 × 2 squares), framed by a fine ink line. */
function terrainIcon(l: Extract<Layer, { kind: 'pattern' }>, style: Style): Scene {
  const t = l.colour ? Math.min(...l.colour.size) : 2;
  const i = t * 0.06;
  const ring: Ring = boxRing({ x0: i, y0: i, x1: t - i, y1: t - i });
  return {
    bounds: { x0: 0, y0: 0, x1: t, y1: t },
    clips: {},
    layers: [
      { ...l, name: 'legend-terrain', polygons: [{ outer: ring, holes: [] }] },
      { name: 'legend-swatch', kind: 'stroke', lines: [{ points: ring, closed: true }], color: style.walls.color, width: t * 0.022, cap: 'round', join: 'round' },
    ],
  };
}

const sampleMap = (objects: MapObject[]): DelveMap => ({ format: 'delve.map', version: 1, id: 'legend', name: 'Legend', grid: { type: 'square' }, seed: 11, objects });

/**
 * A door in a wall stub, a stairwell with its treads, or a stretch of height edge:
 * drawn by the renderer itself from a tiny map, so they look as on the map, then
 * cut to the sample's frame. Hatching and shading are left out (noise at this size).
 */
function drawSample(kind: string, style: Style): Scene {
  const plain: Style = { ...style, hatching: null, shading: null, shadow: null };
  let map: DelveMap;
  let frame: Bounds;
  let keep: (name: string) => boolean;
  const walls = (n: string) => n === 'walls' || n.startsWith('walls-sketch-');
  if (kind.startsWith('door-')) {
    const s = kind.slice(5) as DoorStyle;
    map = sampleMap([
      { type: 'room', id: 'r1', shape: { rect: [-2, 1, 7, 3] } },
      { type: 'door', id: 'd1', at: [1, 1], along: 'x', width: 1, ...(s === 'normal' ? {} : { style: s }) },
    ]);
    frame = { x0: 0.7, y0: 0.2, x1: 2.3, y1: 1.8 };
    keep = (n) => walls(n) || n === 'doors' || n === 'door-marks';
  } else if (kind === 'stairs') {
    map = sampleMap([
      { type: 'room', id: 'r1', shape: { rect: [0, -2, 1, 6] } },
      { type: 'stairs', id: 's1', shape: { rect: [0, 0, 1, 2] }, direction: 'n' },
    ]);
    frame = { x0: -0.5, y0: 0, x1: 1.5, y1: 2 };
    keep = (n) => walls(n) || n === 'stairs:s1';
  } else {
    const edge = kind.slice(7) as HeightEdge;
    map = sampleMap([
      { type: 'room', id: 'r1', shape: { rect: [-3, -3, 8, 8] } },
      { type: 'height', id: 'h1', shape: { rect: [-3, -3, 8, 4.5] }, height: 10, edge },
    ]);
    frame = { x0: 0.3, y0: 0.8, x1: 1.7, y1: 2.2 };
    keep = (n) => n.startsWith('height-') && n !== 'height-labels';
  }
  const drawn = buildScene(map, { view: 'players', grid: false, background: false, frame }, plain);
  const layers = drawn.layers.filter((l) => keep(l.name));
  const clips: Record<string, Polygon[]> = {};
  for (const l of layers) if (l.clip && drawn.clips[l.clip]) clips[l.clip] = drawn.clips[l.clip]!;
  if (drawn.clips[HEIGHT_CLIP] && layers.some((l) => l.clip === HEIGHT_CLIP)) clips[HEIGHT_CLIP] = drawn.clips[HEIGHT_CLIP]!;
  return cropScene({ bounds: frame, clips, layers }, frame);
}

/** The samples are the same for every map, so they're drawn once per style. */
const samples = new Map<string, Scene>();
function sampleIcon(kind: string, style: Style): Scene {
  const key = `${style.name}|${style.walls.color}|${style.doors.fill}|${kind}`;
  let s = samples.get(key);
  if (!s) {
    s = drawSample(kind, style);
    if (samples.size > 64) samples.clear();
    samples.set(key, s);
  }
  return s;
}

// ---------- where the map has ink ----------

/**
 * Which cells of a grid over the map (in squares) hold ink, with running sums so
 * any box can be tested at once. Polygons are filled by scanlines at the cells'
 * centres and their outlines traced, so thin shapes are never missed.
 */
export class InkMask {
  readonly bounds: Bounds;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  private readonly cells: Uint8Array;
  private sums: Int32Array | null = null;

  constructor(bounds: Bounds, cell: number) {
    this.bounds = bounds;
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell));
    this.ny = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) / cell));
    this.cells = new Uint8Array(this.nx * this.ny);
  }

  private mark(i: number, j: number): void {
    if (i >= 0 && j >= 0 && i < this.nx && j < this.ny) this.cells[j * this.nx + i] = 1;
  }

  rect(b: Bounds): void {
    const { x0, y0 } = this.bounds;
    const c = this.cell;
    for (let j = Math.max(0, Math.floor((b.y0 - y0) / c)); j <= Math.min(this.ny - 1, Math.floor((b.y1 - y0) / c)); j++) {
      for (let i = Math.max(0, Math.floor((b.x0 - x0) / c)); i <= Math.min(this.nx - 1, Math.floor((b.x1 - x0) / c)); i++) this.cells[j * this.nx + i] = 1;
    }
  }

  polygons(polys: readonly Polygon[]): void {
    const { x0, y0 } = this.bounds;
    const c = this.cell;
    const rows: number[][] = Array.from({ length: this.ny }, () => []);
    for (const p of polys) {
      for (const ring of [p.outer, ...p.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]!;
          const b = ring[(k + 1) % ring.length]!;
          // the outline, in half-cell steps
          const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (c / 2));
          for (let s = 0; s <= steps; s++) {
            const t = steps ? s / steps : 0;
            this.mark(Math.floor((a[0] + (b[0] - a[0]) * t - x0) / c), Math.floor((a[1] + (b[1] - a[1]) * t - y0) / c));
          }
          // where the edge crosses each row's centre line
          if (a[1] === b[1]) continue;
          const lo = Math.min(a[1], b[1]);
          const hi = Math.max(a[1], b[1]);
          for (let j = Math.max(0, Math.ceil((lo - y0) / c - 0.5)); j < this.ny; j++) {
            const y = y0 + (j + 0.5) * c;
            if (y >= hi) break;
            if (y < lo) continue;
            rows[j]!.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
          }
        }
      }
    }
    rows.forEach((xs, j) => {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.max(0, Math.ceil((xs[k]! - x0) / c - 0.5)); i <= Math.min(this.nx - 1, Math.floor((xs[k + 1]! - x0) / c - 0.5)); i++) this.cells[j * this.nx + i] = 1;
      }
    });
  }

  private sum(): Int32Array {
    if (this.sums) return this.sums;
    const w = this.nx + 1;
    const s = new Int32Array(w * (this.ny + 1));
    for (let j = 0; j < this.ny; j++) {
      let row = 0;
      for (let i = 0; i < this.nx; i++) {
        row += this.cells[j * this.nx + i]!;
        s[(j + 1) * w + i + 1] = s[j * w + i + 1]! + row;
      }
    }
    return (this.sums = s);
  }

  /** Inked cells the box (in squares) touches; outside the grid there is no ink. */
  count(b: Bounds): number {
    const { x0, y0 } = this.bounds;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((b.x0 - x0) / c));
    const j0 = Math.max(0, Math.floor((b.y0 - y0) / c));
    const i1 = Math.min(this.nx, Math.ceil((b.x1 - x0) / c));
    const j1 = Math.min(this.ny, Math.ceil((b.y1 - y0) / c));
    if (i1 <= i0 || j1 <= j0) return 0;
    const s = this.sum();
    const w = this.nx + 1;
    return s[j1 * w + i1]! - s[j0 * w + i1]! - s[j1 * w + i0]! + s[j0 * w + i0]!;
  }
}

/**
 * The map's ink as two masks over the scene: the floor (which the hatching and
 * shading surround, so tests grow it by the style's reach) and everything else
 * drawn: terrain, props, pictures, labels, height areas, doors.
 */
export function inkMasks(scene: Scene): { floor: InkMask; ink: InkMask } {
  const b = scene.bounds;
  const cell = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 240;
  const floor = new InkMask(b, cell);
  const ink = new InkMask(b, cell);
  floor.polygons(scene.clips.floor ?? []);
  for (const l of scene.layers) {
    // the floor's own layers are the floor mask; walls, hatching and shading lie on or around it
    if (l.name === 'floor' || l.name === 'shading') continue;
    if (l.kind === 'fill' || l.kind === 'pattern') ink.polygons(l.polygons);
    else if (l.kind === 'assets') for (const it of l.items) ink.rect(propBounds(it));
    else if (l.kind === 'images') for (const it of l.items) ink.rect(imageBounds(it));
    else if (l.kind === 'text') for (const t of l.items) ink.rect({ x0: t.at[0] - t.text.length * t.size * 0.3, y0: t.at[1] - t.size * 0.7, x1: t.at[0] + t.text.length * t.size * 0.3, y1: t.at[1] + t.size * 0.5 });
  }
  return { floor, ink };
}

// ---------- the box ----------

export interface LegendLayout {
  cols: number;
  rows: number;
  /** The box in points. */
  w: number;
  h: number;
  /** The entries drawn, column by column. */
  shown: LegendEntry[];
  /** How many didn't fit under the cap ("and N more"). */
  more: number;
  /** Each column's width in points. */
  colW: number[];
  /** The icon size in points (one square of the key). */
  icon: number;
}

/** IM FELL English runs about this many ems per character on average. */
const CHAR_EM = 0.47;

/** The legend's box with its entries in `cols` columns, icons `icon` points square. */
export function legendLayout(entries: readonly LegendEntry[], cols: number, icon: number): LegendLayout {
  const shown = entries.slice(0, LEGEND_CAP);
  const more = entries.length - shown.length;
  const lines = shown.length + (more ? 1 : 0);
  const n = Math.max(1, Math.min(cols, lines));
  const rows = Math.ceil(lines / n);
  const f = icon * 0.62;
  const textW = (s: string) => s.length * f * CHAR_EM;
  const colW: number[] = [];
  for (let c = 0; c < n; c++) {
    const names = shown.slice(c * rows, (c + 1) * rows).map((e) => e.name);
    const w = Math.max(0, ...names.map(textW));
    const moreW = more && c === n - 1 ? textW(`and ${more} more`) : 0;
    colW.push(Math.max(icon * 1.45 + w, moreW));
  }
  const pad = icon * 0.6;
  const heading = icon * 1.9;
  const w = pad * 2 + colW.reduce((a, b) => a + b, 0) + (n - 1) * icon * 0.9;
  return { cols: n, rows, w: Math.max(w, pad * 2 + 'Legend'.length * icon * 0.9 * CHAR_EM + icon * 2), h: pad * 2 + heading + rows * icon * 1.25 - icon * 0.25, shown, more, colW, icon };
}
