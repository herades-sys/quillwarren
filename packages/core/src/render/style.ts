// Style presets. Sizes are in grid squares, so a map looks the same at any
// export resolution (at Roll20's 70 px per square, 0.1 sq = 7 px).
import type { ColourMode } from '../assets/colour.ts';
import { contrastRatio, isDark, mixColours, normalizeHex } from '../colour-math.ts';
import type { DelveMap } from '../schema.ts';

export interface HatchStyle {
  color: string;
  /** How far from the walls clusters are placed. */
  width: number;
  /** Lattice spacing between cluster centres. */
  spacing: number;
  strokesPerCluster: number;
  length: number;
  gap: number;
  strokeWidth: number;
}

export interface Style {
  name: string;
  background: string;
  backgroundGrid: { color: string; width: number } | null;
  /** opacity below 1 lets the paper show through (parchment). */
  floor: { color: string; opacity?: number };
  /** sketch: extra thin, differently wobbled passes over each wall, as if drawn by hand. */
  walls: { color: string; width: number; roughness: number; sketch?: number };
  shading: { color: string; width: number } | null;
  hatching: HatchStyle | null;
  shadow: { color: string; offset: [number, number]; opacity: number } | null;
  grid: { style: 'lines' | 'dots' | 'none'; color: string; width: number; opacity: number };
  doors: { fill: string; stroke: string; strokeWidth: number };
  stairs: { color: string; width: number };
  /** font: free labels; numberFont: room numbers (needs clear lining figures). */
  labels: { font: string; numberFont: string; size: number; color: string };
  /** Props and terrain tiles: the three asset inks become these colours. */
  /** Colour props (palette colour): as drawn, toned toward the props' sepia, or by lightness on the props' ink–shade–paper ramp (assets/colour.ts). */
  colours: ColourMode;
  props: { ink: string; paper: string; shade: string };
  /** Terrain tint: 1 = the tile's own tint, lower mixes it toward the floor colour; gray drops the hue (print), and tone then colours the gray (sepia). */
  terrain: { mix: number; gray: boolean; tone?: string };
  /** Fog of war: its colour, and how strongly the GM view dims fogged areas (0..1). */
  fog: { color: string; dim: number };
}

const FONT = 'IM FELL English';
/** IM FELL's old-style figures make "1" read as "I"; room numbers use Marcellus SC. */
const NUMBER_FONT = 'Marcellus SC';

export const PRESETS: Record<string, Style> = {
  'classic-hatching': {
    name: 'Classic hatching',
    background: '#EFEAE2',
    backgroundGrid: null,
    floor: { color: '#F0ECE0' },
    walls: { color: '#111111', width: 0.14, roughness: 1 },
    shading: { color: '#C9C1B2', width: 0.32 },
    hatching: {
      color: '#1A1A1A',
      width: 0.85,
      spacing: 0.3,
      strokesPerCluster: 3,
      length: 0.42,
      gap: 0.085,
      strokeWidth: 0.032,
    },
    shadow: { color: '#8C867D', offset: [0.3, 0.22], opacity: 1 },
    grid: { style: 'lines', color: '#5A5650', width: 0.022, opacity: 0.35 },
    doors: { fill: '#F0ECE0', stroke: '#111111', strokeWidth: 0.05 },
    stairs: { color: '#111111', width: 0.04 },
    labels: { font: FONT, numberFont: NUMBER_FONT, size: 0.9, color: '#111111' },
    props: { ink: '#1A1A1A', paper: '#FBF8F1', shade: '#B7AD9B' },
    colours: { mode: 'drawn' },
    terrain: { mix: 1, gray: false },
    fog: { color: '#24211D', dim: 0.5 },
  },
  clean: {
    name: 'Clean',
    background: '#FFFFFF',
    backgroundGrid: null,
    floor: { color: '#FFFFFF' },
    walls: { color: '#22252A', width: 0.1, roughness: 0 },
    shading: null,
    hatching: null,
    shadow: { color: '#C8CDD4', offset: [0.12, 0.12], opacity: 1 },
    grid: { style: 'lines', color: '#9AA3AE', width: 0.02, opacity: 0.6 },
    doors: { fill: '#FFFFFF', stroke: '#22252A', strokeWidth: 0.045 },
    stairs: { color: '#22252A', width: 0.035 },
    labels: { font: FONT, numberFont: NUMBER_FONT, size: 0.8, color: '#22252A' },
    props: { ink: '#22252A', paper: '#FFFFFF', shade: '#C3C9D1' },
    colours: { mode: 'drawn' },
    terrain: { mix: 0.8, gray: false },
    fog: { color: '#2A2F36', dim: 0.45 },
  },
  'old-school-blue': {
    name: 'Old-school blue',
    background: '#3674AC',
    backgroundGrid: { color: '#4D86BA', width: 0.03 },
    floor: { color: '#FFFFFF' },
    walls: { color: '#0F2438', width: 0.1, roughness: 0 },
    shading: null,
    hatching: null,
    shadow: null,
    grid: { style: 'lines', color: '#9CBBDA', width: 0.03, opacity: 1 },
    doors: { fill: '#FFFFFF', stroke: '#0F2438', strokeWidth: 0.05 },
    stairs: { color: '#0F2438', width: 0.04 },
    labels: { font: FONT, numberFont: NUMBER_FONT, size: 0.9, color: '#0F2438' },
    props: { ink: '#0F2438', paper: '#FFFFFF', shade: '#9CBBDA' },
    colours: { mode: 'ramp', steps: 6 },
    terrain: { mix: 0.55, gray: false },
    fog: { color: '#0B1B2B', dim: 0.5 },
  },
  print: {
    name: 'Black and white print',
    background: '#FFFFFF',
    backgroundGrid: null,
    floor: { color: '#FFFFFF' },
    walls: { color: '#000000', width: 0.12, roughness: 0.6 },
    shading: null,
    hatching: {
      color: '#000000',
      width: 0.7,
      spacing: 0.32,
      strokesPerCluster: 3,
      length: 0.4,
      gap: 0.09,
      strokeWidth: 0.03,
    },
    shadow: null,
    grid: { style: 'dots', color: '#000000', width: 0.05, opacity: 0.5 },
    doors: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 0.05 },
    stairs: { color: '#000000', width: 0.035 },
    labels: { font: FONT, numberFont: NUMBER_FONT, size: 0.9, color: '#000000' },
    props: { ink: '#000000', paper: '#FFFFFF', shade: '#BDBDBD' },
    colours: { mode: 'ramp', steps: 6 },
    terrain: { mix: 0.45, gray: true },
    fog: { color: '#FFFFFF', dim: 0.7 },
  },
  // Brown ink on old paper, drawn by hand: the players' handout (handout.ts) puts it on a parchment sheet.
  parchment: {
    name: 'Parchment',
    background: '#E4CE9C',
    backgroundGrid: null,
    floor: { color: '#F3E6C4', opacity: 0.45 },
    walls: { color: '#2E1F11', width: 0.11, roughness: 2.4, sketch: 2 },
    shading: { color: '#B89865', width: 0.2 },
    hatching: {
      color: '#3B2814',
      width: 0.75,
      spacing: 0.32,
      strokesPerCluster: 3,
      length: 0.4,
      gap: 0.09,
      strokeWidth: 0.026,
    },
    shadow: null,
    grid: { style: 'none', color: '#3B2814', width: 0.02, opacity: 0.3 },
    doors: { fill: '#EEDDB6', stroke: '#2E1F11', strokeWidth: 0.045 },
    stairs: { color: '#2E1F11', width: 0.035 },
    labels: { font: FONT, numberFont: NUMBER_FONT, size: 0.9, color: '#2E1F11' },
    props: { ink: '#2E1F11', paper: '#EEDDB6', shade: '#B89A6A' },
    colours: { mode: 'toned', chroma: 0.45 },
    terrain: { mix: 0.55, gray: true, tone: '#8C6A3C' },
    fog: { color: '#2E1F11', dim: 0.45 },
  },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as Plain, v) : v;
  }
  return out;
}

