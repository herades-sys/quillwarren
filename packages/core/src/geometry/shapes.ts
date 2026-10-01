// Shape helpers shared by the geometry modules. Public geometry uses [x, y]
// tuples; Clipper2 works on {x, y} objects, so conversions live here.
import { areaD, ellipseD, type PathD } from 'clipper2-ts';
import type { Point, Shape } from '../schema.ts';

export type Ring = Point[];
export interface Polygon {
  outer: Ring;
  holes: Ring[];
}
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Decimal places Clipper keeps; far below the 0.5-square grid. */
export const PRECISION = 6;
export const EPS = 1e-6;
export const CIRCLE_STEPS = 64;

const round = (n: number): number => {
  const r = Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;
  return r === 0 ? 0 : r; // no -0
};

export const toPath = (ring: readonly Point[]): PathD => ring.map(([x, y]) => ({ x, y }));
export const fromPath = (path: PathD): Ring => path.map((p) => [round(p.x), round(p.y)] as Point);

/** Closed outline of a shape, always in the same (positive-area) orientation so NonZero unions merge. */
export function shapePath(shape: Shape): PathD {
  let path: PathD;
  if ('rect' in shape) {
    const [x, y, w, h] = shape.rect;
    path = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  } else if ('poly' in shape) {
    path = toPath(shape.poly);
  } else {
    const [cx, cy, r] = shape.circle;
    path = ellipseD({ x: cx, y: cy }, r, r, CIRCLE_STEPS);
  }
  return areaD(path) < 0 ? path.reverse() : path;
}

export function shapeBounds(shape: Shape): Bounds {
  if ('rect' in shape) {
    const [x, y, w, h] = shape.rect;
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  }
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle;
    return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
  }
  return pointsBounds(shape.poly);
}

export function pointsBounds(points: readonly Point[]): Bounds {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function shapeArea(shape: Shape): number {
  if ('rect' in shape) return shape.rect[2] * shape.rect[3];
  if ('circle' in shape) return Math.PI * shape.circle[2] ** 2;
  return Math.abs(areaD(toPath(shape.poly)));
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if ('rect' in shape) {
    const [x, y, w, h] = shape.rect;
    return { rect: [x + dx, y + dy, w, h] };
  }
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle;
    return { circle: [cx + dx, cy + dy, r] };
  }
  return { poly: shape.poly.map(([x, y]) => [x + dx, y + dy] as Point) };
}

export function containsPoint(b: Bounds, [x, y]: Point, eps = EPS): boolean {
  return x >= b.x0 - eps && x <= b.x1 + eps && y >= b.y0 - eps && y <= b.y1 + eps;
}

/** Is p inside the ring (even-odd)? */
export function pointInRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is p inside the shape (its edge counts as inside)? */
export function pointInShape(shape: Shape, p: Point): boolean {
  if ('rect' in shape) {
    const [x, y, w, h] = shape.rect;
    return p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
  }
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle;
    return Math.hypot(p[0] - cx, p[1] - cy) <= r;
  }
  return pointInRing(p, shape.poly);
}
