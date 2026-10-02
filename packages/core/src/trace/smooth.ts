// Smoothing a painted map before its colours are clustered: brush strokes,
// roof tiles, wave crests and the lit and shaded sides of a roof collapse into
// flat patches, while the edges between houses, streets and water stay sharp.
// The Kuwahara filter does this: each pixel takes the mean colour of whichever
// of the four squares around it (it at a corner of each) varies least.

/** Box means over (r + 1) × (r + 1) windows anchored at their top left, clamped at the picture's edge. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const k = r + 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(k, w); x++) s += src[row + x]!;
    for (let x = 0; x < w; x++) {
      const n = Math.min(k, w - x);
      tmp[row + x] = s / n;
      s -= src[row + x]!;
      if (x + k < w) s += src[row + x + k]!;
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < Math.min(k, h); y++) s += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      const n = Math.min(k, h - y);
      out[y * w + x] = s / n;
      s -= tmp[y * w + x]!;
      if (y + k < h) s += tmp[(y + k) * w + x]!;
    }
  }
  return out;
}

/**
 * Kuwahara filter with squares of (r + 1) pixels (r = 2: 3 × 3 squares), done
 * `passes` times. Alpha is kept as it was.
 */
export function kuwahara(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, r = 2, passes = 1): Uint8ClampedArray {
  let cur = Uint8ClampedArray.from(rgba);
  const n = w * h;
  for (let p = 0; p < passes; p++) {
    const ch = [0, 1, 2].map((c) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = cur[i * 4 + c]!;
      return a;
    });
    const lum = new Float32Array(n);
    const lum2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = 0.299 * ch[0]![i]! + 0.587 * ch[1]![i]! + 0.114 * ch[2]![i]!;
      lum[i] = l;
      lum2[i] = l * l;
    }
    const mean = ch.map((a) => boxMean(a, w, h, r));
    const ml = boxMean(lum, w, h, r);
    const ml2 = boxMean(lum2, w, h, r);
    const out = new Uint8ClampedArray(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = -1;
        let bv = Infinity;
        // the four squares that have (x, y) as a corner: their top left corners
        for (const [qx, qy] of [
          [x - r, y - r],
          [x, y - r],
          [x - r, y],
          [x, y],
        ] as const) {
          const cx = Math.max(0, qx);
          const cy = Math.max(0, qy);
          const j = cy * w + cx;
          const v = ml2[j]! - ml[j]! * ml[j]!;
          if (v < bv) {
            bv = v;
            best = j;
          }
        }
        const i = y * w + x;
        out[i * 4] = mean[0]![best]!;
        out[i * 4 + 1] = mean[1]![best]!;
        out[i * 4 + 2] = mean[2]![best]!;
        out[i * 4 + 3] = cur[i * 4 + 3]!;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * How painted a picture looks: the share of pixels that differ clearly from
 * their neighbours (texture). Flat-colour plans score near 0 (only edges),
 * painted and scanned maps well above.
 */
export function textureShare(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): number {
  let busy = 0;
  let all = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200_000)));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = (y * w + x) * 4;
      // a pixel in the middle of an area (not on an edge) that still differs from its neighbours: texture
      let lo = Infinity;
      let hi = -Infinity;
      for (const j of [i - 4, i + 4, i - w * 4, i + w * 4]) {
        const d = Math.abs(rgba[j]! - rgba[i]!) + Math.abs(rgba[j + 1]! - rgba[i + 1]!) + Math.abs(rgba[j + 2]! - rgba[i + 2]!);
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      all++;
      // flat: some neighbour has the same colour; edge: some neighbour is the same, another very different
      if (lo >= 12) busy++;
    }
  }
  return all ? busy / all : 0;
}
