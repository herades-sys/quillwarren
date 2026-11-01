// Tracing a map picture into a Quillwarren map, in one of two modes.
// - Dungeon (and battle maps): light floor drawn inside dark wall lines, often on
//   a grid. The floor becomes rooms and corridors and Quillwarren draws the walls; see
//   dungeon.ts.
// - City plan (Watabou's generator and other flat-colour plans): each main colour
//   gets a role; buildings and walls become rooms, the other roles become
//   terrain. Thin lines (grid, outlines) are cleaned away, text holes in
//   buildings are filled, and shapes with holes that Quillwarren can't hold in one
//   piece (a city wall ring, a park around houses) are split in two.
import { FORMAT, FORMAT_VERSION, type DelveMap, type MapObject, type Point } from '../schema.ts';
import { validateMap } from '../validate.ts';
import { classify, type ColourSpace } from './colour.ts';
import { traceDungeon, type DungeonRole } from './dungeon.ts';
import { paintedSmoothing, tracePainted } from './painted.ts';
import { kuwahara } from './smooth.ts';
import { close, dropGridLines, fillHoles, maskOf, open, outlines, parts, signedArea, simplify, type Mask, type RGB } from './raster.ts';

export const TRACE_ROLES = ['ignore', 'building', 'wall', 'water', 'road', 'grass', 'field', 'sand'] as const;
export type TraceRole = (typeof TRACE_ROLES)[number];

export const TRACE_MODES = ['dungeon', 'city'] as const;
export type TraceMode = (typeof TRACE_MODES)[number];

export const TRACE_TERRAIN: Partial<Record<TraceRole, string>> = { water: 'water-deep', road: 'cobblestones', grass: 'grass', field: 'dirt', sand: 'sand' };
const TERRAIN = TRACE_TERRAIN;

/** Parts thinner than this many squares are dropped, by default: text, outlines and shadows printed in the wall or water colour. */
export const TRACE_MIN_WIDTH: Partial<Record<TraceRole, number>> = { wall: 0.5, water: 1 };

export interface TraceOptions {
  width: number;
  height: number;
  /** RGBA pixels, row by row. */
  rgba: Uint8Array | Uint8ClampedArray;
  colours: RGB[];
  /** A role for each colour. In dungeon mode "building" is the floor and "wall" the wall lines. */
  roles: TraceRole[];
  /** Picture pixels per grid square. */
  pxPerSquare: number;
  /** Where the colours were found and are compared: as mainColours found them (default rgb in city mode, lab in dungeon mode). */
  space?: ColourSpace;
  /** A painted picture (textures, shading): colours were found on a smoothed copy, and city mode squares up houses and finds the wall by its shape. */
  painted?: boolean;
  /** That smoothed copy (made here when left out). */
  smoothed?: Uint8Array | Uint8ClampedArray;
  /** City plan (the default) or dungeon / battle map. */
  mode?: TraceMode;
  /** The picture pixel where square (0, 0) is, e.g. where two grid lines cross (default the top left corner). */
  origin?: [number, number];
  /** Dungeon mode: the picture has a printed grid at this scale, so floors have to show it (default false). */
  printedGrid?: boolean;
  /** Dungeon mode: split the floor into rooms and corridors (default true). */
  split?: boolean;
  /** Dungeon mode: move straight walls this close onto the half-square grid (squares, default 0.2; 0 = off). */
  snap?: number;
  /** Drop shapes smaller than this many squares (default 0.3; dungeon floors 0.5). */
  minArea?: number;
  /** Remove lines and specks thinner than about 2r + 1 pixels, and close cuts that thin (default 1). */
  clean?: number;
  /** For each role, drop parts thinner than this many squares (defaults in TRACE_MIN_WIDTH). */
  minWidth?: Partial<Record<TraceRole, number>>;
  /** City mode: remove a printed grid: long straight lines across the picture, up to 3 pixels thick (default true). */
  grid?: boolean;
  /** Painted city: square the houses up (oriented rectangles and right angles; default true). */
  regular?: boolean;
  /** Join houses that only a thin line separates into one block (default false). */
  join?: boolean;
  /** Fill holes in buildings smaller than this many squares, e.g. printed text (default 3; in dungeon mode 0.35, bigger ones are pillars). */
  fillHoles?: number;
  /** Dungeon mode: filled in with the milliseconds each stage took. */
  timings?: Record<string, number>;
  /** Outline simplification in pixels (default 1.5). */
  simplify?: number;
}

export interface TraceResult {
  /** City mode: per role; dungeon mode: room, corridor, pillar, wall and terrain. */
  objects: MapObject[];
  counts: Record<string, number>;
  /** Picture size in squares. */
  size: [number, number];
  /** Dungeon mode: the wall lines' thickness found, in picture pixels. */
  wallWidth?: number;
}

type P = [number, number];

/** One connected part, cut out into its own small mask at (x0, y0). */
interface Piece {
  x0: number;
  y0: number;
  mask: Mask;
}

