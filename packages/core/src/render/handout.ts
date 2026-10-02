// The players' handout: the whole map (players' view, in the parchment style)
// on an aged sheet, as if drawn by hand. Paper texture and stains, a torn and
// burnt edge, a hand-drawn frame, a title, a compass rose and a scale bar.
// Pure SVG, so resvg (PNG) and browsers draw it alike. No feDisplacementMap:
// resvg panics (and takes the process down) when its regions round unevenly.
// Units are points (1/72 inch), so the sheet prints at its true paper size.
import type { DelveMap, Room } from '../schema.ts';
import { computeFloor } from '../geometry/floor.ts';
import { shapeBounds } from '../geometry/shapes.ts';
import { hashString, rng } from './rng.ts';
import { buildScene, type RenderOptions } from './scene.ts';
import { resolveStyle } from './style.ts';
import { sceneToSvg } from './svg.ts';
import { parseSquareUnit } from '../units.ts';

export type Paper = 'a4' | 'a3' | 'letter' | 'fit';
export const PAPERS: Record<Exclude<Paper, 'fit'>, { name: string; w: number; h: number }> = {
  a4: { name: 'A4', w: 595.28, h: 841.89 },
  a3: { name: 'A3', w: 841.89, h: 1190.55 },
  letter: { name: 'Letter', w: 612, h: 792 },
};

export interface HandoutOptions {
  /** Paper size; 'fit' sizes the sheet to the map. Default A4. */
  paper?: Paper;
  /** Default 'auto': landscape when the map is wider than tall. */
  orientation?: 'auto' | 'portrait' | 'landscape';
  /** Only what the players have seen (fog of war). Default: the whole map. */
  revealedOnly?: boolean;
  /** Write the room names on the map. */
  names?: boolean;
  /** Title across the top: the map's name by default, '' for none. */
  title?: string;
  compass?: boolean;
  scaleBar?: boolean;
  frame?: boolean;
  stains?: boolean;
  /** Sets the width/height attributes (the PNG size): pixels per inch, default 96. */
  dpi?: number;
  assets?: RenderOptions['assets'];
}

export interface Handout {
  svg: string;
  /** Sheet size in points. */
  width: number;
  height: number;
  paper: Paper;
  landscape: boolean;
}

const INK = '#2E1F11';
const PAPER = '#E8D5A8';
const LIGHT = '#F3E6C4';

const n = (v: number): string => String(Math.round(v * 100) / 100);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A torn sheet: the rectangle's outline pushed inward by a wandering amount, with the odd nick. */
function tornEdge(w: number, h: number, inset: number, rand: () => number): string {
  const perimeter = 2 * (w + h);
  const knots = Array.from({ length: Math.ceil(perimeter / 22) + 2 }, () => rand() * 4 + (rand() < 0.06 ? 3 + rand() * 6 : 0));
  const depth = (s: number) => {
    const t = s / 22;
    const i = Math.floor(t);
    const f = t - i;
    const e = f * f * (3 - 2 * f);
    return inset + knots[i % knots.length]! * (1 - e) + knots[(i + 1) % knots.length]! * e + (rand() - 0.5) * 0.9;
  };
  const edges: [number, number, number, number, number, number][] = [
    // from (x, y), to (x, y), inward normal
    [0, 0, w, 0, 0, 1],
    [w, 0, w, h, -1, 0],
    [w, h, 0, h, 0, -1],
    [0, h, 0, 0, 1, 0],
  ];
  const pts: string[] = [];
  let s = 0;
  edges.forEach(([ax, ay, bx, by, nx, ny], k) => {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(len / 4);
    const [px, py] = [edges[(k + 3) % 4]![4], edges[(k + 3) % 4]![5]];
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const d = depth(s + t * len);
      // at a corner, push in from both sides
      const cx = i === 0 ? px * d : 0;
      const cy = i === 0 ? py * d : 0;
      pts.push(`${n(ax + (bx - ax) * t + nx * d + cx)} ${n(ay + (by - ay) * t + ny * d + cy)}`);
    }
    s += len;
  });
  return `M${pts.join('L')}Z`;
}

