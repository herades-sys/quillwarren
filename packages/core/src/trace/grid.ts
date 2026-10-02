// Finding a printed grid in a map picture: its cell size and where its lines
// are, in picture pixels. Thin lines (darker or lighter than both sides) are
// summed along each column and row; walls, filled areas and edges barely
// count, and a cap keeps strong ink (walls, text) from outweighing faint grid
// lines. The sums are searched for the strongest repeat (a frequency scan),
// the fundamental is picked over its harmonics, refined to a fraction of a
// pixel, and its phase gives the lines' offset. Hatching, text and lines
// missing outside the map only add noise to the scan.

export interface GridFit {
  /** Picture pixels per grid cell. */
  cell: number;
  /** Where grid lines cross, in picture pixels from the top left corner (0 ≤ offset < cell). */
  offset: [number, number];
  /** How regular the lines are, 0 (no grid) to 1 (clean lines): the share of line ink that falls on the grid. */
  strength: number;
  /** The same per axis (vertical lines, horizontal lines). */
  strengthXY: [number, number];
  /** The share of grid positions (between the outermost lines) that carry a line. */
  fill: number;
}

/** Below this strength a repeat is not taken for a grid. */
export const GRID_MIN_STRENGTH = 0.3;

/** Luminance 0..255 (Rec. 709 weights on the sRGB values; transparent pixels count as white). */
export function luminance(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = rgba[i * 4 + 3]! < 128 ? 255 : Math.round(0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!);
  }
  return out;
}

/** Thin-line strength is capped here, so a black wall counts no more than a faint grey grid line. */
const CAP = 40;

/**
 * How much pixel (x, y) looks like part of a thin line (up to 5 px wide) when
 * looked at across the step (sx, sy): darker or lighter than the pixels on both
 * sides. 0 on edges and inside filled areas.
 */
function thinAcross(lum: Uint8Array, w: number, h: number, x: number, y: number, sx: number, sy: number): number {
  const c = lum[y * w + x]!;
  let best = 0;
  for (let d = 1; d <= 3; d++) {
    const ax = x - d * sx;
    const ay = y - d * sy;
    const bx = x + d * sx;
    const by = y + d * sy;
    if (ax < 0 || bx < 0 || ax >= w || bx >= w || ay < 0 || by < 0 || ay >= h || by >= h) break;
    const a = lum[ay * w + ax]!;
    const b = lum[by * w + bx]!;
    const dark = Math.min(a, b) - c;
    const light = c - Math.max(a, b);
    const r = dark > light ? dark : light;
    if (r > best) best = r;
  }
  return best > CAP ? CAP : best;
}

/** How much darker (x, y) is than every pixel on a square ring 2, 3, 4 or 6 px around it: a dot. */
function spot(lum: Uint8Array, w: number, h: number, x: number, y: number): number {
  const c = lum[y * w + x]!;
  let best = 0;
  for (const r of [2, 3, 4, 6]) {
    if (x - r < 0 || y - r < 0 || x + r >= w || y + r >= h) break;
    let lo = 255;
    for (let k = -r; k < r && lo > c; k++) {
      for (const q of [lum[(y - r) * w + x + k]!, lum[(y + r) * w + x - k]!, lum[(y + k) * w + x + r]!, lum[(y - k) * w + x - r]!]) if (q < lo) lo = q;
    }
    // dark dots only: light pockets between hatching strokes would pass as light ones
    const s = lo - c;
    if (s > best) best = s;
  }
  return best > CAP ? CAP : best;
}

export interface Profiles {
  /** Column sums (vertical lines) and row sums (horizontal lines) of the thin-line strength. */
  x: Float64Array;
  y: Float64Array;
  /** The same for small spots, thin both ways: a grid of dots (hatching strokes hardly count). */
  dotX: Float64Array;
  dotY: Float64Array;
}

/**
 * 1 where few pixels nearby (within r) are dark: grid lines on a floor count,
 * hatching, textures and the ground around a wall hardly do.
 */
export function calmMask(lum: Uint8Array, w: number, h: number, r = 6, share = 0.22): Uint8Array {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]!]!++;
  const pct = (p: number) => {
    let s = 0;
    for (let v = 0; v < 256; v++) if ((s += hist[v]!) >= p * lum.length) return v;
    return 255;
  };
  const threshold = (pct(0.05) + pct(0.9)) / 2;
  const W = w + 1;
  const sum = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x]! < threshold ? 1 : 0;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1]! + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = sum[y1 * W + x1]! - sum[y0 * W + x1]! - sum[y1 * W + x0]! + sum[y0 * W + x0]!;
      out[y * w + x] = n <= share * (x1 - x0) * (y1 - y0) ? 1 : 0;
    }
  }
  return out;
}