/** The parts of a mask of at least minPx pixels, each in a mask just big enough for it. */
function pieces(m: Mask, minPx: number): Piece[] {
  const { labels, sizes } = parts(m);
  const n = sizes.length;
  const box = new Int32Array(n * 4).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (!l || sizes[l]! < minPx) continue;
    const x = i % m.w;
    const y = (i - x) / m.w;
    const b = l * 4;
    if (box[b] === -1) {
      box[b] = box[b + 2] = x;
      box[b + 1] = box[b + 3] = y;
    } else {
      if (x < box[b]!) box[b] = x;
      if (x > box[b + 2]!) box[b + 2] = x;
      if (y > box[b + 3]!) box[b + 3] = y;
    }
  }
  const out: (Piece | null)[] = Array.from({ length: n }, (_, l) => {
    const b = l * 4;
    if (box[b] === -1) return null;
    const pw = box[b + 2]! - box[b]! + 1;
    const ph = box[b + 3]! - box[b + 1]! + 1;
    return { x0: box[b]!, y0: box[b + 1]!, mask: { w: pw, h: ph, px: new Uint8Array(pw * ph) } };
  });
  for (let i = 0; i < labels.length; i++) {
    const p = out[labels[i]!];
    if (!p) continue;
    const x = i % m.w;
    const y = (i - x) / m.w;
    p.mask.px[(y - p.y0) * p.mask.w + (x - p.x0)] = 1;
  }
  return out.filter((p): p is Piece => p !== null);
}

const shift = (rings: P[][], dx: number, dy: number): P[][] => rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as P));

/** Outer rings of each part; a part with holes is split down the middle of its first hole (a few times at most) so every piece is solid. */
function solidRings(m: Mask, minPx: number, depth = 0): P[][] {
  const out: P[][] = [];
  for (const piece of pieces(m, minPx)) {
    const rings = outlines(piece.mask);
    const holes = rings.filter((r) => -signedArea(r) >= 4);
    if (!holes.length || depth >= 4) {
      out.push(...shift(rings.filter((r) => signedArea(r) > 0), piece.x0, piece.y0));
      continue;
    }
    // split at the hole's middle column; both halves keep that column, so they overlap and join seamlessly
    const cx = Math.round(holes[0]!.reduce((s, p) => s + p[0], 0) / holes[0]!.length);
    const half = (keep: (x: number) => boolean): Mask => ({ w: piece.mask.w, h: piece.mask.h, px: piece.mask.px.map((v, i) => (v && keep(i % piece.mask.w) ? 1 : 0)) });
    for (const side of [half((x) => x <= cx), half((x) => x >= cx - 1)]) out.push(...shift(solidRings(side, minPx, depth + 1), piece.x0, piece.y0));
  }
  return out;
}

/** How each trace role reads in a dungeon picture. */
export function dungeonRole(r: TraceRole): DungeonRole {
  return r === 'building' ? 'floor' : r === 'wall' ? 'ink' : TERRAIN[r] ? 'terrain' : 'other';
}

