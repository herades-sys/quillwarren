// Tracing a painted city map (an RPG city, a hand-painted or scanned plan):
// roofs with a lit and a shaded side, textured streets, gardens and fields,
// water with wave strokes, a city wall with round towers, numbers on top.
//
// - The colours come from a smoothed copy of the picture (smooth.ts), where
//   textures and shading have collapsed; roles come from the colours' hue and
//   how they sit (painted roles below), so the lit and shaded roof both build.
// - Houses: the roof colours together, holes (ridge highlights, numbers) filled;
//   the dark lines a painter draws between touching houses, read from the
//   unsmoothed picture, part them. Each house is then squared up: an oriented
//   rectangle, or a right-angled outline in its own direction.
// - The city wall: the long thin parts of the wall colour (blobs of it are dark
//   roofs). Round and square buildings standing on the wall line are its towers.
// - Water, grass, fields and streets become terrain (holes kept); water may be
//   narrow, for brooks.
import type { MapObject, Point } from '../schema.ts';
import { chroma, type ColourStats } from './colour.ts';
import { luminance } from './grid.ts';
import { close, dilate, fillHoles, open, outlines, parts, signedArea, simplify, type Mask } from './raster.ts';
import type { TraceRole } from './trace.ts';

type P = [number, number];

const TERRAIN: Partial<Record<TraceRole, string>> = { water: 'water-deep', road: 'cobblestones', grass: 'grass', field: 'dirt', sand: 'sand' };

/**
 * Roles for a painted city, from each colour's Lab values and layout:
 * red to brown with some colour: roofs; dark, colourless or olive: wall or
 * dark roofs (the tracer sorts them by shape); pale cyan to blue: water;
 * yellow-greens and greens: grass, light yellow: fields; the sandy colour
 * that sits among the houses: streets; white and black: left out.
 */
export function guessPaintedRoles(stats: readonly ColourStats[]): TraceRole[] {
  const roles: TraceRole[] = stats.map(() => 'ignore');
  // the streets: the most enclosed sandy, unsaturated-to-yellow colour
  let street = -1;
  let streetScore = 0;
  stats.forEach((s, i) => {
    const { l, a, b } = s.lab;
    const c = chroma(s.lab);
    if (l < 20 || l > 90) return; // black ink and white paper (legend, text, wave crests)
    if (a >= 7 && b > 10 && l < 70) roles[i] = 'building'; // red, orange and brown roofs
    else if (l < 60 && c < 45 && a > -6 && a < 7) roles[i] = 'wall'; // grey, dark olive: the wall (and dark roofs)
    else if (a < -4 && b < 1.5 * -a && l > 45) roles[i] = 'water'; // pale cyan to blue: greens are far more yellow (b over 3 × -a)
    else if (b < -8 && l > 35) roles[i] = 'water';
    else if (l >= 74 && a > -17 && b >= 20 && b <= 55) roles[i] = 'field'; // light yellow: fields
    else if (a < -12 || (a < -6 && b > 40 && l < 70)) roles[i] = 'grass';
    else if (b > 25 && a > -14) {
      const v = s.share * (0.2 + s.enclosed);
      if (v > streetScore) {
        streetScore = v;
        street = i;
      }
      roles[i] = 'field';
    } else if (a < -4) roles[i] = 'grass';
  });
  if (street >= 0) roles[street] = 'road';
  return roles;
}

export interface PaintedOptions {
  width: number;
  height: number;
  /** The picture as it is (its fine dark lines part touching houses). */
  rgba: Uint8Array | Uint8ClampedArray;
  /** Each pixel's colour in the smoothed picture (an index into roles), 255 for none. */
  classes: Uint8Array;
  roles: readonly TraceRole[];
  /** Picture pixels per square, and the pixel where square (0, 0) is. */
  s: number;
  origin?: [number, number];
  /** Join touching houses into blocks (default false: each house on its own). */
  join?: boolean;
  /** Square the houses up (default true). */
  regular?: boolean;
  /** Drop pieces smaller than this many squares (default 0.3). */
  minArea?: number;
  /** How much darker than both sides a line between two houses is (luminance, default 22). */
  lineContrast?: number;
  /** Each pixel's colour in the picture as it is (unsmoothed): a thin gap of street between two roofs parts them. */
  origClasses?: Uint8Array;
}