/** Turn {"walls.width": 0.2} into {walls: {width: 0.2}}; nested objects pass through. */
function expandDotted(overrides: Plain): Plain {
  let out: Plain = {};
  for (const [k, v] of Object.entries(overrides)) {
    const nested = k
      .split('.')
      .reverse()
      .reduce<unknown>((acc, part) => ({ [part]: acc }), v) as Plain;
    out = deepMerge(out, nested);
  }
  return out;
}

export function resolveStyle(map: Pick<DelveMap, 'style'>): Style {
  const presetName = map.style?.preset ?? 'classic-hatching';
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`unknown style preset "${presetName}" (expected ${Object.keys(PRESETS).join(', ')})`);
  }
  const overrides = map.style?.overrides;
  if (!overrides) return preset;
  const expanded = expandDotted(overrides);
  return onOwnBackground(preset, expanded, deepMerge(preset as unknown as Plain, expanded) as unknown as Style);
}

/** Below this contrast with the map's own background, the hatching is drawn in a light (or dark) ink instead. */
export const MIN_HATCH_CONTRAST = 2;

/** The background grid's lines on a background: a shade lighter on dark colours, darker on light ones (old-school blue's #4D86BA on #3674AC). */
export const backgroundGridColour = (bg: string): string => (isDark(bg) ? mixColours(bg, '#FFFFFF', 0.12) : mixColours(bg, '#000000', 0.1));

/** Hatching that stays readable on a background its own ink vanishes on: the background mixed halfway to white (or black). */
export const hatchingInkOn = (bg: string): string => (isDark(bg) ? mixColours(bg, '#FFFFFF', 0.5) : mixColours(bg, '#000000', 0.6));

/**
 * A map's own background colour (style.overrides.background, the editor's
 * colour wheel): the parts drawn on the background follow it so they stay
 * readable, unless the overrides set them too. The background grid (old-school
 * blue) takes a shade of the new colour, and hatching whose ink would vanish
 * (dark hatching on a dark colour) is drawn in a light ink. The style's own
 * colour, or no override, leaves the style exactly as it was.
 */
function onOwnBackground(preset: Style, expanded: Plain, s: Style): Style {
  const bg = normalizeHex(expanded.background);
  if (!bg) return s;
  // the style's own colour, in any spelling, is no change at all
  if (bg === normalizeHex(preset.background)) return s.background === preset.background ? s : { ...s, background: preset.background };
  const out: Style = { ...s, background: bg };
  if (out.backgroundGrid && !('backgroundGrid' in expanded)) out.backgroundGrid = { ...out.backgroundGrid, color: backgroundGridColour(bg) };
  const hatchSet = 'hatching' in expanded && !(isPlain(expanded.hatching) && !('color' in expanded.hatching));
  if (out.hatching && !hatchSet && contrastRatio(out.hatching.color, bg) < MIN_HATCH_CONTRAST) out.hatching = { ...out.hatching, color: hatchingInkOn(bg) };
  return out;
}