export function traceImage(o: TraceOptions): TraceResult {
  if (o.mode === 'dungeon') {
    const r = traceDungeon({
      width: o.width,
      height: o.height,
      rgba: o.rgba,
      classes: classify(o.painted ? (o.smoothed ?? kuwahara(o.rgba, o.width, o.height, paintedSmoothing(o.width, o.height), 2)) : o.rgba, o.colours, o.space ?? 'lab'),
      roles: o.roles.map(dungeonRole),
      terrain: o.roles.map((r) => TERRAIN[r]),
      s: o.pxPerSquare,
      origin: o.origin ?? [0, 0],
      grid: o.printedGrid ?? false,
      ...(o.minArea !== undefined ? { minArea: o.minArea } : {}),
      ...(o.fillHoles !== undefined ? { fillHoles: o.fillHoles } : {}),
      ...(o.split !== undefined ? { split: o.split } : {}),
      ...(o.snap !== undefined ? { snap: o.snap } : {}),
      ...(o.timings ? { timings: o.timings } : {}),
    });
    const [ox, oy] = o.origin ?? [0, 0];
    return {
      objects: r.objects,
      counts: { room: r.rooms, corridor: r.corridors, door: r.doors, pillar: r.pillars, wall: r.walls, terrain: r.terrain },
      size: [Math.ceil((o.width - ox) / o.pxPerSquare), Math.ceil((o.height - oy) / o.pxPerSquare)],
      wallWidth: r.wallWidth,
    };
  }
  if (o.painted) {
    // a painted city: colours from the smoothed picture, the fine lines between houses from the picture itself
    const src = o.smoothed ?? kuwahara(o.rgba, o.width, o.height, paintedSmoothing(o.width, o.height), 2);
    const r = tracePainted({
      width: o.width,
      height: o.height,
      rgba: o.rgba,
      classes: classify(src, o.colours, o.space ?? 'lab'),
      origClasses: classify(o.rgba, o.colours, o.space ?? 'lab'),
      roles: o.roles,
      s: o.pxPerSquare,
      origin: o.origin ?? [0, 0],
      ...(o.join !== undefined ? { join: o.join } : {}),
      ...(o.regular !== undefined ? { regular: o.regular } : {}),
      ...(o.minArea !== undefined ? { minArea: o.minArea } : {}),
    });
    const [ox, oy] = o.origin ?? [0, 0];
    return { objects: r.objects, counts: r.counts, size: [Math.ceil((o.width - ox) / o.pxPerSquare), Math.ceil((o.height - oy) / o.pxPerSquare)] };
  }
  const { width: w, height: h } = o;
  const s = o.pxPerSquare;
  const [ox, oy] = o.origin ?? [0, 0];
  const minPx = Math.max(4, (o.minArea ?? 0.3) * s * s);
  const clean = Math.max(0, Math.round(o.clean ?? 1));
  const tol = o.simplify ?? 1.5;
  const minWidth = { ...TRACE_MIN_WIDTH, ...o.minWidth };
  // opening with radius r drops anything thinner than 2r + 1 pixels
  const thin = (role: TraceRole) => Math.max(clean, Math.floor(((minWidth[role] ?? 0) * s - 1) / 2));
  const plain = classify(o.rgba, o.colours, o.space ?? 'rgb');
  const classes = (o.grid ?? true) ? dropGridLines(plain, w, h) : plain;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const toSquares = (ring: readonly P[]): Point[] => simplify(ring, tol).map(([x, y]) => [r2((x - ox) / s), r2((y - oy) / s)]);
  const objects: MapObject[] = [];
  const counts: Record<string, number> = {};
  let n = 0;
  const id = (p: string) => `${p}${++n}`;

  const roles = [...new Set(o.roles)].filter((r) => r !== 'ignore');
  // terrain first (under everything), then walls, then buildings
  const order = roles.sort((a, b) => (TERRAIN[a] ? 0 : a === 'wall' ? 1 : 2) - (TERRAIN[b] ? 0 : b === 'wall' ? 1 : 2));
  for (const role of order) {
    let m = maskOf(classes, w, h, (c) => o.roles[c] === role);
    if (role === 'building') {
      if (o.join) m = close(m, clean); // heal grid lines and outlines cut through a block
      m = fillHoles(m, (o.fillHoles ?? 3) * s * s); // text printed on the houses
      m = open(m, thin(role));
    } else {
      m = open(close(m, clean), thin(role)); // drop thin lines (grid, text strokes, shadows) of this colour
    }
    let count = 0;
    if (role === 'building') {
      // buildings keep real holes (courtyards) as cutouts
      for (const piece of pieces(m, minPx)) {
        for (const ring of shift(outlines(piece.mask), piece.x0, piece.y0)) {
          const area = signedArea(ring);
          const pts = toSquares(ring);
          if (pts.length < 3) continue;
          if (area > 0) {
            objects.push({ id: id('r'), type: 'room', shape: { poly: pts } });
            count++;
          } else if (-area >= minPx) objects.push({ id: id('p'), type: 'cutout', shape: { poly: pts } });
        }
      }
    } else {
      for (const ring of solidRings(m, minPx)) {
        const pts = toSquares(ring);
        if (pts.length < 3) continue;
        if (role === 'wall') objects.push({ id: id('r'), type: 'room', shape: { poly: pts }, name: 'Wall' });
        else objects.push({ id: id('t'), type: 'terrain', asset: TERRAIN[role]!, shape: { poly: pts } });
        count++;
      }
    }
    counts[role] = count;
  }
  return { objects, counts, size: [Math.ceil(w / s), Math.ceil(h / s)] };
}

/** A guess at each colour's role: the most common is the ground, near-black the walls, blue water, green grass, the next most common buildings. */
export function guessRoles(colours: readonly { colour: RGB; share: number }[]): TraceRole[] {
  let buildingPicked = false;
  return colours.map(({ colour: { r, g, b }, share }, i) => {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (i === 0) return 'ignore';
    if (lum < 55) return 'wall';
    if (b > r + 18 && b >= g) return 'water';
    if (g > r + 12 && g > b + 8) return 'grass';
    if (!buildingPicked && share > 0.04) {
      buildingPicked = true;
      return 'building';
    }
    return 'ignore';
  });
}

export function tracedMap(
  result: TraceResult,
  o: { id: string; name: string; feetPerSquare?: number; unit?: string; style?: string; seed?: number },
): DelveMap {
  return validateMap({
    format: FORMAT,
    version: FORMAT_VERSION,
    id: o.id,
    name: o.name.trim().slice(0, 200) || 'Traced map',
    // the square size: a unit ("1.5 m"), or feet as before
    grid: { type: 'square', unit: o.unit ?? `${o.feetPerSquare ?? 5} ft` },
    style: { preset: o.style ?? 'clean' },
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    objects: result.objects,
  });
}
