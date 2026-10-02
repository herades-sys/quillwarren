// Colours for tracing a map picture: the main colours (k-means++ in CIE Lab,
// near clusters merged), each pixel's nearest one, and how each colour sits in
// the picture (thin lines or areas, at the border or enclosed), which the role
// guesses build on.
import type { RGB } from './raster.ts';

export interface Lab {
  l: number;
  a: number;
  b: number;
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LIN = Float64Array.from({ length: 256 }, (_, i) => lin(i));
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** sRGB to CIE Lab (D65): l 0..100, a and b roughly -100..100. */
export function toLab(r: number, g: number, b: number): Lab {
  const R = LIN[r | 0]!;
  const G = LIN[g | 0]!;
  const B = LIN[b | 0]!;
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

export const labOf = (c: RGB): Lab => toLab(Math.round(c.r), Math.round(c.g), Math.round(c.b));
const dE2 = (p: Lab, l: number, a: number, b: number) => (p.l - l) ** 2 + (p.a - a) ** 2 + (p.b - b) ** 2;
/** Colour difference (CIE76 ΔE). */
export const deltaE = (p: Lab, q: Lab): number => Math.sqrt(dE2(p, q.l, q.a, q.b));
export const chroma = (p: Lab): number => Math.hypot(p.a, p.b);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clusters closer than this (ΔE) are one colour: the floor and the paper around it often differ by a shade. */
export const MERGE_DELTA_E = 7;

/**
 * Where colours are clustered and compared: 'lab' (perceptual, near clusters
 * merged; dungeon pictures) or 'rgb' (plain k-means, as the city tracing has
 * always done it: its house outlines need a cluster of their own).
 */
export type ColourSpace = 'lab' | 'rgb';

export interface ColourOptions {
  space?: ColourSpace;
  /** Pixels looked at (default 60 000). */
  sample?: number;
  seed?: number;
}

/** The picture's main colours, sorted by how much of the picture each covers. */
export function mainColours(rgba: Uint8Array | Uint8ClampedArray, k = 7, o: ColourOptions = {}): { colour: RGB; share: number }[] {
  return (o.space ?? 'lab') === 'rgb' ? mainColoursRgb(rgba, k, o.sample ?? 60_000, o.seed ?? 1) : mainColoursLab(rgba, k, o.sample ?? 60_000, o.seed ?? 1);
}

/** Each pixel's nearest colour (an index), 255 for transparent pixels. */
export function classify(rgba: Uint8Array | Uint8ClampedArray, colours: readonly RGB[], space: ColourSpace = 'lab'): Uint8Array {
  return space === 'rgb' ? classifyRgb(rgba, colours) : classifyLab(rgba, colours);
}

const d2 = (a: RGB, r: number, g: number, b: number) => (a.r - r) ** 2 + (a.g - g) ** 2 + (a.b - b) ** 2;

function mainColoursRgb(rgba: Uint8Array | Uint8ClampedArray, k: number, sample: number, seed: number): { colour: RGB; share: number }[] {
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / sample));
  const pts: number[] = [];
  for (let i = 0; i < n; i += step) if (rgba[i * 4 + 3]! >= 128) pts.push(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
  const m = pts.length / 3;
  if (!m) return [];
  const rand = rng(seed);
  const centres: RGB[] = [];
  const first = Math.floor(rand() * m) * 3;
  centres.push({ r: pts[first]!, g: pts[first + 1]!, b: pts[first + 2]! });
  const best = new Float64Array(m).fill(Infinity);
  while (centres.length < Math.min(k, m)) {
    const c = centres.at(-1)!;
    let total = 0;
    for (let i = 0; i < m; i++) {
      best[i] = Math.min(best[i]!, d2(c, pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!));
      total += best[i]!;
    }
    if (total === 0) break;
    let pick = rand() * total;
    let j = 0;
    while (j < m - 1 && (pick -= best[j]!) > 0) j++;
    centres.push({ r: pts[j * 3]!, g: pts[j * 3 + 1]!, b: pts[j * 3 + 2]! });
  }
  const assign = new Int32Array(m);
  for (let it = 0; it < 14; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < m; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dd = d2(centres[c]!, pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
        if (dd < bd) {
          bd = dd;
          bi = c;
        }
      }
      assign[i] = bi;
      const s = sum[bi]!;
      s[0]! += pts[i * 3]!;
      s[1]! += pts[i * 3 + 1]!;
      s[2]! += pts[i * 3 + 2]!;
      s[3]!++;
    }
    centres.forEach((c, i) => {
      const s = sum[i]!;
      if (s[3]) {
        c.r = s[0]! / s[3]!;
        c.g = s[1]! / s[3]!;
        c.b = s[2]! / s[3]!;
      }
    });
  }
  const counts = centres.map(() => 0);
  for (let i = 0; i < m; i++) counts[assign[i]!]!++;
  return centres
    .map((c, i) => ({ colour: { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }, share: counts[i]! / m }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
}

function classifyRgb(rgba: Uint8Array | Uint8ClampedArray, colours: readonly RGB[]): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < 128) {
      out[i] = 255;
      continue;
    }
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < colours.length; c++) {
      const dd = d2(colours[c]!, r, g, b);
      if (dd < bd) {
        bd = dd;
        bi = c;
      }
    }
    out[i] = bi;
  }
  return out;
}

