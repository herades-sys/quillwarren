// Open areas (the `opening` object): where the map leaves out the band outside
// the walls, and with `walls` the wall lines too. This file has the geometry
// the walls need; render/open-ends.ts adds the archways' open ends.
import type { DelveMap, Opening, Point } from '../schema.ts';
import { fromPath, pointInRing, pointsBounds, shapePath, type Bounds, type Polygon, type Ring } from './shapes.ts';

type Segment = [Point, Point];

/** The map's opening objects (all, or only the ones that open the walls). */
export function openingsOf(map: DelveMap, walls = false): Opening[] {
  return map.objects.filter((o): o is Opening => o.type === 'opening' && (!walls || Boolean(o.walls)));
}

/** The outlines of the openings that leave the walls out. */
export function openWallRings(map: DelveMap): Ring[] {
  return openingsOf(map, true).map((o) => fromPath(shapePath(o.shape)));
}

/** A point test for the floor (inside an outer ring, not in one of its holes), for cutSegments' `floorAt`. */
export function floorTest(floor: readonly Polygon[]): (p: Point) => boolean {
  return (p) => floor.some((poly) => pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h)));
}

const overlaps = (a: Bounds, b: Bounds, eps = 1e-9): boolean => a.x0 <= b.x1 + eps && b.x0 <= a.x1 + eps && a.y0 <= b.y1 + eps && b.y0 <= a.y1 + eps;

function onRing(ring: Ring, p: Point, eps = 1e-7): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= eps) return true;
  }
  return false;
}

/**
 * The parts of the segments that lie outside the rings, cut exactly where they
 * cross a ring's edge. A piece lying along a ring's edge goes only when the
 * ring is on its open side (`floorAt` false there): an open area drawn against
 * a room's top wall from outside opens it, while the side walls running along
 * an open area that reaches into the room stay. Without `floorAt`, edges stay.
 */
export function cutSegments(segs: readonly Segment[], rings: readonly Ring[], floorAt?: (p: Point) => boolean): Segment[] {
  if (!rings.length) return [...segs];
  const boxes = rings.map(pointsBounds);
  const out: Segment[] = [];
  for (const seg of segs) {
    const [a, b] = seg;
    const near = rings.filter((_, i) => overlaps(boxes[i]!, pointsBounds(seg)));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (!near.length || len2 < 1e-18) {
      out.push(seg);
      continue;
    }
    const ts: number[] = [];
    for (const ring of near) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        const ex = q[0] - p[0];
        const ey = q[1] - p[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) {
          // parallel: a collinear edge splits the wall at its ends
          const cross = (p[0] - a[0]) * dy - (p[1] - a[1]) * dx;
          if (Math.abs(cross) / Math.sqrt(len2) < 1e-9) for (const r of [p, q]) ts.push(((r[0] - a[0]) * dx + (r[1] - a[1]) * dy) / len2);
          continue;
        }
        const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
        const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
        if (u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
      }
    }
    const cuts = [0, ...ts.filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y), 1];
    const at = (t: number): Point => (t === 0 ? a : t === 1 ? b : [a[0] + dx * t, a[1] + dy * t]);
    const len = Math.sqrt(len2);
    const nx = -dy / len;
    const ny = dx / len;
    const k = 1e-4;
    const strictly = (ring: Ring, p: Point) => !onRing(ring, p) && pointInRing(p, ring);
    const goes = (ring: Ring, m: Point): boolean => {
      if (!onRing(ring, m)) return pointInRing(m, ring);
      if (!floorAt) return false;
      // along the edge: gone if the ring lies on the side away from the floor
      return [1, -1].some((s) => {
        const p: Point = [m[0] + nx * k * s, m[1] + ny * k * s];
        return strictly(ring, p) && !floorAt(p);
      });
    };
    let start: number | null = null;
    let end = 0;
    const flush = () => {
      if (start !== null && end - start > 1e-9) out.push([at(start), at(end)]);
      start = null;
    };
    for (let i = 0; i < cuts.length - 1; i++) {
      const t0 = cuts[i]!;
      const t1 = cuts[i + 1]!;
      if (t1 - t0 <= 1e-9) continue;
      const m = at((t0 + t1) / 2);
      const gone = near.some((ring) => goes(ring, m));
      if (gone) flush();
      else {
        if (start === null) start = t0;
        end = t1;
      }
    }
    flush();
  }
  return out;
}
