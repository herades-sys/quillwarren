// "Where you can go" (core walkableMap), drawn as SVG in map squares: the ground
// tinted by height with its height on a small tag, the cliff and rock-face edges
// nobody can walk over as red dashes, and the crossings in green (thick for
// stairs and ladders, thin for slopes and steps). The editor (heights.ts) and
// Quillwarren Table's GM board (table/movement-view.ts) both draw it. No DOM helpers
// beyond createElementNS, so the table's bundle carries nothing of the editor's.
import { heightText, labelPoint, parseSquareUnit, walkableMap, type DelveMap, type Point, type View, type Walkable } from '@delve/core';

import { bandColor } from './height-text.ts';

export { bandColor };

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export const MOVEMENT_KEY = 'delve-movement';

export function loadMovement(): boolean {
  try {
    return localStorage.getItem(MOVEMENT_KEY) === 'on';
  } catch {
    return false;
  }
}
export function saveMovement(on: boolean): void {
  try {
    localStorage.setItem(MOVEMENT_KEY, on ? 'on' : 'off');
  } catch {
    /* private window: the choice just isn't kept */
  }
}

/** Footprints: the overlay's switch on the rail. */
export function movementIcon(size = 19): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'icon', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  svg.innerHTML = '<path d="M7 4c-1.7 0-2.6 2.3-2.4 4.6.2 1.9 1 3.4 2.2 3.4s1.9-1.3 1.9-3.4C8.7 6.4 8.4 4 7 4zM5.3 14.6l3.4-.5.5 2.6c.2 1.2-.6 2.2-1.7 2.3-1 .1-1.8-.6-2-1.6zM16.5 7c1.7 0 2.6 2.3 2.4 4.6-.2 1.9-1 3.4-2.2 3.4s-1.9-1.3-1.9-3.4C14.8 9.4 15.1 7 16.5 7zM18.2 17.6l-3.4-.5-.5 2.6c-.2 1.2.6 2.2 1.7 2.3 1 .1 1.8-.6 2-1.6z"/>';
  return svg;
}

const ringPath = (rings: readonly (readonly Point[])[]) => rings.map((r) => `M${r.map(([x, y]) => `${x} ${y}`).join('L')}Z`).join('');

/**
 * "Where you can go", drawn into an SVG group in map squares: the ground tinted
 * by height (with its height), cliff and rock-face edges nobody crosses as red
 * dashes, and crossings in green (thick for stairs and ladders, thin for slopes
 * and steps). `px` is squares per screen pixel, for the label size.
 */
export function drawMovement(layer: SVGElement, map: DelveMap, o: { view: View; px: number; walk?: Walkable }): void {
  if (!map.objects.some((x) => x.type === 'height')) return;
  const unit = parseSquareUnit(map.grid.unit);
  const w = o.walk ?? walkableMap(map, { view: o.view });
  const g = svgEl('g', { class: 'ed-move', 'pointer-events': 'none' });
  for (const band of w.bands) {
    const c = bandColor(band.height, unit);
    if (!c) continue;
    g.appendChild(svgEl('path', { d: ringPath(band.polygons.flatMap((p) => [p.outer, ...p.holes])), fill: c, 'fill-opacity': 0.3, 'fill-rule': 'evenodd', stroke: 'none' }));
  }
  const line = (a: Point, b: Point, attrs: Record<string, string | number>) => g.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', ...attrs }));
  for (const s of w.blocked) {
    line(s.a, s.b, { stroke: '#000000', 'stroke-opacity': 0.35, 'stroke-width': 5 });
    line(s.a, s.b, { stroke: '#e5484d', 'stroke-width': 3, 'stroke-dasharray': '7 5' });
  }
  for (const c of w.crossings) {
    const thick = c.kind === 'stairs' || c.kind === 'ladder';
    line(c.a, c.b, { stroke: '#000000', 'stroke-opacity': 0.3, 'stroke-width': thick ? 7 : 4 });
    line(c.a, c.b, { stroke: '#30a46c', 'stroke-width': thick ? 5 : 2.5 });
  }
  // the heights, in the overlay's own small tags
  const size = 11 * o.px;
  for (const band of w.bands) {
    if (Math.abs(band.height) < 1e-9) continue;
    for (const poly of band.polygons) {
      const at = labelPoint([poly]);
      if (!at) continue;
      const t = heightText(band.height, unit);
      const tw = (t.length * 6.6 + 10) * o.px;
      g.appendChild(svgEl('rect', { x: at[0] - tw / 2, y: at[1] - size * 0.85, width: tw, height: size * 1.7, rx: 4 * o.px, fill: '#1b1f24', 'fill-opacity': 0.85 }));
      const label = svgEl('text', { x: at[0], y: at[1] + size * 0.36, 'font-size': size, 'text-anchor': 'middle', fill: '#ffffff', 'font-family': 'var(--font-ui), sans-serif' });
      label.textContent = t;
      g.appendChild(label);
    }
  }
  layer.appendChild(g);
}

