// A first look at a map picture before tracing it: its main colours and how
// each sits in the picture, a printed grid, whether it is a dungeon or battle
// map (light floor inside dark wall lines) or a city plan (flat coloured
// blocks), and a role for each colour in either mode.
import { chroma, classify, colourStats, mainColours, type ColourSpace, type ColourStats } from './colour.ts';
import { wallThickness } from './dungeon.ts';
import { detectGrid, wallLattice, type GridFit } from './grid.ts';
import type { RGB } from './raster.ts';
import { guessPaintedRoles, paintedSmoothing } from './painted.ts';
import { kuwahara, textureShare } from './smooth.ts';
import { guessRoles, type TraceMode, type TraceRole } from './trace.ts';

export interface PictureAnalysis {
  /** The main colours for the mode, the space they are in, and a guessed role for each. */
  colours: { colour: RGB; share: number }[];
  space: ColourSpace;
  roles: TraceRole[];
  /** The perceptual colours' statistics (the mode and the dungeon roles are judged on them). */
  stats: ColourStats[];
  grid: GridFit | null;
  mode: TraceMode;
  /** Painted (textured: smoothed before its colours were found), how textured, and the smoothed copy. */
  painted: boolean;
  texture: number;
  smoothed?: Uint8ClampedArray;
  /** Why that mode, in a few words for the page. */
  why: string;
  /** The wall lines' thickness in pixels (the dungeon-mode wall colours), if there are long straight walls. */
  wallWidth: number | null;
  /** Without a grid: the lattice the walls stand on (a good guess for the squares), if they are straight enough. */
  wallGrid: GridFit | null;
  /** Without a grid: pixels per square if the walls are of a usual thickness (a rougher guess). */
  wallScale: number | null;
}

const isBlue = (s: ColourStats) => chroma(s.lab) >= 10 && s.lab.b < -6 && s.lab.b < -Math.abs(s.lab.a) * 0.6;
const isGreen = (s: ColourStats) => chroma(s.lab) >= 12 && s.lab.a < -8 && s.lab.a < -Math.abs(s.lab.b) * 0.5;

/**
 * Roles for a dungeon picture: the darkest colour draws the walls (and text,
 * grid, hatching), the light colour that sits enclosed most is the floor (with
 * near shades of it), blue is water and green grass unless it is the ground
 * round the map, and the rest is left out.
 */
export function guessDungeonRoles(stats: readonly ColourStats[], cell?: number): TraceRole[] {
  const roles: TraceRole[] = stats.map(() => 'ignore');
  if (!stats.length) return roles;
  // walls: very dark colours, and the darkest one if it's darkish
  let darkest = 0;
  stats.forEach((s, i) => {
    if (s.lab.l < stats[darkest]!.lab.l) darkest = i;
  });
  stats.forEach((s, i) => {
    if (s.lab.l < 38 && chroma(s.lab) < 40) roles[i] = 'wall';
  });
  if (stats[darkest]!.lab.l < 60 && stats[darkest]!.share >= 0.005) roles[darkest] = 'wall';
  // the floor: light, and enclosed by the walls rather than round the map
  let floor = -1;
  let score = 0;
  stats.forEach((s, i) => {
    if (roles[i] !== 'ignore' || s.lab.l < 55 || s.share < 0.03) return;
    if (isBlue(s) && s.border > 0.5) return;
    const v = s.share * (0.15 + s.enclosed) * (s.lab.l / 100);
    if (v > score) {
      score = v;
      floor = i;
    }
  });
  if (floor >= 0) {
    roles[floor] = 'building';
    const f = stats[floor]!.lab;
    stats.forEach((s, i) => {
      if (roles[i] !== 'ignore' || s.lab.l < 60) return;
      const d = Math.hypot(s.lab.l - f.l, s.lab.a - f.a, s.lab.b - f.b);
      if (d < 12 && s.enclosed >= 0.3) roles[i] = 'building';
    });
  }
  stats.forEach((s, i) => {
    if (roles[i] !== 'ignore' || s.share < 0.004) return;
    // areas, not lines (a grid drawn in blue is no water)
    if (s.thickness < Math.max(6, 0.2 * (cell ?? 30))) return;
    // the ground round the whole map is no terrain
    if (s.border > 0.5) return;
    if (isBlue(s)) roles[i] = 'water';
    else if (isGreen(s)) roles[i] = 'grass';
  });
  return roles;
}

