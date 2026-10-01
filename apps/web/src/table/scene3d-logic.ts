// Pure helpers for the 3D table view (no DOM, no WebGL), so they can be unit-tested.
// World axes as in the editor's 3D view (stack-logic.ts): x = page x, z = page y
// (south is +z), y = up. One world unit is one cell.
import type { Member, SceneBox, SceneDoor, SceneStairs, Token } from '@delve/table';
import { BAR_COLORS, barFraction, canMove } from './logic.ts';

export type Vec3 = [number, number, number];

/** Where the camera is and what it looks at. */
export interface View3 {
  position: Vec3;
  target: Vec3;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const rad = (deg: number): number => (deg * Math.PI) / 180;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

// ---------- camera ----------

/** The narrower of the vertical and horizontal fields of view, in radians. */
function narrowFov(vfovDeg: number, aspect: number): number {
  const v = rad(vfovDeg);
  const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(aspect, 0.05));
  return Math.min(v, h);
}

/**
 * A view that shows the whole box at an angle: `tilt` degrees from straight
 * down, from the south and a little east (`azimuth` degrees), like a seat at the table.
 */
export function fitView(b: SceneBox, vfovDeg: number, aspect: number, tilt = 52, azimuth = 18): View3 {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.y0 + b.y1) / 2;
  const radius = Math.max(Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2, 2);
  const dist = (radius / Math.sin(narrowFov(vfovDeg, aspect) / 2)) * 0.9;
  const p = rad(tilt);
  const a = rad(azimuth);
  return {
    position: [r6(cx + dist * Math.sin(p) * Math.sin(a)), r6(dist * Math.cos(p)), r6(cz + dist * Math.sin(p) * Math.cos(a))],
    target: [cx, 0, cz],
  };
}

/** Straight down at the box, filling the view (a hair off vertical, so the orbit keeps its bearings: north stays up). */
export function topView(b: SceneBox, vfovDeg: number, aspect: number): View3 {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.y0 + b.y1) / 2;
  const v = rad(vfovDeg);
  const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(aspect, 0.05));
  const w = Math.max(b.x1 - b.x0, 2);
  const d = Math.max(b.y1 - b.y0, 2);
  const dist = Math.max(d / 2 / Math.tan(v / 2), w / 2 / Math.tan(h / 2)) * 1.08;
  return { position: [cx, r6(dist), r6(cz + dist * 1e-3)], target: [cx, 0, cz] };
}

/** Eased step between two views, t from 0 to 1. */
export function lerpView(a: View3, b: View3, t: number): View3 {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const mix = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
  return { position: mix(a.position, b.position), target: mix(a.target, b.target) };
}

/** Follow: move the view by the step from its target toward `goal` (a share k of the way), keeping the angle and distance. */
export function followStep(v: View3, goal: Vec3, k: number): View3 {
  const d: Vec3 = [(goal[0] - v.target[0]) * k, (goal[1] - v.target[1]) * k, (goal[2] - v.target[2]) * k];
  return {
    position: [v.position[0] + d[0], v.position[1] + d[1], v.position[2] + d[2]],
    target: [v.target[0] + d[0], v.target[1] + d[1], v.target[2] + d[2]],
  };
}

/** Screen pixels per cell at a distance from the camera (for hiding bars on minis too small to read). */
export const pxPerCell = (dist: number, vfovDeg: number, viewportH: number): number => viewportH / (2 * Math.max(dist, 1e-6) * Math.tan(rad(vfovDeg) / 2));

/** Where a ray meets the ground plane y = h, as page cells [x, y]; null if it runs along it or away from it. */
export function groundHit(origin: Vec3, dir: Vec3, h = 0): [number, number] | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (h - origin[1]) / dir[1];
  if (!(t > 0)) return null;
  return [origin[0] + dir[0] * t, origin[2] + dir[2] * t];
}

/** Half the size the directional light's shadow camera must cover for a page. */
export const shadowSpan = (b: SceneBox, margin = 3): number => Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + margin;

