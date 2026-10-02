// The hand-inked line for props drawn outside the design system's generators
// (custom props, which Claude draws in the editor's chat). Claude writes plain
// geometry (rects, circles, polygons, straight or curved paths); inkBody turns
// every shape into the same kind of line the built-in art has: resampled,
// nudged off true by a slow seeded swell, and written back as smooth cubic
// Béziers (a port of the Pen in delve-props-design-system/assets/tools).
// The swell is seeded by the prop and the shape's own geometry, so a fill and
// an outline drawn from the same coordinates stay on top of each other, and
// shapes that didn't change keep their line when a prop is redrawn.
// Pure string and number work: runs in the browser and on the server.
import { hashString, rng } from '../render/rng.ts';

export type Pt = [number, number];
export interface Subpath {
  pts: Pt[];
  closed: boolean;
}

const fmt = (v: number): string => {
  let s = v.toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  if (s === '-0') s = '0';
  return s;
};
const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------- shapes as points ----------

function rrect(x: number, y: number, w: number, h: number, r = 0, cn = 5): Pt[] {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0.01) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const p: Pt[] = [];
  for (const [cx, cy, a0] of [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]] as const) {
    for (let k = 0; k <= cn; k++) {
      const a = a0 + ((Math.PI / 2) * k) / cn;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return p;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const n = Math.max(16, Math.floor((Math.PI * (rx + ry)) / 2));
  return [...Array(n)].map((_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as Pt);
}

const nums = (v: string | undefined): number[] => (v ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
const num = (a: Map<string, string>, k: string): number => Number(a.get(k) ?? 0) || 0;

/** A path's d as polylines, one per subpath (curves and arcs sampled about every 2 units). */
export function flattenPath(d: string): Subpath[] {
  const out: Subpath[] = [];
  let i = 0;
  const ws = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const number = (): number | null => {
    ws();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | null => {
    ws();
    const c = d[i];
    if (c !== '0' && c !== '1') return null;
    i++;
    return c === '1' ? 1 : 0;
  };
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let pts: Pt[] = [];
  let lastCtrl: Pt | null = null;
  let lastCmd = '';
  const flush = (closed: boolean) => {
    if (pts.length >= 2) out.push({ pts, closed });
    pts = [];
  };
  const lineTo = (p: Pt) => {
    pts.push(p);
    cur = p;
  };
  const cubic = (c1: Pt, c2: Pt, p: Pt) => {
    const len = dist(cur, c1) + dist(c1, c2) + dist(c2, p);
    const n = clamp(Math.ceil(len / 2), 2, 64);
    const p0 = cur;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      lineTo([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1]]);
    }
  };
  const quad = (c: Pt, p: Pt) => {
    const len = dist(cur, c) + dist(c, p);
    const n = clamp(Math.ceil(len / 2), 2, 64);
    const p0 = cur;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      lineTo([u * u * p0[0] + 2 * u * t * c[0] + t * t * p[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p[1]]);
    }
  };
  // SVG arc: endpoint to centre parametrisation (SVG 1.1, appendix F.6.5)
  const arc = (rx: number, ry: number, deg: number, large: number, sweep: number, p: Pt) => {
    const p0 = cur;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!rx || !ry || (p0[0] === p[0] && p0[1] === p[1])) return lineTo(p);
    const phi = (deg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (p0[0] - p[0]) / 2;
    const dy = (p0[1] - p[1]) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) {
      rx *= Math.sqrt(lam);
      ry *= Math.sqrt(lam);
    }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (co * rx * y1) / ry;
    const cyp = (-co * ry * x1) / rx;
    const cx = cos * cxp - sin * cyp + (p0[0] + p[0]) / 2;
    const cy = sin * cxp + cos * cyp + (p0[1] + p[1]) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = clamp(Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 2), 2, 90);
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      lineTo(k === n ? p : [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
    }
  };

  let guard = 0;
  while (i < d.length && guard++ < 200_000) {
    ws();
    if (i >= d.length) break;
    let cmd = d[i]!;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) i++;
    else if (lastCmd && lastCmd !== 'Z' && lastCmd !== 'z') cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd; // repeated arguments
    else break;
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      if (pts.length) flush(true);
      cur = start;
      lastCtrl = null;
      lastCmd = cmd;
      continue;
    }
    const before = i;
    if (C === 'M') {
      const x = number();
      const y = number();
      if (x === null || y === null) break;
      flush(false);
      cur = at(x, y);
      start = cur;
      pts = [cur];
      lastCtrl = null;
    } else if (C === 'L') {
      const x = number();
      const y = number();
      if (x === null || y === null) break;
      if (!pts.length) pts = [cur];
      lineTo(at(x, y));
      lastCtrl = null;
    } else if (C === 'H' || C === 'V') {
      const v = number();
      if (v === null) break;
      if (!pts.length) pts = [cur];
      lineTo(C === 'H' ? [rel ? cur[0] + v : v, cur[1]] : [cur[0], rel ? cur[1] + v : v]);
      lastCtrl = null;
    } else if (C === 'C' || C === 'S') {
      const v = (C === 'C' ? [number(), number(), number(), number(), number(), number()] : [number(), number(), number(), number()]) as (number | null)[];
      if (v.some((x) => x === null)) break;
      const n6 = v as number[];
      if (!pts.length) pts = [cur];
      const reflect: Pt = lastCtrl && /[CcSs]/.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
      const c1 = C === 'C' ? at(n6[0]!, n6[1]!) : reflect;
      const c2 = C === 'C' ? at(n6[2]!, n6[3]!) : at(n6[0]!, n6[1]!);
      const p = C === 'C' ? at(n6[4]!, n6[5]!) : at(n6[2]!, n6[3]!);
      cubic(c1, c2, p);
      lastCtrl = c2;
    } else if (C === 'Q' || C === 'T') {
      const v = (C === 'Q' ? [number(), number(), number(), number()] : [number(), number()]) as (number | null)[];
      if (v.some((x) => x === null)) break;
      const n4 = v as number[];
      if (!pts.length) pts = [cur];
      const prev: Pt | null = lastCtrl;
      const c: Pt = C === 'Q' ? at(n4[0]!, n4[1]!) : prev && /[QqTt]/.test(lastCmd) ? [2 * cur[0] - prev[0], 2 * cur[1] - prev[1]] : cur;
      const p = C === 'Q' ? at(n4[2]!, n4[3]!) : at(n4[0]!, n4[1]!);
      quad(c, p);
      lastCtrl = c;
    } else if (C === 'A') {
      const rx = number();
      const ry = number();
      const rot = number();
      const large = flag();
      const sweep = flag();
      const x = number();
      const y = number();
      if ([rx, ry, rot, large, sweep, x, y].some((v) => v === null)) break;
      if (!pts.length) pts = [cur];
      arc(rx!, ry!, rot!, large!, sweep!, at(x!, y!));
      lastCtrl = null;
    }
    if (i === before) break;
    lastCmd = cmd;
  }
  flush(false);
  return out.map((s) => ({ ...s, pts: dedupe(s.pts, s.closed) })).filter((s) => s.pts.length >= 2);
}

