// 3D dice, the pure part (no WebGL, no DOM): which dice a chat roll throws,
// the shape of every die, which face ends up on top after a throw, and how the
// labels are swapped so that face shows the value the server rolled. The dice
// bundle (table-dice.js) uses all of it; table.js only diceForRolls.
import type { RollResult } from '@delve/table';

/** d100t and d100u are the two d10s of a d100 (tens 00–90, units 0–9). dF is a d6 with +, +, −, −, blank, blank. */
export type DieKind = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100t' | 'd100u' | 'dF';
export type ShapeKind = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20';
export type Vec3 = [number, number, number];
/** x, y, z, w */
export type Quat = [number, number, number, number];

export interface ThrowDie {
  kind: DieKind;
  /** What the die must show: its own face value (d100 tens 0–90, units 0–9, dF −1/0/1). */
  value: number;
  /** Dropped by kh/kl/dh/dl: dimmed once it lands. */
  dropped: boolean;
}

export interface DiceThrow {
  dice: ThrowDie[];
  /** Dice left out because a throw holds at most MAX_THROWN (a d100 counts once). */
  more: number;
}

export const MAX_THROWN = 20;

const SIDES: Partial<Record<number, DieKind>> = { 4: 'd4', 6: 'd6', 8: 'd8', 10: 'd10', 12: 'd12', 20: 'd20' };

/** The physical dice for one rolled die, or null when there's no 3D die of that size (d3, d7…). */
function physicalDice(sides: number | 'F', value: number, dropped: boolean): ThrowDie[] | null {
  if (!Number.isInteger(value)) return null;
  if (sides === 'F') return value >= -1 && value <= 1 ? [{ kind: 'dF', value, dropped }] : null;
  if (sides === 100) {
    if (value < 1 || value > 100) return null;
    const units = value % 10;
    // 100 is 00 + 0, as on the table
    return [
      { kind: 'd100t', value: (value % 100) - units, dropped },
      { kind: 'd100u', value: units, dropped },
    ];
  }
  const kind = SIDES[sides];
  return kind && value >= 1 && value <= sides ? [{ kind, value, dropped }] : null;
}

/** The dice to throw for a message's rolls: every die that counts or was dropped; rerolled ones are replaced by their reroll. */
export function diceForRolls(rolls: readonly RollResult[] | undefined, max = MAX_THROWN): DiceThrow {
  const dice: ThrowDie[] = [];
  let more = 0;
  let full = false;
  for (const r of rolls ?? []) {
    for (const t of r.terms) {
      if (t.kind !== 'dice') continue;
      for (const d of t.dice) {
        if (d.rerolled) continue;
        const set = physicalDice(t.sides, d.value, Boolean(d.dropped));
        if (!set) continue;
        if (full || dice.length + set.length > max) {
          full = true;
          more++;
        } else dice.push(...set);
      }
    }
  }
  return { dice, more };
}

const range = (from: number, to: number, step = 1): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_v, i) => from + i * step);

/** Every face value of a die, once per face. */
export function faceValues(kind: DieKind): number[] {
  switch (kind) {
    case 'd100t':
      return range(0, 90, 10);
    case 'd100u':
      return range(0, 9);
    case 'dF':
      return [-1, -1, 0, 0, 1, 1];
    default:
      return range(1, Number(kind.slice(1)));
  }
}

export function labelText(kind: DieKind, value: number): string {
  if (kind === 'dF') return value > 0 ? '+' : value < 0 ? '−' : '';
  if (kind === 'd100t') return value === 0 ? '00' : String(value);
  return String(value);
}

/** 6 and 9 get a line under them, so upside down they still read right. */
export const underlined = (text: string): boolean => text === '6' || text === '9';

export const shapeOf = (kind: DieKind): ShapeKind => (kind === 'dF' ? 'd6' : kind === 'd100t' || kind === 'd100u' ? 'd10' : kind);