// ---------- minis ----------

/** Base colour of a mini with nobody but the GM in control, and of one everyone controls. */
export const GM_BASE = '#55504A';
export const ALL_BASE = '#D8D0BC';

/** The base's colour: the first controlling member's colour, a light stone for "all", dark stone for GM-only tokens. */
export function baseColor(t: Pick<Token, 'controlledBy'>, members: readonly Pick<Member, 'id' | 'color'>[]): string {
  for (const id of t.controlledBy) {
    const m = id === 'all' ? undefined : members.find((x) => x.id === id);
    if (m) return m.color;
  }
  return t.controlledBy.includes('all') ? ALL_BASE : GM_BASE;
}

/** How a token stands as a mini, in cells. */
export interface MiniShape {
  /** Lies on the floor: map-layer tokens always, others when the minis are shown flat. */
  flat: boolean;
  /** Base half-sizes along x and z (an ellipse for tokens that aren't square), and its height (0: no base). */
  rx: number;
  rz: number;
  baseH: number;
  /** The picture's card: upright and facing the camera, or flat on the base. */
  cardW: number;
  cardH: number;
  /** Height of the top of the mini (for its tag). */
  top: number;
}

/** `aspect`: the picture's height over its width (1 until it has loaded). */
export function miniShape(t: Pick<Token, 'w' | 'h' | 'layer'>, aspect: number, flatMinis: boolean): MiniShape {
  const w = Math.max(t.w, 0.1);
  const h = Math.max(t.h, 0.1);
  if (t.layer === 'map') return { flat: true, rx: w / 2, rz: h / 2, baseH: 0, cardW: w, cardH: h, top: 0.05 };
  const rx = (w / 2) * 0.92;
  const rz = (h / 2) * 0.92;
  if (flatMinis) {
    const baseH = 0.06;
    return { flat: true, rx, rz, baseH, cardW: w * 0.84, cardH: h * 0.84, top: baseH + 0.02 };
  }
  const baseH = 0.1;
  const cardW = Math.max(w, h) * 0.88;
  const cardH = cardW * clamp(Number.isFinite(aspect) && aspect > 0 ? aspect : 1, 0.4, 1.8);
  return { flat: false, rx, rz, baseH, cardW, cardH, top: baseH + cardH };
}

/** The turn about the up axis that makes a standee at (x, z) face a camera at (cx, cz). */
export const faceYaw = (x: number, z: number, cx: number, cz: number): number => Math.atan2(cx - x, cz - z);

/** What the tag over a mini shows: its name like the 2D table (showName, hovered or selected), and its bars when it's big enough to read. */
export function tagParts(t: Pick<Token, 'name' | 'showName' | 'bars' | 'w'>, hovered: boolean, selected: boolean, px: number): { name: string | null; bars: { fraction: number | null; color: string }[] } {
  const name = t.name && (t.showName || hovered || selected) ? t.name : null;
  const big = px * Math.max(t.w, 0.25) >= 14;
  const bars = big ? (t.bars ?? []).slice(0, 3).map((b, i) => ({ fraction: barFraction(b), color: BAR_COLORS[i] ?? '#888888' })) : [];
  return { name, bars };
}

/** The tokens the 3D view shows: the GM looking as the players do leaves the gm layer out, like the 2D table. */
export const shownTokens = (tokens: readonly Token[], seeAs: 'gm' | 'players'): Token[] => (seeAs === 'players' ? tokens.filter((t) => t.layer !== 'gm') : [...tokens]);

/** Map-layer tokens lie on the floor and never catch the pointer, so dragging the floor always turns the view (move them on the 2D table). */
export const pickable = (t: Pick<Token, 'layer'>): boolean => t.layer !== 'map';

/** Which mini "follow" keeps in view: the first selected one, else the first this member may move (not on the map layer). */
export function followSubject(tokens: readonly Token[], selection: ReadonlySet<string>, me: Member): string | null {
  const sel = tokens.find((t) => selection.has(t.id));
  if (sel) return sel.id;
  return tokens.find((t) => t.layer === 'tokens' && canMove(me, t) && t.controlledBy.length > 0)?.id ?? null;
}

