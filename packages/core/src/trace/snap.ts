// Tidying traced outlines: a pixel outline becomes a polygon in grid squares
// whose straight walls sit on the half-square grid (as hand-made maps have
// them), while curves (round rooms, caves) stay smooth polygons.
import type { Point } from '../schema.ts';
import { simplify } from './raster.ts';

type P = [number, number];

export interface SnapOptions {
  /** Picture pixels per square. */
  s: number;
  /** The picture pixel where square (0, 0) is. */
  origin: [number, number];
  /** Outline simplification in pixels (default: 0.035 squares, at least 1 px). */
  tolerance?: number;
  /** Straight walls closer than this to a half-square line move onto it (squares, default 0.2). 0: no snapping. */
  snap?: number;
  /**
   * Whether moving a wall to (x, y) (in picture pixels, just past where it would
   * go) would run into something else, e.g. a neighbouring room behind a thin wall.
   */
  blocked?: (x: number, y: number) => boolean;
}

const r3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

interface Line {
  /** A point on the line and its direction (unit). */
  px: number;
  py: number;
  dx: number;
  dy: number;
  snapped: boolean;
}

/** The intersection of two lines, or null when they are (nearly) parallel. */
function meet(a: Line, b: Line): P | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + a.dx * t, a.py + a.dy * t];
}

/**
 * A traced ring (picture pixels, along pixel edges) as a polygon in squares:
 * simplified, then each long straight wall that runs along x or y (or at 45°)
 * moved onto the nearest half-square line when that is close, and the corners
 * rebuilt where the walls meet.
 */
