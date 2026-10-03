// The players' handout: the whole map (players' view, in the parchment style)
// on an aged sheet, as if drawn by hand. Paper texture and stains, a torn and
// burnt edge, a hand-drawn frame, a title, a compass rose, a scale bar and a
// legend (legend.ts) in a free corner.
// Pure SVG, so resvg (PNG) and browsers draw it alike. No feDisplacementMap:
// resvg panics (and takes the process down) when its regions round unevenly.
// Units are points (1/72 inch), so the sheet prints at its true paper size.
import type { DelveMap, Room } from '../schema.ts';
import { computeFloor } from '../geometry/floor.ts';
import { shapeBounds, type Bounds } from '../geometry/shapes.ts';
import { hashString, rng } from './rng.ts';
import { buildScene, type RenderOptions, type Scene } from './scene.ts';
import { resolveStyle, type Style } from './style.ts';
import { sceneToSvg } from './svg.ts';
import { cropScene } from '../crop.ts';
import { parseSquareUnit } from '../units.ts';
import { inscriptionBounds, inscriptionNear, inscriptionsOf, inscriptionsSvg } from '../inscriptions.ts';
import { inkMasks, legendEntries, legendLayout, type LegendEntry, type LegendLayout } from './legend.ts';

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
  /** Only this part of the map, in squares (a cropped handout); default: the whole map. */
  crop?: Bounds;
  assets?: RenderOptions['assets'];
  /** false leaves the handwritten notes (inscription objects) out: the handout page draws them itself while the GM edits them. */
  inscriptions?: boolean;
  /**
   * The legend (map key) in a free corner: each kind of thing the players can see,
   * once, with its picture and name. Unset: when it has 2 entries or more.
   */
  legend?: boolean;
}

/**
 * Where the map sits on the sheet: the square (x0, y0) is at (x, y) points and
 * one square is k points, so a sheet point (X, Y) is the square
 * (x0 + (X - x) / k, y0 + (Y - y) / k). Notes are drawn in this frame too.
 */
export interface HandoutFrame {
  x: number;
  y: number;
  k: number;
  x0: number;
  y0: number;
}

