// Colour maths for a map's own background colour and the editor's colour
// wheel: hex <-> RGB <-> HSV, mixing, and WCAG contrast. Pure functions, no
// DOM, so the browser and the server share them.

/** 0–255 per channel. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Hue in degrees 0 ≤ h < 360, saturation and value (brightness) 0–1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A typed colour as "#RRGGBB" (upper case), or null when it isn't one.
 * Takes "#abc", "abc", "#aabbcc" and "AABBCC", with spaces around.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = HEX.exec(input.trim());
  if (!m) return null;
  const d = m[1]!;
  const full = d.length === 3 ? [...d].map((c) => c + c).join('') : d;
  return `#${full.toUpperCase()}`;
}

/** True for "#RRGGBB" and "#RGB" (the forms a map stores). */
export const isHexColour = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex);
  if (!n) throw new Error(`not a colour: ${JSON.stringify(hex)} (expected "#RRGGBB")`);
  const v = parseInt(n.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** RGB to HSV. Greys have hue 0 and saturation 0. */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV to RGB (unrounded, 0–255). Hue wraps; saturation and value are clamped to 0–1. */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const H = (((h % 360) + 360) % 360) / 60;
  const S = clamp(s, 0, 1);
  const V = clamp(v, 0, 1);
  const c = V * S;
  const x = c * (1 - Math.abs((H % 2) - 1));
  const m = V - c;
  const [r, g, b] = H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export const hexToHsv = (hex: string): Hsv => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

/** a mixed toward b by t (0 = a, 1 = b), in sRGB. */
export function mixColours(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two colours, 1 (the same) … 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Dark enough that light ink reads better on it than dark ink. */
export const isDark = (hex: string): boolean => relativeLuminance(hex) < 0.18;
