// sceneToSvg: a scene (in grid squares) as a standalone SVG string. The
// viewBox is in squares; width/height are pixels at `ppg` (pixels per grid square).
import { recolor, type Palette } from '../assets/svg.ts';
import { markerGlyph } from '../markers.ts';
import type { Polygon } from '../geometry/shapes.ts';
import type { Polyline } from '../geometry/walls.ts';
import type { AssetItem, Layer, Scene } from './scene.ts';

export interface SvgOptions {
  /** Pixels per grid square. Roll20's default grid is 70. */
  ppg?: number;
  /** Prefix for element ids, so several maps can sit inline on one HTML page. */
  idPrefix?: string;
}

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function polygonsD(polys: readonly Polygon[]): string {
  let d = '';
  for (const p of polys) {
    for (const ring of [p.outer, ...p.holes]) {
      if (ring.length < 3) continue;
      d += `M${ring.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;
    }
  }
  return d;
}

function linesD(lines: readonly Polyline[]): string {
  let d = '';
  for (const l of lines) {
    if (l.points.length < 2) continue;
    d += `M${l.points.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}${l.closed ? 'Z' : ''}`;
  }
  return d;
}

/** Pattern ids must be valid in url(#…) and unique per tile and palette. */
const patternId = (prefix: string, tile: string, p: Palette): string =>
  `${prefix}tile-${tile.replace(/[^A-Za-z0-9_-]/g, '_')}-${(p.ink + p.paper + p.shade).replace(/#/g, '')}`;

/** A prop: the body is in asset units (100 per square) with its footprint's top-left at 0,0. */
function assetSvg(it: AssetItem, palette: Palette): string {
  const place = `translate(${n(it.at[0])} ${n(it.at[1])})${it.rotation ? ` rotate(${n(it.rotation)})` : ''}`;
  const w = it.w * it.scale;
  const h = it.h * it.scale;
  if (!it.body) {
    // not loaded yet (or unknown): a dashed footprint so it can still be seen and picked
    return (
      `<g transform="${place}" data-missing="${esc(it.asset)}"><rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" ` +
      `fill="none" stroke="${palette.ink}" stroke-width="0.04" stroke-dasharray="0.15 0.1"/></g>`
    );
  }
  return `<g transform="${place} scale(${n(it.scale / 100)}) translate(${n(-it.w * 50)} ${n(-it.h * 50)})">${recolor(it.body, palette)}</g>`;
}

function common(layer: Layer, prefix: string): string {
  let a = '';
  if (layer.opacity !== undefined && layer.opacity !== 1) a += ` opacity="${n(layer.opacity)}"`;
  if (layer.clip) a += ` clip-path="url(#${esc(prefix)}clip-${esc(layer.clip)})"`;
  return a;
}

function layerSvg(layer: Layer, prefix: string): string {
  const g = (inner: string) => `<g data-layer="${esc(layer.name)}"${common(layer, prefix)}>${inner}</g>`;
  switch (layer.kind) {
    case 'rect': {
      const b = layer.bounds;
      return g(`<rect x="${n(b.x0)}" y="${n(b.y0)}" width="${n(b.x1 - b.x0)}" height="${n(b.y1 - b.y0)}" fill="${layer.color}"/>`);
    }
    case 'fill': {
      const d = polygonsD(layer.polygons);
      if (!d) return '';
      const stroke = layer.stroke
        ? ` stroke="${layer.stroke.color}" stroke-width="${n(layer.stroke.width)}" stroke-linejoin="miter"`
        : '';
      return g(`<path d="${d}" fill="${layer.color}" fill-rule="evenodd"${stroke}/>`);
    }
    case 'stroke': {
      const d = linesD(layer.lines);
      if (!d) return '';
      const dash = layer.dash ? ` stroke-dasharray="${layer.dash.map(n).join(' ')}"` : '';
      return g(
        `<path d="${d}" fill="none" stroke="${layer.color}" stroke-width="${n(layer.width)}" ` +
          `stroke-linecap="${layer.cap}" stroke-linejoin="${layer.join}" stroke-miterlimit="4"${dash}/>`,
      );
    }
    case 'dots': {
      if (!layer.points.length) return '';
      const r = layer.radius;
      const d = layer.points
        .map(([x, y]) => `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`)
        .join('');
      return g(`<path d="${d}" fill="${layer.color}"/>`);
    }
    case 'text': {
      // Baseline shifted by 0.35 em so digits and capitals sit centred on the point.
      const items = layer.items
        .map(
          (t) =>
            `<text x="${n(t.at[0])}" y="${n(t.at[1] + t.size * 0.35)}" font-size="${n(t.size)}" text-anchor="middle">${esc(t.text)}</text>`,
        )
        .join('');
      return g(`<g font-family="${esc(layer.font)}, serif" fill="${layer.color}">${items}</g>`);
    }
    case 'assets':
      return layer.items.length ? g(layer.items.map((it) => assetSvg(it, layer.palette)).join('')) : '';
    case 'pattern': {
      const d = polygonsD(layer.polygons);
      if (!d) return '';
      const tile = layer.body ? `<path d="${d}" fill="url(#${patternId(prefix, layer.tile, layer.palette)})" fill-rule="evenodd"/>` : '';
      return g(`<path d="${d}" fill="${layer.tint}" fill-rule="evenodd"/>${tile}`);
    }
    case 'markers':
      return g(
        layer.items
          .map(
            (m) =>
              `<g class="marker" data-marker="${esc(m.id)}" data-kind="${m.kind}"${m.done ? ' data-done=""' : ''} transform="translate(${n(m.at[0])} ${n(m.at[1])}) scale(${n(layer.radius)})">${markerGlyph(m.kind, m.done)}</g>`,
          )
          .join(''),
      );
  }
}

/** One <pattern> per terrain tile and palette in the scene. Tiles are 2×2 squares, lined up with the grid from the origin. */
function patternDefs(scene: Scene, prefix: string): string {
  const out = new Map<string, string>();
  for (const l of scene.layers) {
    if (l.kind !== 'pattern' || !l.body) continue;
    const id = patternId(prefix, l.tile, l.palette);
    if (!out.has(id)) {
      out.set(id, `<pattern id="${esc(id)}" patternUnits="userSpaceOnUse" x="0" y="0" width="2" height="2"><g transform="scale(0.01)">${recolor(l.body, l.palette)}</g></pattern>`);
    }
  }
  return [...out.values()].join('');
}

export function sceneToSvg(scene: Scene, opts: SvgOptions = {}): string {
  const ppg = opts.ppg ?? 70;
  const prefix = opts.idPrefix ?? '';
  const { x0, y0, x1, y1 } = scene.bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const clips = Object.entries(scene.clips)
    .map(
      ([id, polys]) =>
        `<clipPath id="${esc(prefix)}clip-${esc(id)}"><path d="${polygonsD(polys)}" clip-rule="evenodd"/></clipPath>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * ppg)}" height="${Math.round(h * ppg)}" ` +
    `viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">` +
    `<defs>${clips}${patternDefs(scene, prefix)}</defs>` +
    scene.layers.map((l) => layerSvg(l, prefix)).join('') +
    `</svg>`
  );
}