export function lineProfiles(lum: Uint8Array, w: number, h: number): Profiles {
  const px = new Float64Array(w);
  const py = new Float64Array(h);
  const dx = new Float64Array(w);
  const dy = new Float64Array(h);
  const calm = calmMask(lum, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!calm[y * w + x]) continue;
      const v = thinAcross(lum, w, h, x, y, 1, 0);
      if (v > 4) px[x]! += v;
      const u = thinAcross(lum, w, h, x, y, 0, 1);
      if (u > 4) py[y]! += u;
      // a dot stands out from a whole ring around it; a stroke or a line crossing runs through the ring
      const d = (v < u ? v : u) > 4 ? spot(lum, w, h, x, y) : 0;
      if (d > 4) {
        dx[x]! += d;
        dy[y]! += d;
      }
    }
  }
  return { x: px, y: py, dotX: dx, dotY: dy };
}

/** Keeps only narrow peaks (up to about 2r + 1 samples wide): the profile minus its opening. */
function topHat(p: Float64Array, r: number): Float64Array {
  const n = p.length;
  const lo = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) if (p[j]! < m) m = p[j]!;
    lo[i] = m;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) if (lo[j]! > m) m = lo[j]!;
    out[i] = Math.max(0, p[i]! - m);
  }
  return out;
}

/** The profile's Fourier sum at frequency f (cycles per pixel), divided by the profile's total: 1 for a perfect comb. */
function spectrum(p: Float64Array, total: number, f: number): { mag: number; re: number; im: number } {
  const t = 2 * Math.PI * f;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  let c = 1;
  let s = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!;
    if (v) {
      re += v * c;
      im -= v * s;
    }
    const nc = c * ct - s * st;
    s = s * ct + c * st;
    c = nc;
  }
  return { mag: total ? Math.hypot(re, im) / total : 0, re, im };
}

export interface GridOptions {
  /** Smallest and largest cell sizes looked for, in pixels (default 6 and a quarter of the picture, at most 400). */
  min?: number;
  max?: number;
}

/**
 * Without a printed grid: the lattice the walls stand on. Long straight wall
 * lines (ink runs at least `long` px along x or y) give their centre lines; the
 * strongest repeat of those positions near `guess` px (from 0.55 to 1.8 times
 * it) is taken for the squares. Maps put walls on whole (and half) squares, so
 * this finds the scale a drawn map was made on.
 */
export function wallLattice(ink: Uint8Array, w: number, h: number, guess: number): GridFit | null {
  const long = Math.max(8, Math.round(0.6 * guess));
  const px = new Float64Array(w);
  const py = new Float64Array(h);
  // horizontal walls: in each column, the middle of each crossing of a long horizontal run
  const along = (n: number, len: number, at: (line: number, i: number) => number, out: Float64Array) => {
    const mark = new Uint8Array(w * h);
    for (let line = 0; line < n; line++) {
      let start = -1;
      for (let i = 0; i <= len; i++) {
        const on = i < len && ink[at(line, i)];
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if (i - start >= long) for (let k = start; k < i; k++) mark[at(line, k)] = 1;
          start = -1;
        }
      }
    }
    for (let i = 0; i < len; i++) {
      let start = -1;
      for (let line = 0; line <= n; line++) {
        const on = line < n && mark[at(line, i)];
        if (on && start < 0) start = line;
        if (!on && start >= 0) {
          if (line - start <= 0.4 * guess) out[Math.floor((start + line - 1) / 2)]! += 1;
          start = -1;
        }
      }
    }
  };
  along(h, w, (y, x) => y * w + x, py);
  along(w, h, (x, y) => y * w + x, px);
  const fit = fitGrid(px, py, { min: 0.55 * guess, max: 1.8 * guess });
  return fit && fit.strength >= 0.35 ? fit : null;
}

/** A grid needs lines at this share of its positions (between the first and the last line): walls alone leave gaps. */
export const GRID_MIN_FILL = 0.65;

/** The printed grid of a picture (lines or dots), or null when there is no regular grid. */
export function detectGrid(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o: GridOptions = {}): GridFit | null {
  const p = lineProfiles(luminance(rgba, w, h), w, h);
  const fits = [fitGrid(p.x, p.y, o), fitGrid(p.dotX, p.dotY, o)].filter((g): g is GridFit => g !== null && g.fill >= GRID_MIN_FILL);
  return fits.sort((a, b) => b.strength * b.fill - a.strength * a.fill)[0] ?? null;
}

/**
 * Of the lattice positions between the first and last clear line, the share that
 * carry a line (at least a quarter as strong as a typical one).
 */