/**
 * The picture's main colours: k-means++ in Lab on up to `sample` pixels
 * (transparent ones skipped), then clusters closer than MERGE_DELTA_E merged.
 * Sorted by how much of the picture each covers; `colour` is the members' mean.
 */
function mainColoursLab(rgba: Uint8Array | Uint8ClampedArray, k: number, sample: number, seed: number): { colour: RGB; share: number }[] {
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / sample));
  const pts: number[] = [];
  const rgb: number[] = [];
  for (let i = 0; i < n; i += step) {
    if (rgba[i * 4 + 3]! < 128) continue;
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const p = toLab(r, g, b);
    pts.push(p.l, p.a, p.b);
    rgb.push(r, g, b);
  }
  const m = pts.length / 3;
  if (!m) return [];
  const rand = rng(seed);
  const at = (i: number): Lab => ({ l: pts[i * 3]!, a: pts[i * 3 + 1]!, b: pts[i * 3 + 2]! });
  const centres: Lab[] = [at(Math.floor(rand() * m))];
  const best = new Float64Array(m).fill(Infinity);
  while (centres.length < Math.min(k, m)) {
    const c = centres.at(-1)!;
    let total = 0;
    for (let i = 0; i < m; i++) {
      best[i] = Math.min(best[i]!, dE2(c, pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!));
      total += best[i]!;
    }
    if (total === 0) break;
    let pick = rand() * total;
    let j = 0;
    while (j < m - 1 && (pick -= best[j]!) > 0) j++;
    centres.push(at(j));
  }
  const assign = new Int32Array(m);
  const run = (cs: Lab[], iterations: number) => {
    for (let it = 0; it < iterations; it++) {
      const sum = cs.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < m; i++) {
        let bi = 0;
        let bd = Infinity;
        for (let c = 0; c < cs.length; c++) {
          const dd = dE2(cs[c]!, pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
          if (dd < bd) {
            bd = dd;
            bi = c;
          }
        }
        assign[i] = bi;
        const s = sum[bi]!;
        s[0]! += pts[i * 3]!;
        s[1]! += pts[i * 3 + 1]!;
        s[2]! += pts[i * 3 + 2]!;
        s[3]!++;
      }
      cs.forEach((c, i) => {
        const s = sum[i]!;
        if (s[3]) {
          c.l = s[0]! / s[3]!;
          c.a = s[1]! / s[3]!;
          c.b = s[2]! / s[3]!;
        }
      });
    }
  };
  run(centres, 14);
  // merge near clusters (the closest pair first), then settle once more
  let cs = centres.slice();
  for (;;) {
    const counts = cs.map(() => 0);
    for (let i = 0; i < m; i++) counts[assign[i]!]!++;
    let pair: [number, number] | null = null;
    let pd = MERGE_DELTA_E;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const d = deltaE(cs[i]!, cs[j]!);
      if (d < pd && counts[i]! && counts[j]!) {
        pd = d;
        pair = [i, j];
      }
    }
    const empty = counts.findIndex((c) => c === 0);
    if (!pair && empty < 0) break;
    if (pair) {
      const [i, j] = pair;
      const wi = counts[i]!;
      const wj = counts[j]!;
      const a = cs[i]!;
      const b = cs[j]!;
      cs[i] = { l: (a.l * wi + b.l * wj) / (wi + wj), a: (a.a * wi + b.a * wj) / (wi + wj), b: (a.b * wi + b.b * wj) / (wi + wj) };
      cs = cs.filter((_, q) => q !== j);
    } else cs = cs.filter((_, q) => q !== empty);
    run(cs, 3);
  }
  const sums = cs.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < m; i++) {
    const s = sums[assign[i]!]!;
    s[0]! += rgb[i * 3]!;
    s[1]! += rgb[i * 3 + 1]!;
    s[2]! += rgb[i * 3 + 2]!;
    s[3]!++;
  }
  return sums
    .filter((s) => s[3]! > 0)
    .map((s) => ({ colour: { r: Math.round(s[0]! / s[3]!), g: Math.round(s[1]! / s[3]!), b: Math.round(s[2]! / s[3]!) }, share: s[3]! / m }))
    .sort((a, b) => b.share - a.share);
}

