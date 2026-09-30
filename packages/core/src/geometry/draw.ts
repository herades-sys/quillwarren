// Rooms and pillars in other shapes. A box (dragged in the editor, or given
// over MCP) becomes a rectangle, circle, oval, triangle, hexagon or octagon;
// a freehand stroke becomes a tidy polygon on a quarter-square grid.
import type { Point, Shape } from '../schema.ts';

export const DRAW_SHAPES = ['rect', 'circle', 'oval', 'triangle', 'hexagon', 'octagon', 'freehand'] as const;
export type DrawShape = (typeof DRAW_SHAPES)[number];
/** The shapes a box turns into (freehand has no box). */
export type BoxShape = Exclude<DrawShape, 'freehand'>;
/** What MCP's `preset` takes: the box shapes that aren't a plain rect or circle. */
export const PRESET_SHAPES = ['oval', 'triangle', 'hexagon', 'octagon'] as const;
export type PresetShape = (typeof PRESET_SHAPES)[number];

/** [x, y, width, height] in squares. */
export type Box = [number, number, number, number];

export const OVAL_POINTS = 40;
/** How far a regular octagon's corners are cut in, as a share of its width: 1 / (2 + √2). */
const OCTAGON_CUT = 1 / (2 + Math.SQRT2);

const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r; // no -0
};
const pt = (x: number, y: number): Point => [r2(x), r2(y)];

/** The shape filling a box. Polygons are rounded to 0.01 squares; a circle takes the box's shorter side. */
export function shapeFromBox(kind: BoxShape, box: Box): Shape {
  const [x, y, w, h] = box;
  switch (kind) {
    case 'rect':
      return { rect: [x, y, w, h] };
    case 'circle':
      return { circle: [r2(x + w / 2), r2(y + h / 2), r2(Math.min(w, h) / 2)] };
    case 'oval': {
      // starts at the top and goes round clockwise (y is down), so it's mirror-symmetric
      const poly: Point[] = [];
      for (let i = 0; i < OVAL_POINTS; i++) {
        const a = (i / OVAL_POINTS) * 2 * Math.PI;
        poly.push(pt(x + w / 2 + (w / 2) * Math.sin(a), y + h / 2 - (h / 2) * Math.cos(a)));
      }
      return { poly };
    }
    case 'triangle':
      return { poly: [pt(x + w / 2, y), pt(x + w, y + h), pt(x, y + h)] };
    case 'hexagon':
      // flat top and bottom, so rows of hex rooms sit on the grid
      return { poly: [pt(x + w / 4, y), pt(x + (3 * w) / 4, y), pt(x + w, y + h / 2), pt(x + (3 * w) / 4, y + h), pt(x + w / 4, y + h), pt(x, y + h / 2)] };
    case 'octagon': {
      const cx = w * OCTAGON_CUT;
      const cy = h * OCTAGON_CUT;
      return {
        poly: [pt(x + cx, y), pt(x + w - cx, y), pt(x + w, y + cy), pt(x + w, y + h - cy), pt(x + w - cx, y + h), pt(x + cx, y + h), pt(x, y + h - cy), pt(x, y + cy)],
      };
    }
  }
}

/** The box spanned by a drag from a to b. regular: as wide as it is high (the longer side wins), still growing the way the drag goes. */
export function dragBox(a: Point, b: Point, regular = false): Box {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  if (regular) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  return [Math.min(a[0], a[0] + dx), Math.min(a[1], a[1] + dy), Math.abs(dx), Math.abs(dy)];
}

/** The shape a Room or Pillar drag makes, or null while it's smaller than `min` either way. A circle is always regular. */
export function shapeFromDrag(kind: BoxShape, a: Point, b: Point, opts: { regular?: boolean; min?: number } = {}): Shape | null {
  const box = dragBox(a, b, Boolean(opts.regular) || kind === 'circle');
  const min = opts.min ?? 1;
  return box[2] >= min && box[3] >= min ? shapeFromBox(kind, box) : null;
}

// ---------- freehand ----------

export interface FreehandOptions {
  /** Douglas–Peucker tolerance in squares. */
  tolerance?: number;
  /** Corners snap to this grid. */
  grid?: number;
  /** Outlines enclosing less than this (square squares) are dropped. */
  minArea?: number;
}

const same = (a: Point, b: Point): boolean => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker on an open chain; keeps both ends. */
function simplifyChain(pts: readonly Point[], tol: number): Point[] {
  if (pts.length < 3) return [...pts];
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let far = -1;
    let best = tol;
    for (let k = i + 1; k < j; k++) {
      const d = distToSegment(pts[k]!, pts[i]!, pts[j]!);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    if (far < 0) continue;
    keep[far] = true;
    stack.push([i, far], [far, j]);
  }
  return pts.filter((_, k) => keep[k]);
}

/** Twice the signed area of a ring. */
function area2(ring: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** Drop repeated points and corners that lie on a straight line (spikes included), all the way round. */
function tidyRing(ring: Point[]): Point[] {
  let out = ring;
  for (let changed = true; changed && out.length >= 3; ) {
    changed = false;
    for (let i = 0; i < out.length && out.length >= 3; i++) {
      const prev = out[(i - 1 + out.length) % out.length]!;
      const cur = out[i]!;
      const next = out[(i + 1) % out.length]!;
      const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
      if (same(prev, cur) || Math.abs(cross) < 1e-9) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        i--;
      }
    }
  }
  return out;
}

/**
 * A freehand outline as a polygon: closed, simplified (Douglas–Peucker, 0.15
 * squares) and snapped to quarter squares. Null for strokes with fewer than
 * 3 distinct points or that enclose next to nothing.
 */
export function freehandShape(points: readonly Point[], opts: FreehandOptions = {}): Shape | null {
  const tol = opts.tolerance ?? 0.15;
  const grid = opts.grid ?? 0.25;
  const minArea = opts.minArea ?? 0.25;
  const pts = points.filter((p, i) => i === 0 || !same(p, points[i - 1]!));
  while (pts.length > 1 && same(pts[0]!, pts.at(-1)!)) pts.pop();
  if (pts.length < 3) return null;
  // a closed ring: split it at the point farthest from the start and simplify both halves
  let far = 0;
  for (let k = 1; k < pts.length; k++) {
    if (Math.hypot(pts[k]![0] - pts[0]![0], pts[k]![1] - pts[0]![1]) > Math.hypot(pts[far]![0] - pts[0]![0], pts[far]![1] - pts[0]![1])) far = k;
  }
  const first = simplifyChain(pts.slice(0, far + 1), tol);
  const second = simplifyChain([...pts.slice(far), pts[0]!], tol);
  const simple = [...first.slice(0, -1), ...second.slice(0, -1)];
  const snapped = simple.map(([x, y]) => pt(Math.round(x / grid) * grid, Math.round(y / grid) * grid));
  const ring = tidyRing(snapped);
  if (ring.length < 3 || Math.abs(area2(ring)) / 2 < minArea) return null;
  return { poly: ring };
}
