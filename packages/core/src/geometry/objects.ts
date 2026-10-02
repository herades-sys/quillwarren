// Where objects are and what they cover, and clipping lines to an area:
// shared by the editor (zooming, highlights), the players' screen and fog.
import { propBounds } from '../assets/catalog.ts';
import { imageBounds } from '../images.ts';
import { inscriptionBounds } from '../inscriptions.ts';
import type { DelveMap, MapObject, Point } from '../schema.ts';
import { corridorBounds, corridorPath, roomsById } from './corridors.ts';
import { shapeBounds, type Bounds, type Polygon, type Ring } from './shapes.ts';
import { doorSegment, type Polyline } from './walls.ts';

/** Area an object covers, for zooming to it and highlighting it. */
export function objectBounds(o: MapObject, map: DelveMap): Bounds | null {
  switch (o.type) {
    case 'room':
    case 'cutout':
    case 'stairs':
    case 'terrain':
    case 'opening':
    case 'height':
      return shapeBounds(o.shape);
    case 'corridor': {
      const path = corridorPath(o, roomsById(map));
      return path ? corridorBounds(path, o.width) : null;
    }
    case 'door': {
      const [a, b] = doorSegment(o);
      return { x0: Math.min(a[0], b[0]) - 0.3, y0: Math.min(a[1], b[1]) - 0.3, x1: Math.max(a[0], b[0]) + 0.3, y1: Math.max(a[1], b[1]) + 0.3 };
    }
    case 'label': {
      // roughly the drawn text: about half an em per character, centred on `at`
      const size = o.size ?? 0.63;
      const hw = Math.max(0.5, (o.text.length * size * 0.52) / 2);
      return { x0: o.at[0] - hw, y0: o.at[1] - size * 0.6, x1: o.at[0] + hw, y1: o.at[1] + size * 0.6 };
    }
    case 'prop':
      return propBounds(o);
    case 'marker':
      return { x0: o.at[0] - 0.4, y0: o.at[1] - 0.4, x1: o.at[0] + 0.4, y1: o.at[1] + 0.4 };
    case 'image':
      return imageBounds(o);
    case 'inscription':
      return inscriptionBounds(o);
  }
}

function inRing(ring: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside any of the polygons (and not in one of its holes). */
export function insidePolygons(polys: readonly { outer: readonly Point[]; holes: readonly (readonly Point[])[] }[], p: Point): boolean {
  return polys.some((poly) => inRing(poly.outer, p) && !poly.holes.some((h) => inRing(h, p)));
}

/**
 * The parts of lines that lie inside the polygons: each segment is cut in steps
 * of about `step` squares, and kept pieces are joined back into polylines.
 */
export function clipPolylines(lines: readonly Polyline[], polys: readonly Polygon[] | readonly { outer: Ring; holes: Ring[] }[], step = 0.25): Polyline[] {
  const out: Polyline[] = [];
  for (const line of lines) {
    const pts = line.points;
    const segs = line.closed ? pts.length : pts.length - 1;
    let run: Point[] | null = null;
    const flush = () => {
      if (run && run.length > 1) out.push({ points: run, closed: false });
      run = null;
    };
    for (let s = 0; s < segs; s++) {
      const a = pts[s]!;
      const b = pts[(s + 1) % pts.length]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (let i = 0; i < n; i++) {
        if (insidePolygons(polys, at((i + 0.5) / n))) {
          if (!run) run = [at(i / n)];
          const end = at((i + 1) / n);
          const last: Point = run[run.length - 1]!;
          // extend straight pieces instead of stacking points along one segment
          if (run.length > 1 && i > 0) run[run.length - 1] = end;
          else if (last[0] !== end[0] || last[1] !== end[1]) run.push(end);
        } else flush();
      }
      // keep the corner point exact when a run carries on into the next segment
      if (run) run[run.length - 1] = b;
    }
    flush();
  }
  return out;
}