/** Each pixel's nearest colour in Lab (an index), 255 for transparent pixels. */
function classifyLab(rgba: Uint8Array | Uint8ClampedArray, colours: readonly RGB[]): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  const labs = colours.map(labOf);
  // the nearest colour for each 6-bit-per-channel cell, worked out once
  const cache = new Int16Array(1 << 18).fill(-1);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < 128) {
      out[i] = 255;
      continue;
    }
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let c = cache[key]!;
    if (c < 0) {
      const p = toLab((r & 0xfc) | 2, (g & 0xfc) | 2, (b & 0xfc) | 2);
      let bd = Infinity;
      c = 0;
      for (let q = 0; q < labs.length; q++) {
        const d = dE2(labs[q]!, p.l, p.a, p.b);
        if (d < bd) {
          bd = d;
          c = q;
        }
      }
      cache[key] = c;
    }
    out[i] = c;
  }
  return out;
}

/** How one colour sits in the picture. */
export interface ColourStats {
  share: number;
  lab: Lab;
  /** Share of the picture's edge pixels in this colour. */
  border: number;
  /** Share of this colour's pixels in parts that don't touch the picture's edge. */
  enclosed: number;
  /** Typical thickness in pixels (2 × area / outline length): small for lines and text, big for areas. */
  thickness: number;
  /** Parts of at least 0.02 % of the picture. */
  pieces: number;
  /** The middle size of those parts, in (full-size) pixels. */
  pieceSize: number;
}

/** Statistics for each colour of a classified picture (read on every other pixel, so it stays quick). */
export function colourStats(classes: Uint8Array, w: number, h: number, colours: readonly RGB[]): ColourStats[] {
  const count = colours.length;
  const sw = Math.ceil(w / 2);
  const sh = Math.ceil(h / 2);
  const c = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) c[y * sw + x] = classes[Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2)]!;
  const area = new Float64Array(count);
  const edge = new Float64Array(count);
  const border = new Float64Array(count);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const k = c[y * sw + x]!;
      if (k >= count) continue;
      area[k]!++;
      if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) border[k]!++;
      if (x + 1 < sw && c[y * sw + x + 1] !== k) {
        edge[k]!++;
        const o = c[y * sw + x + 1]!;
        if (o < count) edge[o]!++;
      }
      if (y + 1 < sh && c[(y + 1) * sw + x] !== k) {
        edge[k]!++;
        const o = c[(y + 1) * sw + x]!;
        if (o < count) edge[o]!++;
      }
    }
  }
  // parts of each colour (4-connected): which touch the edge, and how many are not tiny
  const seen = new Uint8Array(sw * sh);
  const queue = new Int32Array(sw * sh);
  const enclosedPx = new Float64Array(count);
  const pieces = new Float64Array(count);
  const sizes = Array.from({ length: count }, () => [] as number[]);
  const minPiece = Math.max(4, sw * sh * 0.0002);
  for (let start = 0; start < c.length; start++) {
    if (seen[start]) continue;
    const k = c[start]!;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let touches = false;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % sw;
      const y = (i - x) / sw;
      if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) touches = true;
      if (x > 0 && !seen[i - 1] && c[i - 1] === k) (seen[i - 1] = 1), (queue[tail++] = i - 1);
      if (x < sw - 1 && !seen[i + 1] && c[i + 1] === k) (seen[i + 1] = 1), (queue[tail++] = i + 1);
      if (y > 0 && !seen[i - sw] && c[i - sw] === k) (seen[i - sw] = 1), (queue[tail++] = i - sw);
      if (y < sh - 1 && !seen[i + sw] && c[i + sw] === k) (seen[i + sw] = 1), (queue[tail++] = i + sw);
    }
    if (k >= count) continue;
    if (!touches) enclosedPx[k]! += tail;
    if (tail >= minPiece) {
      pieces[k]!++;
      sizes[k]!.push(tail);
    }
  }
  const borderTotal = 2 * (sw + sh) - 4;
  return Array.from({ length: count }, (_, k) => ({
    share: area[k]! / (sw * sh),
    lab: labOf(colours[k]!),
    border: border[k]! / borderTotal,
    enclosed: area[k]! ? enclosedPx[k]! / area[k]! : 0,
    // in full-size pixels
    thickness: edge[k]! ? (4 * area[k]!) / edge[k]! : Math.max(w, h),
    pieces: pieces[k]!,
    pieceSize: sizes[k]!.length ? 4 * sizes[k]!.sort((a, b) => a - b)[sizes[k]!.length >> 1]! : 0,
  }));
}