/** The middle of a token on the ground, as a world point. */
export const tokenCentre = (t: Pick<Token, 'x' | 'y' | 'w' | 'h'>, y = 0): Vec3 => [t.x + t.w / 2, y, t.y + t.h / 2];

// ---------- walls, doors, stairs ----------

/** A box lying along local x, turned `angle` about the up axis; (x, y, z) is its centre. */
export interface Piece {
  kind: 'frame' | 'leaf' | 'locked' | 'secret' | 'iron' | 'step';
  x: number;
  y: number;
  z: number;
  length: number;
  height: number;
  depth: number;
  angle: number;
}

const POST = 0.12;
const SWING = rad(80);

/** The turn that lays local x along the direction (dx, dz) (same convention as stack-logic's wallBox). */
const along = (dx: number, dz: number): number => Math.atan2(-dz, dx);

/**
 * A wall segment as a box lying along it: centre, length (padded by the
 * thickness so corners close) and turn. The same as the editor's 3D view
 * (stack-logic.ts wallBox), kept here because stack-logic imports all of
 * @delve/core, which the table's bundle doesn't need.
 */
export function wallPiece([a, b]: readonly [readonly [number, number], readonly [number, number]], thickness: number): { x: number; z: number; length: number; angle: number } {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, length: Math.hypot(dx, dz) + thickness, angle: along(dx, dz) };
}

/**
 * A door as boxes: posts at both ends and a lintel (every style), plus the
 * leaf (or two for a double door) shut in the gap or swung open, iron bars
 * for a portcullis, and nothing in an archway. Secret doors (GM only) get a
 * leaf of their own kind so the GM can see them. No walls, no doors.
 */
export function doorPieces(d: SceneDoor, wallH: number, thick: number): Piece[] {
  if (!(wallH > 0)) return [];
  const [ax, az] = d.a;
  const [bx, bz] = d.b;
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-6) return [];
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const nx = -uz;
  const nz = ux;
  const angle = along(ux, uz);
  const open = wallH * 0.82;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const out: Piece[] = [
    { kind: 'frame', x: ax, y: wallH / 2, z: az, length: POST, height: wallH, depth: thick * 1.35, angle },
    { kind: 'frame', x: bx, y: wallH / 2, z: bz, length: POST, height: wallH, depth: thick * 1.35, angle },
  ];
  if (wallH - open > 0.01) out.push({ kind: 'frame', x: mx, y: (open + wallH) / 2, z: mz, length: len + POST, height: wallH - open, depth: thick * 1.2, angle });
  if (d.style === 'archway') return out;
  const leafH = open * 0.97;
  const gap = Math.max(len - POST, 0.05);
  if (d.style === 'portcullis') {
    if (d.open) return out;
    const n = Math.max(2, Math.round(gap / 0.16));
    for (let k = 0; k <= n; k++) {
      const t = -gap / 2 + (gap * k) / n;
      out.push({ kind: 'iron', x: mx + ux * t, y: leafH / 2, z: mz + uz * t, length: 0.04, height: leafH, depth: 0.04, angle });
    }
    for (const f of [0.3, 0.75]) out.push({ kind: 'iron', x: mx, y: leafH * f, z: mz, length: gap, height: 0.04, depth: 0.05, angle });
    return out;
  }
  const kind: Piece['kind'] = d.style === 'locked' ? 'locked' : d.style === 'secret' ? 'secret' : 'leaf';
  // one leaf hinged at a, or two hinged at both ends
  const leaves: { hx: number; hz: number; dx: number; dz: number; l: number }[] =
    d.style === 'double'
      ? [
          { hx: ax + ux * (POST / 2), hz: az + uz * (POST / 2), dx: ux, dz: uz, l: gap / 2 - 0.01 },
          { hx: bx - ux * (POST / 2), hz: bz - uz * (POST / 2), dx: -ux, dz: -uz, l: gap / 2 - 0.01 },
        ]
      : [{ hx: ax + ux * (POST / 2), hz: az + uz * (POST / 2), dx: ux, dz: uz, l: gap }];
  for (const lf of leaves) {
    // shut: along the gap; open: swung toward the door's +normal side
    const c = d.open ? Math.cos(SWING) : 1;
    const s = d.open ? Math.sin(SWING) : 0;
    const vx = lf.dx * c + nx * s;
    const vz = lf.dz * c + nz * s;
    out.push({ kind, x: lf.hx + (vx * lf.l) / 2, y: leafH / 2, z: lf.hz + (vz * lf.l) / 2, length: lf.l, height: leafH, depth: 0.07, angle: along(vx, vz) });
  }
  return out;
}