/** A rectangle ruled by hand: each side wanders a little around its line. */
function handRect(x: number, y: number, w: number, h: number, rand: () => number): string {
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const pts: string[] = [];
  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % 4]!;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.round(len / 18));
    let drift = 0;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      drift = drift * 0.6 + (rand() - 0.5) * 0.9; // a slow sway, not noise
      const nx = (-(by - ay) / len) * drift;
      const ny = ((bx - ax) / len) * drift;
      pts.push(`${n(ax + (bx - ax) * t + (s ? nx : 0))} ${n(ay + (by - ay) * t + (s ? ny : 0))}`);
    }
  });
  return `M${pts.join('L')}Z`;
}

function compassRose(cx: number, cy: number, r: number): string {
  const at = (deg: number, d: number): string => {
    const a = (deg * Math.PI) / 180;
    return `${n(cx + Math.sin(a) * d)} ${n(cy - Math.cos(a) * d)}`;
  };
  const c = `${n(cx)} ${n(cy)}`;
  let out = `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.62)}" fill="none" stroke="${INK}" stroke-width="0.8"/>`;
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.54)}" fill="none" stroke="${INK}" stroke-width="0.4"/>`;
  for (const [deg, len, half] of [45, 135, 225, 315].map((d) => [d, r * 0.64, r * 0.09]).concat([0, 90, 180, 270].map((d) => [d, r, r * 0.13]))) {
    const tip = at(deg!, len!);
    out += `<path d="M${c}L${tip}L${at(deg! - 90, half!)}Z" fill="${INK}"/>`;
    out += `<path d="M${c}L${tip}L${at(deg! + 90, half!)}Z" fill="${LIGHT}" stroke="${INK}" stroke-width="0.6" stroke-linejoin="round"/>`;
  }
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.07)}" fill="${INK}"/>`;
  out += `<text x="${n(cx)}" y="${n(cy - r - r * 0.12)}" font-size="${n(r * 0.42)}" text-anchor="middle" fill="${INK}">N</text>`;
  return out;
}