export interface PaintedResult {
  objects: MapObject[];
  counts: Record<string, number>;
}

/** The parts of a mask: for each, its pixels' indices and bounding box. */
function components(m: Mask, minPx: number, four = true): { px: number[]; box: [number, number, number, number] }[] {
  const { labels, sizes } = parts(m, four);
  const out: ({ px: number[]; box: [number, number, number, number] } | null)[] = sizes.map((n) => (n >= minPx ? { px: [], box: [Infinity, Infinity, -1, -1] } : null));
  for (let i = 0; i < labels.length; i++) {
    const c = out[labels[i]!];
    if (!c || !labels[i]) continue;
    c.px.push(i);
    const x = i % m.w;
    const y = (i - x) / m.w;
    if (x < c.box[0]) c.box[0] = x;
    if (y < c.box[1]) c.box[1] = y;
    if (x > c.box[2]) c.box[2] = x;
    if (y > c.box[3]) c.box[3] = y;
  }
  return out.filter((c, k) => c !== null && k > 0) as { px: number[]; box: [number, number, number, number] }[];
}

/** A component's pixels cut out into a small mask. */
function cut(px: readonly number[], box: readonly number[], w: number, pad = 1): { m: Mask; x0: number; y0: number } {
  const x0 = box[0]! - pad;
  const y0 = box[1]! - pad;
  const mw = box[2]! - box[0]! + 1 + 2 * pad;
  const mh = box[3]! - box[1]! + 1 + 2 * pad;
  const m: Mask = { w: mw, h: mh, px: new Uint8Array(mw * mh) };
  for (const i of px) {
    const x = i % w;
    const y = (i - x) / w;
    m.px[(y - y0) * mw + x - x0] = 1;
  }
  return { m, x0, y0 };
}

/** Convex hull (monotone chain) of points. */
function hull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The smallest rectangle round some points, at any angle: its angle (radians, 0..π/2), centre and sides. */
export function minAreaRect(points: P[]): { angle: number; cx: number; cy: number; w: number; h: number } {
  const hp = hull(points);
  let best = { angle: 0, cx: 0, cy: 0, w: 0, h: 0, area: Infinity };
  const n = hp.length;
  // the best rectangle has a side on one of the hull's edges
  const angles = n >= 2 ? hp.map((p, i) => Math.atan2(hp[(i + 1) % n]![1] - p[1], hp[(i + 1) % n]![0] - p[0])) : [0];
  for (const raw of angles) {
    const a = ((raw % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const c = Math.cos(a);
    const s = Math.sin(a);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, y] of hp) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      best = { angle: a, cx: cu * c - cv * s, cy: cu * s + cv * c, w: u1 - u0, h: v1 - v0, area };
    }
  }
  return { angle: best.angle, cx: best.cx, cy: best.cy, w: best.w, h: best.h };
}

/**
 * Enough points of a set of pixels for its convex hull: the outer corners of
 * each row's first and last pixel (or their centres, with `centre`).
 */
function rowEnds(px: readonly number[], w: number, centre = false): P[] {
  const lo = new Map<number, number>();
  const hi = new Map<number, number>();
  for (const i of px) {
    const x = i % w;
    const y = (i - x) / w;
    const a = lo.get(y);
    if (a === undefined || x < a) lo.set(y, x);
    const b = hi.get(y);
    if (b === undefined || x > b) hi.set(y, x);
  }
  const out: P[] = [];
  for (const [y, a] of lo) {
    const b = hi.get(y)!;
    if (centre) out.push([a + 0.5, y + 0.5], [b + 0.5, y + 0.5]);
    else out.push([a, y], [a, y + 1], [b + 1, y], [b + 1, y + 1]);
  }
  return out;
}

/** The largest axis-aligned rectangle of 1s in a mask (histogram method): [x, y, w, h]. */
function largestRect(m: Mask): [number, number, number, number] {
  const { w, h, px } = m;
  const height = new Int32Array(w);
  let best: [number, number, number, number] = [0, 0, 0, 0];
  let bestArea = 0;
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) height[x] = px[y * w + x] ? height[x]! + 1 : 0;
    stack.length = 0;
    for (let x = 0; x <= w; x++) {
      const hx = x < w ? height[x]! : 0;
      while (stack.length && height[stack.at(-1)!]! >= hx) {
        const top = stack.pop()!;
        const hh = height[top]!;
        const left = stack.length ? stack.at(-1)! + 1 : 0;
        const area = hh * (x - left);
        if (area > bestArea) {
          bestArea = area;
          best = [left, y - hh + 1, x - left, hh];
        }
      }
      stack.push(x);
    }
  }
  return best;
}