/** A flight of stairs as steps across it, rising toward `direction`, the top one `rise` high. */
export function stairSteps(s: SceneStairs, rise = 0.3, tread = 0.34): Piece[] {
  const { x0, y0, x1, y1 } = s.box;
  const ns = s.direction === 'n' || s.direction === 's';
  const run = ns ? y1 - y0 : x1 - x0;
  const across = ns ? x1 - x0 : y1 - y0;
  if (!(run > 0) || !(across > 0)) return [];
  const n = clamp(Math.round(run / tread), 2, 16);
  const step = run / n;
  const out: Piece[] = [];
  for (let k = 0; k < n; k++) {
    const h = (rise * (k + 1)) / n;
    // k = 0 is the bottom step, at the end the flight comes from
    const at = { n: y1 - step * (k + 0.5), s: y0 + step * (k + 0.5), w: x1 - step * (k + 0.5), e: x0 + step * (k + 0.5) }[s.direction];
    out.push(
      ns
        ? { kind: 'step', x: (x0 + x1) / 2, y: h / 2, z: at, length: across - 0.04, height: h, depth: step, angle: 0 }
        : { kind: 'step', x: at, y: h / 2, z: (y0 + y1) / 2, length: step, height: h, depth: across - 0.04, angle: 0 },
    );
  }
  return out;
}

/** Grid lines over a page box at whole cells (at most `max` each way, then every 5th or 25th), as [x0, z0, x1, z1]. */
export function gridSegments(b: SceneBox, max = 300): [number, number, number, number][] {
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const step = span <= max ? 1 : span <= max * 5 ? 5 : 25;
  const out: [number, number, number, number][] = [];
  // + 0 turns -0 into 0
  for (let x = Math.ceil(b.x0 / step - 1e-9) * step + 0; x <= b.x1 + 1e-9; x += step) out.push([x, b.y0, x, b.y1]);
  for (let y = Math.ceil(b.y0 / step - 1e-9) * step + 0; y <= b.y1 + 1e-9; y += step) out.push([b.x0, y, b.x1, y]);
  return out;
}

// ---------- light sources (for line of sight and light, step 2) ----------

/** A point light at the table: a torch a token carries, or a brazier on the map. Positions in cells. */
export interface LightSource {
  id: string;
  x: number;
  y: number;
  /** Height above the floor in cells (default 1.2). */
  height?: number;
  color?: string;
  /** three.js intensity (default 6). */
  intensity?: number;
  /** How far it reaches, in cells (default 8; 0 = no limit). */
  range?: number;
  castShadow?: boolean;
}

/** Most point lights the rig keeps (each costs every pixel some work); the nearest to the view win. */
export const MAX_LIGHTS = 12;

/** The light sources to show: at most `max`, nearest to (cx, cy) first; ids in input order break ties. */
export function pickLights(sources: readonly LightSource[], cx: number, cy: number, max = MAX_LIGHTS): LightSource[] {
  if (sources.length <= max) return [...sources];
  return sources
    .map((s, i) => ({ s, i, d: Math.hypot(s.x - cx, s.y - cy) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, max)
    .map((x) => x.s);
}
