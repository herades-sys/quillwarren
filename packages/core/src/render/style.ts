// Style presets. Sizes are in grid squares, so a map looks the same at any
// export resolution (at Roll20's 70 px per square, 0.1 sq = 7 px).
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
  floor: { color: string };
  walls: { color: string; width: number; roughness: number };
  shading: { color: string; width: number } | null;
  hatching: HatchStyle | null;
  shadow: { color: string; offset: [number, number]; opacity: number } | null;
  grid: { style: 'lines' | 'dots' | 'none'; color: string; width: number; opacity: number };
  doors: { fill: string; stroke: string; strokeWidth: number };
  stairs: { color: string; width: number };
  labels: { font: string; size: number; color: string };
}

const FONT = 'IM FELL English';

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
    labels: { font: FONT, size: 0.9, color: '#111111' },
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
    labels: { font: FONT, size: 0.8, color: '#22252A' },
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
    labels: { font: FONT, size: 0.9, color: '#0F2438' },
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
    labels: { font: FONT, size: 0.9, color: '#000000' },
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
  return deepMerge(preset as unknown as Plain, expandDotted(overrides)) as unknown as Style;
}