function fillOf(p: Float64Array, cell: number, offset: number): number {
  const vals: number[] = [];
  for (let c = offset - 0.5; c < p.length; c += cell) {
    if (c < -1) continue;
    let m = 0;
    for (let j = Math.round(c) - 1; j <= Math.round(c) + 1; j++) if (j >= 0 && j < p.length && p[j]! > m) m = p[j]!;
    vals.push(m);
  }
  if (vals.length < 3) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)]!;
  if (!(typical > 0)) return 0;
  const on = vals.map((v) => v >= 0.25 * typical);
  const first = on.indexOf(true);
  const last = on.lastIndexOf(true);
  if (first < 0 || last - first < 4) return 0; // five lines at least: a few big repeats prove nothing
  let n = 0;
  for (let k = first; k <= last; k++) if (on[k]) n++;
  return n / (last - first + 1);
}

export function fitGrid(profileX: Float64Array, profileY: Float64Array, o: GridOptions = {}): GridFit | null {
  const px = topHat(profileX, 3);
  const py = topHat(profileY, 3);
  const tx = px.reduce((a, v) => a + v, 0);
  const ty = py.reduce((a, v) => a + v, 0);
  const n = Math.max(px.length, py.length);
  const tMin = Math.max(4, o.min ?? 6);
  const tMax = Math.min(o.max ?? 400, Math.max(px.length, py.length) / 4);
  if (tMax <= tMin || (tx <= 0 && ty <= 0)) return null;
  // both axes share one cell size; an axis with no lines at all doesn't vote
  const both = (f: number) => {
    const a = tx > 0 ? spectrum(px, tx, f).mag : 0;
    const b = ty > 0 ? spectrum(py, ty, f).mag : 0;
    return tx > 0 && ty > 0 ? (a + b) / 2 : a + b;
  };
  const df = 1 / (6 * n);
  const fs: number[] = [];
  const ms: number[] = [];
  for (let f = 1 / tMax; f <= 1 / tMin; f += df) {
    fs.push(f);
    ms.push(both(f));
  }
  let top = 0;
  for (let i = 1; i < ms.length; i++) if (ms[i]! > ms[top]!) top = i;
  const peak = ms[top]!;
  if (peak < GRID_MIN_STRENGTH * 0.6) return null;
  // a comb of thin lines is as strong at its harmonics (f, 2f, 3f…) as at f: take the lowest
  // frequency that peaks nearly as strongly and of which the top is a whole multiple
  let f0 = fs[top]!;
  for (let i = 1; i < top; i++) {
    if (ms[i]! < 0.5 * peak || ms[i]! < ms[i - 1]! || ms[i]! < ms[i + 1]!) continue;
    const k = fs[top]! / fs[i]!;
    if (Math.abs(k - Math.round(k)) < 0.04 * Math.round(k) && Math.round(k) >= 2) {
      f0 = fs[i]!;
      break;
    }
  }
  const harmonic = Math.max(1, Math.round(fs[top]! / f0));
  // refine the top peak to a fraction of a step (golden section), then the cell from its harmonic number
  let a = fs[top]! - df;
  let b = fs[top]! + df;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = both(c);
  let fd = both(d);
  for (let it = 0; it < 30; it++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = both(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = both(d);
    }
  }
  const cell = harmonic / ((a + b) / 2);
  if (cell < tMin * 0.98 || cell > tMax * 1.02) return null;
  const fx = tx > 0 ? spectrum(px, tx, 1 / cell) : { mag: 0, re: 0, im: 0 };
  const fy = ty > 0 ? spectrum(py, ty, 1 / cell) : { mag: 0, re: 0, im: 0 };
  // lines at sample i0 + k × cell give a phase of -2π i0 / cell; sample i covers pixels i..i+1, so the line is at i0 + 0.5
  const offsetOf = (s: { re: number; im: number }) => {
    const i0 = (-Math.atan2(s.im, s.re) / (2 * Math.PI)) * cell;
    return ((((i0 + 0.5) % cell) + cell) % cell);
  };
  const strengthXY: [number, number] = [fx.mag, fy.mag];
  const strength = tx > 0 && ty > 0 ? (fx.mag + fy.mag) / 2 : fx.mag + fy.mag;
  if (strength < GRID_MIN_STRENGTH) return null;
  const offset: [number, number] = [offsetOf(fx), offsetOf(fy)];
  const fill = Math.min(tx > 0 ? fillOf(px, cell, offset[0]) : 1, ty > 0 ? fillOf(py, cell, offset[1]) : 1);
  return { cell, offset, strength, strengthXY, fill };
}