/**
 * A block of touching houses (pixel indices) cut into rectangles in its own
 * direction, biggest first: most houses are rectangles, so an L or U shaped
 * block is two or three of them. Each rectangle is drawn a third of a pixel in
 * from where it was cut, so the houses keep a hairline between them.
 */
export function splitBlock(px: readonly number[], w: number, minPx: number): P[][] {
  const corners = rowEnds(px, w);
  const r = minAreaRect(corners);
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const gw = Math.ceil(r.w) + 2;
  const gh = Math.ceil(r.h) + 2;
  const g: Mask = { w: gw, h: gh, px: new Uint8Array(gw * gh) };
  for (const i of px) {
    const dx = (i % w) + 0.5 - r.cx;
    const dy = Math.floor(i / w) + 0.5 - r.cy;
    const u = Math.floor(dx * c + dy * s + r.w / 2) + 1;
    const v = Math.floor(-dx * s + dy * c + r.h / 2) + 1;
    if (u >= 0 && v >= 0 && u < gw && v < gh) g.px[v * gw + u] = 1;
  }
  const filled = close(g, 1);
  const toPic = (u: number, v: number): P => {
    const uu = u - 1 - r.w / 2;
    const vv = v - 1 - r.h / 2;
    return [r.cx + uu * c - vv * s, r.cy + uu * s + vv * c];
  };
  const out: P[][] = [];
  const total = filled.px.reduce((a, v) => a + v, 0);
  let left = total;
  while (left >= minPx && out.length < 12) {
    const [x, y, rw, rh] = largestRect(filled);
    if (rw * rh < minPx || Math.min(rw, rh) < 3) break;
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) filled.px[yy * gw + xx] = 0;
    left -= rw * rh;
    const k = 0.35;
    out.push([toPic(x + k, y + k), toPic(x + rw - k, y + k), toPic(x + rw - k, y + rh - k), toPic(x + k, y + rh - k)]);
  }
  // only when the rectangles are the block: a ragged block that they cover badly stays whole
  return left <= 0.15 * total ? out : [];
}

/**
 * A house's footprint (pixel indices) as a squared-up outline in picture
 * pixels: its oriented rectangle when it fills that well, else a right-angled
 * outline in the rectangle's direction.
 */
export function squareUp(px: readonly number[], w: number): P[] | null {
  const corners = rowEnds(px, w);
  const r = minAreaRect(corners);
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const toPic = (u: number, v: number): P => [r.cx + u * c - v * s, r.cy + u * s + v * c];
  if (px.length >= 0.8 * r.w * r.h) {
    return [toPic(-r.w / 2, -r.h / 2), toPic(r.w / 2, -r.h / 2), toPic(r.w / 2, r.h / 2), toPic(-r.w / 2, r.h / 2)];
  }
  // right angles in the house's own direction: its pixels drawn into a turned grid, outlined there
  const gw = Math.ceil(r.w) + 2;
  const gh = Math.ceil(r.h) + 2;
  const g: Mask = { w: gw, h: gh, px: new Uint8Array(gw * gh) };
  for (const i of px) {
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    const dx = x - r.cx;
    const dy = y - r.cy;
    const u = Math.floor(dx * c + dy * s + r.w / 2) + 1;
    const v = Math.floor(-dx * s + dy * c + r.h / 2) + 1;
    if (u >= 0 && v >= 0 && u < gw && v < gh) g.px[v * gw + u] = 1;
  }
  const filled = close(g, 1);
  const rings = outlines(filled).filter((q) => signedArea(q) > 0);
  if (!rings.length) return null;
  const ring = rings.reduce((a, b) => (signedArea(b) > signedArea(a) ? b : a));
  return simplify(ring, 0.9).map(([u, v]) => toPic(u - 1 - r.w / 2, v - 1 - r.h / 2));
}

