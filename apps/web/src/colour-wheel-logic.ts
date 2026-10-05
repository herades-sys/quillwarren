// The colour wheel's geometry and keys (colour-wheel.ts draws it): hue goes
// round the ring clockwise from the top (red), saturation grows from grey in
// the middle to full at the rim, and a slider sets the brightness. Saturation
// runs along the radius squared, so the muted colours maps are usually drawn
// on (parchment, slate, stone) get most of the wheel's area. Pure, for tests.
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from '@delve/core';

/** Saturation = (distance / radius) ^ SAT_GAMMA. */
export const SAT_GAMMA = 2;

const wrap = (h: number): number => ((h % 360) + 360) % 360;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Where a hue and saturation sit on a wheel of this radius, from its centre (y down). */
export function wheelPoint(c: Pick<Hsv, 'h' | 's'>, radius: number): { x: number; y: number } {
  const a = (wrap(c.h) * Math.PI) / 180;
  const d = radius * clamp01(c.s) ** (1 / SAT_GAMMA);
  return { x: Math.sin(a) * d, y: -Math.cos(a) * d };
}

/** The hue and saturation at a point from the wheel's centre (outside the rim: on the rim). */
export function wheelAt(x: number, y: number, radius: number): { h: number; s: number } {
  const d = Math.hypot(x, y);
  const h = d < 1e-9 ? 0 : wrap((Math.atan2(x, -y) * 180) / Math.PI);
  return { h, s: clamp01(d / radius) ** SAT_GAMMA };
}

/** What the arrow keys do on the wheel: ← → turn the hue, ↑ ↓ change the saturation; Shift takes bigger steps. Null for other keys. */
export function wheelKey(c: Hsv, key: string, shift: boolean): Hsv | null {
  const hueStep = shift ? 15 : 2;
  const satStep = shift ? 0.1 : 0.02;
  switch (key) {
    case 'ArrowLeft':
      return { ...c, h: wrap(c.h - hueStep) };
    case 'ArrowRight':
      return { ...c, h: wrap(c.h + hueStep) };
    case 'ArrowUp':
      return { ...c, s: clamp01(Math.round((c.s + satStep) * 1000) / 1000) };
    case 'ArrowDown':
      return { ...c, s: clamp01(Math.round((c.s - satStep) * 1000) / 1000) };
    case 'Home':
      return { ...c, s: 0 };
    case 'End':
      return { ...c, s: 1 };
    default:
      return null;
  }
}

/**
 * A hex as wheel coordinates. A grey (or black) has no hue of its own, so it
 * keeps `keep`'s hue (and black keeps its saturation too): dragging the
 * brightness down to black and back doesn't lose the colour.
 */
export function hsvOf(hex: string, keep?: Hsv): Hsv {
  const c = hexToHsv(hex);
  if (!keep) return c;
  if (hsvToHex(keep) === normalizeHex(hex)) return keep;
  if (c.v === 0) return { ...keep, v: 0 };
  if (c.s === 0) return { ...c, h: keep.h };
  return c;
}

/** The colour as words for screen readers: "hue 36°, saturation 5%, brightness 94%". */
export const hsvText = (c: Hsv): string => `hue ${Math.round(c.h)}°, saturation ${Math.round(c.s * 100)}%, brightness ${Math.round(c.v * 100)}%`;

/** Pixels of a wheel image `size` px across at brightness v, RGBA, the rim anti-aliased over one pixel. */
export function wheelPixels(size: number, v: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(size * size * 4);
  const r = size / 2;
  const R = r - 0.5;
  const V = clamp01(v);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i + 0.5 - r;
      const y = j + 0.5 - r;
      const d = Math.hypot(x, y);
      const alpha = Math.min(1, Math.max(0, R - d + 0.5));
      if (alpha <= 0) continue;
      const h = d < 1e-9 ? 0 : wrap((Math.atan2(x, -y) * 180) / Math.PI);
      const s = Math.min(1, d / R) ** SAT_GAMMA;
      // hsv -> rgb inline (this runs for every pixel)
      const H = h / 60;
      const c = V * s;
      const xx = c * (1 - Math.abs((H % 2) - 1));
      const m = V - c;
      const [rr, gg, bb] = H < 1 ? [c, xx, 0] : H < 2 ? [xx, c, 0] : H < 3 ? [0, c, xx] : H < 4 ? [0, xx, c] : H < 5 ? [xx, 0, c] : [c, 0, xx];
      const k = (j * size + i) * 4;
      out[k] = (rr + m) * 255;
      out[k + 1] = (gg + m) * 255;
      out[k + 2] = (bb + m) * 255;
      out[k + 3] = alpha * 255;
    }
  }
  return out;
}