function dedupe(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1]!, p) > 1e-3) out.push(p);
  if (closed && out.length > 2 && dist(out[0]!, out[out.length - 1]!) < 1e-3) out.pop();
  return out;
}

/** An element's geometry as subpaths in its own coordinates, or null if it isn't a shape. */
export function shapeSubpaths(tag: string, a: Map<string, string>): Subpath[] | null {
  switch (tag) {
    case 'rect': {
      const w = num(a, 'width');
      const h = num(a, 'height');
      if (!(w > 0 && h > 0)) return [];
      return [{ pts: rrect(num(a, 'x'), num(a, 'y'), w, h, Number(a.get('rx') ?? a.get('ry') ?? 0) || 0), closed: true }];
    }
    case 'circle': {
      const r = num(a, 'r');
      return r > 0 ? [{ pts: ellipsePts(num(a, 'cx'), num(a, 'cy'), r, r), closed: true }] : [];
    }
    case 'ellipse': {
      const rx = num(a, 'rx');
      const ry = num(a, 'ry');
      return rx > 0 && ry > 0 ? [{ pts: ellipsePts(num(a, 'cx'), num(a, 'cy'), rx, ry), closed: true }] : [];
    }
    case 'line':
      return [{ pts: [[num(a, 'x1'), num(a, 'y1')], [num(a, 'x2'), num(a, 'y2')]], closed: false }];
    case 'polyline':
    case 'polygon': {
      const v = nums(a.get('points'));
      const pts: Pt[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k]!, v[k + 1]!]);
      return pts.length >= 2 ? [{ pts: dedupe(pts, tag === 'polygon'), closed: tag === 'polygon' }] : [];
    }
    case 'path':
      return flattenPath(a.get('d') ?? '');
    default:
      return null;
  }
}