export interface Handout {
  svg: string;
  /** Sheet size in points. */
  width: number;
  height: number;
  paper: Paper;
  landscape: boolean;
  frame: HandoutFrame;
  /** Where the legend went, in points, and what it lists (none: no legend on this sheet). */
  legend?: { x: number; y: number; w: number; h: number; entries: string[]; more: number };
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
  const drawn = buildScene(
    map,
    { view: 'players', grid: false, background: false, margin: 0.5, assets: o.assets, ...(o.revealedOnly ? { fog: 'hide' as const } : {}), ...(o.crop ? { frame: o.crop } : {}) },
    style,
  );
  // cropped: only what the sheet shows (see cropScene)
  const scene = o.crop ? cropScene(drawn, drawn.bounds) : drawn;
  // notes that are on the map too are drawn below with the others, in the sheet's own frame (not clipped to the map)
  scene.layers = scene.layers.filter((l) => l.kind !== 'inscriptions');
  // a label or stair tag far off the map (a stray one at [-120, 10]) is left out: resvg panics on what a
  // clipped group holds far past the sheet, which kills the server (see inscriptionNear). Kept: its anchor
  // within a quarter of the map's shorter side of the map, and its text within a whole side
  const side = Math.min(scene.bounds.x1 - scene.bounds.x0, scene.bounds.y1 - scene.bounds.y0);
  const inside = (x0: number, y0: number, x1: number, y1: number, slack: number) =>
    x0 >= scene.bounds.x0 - slack && x1 <= scene.bounds.x1 + slack && y0 >= scene.bounds.y0 - slack && y1 <= scene.bounds.y1 + slack;
  const fits = ([x, y]: readonly [number, number], w: number, h: number) => inside(x, y, x, y, side / 4) && inside(x - w, y - h, x + w, y + h, side);
  for (const l of scene.layers) {
    if (l.kind === 'text') l.items = l.items.filter((i) => fits(i.at, i.size * i.text.length * 0.3, i.size));
    else if (l.kind === 'tags') l.items = l.items.filter((i) => fits(i.at, l.size * 1.5, l.size));
  }
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
  // the legend's entries (legend.ts); unset, a legend of one isn't worth the corner
  const entries = o.legend === false ? [] : legendEntries(map, { scene, style, ...(o.crop ? { crop: o.crop } : {}), ...(o.revealedOnly ? { revealedOnly: true } : {}) });
  const withLegend = entries.length > 0 && (o.legend ?? entries.length >= 2);

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
  let k = Math.min(boxW / sw, boxH / sh);
  let mx = M + (boxW - sw * k) / 2;
  let my = M + T + (boxH - sh * k) / 2;
  const r = compass ? Math.min(T * 0.42, 34) : 0;
  // the legend goes where the map leaves the most paper; it may shrink the map a little, or widen a sheet fitted to the map
  let key: LegendSpot | null = null;
  if (withLegend) {
    // what it keeps clear of: the title and its flourish, the compass rose and the scale bar
    const blocked: Bounds[] = [];
    if (title) {
      const room = W - 2 * M - (compass ? 4 * r + 16 : 0);
      const size = Math.min(T * 0.5, 44, room / (title.length * 0.5));
      const half = Math.max(Math.min(room / 2, title.length * size * 0.26 + 18), title.length * size * 0.27);
      blocked.push({ x0: W / 2 - half, y0: M + T * 0.5 - size * 0.8, x1: W / 2 + half, y1: M + T * 0.5 + size * 0.62 + 4 });
    }
    if (compass) blocked.push({ x0: W - M - 2 * r - 12, y0: M + T * 0.54 - r * 1.6, x1: W - M, y1: M + T * 0.54 + r + 4 });
    if (bar) blocked.push({ x0: M, y0: H - M - B * 0.72 - 3, x1: M + 6 + Math.min(0.25 * boxW, 220) * 1.34 + 40, y1: H - M });
    key = placeLegend(map, scene, style, entries, { W, H, M, T, B, fit: paper === 'fit', boxW, boxH, sw, sh, k, mx, my, blocked });
    if (key) {
      ({ W, H, k, mx, my } = key);
      if (paper === 'fit') landscape = W > H;
    }
  }
  const mw = sw * k;
  const mh = sh * k;

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
  // its own seed, so the sheet's frame and stains stay where they were without it
  if (key) ink += legendSvg(key, rng(seed ^ 0x1e9e7d));
  // the GM's handwritten notes, on top: anchored to map squares, but free to run into the margin
  const frame: HandoutFrame = { x: mx, y: my, k, x0: scene.bounds.x0, y0: scene.bounds.y0 };
  // the sheet in squares; a note running more than a quarter sheet past its edge is left out (resvg, see inscriptionNear)
  const onSheet = { x0: frame.x0 - mx / k, y0: frame.y0 - my / k, x1: frame.x0 + (W - mx) / k, y1: frame.y0 + (H - my) / k };
  const near = inscriptionsOf(map).filter((n) => inscriptionNear(n, onSheet, (0.25 * Math.min(W, H)) / k));
  const notes = o.inscriptions === false ? '' : inscriptionsSvg(map, near);
  if (notes) ink += `<g data-layer="inscriptions" transform="${frameTransform(frame)}">${notes}</g>`;

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
  const legend = key ? { x: key.x, y: key.y, w: key.layout.w, h: key.layout.h, entries: key.layout.shown.map((e) => e.name), more: key.layout.more } : undefined;
  return { svg, width: W, height: H, paper, landscape, frame, ...(legend ? { legend } : {}) };
}

// ---------- the legend's place and box ----------

/** Where the legend goes: its box's top-left in points, its layout, and the sheet and map around it. */
interface LegendSpot {
  x: number;
  y: number;
  layout: LegendLayout;
  W: number;
  H: number;
  k: number;
  mx: number;
  my: number;
}

interface SheetPlan {
  W: number;
  H: number;
  M: number;
  T: number;
  B: number;
  /** The sheet is sized to the map: it can grow a strip instead of shrinking the map. */
  fit: boolean;
  boxW: number;
  boxH: number;
  /** The map in squares, and where it sits without a legend. */
  sw: number;
  sh: number;
  k: number;
  mx: number;
  my: number;
  /** The title, compass and scale bar, in points. */
  blocked: Bounds[];
}

const hits = (a: Bounds, b: Bounds): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const grow = (b: Bounds, d: number): Bounds => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

/**
 * A free corner for the legend: the box in one of the four corners inside the
 * margins, clear of the map's ink (its floor grown by the hatching), the title,
 * compass, scale bar and handwritten notes, in as many columns as suit the
 * corner. Of the corners that have room, the one with the most empty paper
 * around the box wins. With no room anywhere, the map is shrunk in small steps
 * and moved away from a corner (which makes a strip along a margin when the map
 * spans the sheet), and the biggest map that leaves room wins; a sheet fitted to
 * the map grows a strip below or beside it instead. Null if nothing works.
 */
