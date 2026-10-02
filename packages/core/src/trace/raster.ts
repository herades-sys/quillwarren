// Raster tools for tracing a map picture: clean-up of
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

// ---------- masks ----------

export function maskOf(classes: Uint8Array, w: number, h: number, pick: (c: number) => boolean): Mask {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = pick(classes[i]!) ? 1 : 0;
  return { w, h, px };
}

// ---------- clean-up (square structuring element, radius r) ----------

/**
 * 1 where any pixel within r (a square) is 1 (dilate), or where all are
 * (erode; outside the picture counts as 1, so parts touching the edge don't shrink).
 * Rows with prefix sums, then columns with running counts row by row (cache friendly).
 */
function sweep(m: Mask, r: number, any: boolean): Mask {
  if (r <= 0) return { w: m.w, h: m.h, px: m.px.slice() };
  const { w, h } = m;
  const src = m.px;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pre = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x]! + src[row + x]!;
    for (let x = 0; x < w; x++) {
      const lo = x - r < 0 ? 0 : x - r;
      const hi = x + r >= w ? w - 1 : x + r;
      const c = pre[hi + 1]! - pre[lo]!;
      tmp[row + x] = any ? (c > 0 ? 1 : 0) : c === hi - lo + 1 ? 1 : 0;
    }
  }
  const count = new Int32Array(w);
  // rows 0..r-1 start in the window of row 0
  for (let y = 0; y < Math.min(r, h); y++) for (let x = 0; x < w; x++) count[x] = count[x]! + tmp[y * w + x]!;
  for (let y = 0; y < h; y++) {
    const add = y + r;
    if (add < h) for (let x = 0, a = add * w; x < w; x++) count[x] = count[x]! + tmp[a + x]!;
    const drop = y - r - 1;
    if (drop >= 0) for (let x = 0, d = drop * w; x < w; x++) count[x] = count[x]! - tmp[d + x]!;
    const span = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    const row = y * w;
    if (any) for (let x = 0; x < w; x++) out[row + x] = count[x]! > 0 ? 1 : 0;
    else for (let x = 0; x < w; x++) out[row + x] = count[x] === span ? 1 : 0;
  }
  return { w, h, px: out };
}

/** Opening with a 2 × 2 square: drops lines one pixel thin, keeps two-pixel ones (thin walls in a small picture). */
export function open2(m: Mask): Mask {
  const { w, h, px } = m;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? px[y * w + x]! : 1);
  const er = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) er[y * w + x] = at(x, y) & at(x + 1, y) & at(x, y + 1) & at(x + 1, y + 1);
  const out = new Uint8Array(w * h);
  const e = (x: number, y: number) => (x >= 0 && y >= 0 ? er[y * w + x]! : 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = px[y * w + x]! & (e(x, y) | e(x - 1, y) | e(x, y - 1) | e(x - 1, y - 1));
  return { w, h, px: out };
}

export const dilate = (m: Mask, r: number) => sweep(m, r, true);
export const erode = (m: Mask, r: number) => sweep(m, r, false);
/** Removes specks and lines thinner than about 2r + 1 pixels. */
export const open = (m: Mask, r: number) => dilate(erode(m, r), r);
/** Closes gaps and thin cuts (grid lines through a building) narrower than about 2r + 1 pixels. */
export const close = (m: Mask, r: number) => erode(dilate(m, r), r);

// ---------- connected parts ----------

/** Connected parts of the 1s (8-connected, or 4-connected with `four`): a label per pixel (0 = none) and each part's pixel count. */
export function parts(m: Mask, four = false): { labels: Int32Array; sizes: number[] } {
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
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= w || (four && dx !== 0 && dy !== 0)) continue;
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

/** 1D squared distance transform of f (Felzenszwalb and Huttenlocher), written into d. */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity && f[v[k]!] === Infinity) continue;
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/** Euclidean distance from each 1 pixel to the nearest 0 (or to outside the mask, when `edge` is set), 0 on the 0s. */
export function distanceTransform(m: Mask, edge = false): Float32Array {
  const { w, h, px } = m;
  const pad = edge ? 1 : 0;
  const W = w + 2 * pad;
  const H = h + 2 * pad;
  const g = new Float64Array(W * H).fill(edge ? 0 : Infinity);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[(y + pad) * W + x + pad] = px[y * w + x] ? Infinity : 0;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x]!;
    edt1(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y]!;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x]!;
    edt1(f, W, d, v, z);
    const yy = y - pad;
    if (yy < 0 || yy >= h) continue;
    for (let x = pad; x < W - pad; x++) out[yy * w + x - pad] = Math.sqrt(d[x]!);
  }
  return out;
}

/** Fill holes (4-connected 0-areas not touching the edge) up to maxArea pixels: text printed over a building, say. */
export function fillHoles(m: Mask, maxArea: number): Mask {
  const { w, h, px } = m;
  const n = w * h;
  const out = px.slice();
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (px[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let edge = false;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      if (x === 0 || x === w - 1 || i < w || i >= n - w) edge = true;
      if (x > 0 && !px[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (queue[tail++] = i - 1);
      if (x < w - 1 && !px[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (queue[tail++] = i + 1);
      if (i >= w && !px[i - w] && !seen[i - w]) (seen[i - w] = 1), (queue[tail++] = i - w);
      if (i < n - w && !px[i + w] && !seen[i + w]) (seen[i + w] = 1), (queue[tail++] = i + w);
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