// ---------- the pen ----------

function resample(pts: Pt[], step: number, closed: boolean): Pt[] {
  const seg: [Pt, Pt][] = [];
  for (let k = 0; k < pts.length - (closed ? 0 : 1); k++) seg.push([pts[k]!, pts[(k + 1) % pts.length]!]);
  const total = seg.reduce((s, [a, b]) => s + dist(a, b), 0);
  if (!seg.length || total < 1e-6) return pts.slice();
  const n = Math.max(closed ? 6 : 2, Math.round(total / step));
  const d = total / n;
  const out: Pt[] = [];
  let acc = 0;
  let k = 0;
  for (let j = 0; j < n + (closed ? 0 : 1); j++) {
    const t = j * d;
    while (k < seg.length - 1 && acc + dist(...seg[k]!) < t - 1e-9) {
      acc += dist(...seg[k]!);
      k++;
    }
    const [a, b] = seg[k]!;
    const l = dist(a, b) || 1e-9;
    const u = clamp((t - acc) / l, 0, 1);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

class Pen {
  private readonly r: () => number;
  constructor(seed: number) {
    this.r = rng(seed);
  }
  u(a: number, b: number): number {
    return a + (b - a) * this.r();
  }
  /** Three sines along the line: one slow swell and two smaller ripples. Closed lines get whole cycles, so the seam doesn't show. */
  noise(len: number, amp: number, closed: boolean, wl: [number, number]): (s: number) => number {
    const c: [number, number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const lam = this.u(wl[0], wl[1]) * (k === 0 ? 2.2 : 1 / k);
      const f = closed ? Math.max(1, Math.round(len / lam)) / len : 1 / lam;
      c.push([(k === 0 ? 1 : 0.35 / k) * this.u(0.8, 1), f, this.u(0, 2 * Math.PI)]);
    }
    const peak = c.reduce((s, x) => s + x[0], 0);
    for (const x of c) x[0] *= amp / peak;
    return (s) => c.reduce((a, [A, f, p]) => a + A * Math.sin(2 * Math.PI * f * s + p), 0);
  }
  wobble(pts: Pt[], closed: boolean, amp: number, step: number, wl: [number, number]): Pt[] {
    const b = resample(pts, step, closed);
    const n = b.length;
    if (n < 2) return b;
    const s = [0];
    let acc = 0;
    for (let k = 1; k < n; k++) {
      acc += dist(b[k - 1]!, b[k]!);
      s.push(acc);
    }
    const total = acc + (closed ? dist(b[n - 1]!, b[0]!) : 0);
    const nz = this.noise(total || 1, amp, closed, wl);
    return b.map((p, k) => {
      const a = closed ? b[(k - 1 + n) % n]! : b[Math.max(0, k - 1)]!;
      const c = closed ? b[(k + 1) % n]! : b[Math.min(n - 1, k + 1)]!;
      const tx = c[0] - a[0];
      const ty = c[1] - a[1];
      const l = Math.hypot(tx, ty) || 1;
      const o = nz(s[k]!);
      return [p[0] - (ty / l) * o, p[1] + (tx / l) * o] as Pt;
    });
  }
}

/** Catmull-Rom through the points, written as cubic Béziers. */
function bez(pts: Pt[], closed: boolean): string {
  const n = pts.length;
  const P = (k: number): Pt => (closed ? pts[((k % n) + n) % n]! : pts[clamp(k, 0, n - 1)]!);
  const T = (k: number): Pt => {
    if (!closed && k === 0) return [P(1)[0] - P(0)[0], P(1)[1] - P(0)[1]];
    if (!closed && k === n - 1) return [P(n - 1)[0] - P(n - 2)[0], P(n - 1)[1] - P(n - 2)[1]];
    const a = P(k - 1);
    const b = P(k + 1);
    return [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2];
  };
  let d = `M${fmt(pts[0]![0])} ${fmt(pts[0]![1])}`;
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const p0 = P(k);
    const p1 = P(k + 1);
    const to = T(k);
    const ti = T(closed ? (k + 1) % n : k + 1);
    d += `C${fmt(p0[0] + to[0] / 3)} ${fmt(p0[1] + to[1] / 3)} ${fmt(p1[0] - ti[0] / 3)} ${fmt(p1[1] - ti[1] / 3)} ${fmt(p1[0])} ${fmt(p1[1])}`;
  }
  return d + (closed ? 'Z' : '');
}

const sizeOf = (pts: Pt[]): number => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};
const lengthOf = (pts: Pt[]): number => pts.reduce((s, p, k) => (k ? s + dist(pts[k - 1]!, p) : 0), 0);

