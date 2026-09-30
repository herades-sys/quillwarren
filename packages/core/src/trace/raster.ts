// Raster tools for tracing a map picture: colour clustering, clean-up of
// binary masks, connected parts, outlines along pixel edges, and outline
// simplification. Pure number crunching on typed arrays (browser and Node).

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A binary mask: 1 = in, 0 = out, row by row. */
export interface Mask {
  w: number;
  h: number;
  px: Uint8Array;
}

// ---------- colours ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const d2 = (a: RGB, r: number, g: number, b: number) => (a.r - r) ** 2 + (a.g - g) ** 2 + (a.b - b) ** 2;

/**
 * The picture's main colours (k-means++ on up to `sample` pixels; transparent
 * pixels are skipped). Sorted by how much of the picture each one covers.
 */
export function mainColours(rgba: Uint8Array | Uint8ClampedArray, k = 7, sample = 60_000, seed = 1): { colour: RGB; share: number }[] {
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

/** Each pixel's nearest colour (index), 255 for transparent pixels. */
export function classify(rgba: Uint8Array | Uint8ClampedArray, colours: readonly RGB[]): Uint8Array {
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

export function maskOf(classes: Uint8Array, w: number, h: number, pick: (c: number) => boolean): Mask {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = pick(classes[i]!) ? 1 : 0;
  return { w, h, px };
}

// ---------- clean-up (square structuring element, radius r) ----------

/**
 * 1 where any pixel within r (a square) is 1 (dilate), or where all are
 * (erode; outside the picture counts as 1, so parts touching the edge don't shrink).
 */
function sweep(m: Mask, r: number, any: boolean): Mask {
  if (r <= 0) return { w: m.w, h: m.h, px: m.px.slice() };
  const { w, h } = m;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  // rows
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      const add = x + r;
      if (add < w) count += m.px[row + add]!;
      const drop = x - r - 1;
      if (drop >= 0) count -= m.px[row + drop]!;
      if (x >= 0) {
        const span = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
        tmp[row + x] = any ? (count > 0 ? 1 : 0) : count === span ? 1 : 0;
      }
    }
  }
  // columns
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r;
      if (add < h) count += tmp[add * w + x]!;
      const drop = y - r - 1;
      if (drop >= 0) count -= tmp[drop * w + x]!;
      if (y >= 0) {
        const span = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
        out[y * w + x] = any ? (count > 0 ? 1 : 0) : count === span ? 1 : 0;
      }
    }
  }
  return { w, h, px: out };
}

export const dilate = (m: Mask, r: number) => sweep(m, r, true);
export const erode = (m: Mask, r: number) => sweep(m, r, false);
/** Removes specks and lines thinner than about 2r + 1 pixels. */
export const open = (m: Mask, r: number) => dilate(erode(m, r), r);
/** Closes gaps and thin cuts (grid lines through a building) narrower than about 2r + 1 pixels. */
export const close = (m: Mask, r: number) => erode(dilate(m, r), r);

// ---------- connected parts ----------