export function snapRing(ring: readonly P[], o: SnapOptions): Point[] {
  const { s } = o;
  const [ox, oy] = o.origin;
  const tol = o.tolerance ?? Math.max(1, 0.035 * s);
  const pts = simplify(ring, tol).map(([x, y]) => [(x - ox) / s, (y - oy) / s] as P);
  const snapTol = o.snap ?? 0.2;
  if (pts.length < 3 || snapTol <= 0) return pts.map(([x, y]) => [r3(x), r3(y)]);
  const n = pts.length;
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const line: Line = { px: mx, py: my, dx, dy, snapped: false };
    const along = Math.abs(dy) < 0.07 ? 'h' : Math.abs(dx) < 0.07 ? 'v' : Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.1 ? 'd' : null;
    if (along && len >= (along === 'd' ? 0.6 : 0.3)) {
      // the wall's own offset, and the nearest half-square one
      let target: P | null = null;
      if (along === 'h') {
        const y = Math.round(my * 2) / 2;
        if (Math.abs(y - my) <= snapTol) target = [mx, y];
      } else if (along === 'v') {
        const x = Math.round(mx * 2) / 2;
        if (Math.abs(x - mx) <= snapTol) target = [x, my];
      } else {
        // x ± y = k: lines at 45° through half-square points have k on the half grid
        const sign = Math.sign(dx) === Math.sign(dy) ? -1 : 1; // direction (1, 1): x - y is constant
        const k = mx + sign * my;
        const k2 = Math.round(k * 2) / 2;
        if (Math.abs(k2 - k) / Math.SQRT2 <= snapTol) {
          const shift = (k2 - k) / 2;
          target = [mx + shift, my + sign * shift];
        }
      }
      if (target) {
        const mvx = target[0] - mx;
        const mvy = target[1] - my;
        const moved = Math.hypot(mvx, mvy);
        let ok = true;
        if (moved > 0.01 && o.blocked) {
          // look a little past the new position, along the whole wall
          const ux = mvx / moved;
          const uy = mvy / moved;
          const steps = Math.max(2, Math.ceil(len / 0.25));
          for (let k = 0; k <= steps && ok; k++) {
            const t = k / steps - 0.5;
            const qx = target[0] + dx * len * t * 0.9 + ux * 0.15;
            const qy = target[1] + dy * len * t * 0.9 + uy * 0.15;
            if (o.blocked(qx * s + ox, qy * s + oy)) ok = false;
          }
        }
        if (ok) {
          line.px = target[0];
          line.py = target[1];
          if (along !== 'd') {
            line.dx = along === 'h' ? Math.sign(dx) : 0;
            line.dy = along === 'v' ? Math.sign(dy) : 0;
          } else {
            line.dx = Math.sign(dx) * Math.SQRT1_2;
            line.dy = Math.sign(dy) * Math.SQRT1_2;
          }
          line.snapped = true;
        }
      }
    }
    lines.push(line);
  }
  // a few short kinks between two walls that moved (a corner rounded off by a pixel or two, a spike where
  // two pieces of floor meet) go: the walls meet instead, or carry on when they are one line
  const shortLen = Math.max(3 / s, 0.25);
  const len = (i: number) => {
    const a = pts[i % n]!;
    const b = pts[(i + 1) % n]!;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const short = (i: number) => !lines[i % n]!.snapped && len(i) < shortLen;
  const sameLine = (a: Line, b: Line) => Math.abs(a.dx * b.dy - a.dy * b.dx) < 1e-6 && Math.abs((b.px - a.px) * a.dy - (b.py - a.py) * a.dx) < 1e-6;
  const skip = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!lines[i]!.snapped || short(i + 1) === false) continue;
    let j = i + 1;
    while (j - i <= 4 && short(j)) j++;
    const last = lines[j % n]!;
    if (j - i > 4 || !last.snapped || j % n === i) continue;
    const corner = meet(lines[i]!, last);
    if (!corner && !sameLine(lines[i]!, last)) continue;
    // every point of the run near where the walls meet (or near the shared line)
    let ok = true;
    for (let k = i + 1; k <= j && ok; k++) {
      const p = pts[k % n]!;
      if (corner) ok = Math.hypot(p[0] - corner[0], p[1] - corner[1]) <= 0.35;
      else ok = Math.abs((p[0] - last.px) * last.dy - (p[1] - last.py) * last.dx) <= 0.2;
    }
    if (ok) for (let k = i + 1; k < j; k++) skip[k % n] = true;
  }
  const kept: { line: Line; start: P }[] = [];
  for (let i = 0; i < n; i++) {
    if (skip[i]) continue;
    // where a run was dropped, the point to fall back on is where the run began
    let k = i;
    while (skip[(k - 1 + n) % n] && (k - 1 + n) % n !== i) k = (k - 1 + n) % n;
    kept.push({ line: lines[i]!, start: pts[k]! });
  }
  // corners: where consecutive walls meet (only where one of them moved)
  const out: P[] = [];
  const m = kept.length;
  for (let i = 0; i < m; i++) {
    const prev = kept[(i - 1 + m) % m]!.line;
    const next = kept[i]!.line;
    const p = kept[i]!.start;
    let q: P = p;
    if (prev.snapped || next.snapped) {
      const m = meet(prev, next);
      if (m && Math.hypot(m[0] - p[0], m[1] - p[1]) <= Math.max(0.35, snapTol * 2)) q = m;
      else if (!m) {
        // parallel walls (one long wall cut in two): keep the point, on the moved line
        const l = next.snapped ? next : prev;
        const t = (p[0] - l.px) * l.dx + (p[1] - l.py) * l.dy;
        q = [l.px + l.dx * t, l.py + l.dy * t];
      }
    }
    out.push(q);
  }
  // drop repeats and points on a straight line
  const clean: P[] = [];
  for (const p of out) {
    const last = clean.at(-1);
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-3) clean.push(p);
  }
  if (clean.length > 1 && Math.hypot(clean[0]![0] - clean.at(-1)![0], clean[0]![1] - clean.at(-1)![1]) <= 1e-3) clean.pop();
  let changed = true;
  while (changed && clean.length > 3) {
    changed = false;
    for (let i = 0; i < clean.length; i++) {
      const a = clean[(i - 1 + clean.length) % clean.length]!;
      const b = clean[i]!;
      const c = clean[(i + 1) % clean.length]!;
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-4) {
        clean.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return clean.map(([x, y]) => [r3(x), r3(y)]);
}
