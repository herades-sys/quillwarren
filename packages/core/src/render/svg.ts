// sceneToSvg: a scene (in grid squares) as a standalone SVG string. The
// viewBox is in squares; width/height are pixels at `ppg` (pixels per grid square).
import type { Polygon } from '../geometry/shapes.ts';
import type { Polyline } from '../geometry/walls.ts';
import type { Layer, Scene } from './scene.ts';

export interface SvgOptions {
  /** Pixels per grid square. Roll20's default grid is 70. */
  ppg?: number;
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

function common(layer: Layer): string {
  let a = '';
  if (layer.opacity !== undefined && layer.opacity !== 1) a += ` opacity="${n(layer.opacity)}"`;
  if (layer.clip) a += ` clip-path="url(#clip-${layer.clip})"`;
  return a;
}

function layerSvg(layer: Layer): string {
  const g = (inner: string) => `<g data-layer="${esc(layer.name)}"${common(layer)}>${inner}</g>`;
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
  }
}

export function sceneToSvg(scene: Scene, opts: SvgOptions = {}): string {
  const ppg = opts.ppg ?? 70;
  const { x0, y0, x1, y1 } = scene.bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const clips = Object.entries(scene.clips)
    .map(([id, polys]) => `<clipPath id="clip-${esc(id)}"><path d="${polygonsD(polys)}" clip-rule="evenodd"/></clipPath>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * ppg)}" height="${Math.round(h * ppg)}" ` +
    `viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">` +
    `<defs>${clips}</defs>` +
    scene.layers.map(layerSvg).join('') +
    `</svg>`
  );
}