export function tracePainted(o: PaintedOptions): PaintedResult {
  const { width: w, height: h, classes, s } = o;
  const n = w * h;
  const [ox, oy] = o.origin ?? [0, 0];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sq = (ring: readonly P[]): Point[] => ring.map(([x, y]) => [r2((x - ox) / s), r2((y - oy) / s)]);
  const roleAt = (i: number): TraceRole => (classes[i]! < o.roles.length ? o.roles[classes[i]!]! : 'ignore');
  const mask = (pick: (r: TraceRole) => boolean): Mask => {
    const m: Mask = { w, h, px: new Uint8Array(n) };
    for (let i = 0; i < n; i++) if (pick(roleAt(i))) m.px[i] = 1;
    return m;
  };
  const objects: MapObject[] = [];
  const counts: Record<string, number> = {};
  let nId = 0;
  const id = (p: string) => `${p}${++nId}`;
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  // sizes in pixels: a painted map's strokes are as wide as its pixels, whatever a square stands for
  // a painted map's strokes, walls and houses grow with the picture: sizes in pixels are for a picture about 1300 px long, scaled by k
  const k = paintedScale(w, h);
  const kr = (v: number) => Math.max(1, Math.round(v * k));
  const minPx = Math.max(12 * k * k, (o.minArea ?? 0.3) * s * s);
  const holeMax = Math.max(60 * k * k, 2e-4 * n);
  // paper: a legend box or a cartouche (big light areas of the left-out colours, holes and all); nothing inside it is traced
  const lum = luminance(o.rgba, w, h);
  const paper: Mask = { w, h, px: new Uint8Array(n) };
  {
    const light: Mask = { w, h, px: new Uint8Array(n) };
    for (let i = 0; i < n; i++) if (roleAt(i) === 'ignore' && lum[i]! >= 170) light.px[i] = 1;
    for (const c of components(fillHoles(close(light, 2), 0.05 * n), 0.002 * n, false)) for (const i of c.px) paper.px[i] = 1;
  }
  const paperNear = dilate(paper, 3);
  const papery = (px: readonly number[]) => {
    let k = 0;
    for (const i of px) k += paperNear.px[i]!;
    return k > 0.5 * px.length;
  };

  // ---- the city wall: the long thin lines of the wall colour; its blobs (wider than about seven
  //      pixels) are dark roofs and towers, and its short thin bits the edges of houses ----
  const wallish = mask((r) => r === 'wall');
  const blobs = open(wallish, kr(3));
  const nearBlob = dilate(blobs, kr(1));
  const thin: Mask = { w, h, px: new Uint8Array(n) };
  for (let i = 0; i < n; i++) thin.px[i] = wallish.px[i]! && !nearBlob.px[i] ? 1 : 0;
  const wallMask: Mask = { w, h, px: new Uint8Array(n) };
  const darkRoofs: Mask = { w, h, px: blobs.px.slice() };
  const longest = 0.06 * Math.max(w, h);
  for (const c of components(close(thin, kr(1)), 4, false)) {
    const span = Math.max(c.box[2] - c.box[0], c.box[3] - c.box[1]);
    const target = span >= longest ? wallMask : darkRoofs;
    for (const i of c.px) if (wallish.px[i] || target === wallMask) target.px[i] = 1;
  }

  // ---- houses ----
  const roofs = mask((r) => r === 'building');
  for (let i = 0; i < n; i++) if (darkRoofs.px[i] && !wallMask.px[i]) roofs.px[i] = 1;
  // the roofs as the picture has them (unsmoothed): there the thin gaps of street between touching
  // houses are still open; only the smoothed roofs' surroundings count, so wall bits stay out
  let roofsHere = roofs;
  if (o.origClasses) {
    const near = dilate(roofs, 1);
    roofsHere = { w, h, px: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      const c = o.origClasses[i]!;
      const r = c < o.roles.length ? o.roles[c]! : 'ignore';
      if (near.px[i] && !wallMask.px[i] && (r === 'building' || r === 'wall')) roofsHere.px[i] = 1;
    }
  }
  const roleHere = (i: number): TraceRole => {
    const c = o.origClasses ? o.origClasses[i]! : classes[i]!;
    return c < o.roles.length ? o.roles[c]! : 'ignore';
  };
  // holes in roofs: ridge highlights, tiles and the numbers printed on them are filled, not gardens or yards
  let houses = fillHoles(roofsHere, holeMax);
  for (let i = 0; i < n; i++) {
    if (!houses.px[i] || roofsHere.px[i]) continue;
    const r = roleHere(i);
    if (r !== 'ignore' && r !== 'wall' && r !== 'building' && !roofs.px[i]) houses.px[i] = 0;
  }
  houses = open(houses, kr(1));
  // what parts touching houses: the painter's dark lines, and thin gaps of street or garden
  // that the smoothing filled in (read from the picture itself)
  const sep = new Uint8Array(n);
  if (!o.join) {
    const origRole = (i: number): TraceRole => (o.origClasses && o.origClasses[i]! < o.roles.length ? o.roles[o.origClasses[i]!]! : 'building');
    const ground = (i: number) => {
      const r = origRole(i);
      return r === 'road' || r === 'grass' || r === 'field' || r === 'water' || r === 'sand';
    };
    // ground inside the roofs counts only where it runs in from the ground outside (a gap between
    // two houses), not where a roof tile merely has a sandy colour
    if (o.origClasses) {
      const queue: number[] = [];
      for (let i = 0; i < n; i++) {
        if (houses.px[i] || !ground(i)) continue;
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < n && houses.px[j] && !sep[j] && ground(j)) {
            sep[j] = 1;
            queue.push(j);
          }
        }
      }
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head]!;
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < n && houses.px[j] && !sep[j] && ground(j)) {
            sep[j] = 1;
            queue.push(j);
          }
        }
      }
    }
    const contrast = o.lineContrast ?? 50;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!houses.px[i] || sep[i]) continue;
        const c = lum[i]!;
        for (const [a, b] of [
          [i - 1, i + 1],
          [i - w, i + w],
          [i - 2, i + 2],
          [i - 2 * w, i + 2 * w],
        ] as const) {
          if (a < 0 || b >= n) continue;
          if (Math.min(lum[a]!, lum[b]!) - c >= contrast) {
            sep[i] = 1;
            break;
          }
        }
      }
    }
  }
  const cores: Mask = { w, h, px: new Uint8Array(n) };
  for (let i = 0; i < n; i++) cores.px[i] = houses.px[i]! && !sep[i] ? 1 : 0;
  const base = o.join ? close(houses, kr(1)) : open(cores, kr(1));
  const { labels: hl, sizes: hs } = parts(base, true);
  // crumbs (bits between lines, smaller than a quarter of a usual house) join the house they touch,
  // across a line; the houses keep a hairline gap between them (touching rooms would draw as one)
  const label = Int32Array.from(hl);
  const sorted = hs.slice(1).filter((v) => v >= minPx).sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1] ?? minPx;
  const crumb = Math.max(minPx, 0.25 * typical);
  const alias = Int32Array.from({ length: hs.length }, (_, i) => i);
  {
    const touch = new Map<number, Map<number, number>>();
    for (let i = 0; i < n; i++) {
      const a = label[i]!;
      if (!a || hs[a]! >= crumb) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const b = label[yy * w + xx]!;
          if (!b || b === a || hs[b]! < crumb) continue;
          let m = touch.get(a);
          if (!m) touch.set(a, (m = new Map()));
          m.set(b, (m.get(b) ?? 0) + 1);
        }
      }
    }
    for (const [a, m] of touch) {
      let best = 0;
      let most = 0;
      for (const [b, k] of m) if (k > most) (most = k), (best = b);
      if (best) alias[a] = best;
    }
  }
  const byHouse = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const l = alias[label[i]!]!;
    if (!l) continue;
    let list = byHouse.get(l);
    if (!list) byHouse.set(l, (list = []));
    list.push(i);
  }
  // ---- the wall drawn in a roof colour: "houses" far longer than wide are stretches of wall ----
  for (const [l, px] of byHouse) {
    if (px.length < minPx) continue;
    const rect = minAreaRect(rowEnds(px, w, true));
    const long = Math.max(rect.w, rect.h) + 1;
    const short = Math.min(rect.w, rect.h) + 1;
    if (long >= 6 * short && long >= 0.04 * Math.max(w, h)) {
      for (const i of px) wallMask.px[i] = 1;
      byHouse.delete(l);
    }
  }
  // ---- towers: houses standing on the wall line ----
  const nearWall = dilate(wallMask, kr(4));
  const isTower = (px: number[]): boolean => {
    let touch = 0;
    for (const i of px) if (nearWall.px[i]) touch++;
    if (touch < 3) return false;
    // on the line, not beside it: wall on two opposite sides
    let sx = 0;
    let sy = 0;
    for (const i of px) {
      sx += i % w;
      sy += Math.floor(i / w);
    }
    const cx = sx / px.length;
    const cy = sy / px.length;
    const rad = Math.sqrt(px.length / Math.PI) + 3 * k;
    const dirs: boolean[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      let hit = false;
      for (let d = rad - 2 * k; d <= rad + 9 * k && !hit; d++) {
        const x = Math.round(cx + Math.cos(a) * d);
        const y = Math.round(cy + Math.sin(a) * d);
        if (x >= 0 && y >= 0 && x < w && y < h && wallMask.px[y * w + x]) hit = true;
      }
      dirs.push(hit);
    }
    for (let k = 0; k < 16; k++) if (dirs[k] && (dirs[(k + 7) % 16] || dirs[(k + 8) % 16] || dirs[(k + 9) % 16])) return true;
    // or round (a tower) or long and thin (a stretch of wall drawn in a roof colour), mostly on the wall line
    if (touch < 0.4 * px.length) return false;
    const corners = rowEnds(px, w, true);
    const rect = minAreaRect(corners);
    const long = Math.max(rect.w, rect.h) + 1;
    const short = Math.min(rect.w, rect.h) + 1;
    if (long >= 3.5 * short) return true;
    return long <= 1.3 * short && px.length < 0.86 * long * short;
  };

  // ---- terrain: streets, grass, fields, water (holes kept) ----
  const terrainOf = (role: TraceRole, m0: Mask, minPart: number, minWidth: number) => {
    let m = fillHoles(m0, holeMax);
    m = close(m, 1);
    if (minWidth > 1) m = open(m, Math.floor((minWidth - 1) / 2));
    for (const c of components(m, minPart, false)) {
      if (papery(c.px)) continue;
      const { m: cm, x0, y0 } = cut(c.px, c.box, w);
      const rings = outlines(cm).map((r) => r.map(([x, y]) => [x + x0, y + y0] as P));
      const outer = rings.filter((r) => signedArea(r) > 0);
      const holes = rings.filter((r) => -signedArea(r) >= minPart);
      for (const ring of outer) {
        const poly = sq(simplify(ring, 1.2));
        if (poly.length < 3) continue;
        const inside = holes.map((hr) => sq(simplify(hr, 1.2))).filter((hp) => hp.length >= 3 && hp.length <= 2000);
        objects.push({ id: id('t'), type: 'terrain', asset: TERRAIN[role]!, shape: { poly }, ...(inside.length ? { holes: inside.slice(0, 2000) } : {}) });
        count(role);
      }
    }
  };
  const area = Math.max(minPx * 4, 1.5e-4 * n);
  terrainOf('road', mask((r) => r === 'road'), area, 3);
  terrainOf('field', mask((r) => r === 'field'), area, 3);
  terrainOf('grass', mask((r) => r === 'grass'), area, 3);
  // water: the wave crests and reflections in it are part of it; brooks may be a few pixels wide
  {
    const water = mask((r) => r === 'water');
    terrainOf('water', water, Math.max(minPx * 2, 0.5e-4 * n), 3);
  }

  // ---- the wall as rooms (in pieces that have no holes), towers on it ----
  {
    const towers: number[][] = [];
    for (const [l, px] of byHouse) {
      if (papery(px)) byHouse.delete(l);
      else if (px.length >= minPx && isTower(px)) {
        towers.push(px);
        byHouse.delete(l);
      }
    }
    const wall = close(wallMask, kr(1));
    for (const ring of solidRings(wall, Math.max(minPx, 20))) {
      const poly = sq(simplify(ring, 1));
      if (poly.length < 3) continue;
      objects.push({ id: id('r'), type: 'room', shape: { poly }, name: 'Wall' });
      count('wall');
    }
    for (const px of towers) {
      // round towers as circles, square ones squared up
      const corners: P[] = [];
      corners.push(...rowEnds(px, w, true));
      const rect = minAreaRect(corners);
      const round = px.length < 0.86 * (rect.w + 1) * (rect.h + 1) && Math.abs(rect.w - rect.h) <= 0.25 * Math.max(rect.w, rect.h);
      if (round) {
        const rad = Math.sqrt(px.length / Math.PI);
        objects.push({ id: id('r'), type: 'room', shape: { circle: [r2((rect.cx - ox) / s), r2((rect.cy - oy) / s), r2(rad / s)] }, name: 'Tower' });
        count('tower');
      } else {
        const ring = squareUp(px, w);
        if (!ring) continue;
        // a long thin piece is wall, a squarish one a gate or corner tower
        const wallPiece = Math.max(rect.w, rect.h) + 1 >= 3.5 * (Math.min(rect.w, rect.h) + 1);
        objects.push({ id: id('r'), type: 'room', shape: { poly: sq(ring) }, name: wallPiece ? 'Wall' : 'Tower' });
        count(wallPiece ? 'wall' : 'tower');
      }
    }
  }

  // ---- houses as rooms ----
  const houseSizes = [...byHouse.values()].map((p) => p.length).filter((v) => v >= minPx).sort((a, b) => a - b);
  const usual = houseSizes[houseSizes.length >> 1] ?? minPx;
  for (const px of byHouse.values()) {
    if (papery(px)) continue;
    if (px.length < minPx) continue;
    // a block of several houses (much bigger than a usual house, and not one rectangle): cut into rectangles
    if (!o.join && o.regular !== false && px.length >= 1.8 * usual) {
      const corners: P[] = [];
      corners.push(...rowEnds(px, w, true));
      const rect = minAreaRect(corners);
      if (px.length < 0.8 * (rect.w + 1) * (rect.h + 1)) {
        const rects = splitBlock(px, w, Math.max(minPx, 0.3 * usual));
        if (rects.length > 1) {
          for (const ring of rects) {
            objects.push({ id: id('r'), type: 'room', shape: { poly: sq(ring) } });
            count('building');
          }
          continue;
        }
      }
    }
    let ring: P[] | null;
    if (o.regular === false) {
      const box: [number, number, number, number] = [Infinity, Infinity, -1, -1];
      for (const i of px) {
        const x = i % w;
        const y = (i - x) / w;
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      const { m, x0, y0 } = cut(px, box, w);
      const rings = outlines(m).filter((r) => signedArea(r) > 0);
      ring = rings.length ? simplify(rings[0]!, 1).map(([x, y]) => [x + x0, y + y0] as P) : null;
    } else ring = squareUp(px, w);
    if (!ring || ring.length < 3) continue;
    objects.push({ id: id('r'), type: 'room', shape: { poly: sq(ring) } });
    count('building');
  }
  return { objects, counts };
}