/** A city plan: some mid-tone colour (not the ground) comes in many separate blocks. */
function looksLikeCity(stats: readonly ColourStats[], w: number, h: number, cell?: number): boolean {
  // (not the ground at the picture's edge, and not a floor cut into cells by its grid lines)
  return stats.some((s, i) => i > 0 && s.share >= 0.05 && s.lab.l >= 35 && s.lab.l <= 85 && s.pieces >= 30 && s.thickness >= 0.004 * Math.max(w, h) && s.border < 0.3 && !(cell && s.pieceSize >= 0.4 * cell * cell));
}

/** Walls in drawn dungeon maps are about this thick, in squares: a scale to start from when a picture has no grid. */
export const TYPICAL_WALL = 0.12;

/** How many colours each mode looks for by default. */
export const DEFAULT_COLOURS: Record<TraceMode, number> = { dungeon: 8, city: 7 };

/** The colours, their space and role guesses for one mode: Lab with merging for dungeons, the city tracer's own RGB clusters for cities. */
export function coloursForMode(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  mode: TraceMode,
  o: { k?: number; cell?: number; painted?: boolean; smoothed?: Uint8Array | Uint8ClampedArray } = {},
): { colours: { colour: RGB; share: number }[]; roles: TraceRole[]; space: ColourSpace } {
  const k = o.k ?? (o.painted ? PAINTED_COLOURS : DEFAULT_COLOURS[mode]);
  if (mode === 'city' && !o.painted) {
    const colours = mainColours(rgba, k, { space: 'rgb' });
    return { colours, roles: guessRoles(colours), space: 'rgb' };
  }
  const src = o.painted ? (o.smoothed ?? kuwahara(rgba, w, h, paintedSmoothing(w, h), 2)) : rgba;
  const colours = mainColours(src, k, { space: 'lab' });
  const stats = colourStats(classify(src, colours.map((c) => c.colour), 'lab'), w, h, colours.map((c) => c.colour));
  return { colours, roles: mode === 'city' ? guessPaintedRoles(stats) : guessDungeonRoles(stats, o.cell), space: 'lab' };
}

/** Pictures with more texture than this (textureShare) are treated as painted: smoothed before their colours are found. */
export const PAINTED_TEXTURE = 0.12;
/** Painted pictures need more colours: two shades per roof, several greens. */
export const PAINTED_COLOURS = 12;

export function analysePicture(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  o: { k?: number; mode?: TraceMode; painted?: boolean } = {},
): PictureAnalysis {
  // painted maps (brush strokes, shaded roofs, textures) are judged on a smoothed copy
  const texture = textureShare(rgba, w, h);
  const painted = o.painted ?? texture >= PAINTED_TEXTURE;
  const smoothed = painted ? kuwahara(rgba, w, h, paintedSmoothing(w, h), 2) : undefined;
  const src = smoothed ?? rgba;
  // the mode and the scale are judged on the perceptual colours
  const lab = mainColours(src, o.k ?? (painted ? PAINTED_COLOURS : DEFAULT_COLOURS.dungeon), { space: 'lab' });
  const classes = classify(src, lab.map((c) => c.colour), 'lab');
  const stats = colourStats(classes, w, h, lab.map((c) => c.colour));
  const grid = detectGrid(rgba, w, h);
  const city = looksLikeCity(stats, w, h, grid?.cell);
  const mode: TraceMode = o.mode ?? (city ? 'city' : 'dungeon');
  const why = o.mode ? 'chosen' : city ? (painted ? 'a painted city: many roofs' : 'many separate blocks of one colour') : grid ? 'a grid was found' : 'no city blocks';
  const dungeonRoles = guessDungeonRoles(stats, grid?.cell);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) if (dungeonRoles[classes[i]!] === 'wall') ink[i] = 1;
  const wallWidth = wallThickness(ink, w, h, grid ? Math.max(10, 0.6 * grid.cell) : 24, grid ? Math.max(4, 0.45 * grid.cell) : 40);
  const own =
    mode === 'dungeon'
      ? { colours: lab, roles: dungeonRoles, space: 'lab' as const }
      : painted
        ? { colours: lab, roles: guessPaintedRoles(stats), space: 'lab' as const }
        : coloursForMode(rgba, w, h, 'city', o.k !== undefined ? { k: o.k } : {});
  const wallScale = wallWidth ? wallWidth / TYPICAL_WALL : null;
  const wallGrid = !grid && wallScale && mode === 'dungeon' ? wallLattice(ink, w, h, wallScale) : null;
  return { ...own, stats, grid, mode, why, painted, texture, ...(smoothed ? { smoothed } : {}), wallWidth, wallScale, wallGrid };
}
