// Colour props (docs/ASSETS-COLOUR.md) are drawn in a fixed palette of 55
// colours instead of the three inks. Each map style shows them its own way
// (Style.colours): classic and clean as drawn, parchment toned toward the
// style's sepia, old-school blue and print mapped by lightness onto the style's
// own ramp from ink through shade to paper, in a few steps. The map from
// palette colour to style colour is worked out once per style and reused.
import type { Style } from '../render/style.ts';

/** The Delve palette, by name, exactly as in Prompt 0 of docs/ASSETS-COLOUR.md (a test keeps the two equal). */
export const COLOUR_PALETTE = {
  ink: '#000000',
  paper: '#FFFFFF',
  shade: '#999999',
  'leaf-deep': '#24452A',
  'leaf-dark': '#345F34',
  leaf: '#4F803C',
  'leaf-light': '#7EA34C',
  'leaf-pale': '#AFC77A',
  'needle-dark': '#233D33',
  needle: '#3B5E4B',
  'needle-light': '#5E8068',
  'gold-leaf': '#D9A63A',
  'orange-leaf': '#C76B2A',
  'red-leaf': '#9C3626',
  blossom: '#E9A7BA',
  'blossom-pale': '#F6E3EA',
  'bark-dark': '#3E2C21',
  bark: '#5C4130',
  wood: '#86603D',
  'wood-light': '#B48A5A',
  'wood-pale': '#D6B98C',
  'stone-dark': '#4E4B47',
  stone: '#7C776F',
  'stone-light': '#ABA598',
  'stone-pale': '#CFC9BC',
  earth: '#6B5139',
  sand: '#D1BA8A',
  straw: '#D8C07A',
  moss: '#6E7F3A',
  'water-deep': '#2C5878',
  water: '#4A86A6',
  'water-light': '#8DBBCF',
  ice: '#CFE5EC',
  snow: '#F1F5F7',
  red: '#962B2B',
  'red-light': '#C0524A',
  blue: '#2D4A84',
  'blue-light': '#5A7EB6',
  green: '#2E6849',
  purple: '#5A3876',
  'purple-light': '#8C6BB0',
  yellow: '#D9B44A',
  cream: '#EADFC2',
  black: '#2A2626',
  iron: '#575C63',
  'iron-light': '#8A9098',
  brass: '#AE873C',
  gold: '#D4A93A',
  silver: '#C8CDD3',
  flame: '#EE8B2B',
  'flame-core': '#F7D766',
  ember: '#B5381D',
  witchfire: '#6FCB5A',
  arcane: '#8F6AD8',
  glow: '#79BDE9',
} as const;

/** The palette's hex values (upper case), for the SVG whitelist. */
export const COLOUR_HEX: ReadonlySet<string> = new Set(Object.values(COLOUR_PALETTE));

/** How a style shows colour props: as drawn, toned toward its sepia (keeping `chroma` of each colour's hue), or by lightness on its ramp in `steps` tones. */
export type ColourMode = { mode: 'drawn' } | { mode: 'toned'; chroma: number } | { mode: 'ramp'; steps: number };

type Rgb = [number, number, number];

const rgbOf = (hex: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1]!, 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const hexOf = (rgb: readonly number[]): string =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const encode = (l: number): number => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);

/** Perceived lightness, CIE L* scaled to 0 (black) … 1 (white). */
export function lightness(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const f = y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116;
  return Math.max(0, Math.min(1, (116 * f - 16) / 100));
}

/** Where the shade ink sits on a ramp: the lightness of #999999, so shade lands exactly on the style's shade. */
const SHADE_AT = lightness(COLOUR_PALETTE.shade);

/** The style's ink → shade → paper ramp at lightness t (0…1), mixed in sRGB. */
function ramp(p: Style['props'], t: number): Rgb {
  const [a, b, k] = t <= SHADE_AT ? [p.ink, p.shade, t / SHADE_AT] : [p.shade, p.paper, (t - SHADE_AT) / (1 - SHADE_AT)];
  const x = rgbOf(a);
  const y = rgbOf(b);
  return x.map((v, i) => v + (y[i]! - v) * k) as Rgb;
}

/** The darkest tone a ramp style gives a fill: well clear of ink, so the ink lines drawn over it still read. */
const DARKEST = 0.26;

/**
 * The tones a ramp style uses for everything but ink: `steps` lightnesses from
 * DARKEST to paper, one of them exactly shade, evenly spaced below shade and
 * above it. Ink itself stays ink.
 */
export function rampLevels(steps: number): number[] {
  const n = Math.max(3, Math.round(steps));
  const above = Math.max(1, Math.min(n - 2, Math.round(((n - 1) * (1 - SHADE_AT)) / (1 - DARKEST))));
  const below = n - 1 - above;
  return [
    ...Array.from({ length: below }, (_, i) => DARKEST + ((SHADE_AT - DARKEST) * i) / below),
    ...Array.from({ length: above + 1 }, (_, i) => SHADE_AT + ((1 - SHADE_AT) * i) / above),
  ];
}

/** One palette colour as a style shows it. */
export function styleColour(hex: string, props: Style['props'], how: ColourMode): string {
  const up = hex.toUpperCase();
  if (how.mode === 'drawn') return up;
  if (up === COLOUR_PALETTE.ink) return props.ink.toUpperCase();
  const t = lightness(up);
  if (how.mode === 'ramp') {
    const levels = rampLevels(how.steps);
    const near = levels.reduce((best, l) => (Math.abs(l - t) < Math.abs(best - t) ? l : best), levels[0]!);
    return hexOf(ramp(props, near));
  }
  // toned: the sepia of the same lightness, plus a little of the colour's own hue (its distance from a gray as light)
  const rgb = rgbOf(up);
  const y = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const gray = encode(y);
  const base = ramp(props, t);
  return hexOf(base.map((v, i) => v + (rgb[i]! - gray) * how.chroma));
}

/** Palette colour (upper-case hex) → what the style draws, or null when it draws them as they are. */
export type ColourMap = ReadonlyMap<string, string> | null;

const maps = new Map<string, ColourMap>();

/** The whole palette for a style, worked out once per distinct setting (a map's style overrides can change the inks). */
export function colourMap(style: Pick<Style, 'props' | 'colours'>): ColourMap {
  const how = style.colours ?? { mode: 'drawn' };
  if (how.mode === 'drawn') return null;
  const key = JSON.stringify([how, style.props.ink, style.props.shade, style.props.paper]);
  let m = maps.get(key);
  if (m === undefined) {
    m = new Map([...COLOUR_HEX].map((h) => [h, styleColour(h, style.props, how)]));
    maps.set(key, m);
  }
  return m;
}

/** A style colour as it goes into the art, escaped: the props' ink of a map saved before style overrides were checked may hold anything (a hex colour comes out unchanged). */
const inkValue = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A colour prop's body in a style's colours. Anything not in the palette (there shouldn't be any after parseAssetSvg) is left alone. */
export function recolour(body: string, map: ColourMap): string {
  if (!map) return body;
  return body.replace(/#[0-9A-F]{6}\b/g, (c) => inkValue(map.get(c) ?? c));
}

/** The palette colour nearest to any colour (for stray values in a colour prop). */
export function nearestPaletteColour(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  let best: string = COLOUR_PALETTE.ink;
  let dist = Infinity;
  for (const h of COLOUR_HEX) {
    const [x, y, z] = rgbOf(h);
    const d = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
    if (d < dist) [best, dist] = [h, d];
  }
  return best;
}