// ---------- vectors ----------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const mean = (ps: Vec3[]): Vec3 => scale(ps.reduce(add, [0, 0, 0]), 1 / ps.length);

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} out of range`);
  return x;
}

/** Rotate a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

// ---------- shapes ----------

export interface DieShape {
  kind: ShapeKind;
  /** In world units, centred on the die's middle. */
  vertices: Vec3[];
  /** Vertex indices, counter-clockwise seen from outside. */
  faces: number[][];
  /** Unit outward normal of each face. */
  normals: Vec3[];
  /** Where the labels are read: on the top face, or for the d4 at the top corner. */
  sites: 'faces' | 'vertices';
  /** Unit direction of each site from the middle. */
  siteDirs: Vec3[];
  /** The site straight across from each, or -1 (the d4 has none). */
  opposite: number[];
}

/** The golden ratio, (1 + √5) / 2, for the d12 and d20. */
const PHI = 1.618033988749895;

/** Distance from the middle to the corners, in world units, so the dice look about the same size. */
const RADIUS: Record<ShapeKind, number> = { d4: 1.45, d6: 1.0, d8: 1.1, d10: 1.08, d12: 1.08, d20: 1.12 };

function baseVertices(s: ShapeKind): Vec3[] {
  const signs = [1, -1];
  const out: Vec3[] = [];
  switch (s) {
    case 'd4':
      return [
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ];
    case 'd6':
      for (const x of signs) for (const y of signs) for (const z of signs) out.push([x, y, z]);
      return out;
    case 'd8':
      for (const a of signs) out.push([a, 0, 0], [0, a, 0], [0, 0, a]);
      return out;
    case 'd10': {
      // A pentagonal trapezohedron: two apexes and a zigzag ring. The ring's
      // height follows from the apex so each face is a flat kite.
      const step = Math.PI / 5;
      const z = (1 - Math.cos(step)) / (1 + Math.cos(step));
      out.push([0, 1, 0], [0, -1, 0]);
      for (let i = 0; i < 10; i++) out.push([Math.cos(i * step), i % 2 ? -z : z, Math.sin(i * step)]);
      return out;
    }
    case 'd12':
      for (const x of signs) for (const y of signs) for (const z of signs) out.push([x, y, z]);
      for (const a of signs) for (const b of signs) out.push([0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]);
      return out;
    case 'd20':
      for (const a of signs) for (const b of signs) out.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
      return out;
  }
}

/** The faces of the convex hull of points around the origin, each counter-clockwise from outside. */
export function hullFaces(vs: readonly Vec3[]): number[][] {
  const eps = 1e-6;
  const faces: number[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      for (let k = j + 1; k < vs.length; k++) {
        const a = at(vs, i);
        let n = cross(sub(at(vs, j), a), sub(at(vs, k), a));
        if (len(n) < eps) continue;
        n = normalize(n);
        let d = dot(n, a);
        if (d < 0) {
          n = scale(n, -1);
          d = -d;
        }
        if (vs.some((v) => dot(n, v) - d > eps)) continue;
        const members = vs.flatMap((v, m) => (Math.abs(dot(n, v) - d) <= eps ? [m] : []));
        const key = members.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const c = mean(members.map((m) => at(vs, m)));
        const e1 = normalize(sub(at(vs, at(members, 0)), c));
        const e2 = cross(n, e1);
        const angle = (m: number) => {
          const p = sub(at(vs, m), c);
          return Math.atan2(dot(p, e2), dot(p, e1));
        };
        faces.push(members.sort((x, y) => angle(x) - angle(y)));
      }
    }
  }
  return faces;
}

function buildShape(s: ShapeKind): DieShape {
  const base = baseVertices(s);
  const r = Math.max(...base.map(len));
  const vertices = base.map((v) => scale(v, RADIUS[s] / r));
  const faces = hullFaces(vertices);
  const normals = faces.map((f) => normalize(cross(sub(at(vertices, at(f, 1)), at(vertices, at(f, 0))), sub(at(vertices, at(f, 2)), at(vertices, at(f, 0))))));
  const sites = s === 'd4' ? 'vertices' : 'faces';
  const siteDirs = sites === 'faces' ? normals : vertices.map(normalize);
  const opposite = siteDirs.map((d, i) => siteDirs.findIndex((e, k) => k !== i && dot(d, e) < -0.9999));
  return { kind: s, vertices, faces, normals, sites, siteDirs, opposite };
}

const shapes = new Map<ShapeKind, DieShape>();

export function dieShape(kind: DieKind): DieShape {
  const s = shapeOf(kind);
  let shape = shapes.get(s);
  if (!shape) shapes.set(s, (shape = buildShape(s)));
  return shape;
}

// ---------- labels ----------

/** A starting label (a face value) for every site: opposite sites pair lowest with highest, so they add up like real dice (d6: 7). */
export function canonicalLabels(kind: DieKind): number[] {
  const { opposite } = dieShape(kind);
  const values = faceValues(kind).sort((a, b) => a - b);
  if (opposite.every((j) => j < 0)) return values;
  const labels: (number | undefined)[] = new Array<number | undefined>(opposite.length).fill(undefined);
  let lo = 0;
  let hi = values.length - 1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== undefined) continue;
    labels[i] = at(values, lo++);
    labels[at(opposite, i)] = at(values, hi--);
  }
  return labels.map((v) => v ?? 0);
}

/** The site that ends up on top for a die resting with rotation q, and how straight up it points (1: flat). */
export function topSite(kind: DieKind, q: Quat): { site: number; up: number } {
  let site = 0;
  let up = -Infinity;
  dieShape(kind).siteDirs.forEach((d, i) => {
    const y = rotate(q, d)[1];
    if (y > up) {
      up = y;
      site = i;
    }
  });
  return { site, up };
}

/**
 * Swap labels so `top` shows `value`. With opposite sites, the pair across is
 * swapped too, so opposite faces still add up the same.
 */
export function remapLabels(labels: readonly number[], opposite: readonly number[], top: number, value: number): number[] {
  const out = labels.slice();
  if (out[top] === value) return out;
  const g = out.findIndex((v, i) => v === value && i !== top);
  if (g < 0) throw new Error(`No face shows ${value}`);
  const swap = (a: number, b: number) => {
    const t = at(out, a);
    out[a] = at(out, b);
    out[b] = t;
  };
  const ot = opposite[top] ?? -1;
  const og = opposite[g] ?? -1;
  swap(top, g);
  if (ot >= 0 && og >= 0 && g !== ot) swap(ot, og);
  return out;
}

/** The labels a die needs so that, resting as `q`, it shows `value` on top. */
export function labelsFor(kind: DieKind, q: Quat, value: number): number[] {
  return remapLabels(canonicalLabels(kind), dieShape(kind).opposite, topSite(kind, q).site, value);
}

// ---------- where labels go on each face ----------

export interface FaceFrame {
  centroid: Vec3;
  /** In-plane unit vectors: the label's up and right, seen from outside. */
  up: Vec3;
  right: Vec3;
  /** Where the label's middle sits (on the d10's kite: just above its widest part, not at the centroid). */
  anchor: Vec3;
}

/** A frame per face for texturing. `extent` is the largest centre-to-corner distance, the same scale for every face of a die. */
export function faceFrames(kind: DieKind): { frames: FaceFrame[]; extent: number } {
  const shape = dieShape(kind);
  const { vertices, faces, normals } = shape;
  let extent = 0;
  const frames = faces.map((f, fi) => {
    const ps = f.map((i) => at(vertices, i));
    const c = mean(ps);
    const n = at(normals, fi);
    const dists = ps.map((p) => len(sub(p, c)));
    const far = Math.max(...dists);
    extent = Math.max(extent, far);
    const farIdx = dists.findIndex((d) => d >= far - 1e-6);
    // d6 labels sit square to the edges; the rest point at a corner (the d10's at its apex)
    const toward = shape.kind === 'd6' ? scale(add(at(ps, 0), at(ps, 1)), 0.5) : at(ps, farIdx);
    const up = normalize(sub(toward, c));
    const right = cross(up, n);
    // the d10's kite: a little above its widest line (between the two corners next to the apex)
    const wide = scale(add(at(ps, (farIdx + 1) % ps.length), at(ps, (farIdx + ps.length - 1) % ps.length)), 0.5);
    const anchor = shape.kind === 'd10' ? add(wide, scale(sub(at(ps, farIdx), wide), 0.3)) : c;
    return { centroid: c, up, right, anchor };
  });
  return { frames, extent };
}

/** Face `fi` with every edge moved `width` inwards (in the face's plane): the flat part left inside a rounded edge. */
export function insetFace(kind: DieKind, fi: number, width: number): Vec3[] {
  const { vertices, faces, normals } = dieShape(kind);
  const n = at(normals, fi);
  const ps = at(faces, fi).map((i) => at(vertices, i));
  return ps.map((p, k) => {
    const prev = at(ps, (k + ps.length - 1) % ps.length);
    const next = at(ps, (k + 1) % ps.length);
    // counter-clockwise from outside, so n × edge points into the face
    const a = cross(n, normalize(sub(p, prev)));
    const b = cross(n, normalize(sub(next, p)));
    return add(p, scale(add(a, b), width / (1 + dot(a, b))));
  });
}

// ---------- randomness ----------

/** A small seeded RNG (a string hash feeding mulberry32): the same seed gives the same throw. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly random rotation. */
export function randomQuat(rand: () => number): Quat {
  const u1 = rand();
  const u2 = rand() * 2 * Math.PI;
  const u3 = rand() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}
