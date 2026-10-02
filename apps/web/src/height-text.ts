// Heights as typed and shown in the editor's fields, and the movement overlay's tints (no DOM, so they can be tested).

/** A height as typed ("+10", "-5", "7,5"), rounded to hundredths; null if it isn't a number. */
export function parseHeight(raw: string): number | null {
  const s = raw.replace(',', '.').replace(/[−–]/g, '-').replace(/\s+/g, '').replace(/[a-z]+$/i, '');
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) && Math.abs(v) <= 10000 ? Math.round(v * 100) / 100 : null;
}

/** "+10", "−5", "0": a height for a field. */
export const heightValue = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

const mixHex = (a: string, b: string, k: number): string => {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const x = p(a);
  const y = p(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * k).toString(16).padStart(2, '0')).join('')}`;
};

/** The overlay's tint for a height: blues going down, yellow to orange going up, none at the floor. */
export function bandColor(height: number, unit: { size: number }): string | null {
  if (Math.abs(height) < 1e-9) return null;
  const t = Math.min(1, Math.abs(height) / (unit.size * 4));
  return height > 0 ? mixHex('#f2c94c', '#e8590c', t) : mixHex('#7cc4f0', '#2b59c3', t);
}