/**
 * One subpath, inked. Closed shapes swell with their size (a 70-unit table top
 * about 0.6 units, a 5-unit rivet hardly at all), never with their stroke, so
 * a fill and its outline match. Open lines swell with their weight.
 */
export function inkSubpath(sp: Subpath, seed: number, strokeWidth: number): string {
  const pen = new Pen(seed);
  if (sp.closed) {
    const d = Math.max(1, sizeOf(sp.pts));
    const amp = clamp(0.0085 * d, 0.03, 0.6);
    const step = clamp(1.2 + d / 16, 1.3, 5);
    return bez(pen.wobble(sp.pts, true, amp, step, [22, 60]), true);
  }
  const len = lengthOf(sp.pts);
  const base = strokeWidth >= 4 ? 0.45 : strokeWidth >= 2 ? 0.35 : 0.18;
  const amp = base * Math.min(1, len / 20);
  const step = clamp(len / 6, 1.5, 5);
  return bez(pen.wobble(sp.pts, false, amp, step, [18, 45]), false);
}

// ---------- the pass over a cleaned body ----------

const GEOMETRY = new Set(['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2']);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
const attrsOf = (raw: string): Map<string, string> => new Map([...raw.matchAll(attrRe)].map((m) => [m[1]!, m[2]!]));

/**
 * Ink every shape of a body cleaned by parseAssetSvg (whitelisted markup with
 * double-quoted attributes): each becomes a <path> with the hand-drawn line and
 * the shape's own paint. Marks smaller than `keepBelow` units (rivets, nail
 * heads, keyholes) stay exactly as drawn, like the built-in art's dots.
 */
export function inkBody(body: string, seedKey: string, o: { keepBelow?: number } = {}): string {
  const keepBelow = o.keepBelow ?? 6;
  const widths: number[] = [];
  return body.replace(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g, (all, closing: string, tag: string, raw: string) => {
    if (tag === 'g') {
      if (closing) widths.pop();
      else {
        const w = Number(attrsOf(raw).get('stroke-width'));
        widths.push(Number.isFinite(w) && w > 0 ? w : (widths[widths.length - 1] ?? 1));
      }
      return all;
    }
    if (closing || !SHAPES.has(tag)) return all;
    const a = attrsOf(raw);
    const subs = shapeSubpaths(tag, a);
    if (!subs || !subs.length) return all;
    const every = subs.flatMap((s) => s.pts);
    const xs = every.map((p) => p[0]);
    const ys = every.map((p) => p[1]);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < keepBelow) return all;
    const sw = Number(a.get('stroke-width')) || widths[widths.length - 1] || 1;
    const geo = [...a].filter(([k]) => GEOMETRY.has(k)).map(([k, v]) => `${k}=${v}`).join(';');
    const d = subs.map((s, k) => inkSubpath(s, hashString(`${seedKey}|${tag}|${geo}|${k}`), sw)).join('');
    // a <line> never fills; as a path it would, with whatever fill it has or inherits
    const paint = [...a].filter(([k]) => !GEOMETRY.has(k) && !(tag === 'line' && k === 'fill')).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<path d="${d}"${tag === 'line' ? ' fill="none"' : ''}${paint}/>`;
  });
}