/** Outer rings of each part; a part with a hole is cut through its first hole so every piece is solid (the city tracer does the same). */
function solidRings(m: Mask, minPx: number, depth = 0): P[][] {
  const out: P[][] = [];
  for (const c of components(m, minPx, false)) {
    const { m: cm, x0, y0 } = cut(c.px, c.box, m.w);
    const rings = outlines(cm);
    const holes = rings.filter((r) => -signedArea(r) >= 4);
    if (!holes.length || depth >= 4) {
      out.push(...rings.filter((r) => signedArea(r) > 0).map((r) => r.map(([x, y]) => [x + x0, y + y0] as P)));
      continue;
    }
    const cx = Math.round(holes[0]!.reduce((a, p) => a + p[0], 0) / holes[0]!.length);
    const half = (keep: (x: number) => boolean): Mask => {
      const hm: Mask = { w: m.w, h: m.h, px: new Uint8Array(m.w * m.h) };
      for (const i of c.px) if (keep((i % m.w) - x0)) hm.px[i] = 1;
      return hm;
    };
    for (const side of [half((x) => x <= cx), half((x) => x >= cx - 1)]) out.push(...solidRings(side, minPx, depth + 1));
  }
  return out;
}

/** How much bigger a painted map's features are than in a picture about 1300 px long (at least 1). */
export function paintedScale(w: number, h: number): number {
  return Math.max(1, Math.max(w, h) / 1300);
}

/** The Kuwahara radius that flattens a painted map's textures at this picture size. */
export function paintedSmoothing(w: number, h: number): number {
  return Math.max(2, Math.round(2 * paintedScale(w, h)));
}