/** 1, 2, 2.5 or 5 times a power of ten, the one nearest to v. */
function nice(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

function unitOf(map: DelveMap): { size: number; name: string } {
  return parseSquareUnit(map.grid.unit);
}

function scaleBar(x: number, y: number, ptPerSquare: number, target: number, map: DelveMap, font: number): string {
  const unit = unitOf(map);
  const length = nice((target / ptPerSquare) * unit.size);
  const w = (length / unit.size) * ptPerSquare;
  const segs = 4;
  let out = '';
  for (let i = 0; i < segs; i++) {
    out += `<rect x="${n(x + (w / segs) * i)}" y="${n(y)}" width="${n(w / segs)}" height="4.5" fill="${i % 2 ? LIGHT : INK}" stroke="${INK}" stroke-width="0.6"/>`;
  }
  const label = (at: number, text: string, anchor: string) =>
    `<text x="${n(at)}" y="${n(y + 6 + font)}" font-size="${n(font)}" text-anchor="${anchor}" fill="${INK}">${esc(text)}</text>`;
  return out + label(x, '0', 'start') + label(x + w / 2, String(length / 2), 'middle') + label(x + w, `${length} ${unit.name}`, 'middle');
}

/** Total length of the floor's outline in squares: how much wall there is to draw. */
function wallLength(map: DelveMap): number {
  let len = 0;
  for (const p of computeFloor(map)) {
    for (const ring of [p.outer, ...p.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }
  }
  return len;
}

/** Past this much wall (a city of a hundred houses), hatching takes many seconds and only looks busy: the handout leaves it out. */
const HATCH_LIMIT = 1500;

export function handoutSvg(map: DelveMap, o: HandoutOptions = {}): Handout {
  const style = resolveStyle({ style: { preset: 'parchment', ...(wallLength(map) > HATCH_LIMIT ? { overrides: { hatching: null } } : {}) } });
  const scene = buildScene(
    map,
    { view: 'players', grid: false, background: false, margin: 0.5, assets: o.assets, ...(o.revealedOnly ? { fog: 'hide' as const } : {}) },
    style,
  );
  if (o.names) {
    const fogged = o.revealedOnly && map.fog?.on;
    const items = map.objects
      .filter((r): r is Room => r.type === 'room' && Boolean(r.name) && (!fogged || Boolean(map.fog?.revealed?.includes(r.id))))
      .map((r) => {
        const b = shapeBounds(r.shape);
        const size = Math.max(0.35, Math.min(0.7, (b.x1 - b.x0) / (r.name!.length * 0.55)));
        return { text: r.name!, at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] as [number, number], size };
      });
    if (items.length) scene.layers.push({ name: 'room-names', kind: 'text', items, color: style.labels.color, font: style.labels.font });
  }
  const sw = scene.bounds.x1 - scene.bounds.x0;
  const sh = scene.bounds.y1 - scene.bounds.y0;

  const title = (o.title ?? map.name).trim();
  const compass = o.compass ?? true;
  const bar = o.scaleBar ?? true;
  const paper = o.paper ?? 'a4';
  let W: number;
  let H: number;
  let landscape: boolean;
  let M: number;
  let T: number;
  let B: number;
  if (paper === 'fit') {
    // the sheet around the map: 18 pt per square, less for very big maps
    const s = Math.min(18, 2400 / Math.max(sw, sh));
    M = 40;
    T = title || compass ? 64 : 0;
    B = bar ? 32 : 0;
    W = sw * s + 2 * M;
    H = sh * s + 2 * M + T + B;
    landscape = W > H;
  } else {
    const p = PAPERS[paper];
    const bands = (w: number, h: number) => {
      const m = Math.max(34, 0.055 * Math.min(w, h));
      const t = title || compass ? Math.max(52, 0.085 * h) : 0;
      const b = bar ? Math.max(26, 0.042 * h) : 0;
      return { m, t, b, k: Math.min((w - 2 * m) / sw, (h - 2 * m - t - b) / sh) };
    };
    // auto: whichever way round draws the map bigger
    landscape = o.orientation === 'landscape' || (o.orientation !== 'portrait' && bands(p.h, p.w).k > bands(p.w, p.h).k * 1.02);
    W = landscape ? p.h : p.w;
    H = landscape ? p.w : p.h;
    ({ m: M, t: T, b: B } = bands(W, H));
  }
  // the map, as big as fits between the title and the scale bar
  const boxW = W - 2 * M;
  const boxH = H - 2 * M - T - B;
  const k = Math.min(boxW / sw, boxH / sh);
  const mw = sw * k;
  const mh = sh * k;
  const mx = M + (boxW - mw) / 2;
  const my = M + T + (boxH - mh) / 2;

  const seed = map.seed ?? hashString(map.id);
  const rand = rng(seed ^ 0x5eed);
  const edge = tornEdge(W, H, Math.min(W, H) * 0.012 + 5, rand);
  const px = (pt: number) => Math.round((pt * (o.dpi ?? 96)) / 72);
  const all = `x="0" y="0" width="${n(W)}" height="${n(H)}"`;

  let ink = '';
  if (o.frame ?? true) {
    const f = M * 0.55;
    ink += `<path d="${handRect(f, f, W - 2 * f, H - 2 * f, rand)}" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`;
    ink += `<path d="${handRect(f + 4, f + 4, W - 2 * f - 8, H - 2 * f - 8, rand)}" fill="none" stroke="${INK}" stroke-width="0.5" stroke-linejoin="round"/>`;
  }
  ink += sceneToSvg(scene, { idPrefix: 'h-', frame: { x: mx, y: my, width: mw, height: mh } });
  const r = compass ? Math.min(T * 0.42, 34) : 0;
  if (title) {
    const room = W - 2 * M - (compass ? 4 * r + 16 : 0);
    const size = Math.min(T * 0.5, 44, room / (title.length * 0.5));
    const cy = M + T * 0.5;
    ink += `<text x="${n(W / 2)}" y="${n(cy + size * 0.3)}" font-size="${n(size)}" text-anchor="middle" fill="${INK}">${esc(title)}</text>`;
    // a flourish under the title
    const half = Math.min(room / 2, title.length * size * 0.26 + 18);
    const fy = cy + size * 0.62;
    ink += `<path d="M${n(W / 2 - half)} ${n(fy)}H${n(W / 2 - 7)}M${n(W / 2 + 7)} ${n(fy)}H${n(W / 2 + half)}" stroke="${INK}" stroke-width="0.8" stroke-linecap="round"/>`;
    ink += `<path d="M${n(W / 2 - 5)} ${n(fy)}L${n(W / 2)} ${n(fy - 3)}L${n(W / 2 + 5)} ${n(fy)}L${n(W / 2)} ${n(fy + 3)}Z" fill="${INK}"/>`;
  }
  if (compass) ink += compassRose(W - M - r - 6, M + T * 0.54, r);
  if (bar) ink += scaleBar(M + 6, H - M - B * 0.72, k, Math.min(0.25 * boxW, 220), map, Math.max(8, Math.min(11, B * 0.32)));

  let stains = '';
  if (o.stains ?? true) {
    for (let i = 0; i < 2; i++) {
      const cx = M + rand() * (W - 2 * M);
      const cy = M + rand() * (H - 2 * M);
      const rr = 22 + rand() * 26;
      const c = 2 * Math.PI * rr;
      stains += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rr)}" fill="#8A5A2A" fill-opacity="0.05" stroke="#6A4219" stroke-opacity="0.2" stroke-width="${n(2 + rand() * 1.5)}" stroke-dasharray="${n(c * (0.6 + rand() * 0.3))} ${n(c)}" transform="rotate(${n(rand() * 360)} ${n(cx)} ${n(cy)})" filter="url(#hp-soft)"/>`;
    }
    const bx = M + rand() * (W - 2 * M);
    const by = M + rand() * (H - 2 * M);
    stains += `<ellipse cx="${n(bx)}" cy="${n(by)}" rx="${n(30 + rand() * 40)}" ry="${n(20 + rand() * 30)}" fill="#7A4E22" opacity="0.07" filter="url(#hp-blot)"/>`;
  }

  const filter = (id: string, body: string) => `<filter id="${id}" filterUnits="userSpaceOnUse" ${all} color-interpolation-filters="sRGB">${body}</filter>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(W)}" height="${px(H)}" viewBox="0 0 ${n(W)} ${n(H)}" font-family="IM FELL English, Georgia, serif">` +
    `<defs>` +
    filter('hp-age', `<feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="3" seed="${seed % 1000}"/><feColorMatrix values="0 0 0 0 0.42 0 0 0 0 0.27 0 0 0 0 0.1 2.6 0 0 0 -1.25"/>`) +
    filter('hp-mottle', `<feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="4" seed="${(seed + 1) % 1000}"/><feColorMatrix values="0 0 0 0 0.4 0 0 0 0 0.27 0 0 0 0 0.12 2.2 0 0 0 -0.95"/>`) +
    filter('hp-grain', `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="1" seed="${(seed + 2) % 1000}"/><feColorMatrix values="0 0 0 0 0.3 0 0 0 0 0.2 0 0 0 0 0.1 1.6 0 0 0 -0.7"/>`) +
    filter('hp-burn', `<feGaussianBlur stdDeviation="${n(Math.min(W, H) * 0.022)}"/>`) +
    filter('hp-rim', `<feGaussianBlur stdDeviation="1.8"/>`) +
    filter('hp-soft', `<feGaussianBlur stdDeviation="1.2"/>`) +
    filter('hp-blot', `<feGaussianBlur stdDeviation="9"/>`) +
    `<clipPath id="hp-sheet"><path d="${edge}"/></clipPath>` +
    `</defs>` +
    `<g clip-path="url(#hp-sheet)">` +
    `<rect ${all} fill="${PAPER}"/>` +
    `<rect ${all} filter="url(#hp-age)" opacity="0.3"/>` +
    `<rect ${all} filter="url(#hp-mottle)" opacity="0.32"/>` +
    `<rect ${all} filter="url(#hp-grain)" opacity="0.22"/>` +
    stains +
    `<path d="${edge}" fill="none" stroke="#6B4520" stroke-width="${n(Math.min(W, H) * 0.07)}" filter="url(#hp-burn)" opacity="0.8"/>` +
    `<path d="${edge}" fill="none" stroke="#3B2410" stroke-width="4" filter="url(#hp-rim)" opacity="0.85"/>` +
    `<g opacity="0.94">${ink}</g>` +
    `</g></svg>`;
  return { svg, width: W, height: H, paper, landscape };
}