function placeLegend(map: DelveMap, scene: Scene, style: Style, entries: LegendEntry[], p: SheetPlan): LegendSpot | null {
  const icon = Math.max(12, 0.026 * Math.min(p.W, p.H));
  const R: Bounds = { x0: p.M, y0: p.M, x1: p.W - p.M, y1: p.H - p.M };
  const layouts: LegendLayout[] = [];
  for (let cols = 1; cols <= 6; cols++) {
    const L = legendLayout(entries, cols, icon);
    if (L.cols === cols) layouts.push(L);
  }
  const masks = inkMasks(scene);
  const { x0, y0 } = scene.bounds;
  const reach = Math.max(style.hatching?.width ?? 0, style.shading?.width ?? 0) + (style.hatching ? style.hatching.length : 0);
  const gap = icon * 0.45;
  const notes = inscriptionsOf(map).map(inscriptionBounds);
  type Place = { k: number; mx: number; my: number };
  const clear = (b: Bounds, q: Place): boolean => {
    if (p.blocked.some((o) => hits(grow(b, gap * 0.6), o))) return false;
    const sq = (g: number): Bounds => ({ x0: x0 + (b.x0 - g - q.mx) / q.k, y0: y0 + (b.y0 - g - q.my) / q.k, x1: x0 + (b.x1 + g - q.mx) / q.k, y1: y0 + (b.y1 + g - q.my) / q.k });
    if (masks.ink.count(sq(gap)) || masks.floor.count(sq(gap + reach * q.k))) return false;
    return !notes.some((nb) => hits(grow(b, gap), { x0: q.mx + (nb.x0 - x0) * q.k, y0: q.my + (nb.y0 - y0) * q.k, x1: q.mx + (nb.x1 - x0) * q.k, y1: q.my + (nb.y1 - y0) * q.k }));
  };
  // how far the box could grow into the sheet before it meets something (up to 3 icons): its empty paper
  const room = (b: Bounds, q: Place): number => {
    let d = 0;
    const cap = icon * 3;
    while (d < cap) {
      const g = grow(b, d + 2);
      if (!clear({ x0: Math.max(R.x0, g.x0), y0: Math.max(R.y0, g.y0), x1: Math.min(R.x1, g.x1), y1: Math.min(R.y1, g.y1) }, q)) break;
      d += 2;
    }
    return d;
  };
  const corners = [
    [1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ] as const; // [right?, bottom?]: bottom right first, the compass's corner last
  type Found = LegendSpot & { score: number };
  const best = (found: Found[]): Found | null => found.reduce<Found | null>((a, b) => (!a || b.score > a.score ? b : a), null);
  const tryCorners = (q: Place, which: readonly (readonly [0 | 1, 0 | 1])[], bias: number): Found[] => {
    const found: Found[] = [];
    which.forEach(([right, bottom], ci) => {
      for (const L of layouts) {
        if (L.w > R.x1 - R.x0 || L.h > R.y1 - R.y0) continue;
        const x = right ? R.x1 - L.w : R.x0;
        const y = bottom ? R.y1 - L.h : R.y0;
        const b = { x0: x, y0: y, x1: x + L.w, y1: y + L.h };
        if (!clear(b, q)) continue;
        // the most empty paper, then a box that's not too long or too flat, then the corner's order
        const score = room(b, q) + bias - 4 * Math.abs(Math.log(L.w / L.h)) - ci * 0.1;
        found.push({ x, y, layout: L, W: p.W, H: p.H, ...q, score });
      }
    });
    return found;
  };

  const here = best(tryCorners({ k: p.k, mx: p.mx, my: p.my }, corners, 0));
  if (here) return here;

  if (p.fit) {
    // grow the sheet: a strip under the map (above the scale bar) or beside it, whichever adds less paper
    const G = icon * 0.8;
    const options: LegendSpot[] = [];
    for (const L of layouts) {
      const bw = Math.max(p.W, L.w + 2 * p.M);
      options.push({ x: bw - p.M - L.w, y: p.M + p.T + p.boxH + G, layout: L, W: bw, H: p.H + L.h + G, k: p.k, mx: p.mx + (bw - p.W) / 2, my: p.my });
      const sh = Math.max(p.H, 2 * p.M + p.T + p.B + L.h);
      options.push({ x: p.W - p.M + G, y: p.M + p.T + (sh - p.H) / 2, layout: L, W: p.W + L.w + G, H: sh, k: p.k, mx: p.mx, my: p.my + (sh - p.H) / 2 });
    }
    return options.reduce((a, b) => (b.W * b.H < a.W * a.H - 1e-6 ? b : a));
  }

  // move the map away from the legend's corner (or keep it centred one way), then shrink it a little at a time
  for (let s = 1; s >= 0.6; s -= 0.03) {
    const k = p.k * s;
    const mw = p.sw * k;
    const mh = p.sh * k;
    const centre = { mx: p.M + (p.boxW - mw) / 2, my: p.M + p.T + (p.boxH - mh) / 2 };
    const found: Found[] = [];
    for (const corner of corners) {
      const [right, bottom] = corner;
      const away = { mx: right ? p.M : p.M + p.boxW - mw, my: bottom ? p.M + p.T : p.M + p.T + p.boxH - mh };
      // a map still centred one way looks better: a small bonus
      found.push(...tryCorners({ k, mx: away.mx, my: centre.my }, [corner], 3));
      found.push(...tryCorners({ k, mx: centre.mx, my: away.my }, [corner], 3));
      found.push(...tryCorners({ k, ...away }, [corner], 0));
    }
    const pick = best(found);
    if (pick) return pick;
  }
  return null;
}

/** The legend: an ink frame like the sheet's, "Legend" with a flourish, and the entries in columns. */
function legendSvg(spot: LegendSpot, rand: () => number): string {
  const { x, y, layout: L } = spot;
  const S = L.icon;
  const pad = S * 0.6;
  const f = S * 0.62;
  let out = `<g data-legend="">`;
  out += `<path d="${handRect(x, y, L.w, L.h, rand)}" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="${handRect(x + 2.5, y + 2.5, L.w - 5, L.h - 5, rand)}" fill="none" stroke="${INK}" stroke-width="0.4" stroke-linejoin="round"/>`;
  const hs = S * 0.9;
  const cx = x + L.w / 2;
  out += `<text x="${n(cx)}" y="${n(y + pad + hs * 0.72)}" font-size="${n(hs)}" text-anchor="middle" fill="${INK}">Legend</text>`;
  const fy = y + pad + hs * 1.3;
  const half = Math.min(L.w / 2 - pad, 'Legend'.length * hs * 0.24 + 10);
  out += `<path d="M${n(cx - half)} ${n(fy)}H${n(cx - 5)}M${n(cx + 5)} ${n(fy)}H${n(cx + half)}" stroke="${INK}" stroke-width="0.6" stroke-linecap="round"/>`;
  out += `<path d="M${n(cx - 3.5)} ${n(fy)}L${n(cx)} ${n(fy - 2)}L${n(cx + 3.5)} ${n(fy)}L${n(cx)} ${n(fy + 2)}Z" fill="${INK}"/>`;
  const top = y + pad + S * 1.9;
  let colX = x + pad;
  for (let c = 0; c < L.cols; c++) {
    for (let row = 0; row < L.rows; row++) {
      const i = c * L.rows + row;
      const ry = top + row * S * 1.25;
      const e = L.shown[i];
      if (e) {
        // a terrain swatch fills with the map's own tile (h-), so the sheet carries each tile once
        out += sceneToSvg(e.icon, { idPrefix: `hl${i}-`, frame: { x: colX, y: ry, width: S, height: S }, ...(e.kind === 'terrain' ? { patternPrefix: 'h-' } : {}) });
        out += `<text x="${n(colX + S * 1.45)}" y="${n(ry + S / 2 + f * 0.32)}" font-size="${n(f)}" fill="${INK}">${esc(e.name)}</text>`;
      } else if (i === L.shown.length && L.more) {
        out += `<text x="${n(colX)}" y="${n(ry + S / 2 + f * 0.32)}" font-size="${n(f)}" font-style="italic" fill="${INK}">and ${L.more} more</text>`;
      }
    }
    colX += L.colW[c]! + S * 0.9;
  }
  return out + `</g>`;
}

/** The SVG transform from map squares to sheet points for a frame (the handout page's overlay uses it too). */
export function frameTransform(f: HandoutFrame): string {
  return `translate(${n(f.x)} ${n(f.y)}) scale(${Math.round(f.k * 1e5) / 1e5}) translate(${n(-f.x0)} ${n(-f.y0)})`;
}