/** 8-connected parts of the 1s: a label per pixel (0 = none) and each part's pixel count. */
export function parts(m: Mask): { labels: Int32Array; sizes: number[] } {
  const { w, h, px } = m;
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const queue = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < px.length; start++) {
    if (!px[start] || labels[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = next;
    let size = 0;
    while (head < tail) {
      const i = queue[head++]!;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (px[j] && !labels[j]) {
            labels[j] = next;
            queue[tail++] = j;
          }
        }
      }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

/** Fill holes (4-connected 0-areas not touching the edge) up to maxArea pixels: text printed over a building, say. */
export function fillHoles(m: Mask, maxArea: number): Mask {
  const { w, h } = m;
  const inv: Mask = { w, h, px: m.px.map((v) => (v ? 0 : 1)) };
  const out = m.px.slice();
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  for (let start = 0; start < inv.px.length; start++) {
    if (!inv.px[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let edge = false;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && inv.px[j] && !seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (!edge && tail <= maxArea) for (let q = 0; q < tail; q++) out[queue[q]!] = 1;
  }
  return { w, h, px: out };
}

// ---------- outlines ----------

type P = [number, number];

/**
 * Outlines of the 1s along pixel edges: each ring has the inside on its
 * right, so outer outlines run clockwise (on screen, y down) and holes
 * counter-clockwise. Where two parts touch at a corner, they stay joined.
 */
export function outlines(m: Mask): P[][] {
  const { w, h, px } = m;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? px[y * w + x]! : 0);
  // edges keyed by their start corner; corner id = y * (w + 1) + x
  const W = w + 1;
  const out = new Map<number, number[]>(); // start corner -> end corners
  const push = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = out.get(k);
    if (list) list.push(y1 * W + x1);
    else out.set(k, [y1 * W + x1]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!px[y * w + x]) continue;
      if (!at(x, y - 1)) push(x, y, x + 1, y); // top, going east
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1); // right, going south
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1); // bottom, going west
      if (!at(x - 1, y)) push(x, y + 1, x, y); // left, going north
    }
  }
  const rings: P[][] = [];
  const dirOf = (a: number, b: number): P => [(b % W) - (a % W), Math.floor(b / W) - Math.floor(a / W)];
  for (const [startKey] of out) {
    while (out.get(startKey)?.length) {
      const ring: P[] = [];
      let from = startKey;
      let to = out.get(from)!.pop()!;
      let guard = 0;
      while (guard++ < 4 * w * h + 8) {
        ring.push([from % W, Math.floor(from / W)]);
        if (to === startKey) break;
        const choices = out.get(to);
        if (!choices?.length) break;
        let pick = 0;
        if (choices.length > 1) {
          // prefer turning right (keeps the inside, on the right, joined across corners), then straight, then left
          const [dx, dy] = dirOf(from, to);
          const rank = (c: number) => {
            const [ex, ey] = dirOf(to, c);
            const cross = dx * ey - dy * ex; // > 0: right turn on screen (y down)
            return cross > 0 ? 0 : cross === 0 ? 1 : 2;
          };
          pick = choices.reduce((best, c, i) => (rank(c) < rank(choices[best]!) ? i : best), 0);
        }
        from = to;
        to = choices.splice(pick, 1)[0]!;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/** Signed area (on screen, y down): > 0 for clockwise rings. */
export function signedArea(ring: readonly P[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function dp(pts: readonly P[], tol: number, keep: Uint8Array, lo: number, hi: number): void {
  let far = -1;
  let fd = tol;
  const [ax, ay] = pts[lo]!;
  const [bx, by] = pts[hi]!;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  for (let i = lo + 1; i < hi; i++) {
    const [px, py] = pts[i]!;
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  if (far >= 0) {
    keep[far] = 1;
    dp(pts, tol, keep, lo, far);
    dp(pts, tol, keep, far, hi);
  }
}

/** Douglas-Peucker for a closed ring: fewer points, within `tol` of the original. */
export function simplify(input: readonly P[], tol: number): P[] {
  // only the corners: a pixel outline has a point at every step, and one mid-edge start point would cost a real corner
  const ring = input.filter((p, i) => {
    const a = input[(i - 1 + input.length) % input.length]!;
    const b = input[(i + 1) % input.length]!;
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
  if (ring.length < 4) return ring.length >= 3 ? ring : [...input];
  // anchor at the point farthest from the first, so the split is stable
  let far = 0;
  let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const pts = [...ring, ring[0]!];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[far] = keep[pts.length - 1] = 1;
  dp(pts, tol, keep, 0, far);
  dp(pts, tol, keep, far, pts.length - 1);
  const out = pts.filter((_, i) => keep[i]);
  out.pop();
  return out;
}

/** The picture shrunk (by averaging) so its longer side is at most maxSide pixels; returned as is when it already fits. */
export function downscale(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, maxSide: number): { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; factor: number } {
  const factor = Math.max(w, h) / maxSide;
  if (factor <= 1) return { width: w, height: h, rgba, factor: 1 };
  const nw = Math.max(1, Math.round(w / factor));
  const nh = Math.max(1, Math.round(h / factor));
  const out = new Uint8Array(nw * nh * 4);
  const sum = new Float64Array(nw * 4);
  const count = new Float64Array(nw);
  for (let ny = 0; ny < nh; ny++) {
    sum.fill(0);
    count.fill(0);
    const y0 = Math.floor((ny * h) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((ny + 1) * h) / nh));
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const nx = Math.min(nw - 1, Math.floor((x * nw) / w));
        const i = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) sum[nx * 4 + k] = sum[nx * 4 + k]! + rgba[i + k]!;
        count[nx] = count[nx]! + 1;
      }
    }
    for (let nx = 0; nx < nw; nx++) for (let k = 0; k < 4; k++) out[(ny * nw + nx) * 4 + k] = Math.round(sum[nx * 4 + k]! / count[nx]!);
  }
  return { width: nw, height: nh, rgba: out, factor: w / nw };
}

/**
 * Removes a printed grid: rows (and columns) where a thin line of up to 3 pixels
 * crosses at least `share` of the picture get each of those line pixels replaced by
 * what lies beside the line. Short thin lines, like outlines between houses, stay.
 */
export function dropGridLines(classes: Uint8Array, w: number, h: number, share = 0.12): Uint8Array {
  const m = classes.slice();
  // lines run along `i`; `line` steps across them. `before` reads the cleaned picture, so a 3-pixel line clears row by row.
  const pass = (n: number, len: number, at: (line: number, i: number) => number) => {
    const src = m.slice();
    const isLine = (line: number, i: number) => {
      const c = src[at(line, i)]!;
      const before = m[at(line - 2, i)]!;
      return c !== before && (before === src[at(line + 2, i)] || (line + 3 < n && before === src[at(line + 3, i)]));
    };
    for (let line = 2; line < n - 2; line++) {
      let hits = 0;
      for (let i = 0; i < len; i++) if (isLine(line, i)) hits++;
      if (hits < share * len) continue;
      for (let i = 0; i < len; i++) if (isLine(line, i)) m[at(line, i)] = m[at(line - 2, i)]!;
    }
  };
  pass(h, w, (y, x) => y * w + x); // horizontal lines
  pass(w, h, (x, y) => y * w + x); // vertical lines
  return m;
}
