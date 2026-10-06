// Cropped exports: the part of a map a PNG or SVG covers, in whole squares so a
// VTT's grid lines up with the picture. Shared by the MCP export tool and the
// editor's "Crop to selection".
import { FillRule, intersectD, type PathD, type PathsD } from 'clipper2-ts';
import { polygonsOf } from './geometry/floor.ts';
import { objectBounds } from './geometry/objects.ts';
import { PRECISION, toPath, type Bounds, type Polygon } from './geometry/shapes.ts';
import { doorSegment, type Polyline } from './geometry/walls.ts';
import type { Layer, Scene } from './render/scene.ts';
import type { DelveMap, MapObject, Point } from './schema.ts';
import { ValidationError } from './validate.ts';

/** Where an object lies, without the pick padding objectBounds gives a door (a door is its line). */
export function tightBounds(o: MapObject, map: DelveMap): Bounds | null {
  if (o.type === 'door') {
    const [a, b] = doorSegment(o);
    return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
  }
  return objectBounds(o, map);
}

export function unionOf(list: readonly (Bounds | null)[]): Bounds | null {
  const bs = list.filter((b): b is Bounds => b !== null);
  if (!bs.length) return null;
  return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) };
}

/** The bounds of these objects together; unknown ids are skipped. */
export function selectionBounds(map: DelveMap, ids: readonly string[]): Bounds | null {
  const want = new Set(ids);
  return unionOf(map.objects.filter((o) => want.has(o.id)).map((o) => tightBounds(o, map)));
}

/** Out to whole squares (a hair's breadth of floating point doesn't add a square). */
export function wholeSquares(b: Bounds): Bounds {
  const lo = (v: number) => Math.floor(v + 1e-9);
  const hi = (v: number) => Math.ceil(v - 1e-9);
  const out = { x0: lo(b.x0), y0: lo(b.y0), x1: hi(b.x1), y1: hi(b.y1) };
  if (out.x1 <= out.x0) out.x1 = out.x0 + 1;
  if (out.y1 <= out.y0) out.y1 = out.y0 + 1;
  return out;
}

export interface CropRequest {
  /** [x, y, width, height] in squares. */
  crop?: readonly [number, number, number, number];
  /** Object ids: their bounds plus `margin`. */
  around?: readonly string[];
  /** Squares around the `around` objects (default 1). */
  margin?: number;
}

/** The largest crop, the same limit the render route's frame has. */
export const MAX_CROP = 1000;

/**
 * The frame of a cropped export: the crop rectangle and/or the bounds of the
 * `around` objects plus the margin, together, out to whole squares. Null when
 * nothing asks for a crop.
 */
export function cropFrame(map: DelveMap, r: CropRequest): Bounds | null {
  const parts: Bounds[] = [];
  if (r.crop) {
    const [x, y, w, h] = r.crop;
    if (![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) throw new ValidationError(['crop: [x, y, width, height] in squares, with a width and height greater than 0']);
    parts.push({ x0: x, y0: y, x1: x + w, y1: y + h });
  }
  if (r.around?.length) {
    const known = new Set(map.objects.map((o) => o.id));
    const missing = [...new Set(r.around)].filter((id) => !known.has(id));
    if (missing.length) throw new ValidationError([`around: no object with id ${missing.map((s) => JSON.stringify(s)).join(', ')} on this map`]);
    const margin = r.margin ?? 1;
    if (!Number.isFinite(margin) || margin < 0 || margin > 100) throw new ValidationError(['margin: from 0 to 100 squares']);
    const b = selectionBounds(map, r.around);
    if (b) parts.push({ x0: b.x0 - margin, y0: b.y0 - margin, x1: b.x1 + margin, y1: b.y1 + margin });
  }
  const all = unionOf(parts);
  if (!all) return null;
  const f = wholeSquares(all);
  if (f.x1 - f.x0 > MAX_CROP || f.y1 - f.y0 > MAX_CROP) throw new ValidationError([`crop: at most ${MAX_CROP} squares each way`]);
  return f;
}

/** "x0,y0,x1,y1": the render route's frame query. */
export const frameQuery = (b: Bounds): string => `${b.x0},${b.y0},${b.x1},${b.y1}`;

// ---------- how big a PNG may be ----------

/**
 * The largest PNG the render route makes: a whole city at Roll20's 70 px a square
 * still fits (Feyvale, 157 × 106 squares, is 81 megapixels), but 1000 squares at
 * 300 px would ask resvg for a picture that takes the whole server down.
 */
export const MAX_RENDER_SIDE = 16_384;
export const MAX_RENDER_PIXELS = 100_000_000;

/** Why a picture of w × h squares at `ppg` px a square is too big to render, or null when it fits. */
export function renderSizeProblem(w: number, h: number, ppg: number): string | null {
  const pw = Math.round(w * ppg);
  const ph = Math.round(h * ppg);
  const what = `${w} × ${h} squares at ${ppg} px a square is ${pw} × ${ph} px`;
  if (pw > MAX_RENDER_SIDE || ph > MAX_RENDER_SIDE) return `${what}; at most ${MAX_RENDER_SIDE} px a side`;
  if (pw * ph > MAX_RENDER_PIXELS) return `${what} (${Math.round((pw * ph) / 1e6)} megapixels); at most ${MAX_RENDER_PIXELS / 1e6}`;
  return null;
}

// ---------- cutting a scene down to its frame ----------

const boxPath = (b: Bounds): PathD => [
  { x: b.x0, y: b.y0 },
  { x: b.x1, y: b.y0 },
  { x: b.x1, y: b.y1 },
  { x: b.x0, y: b.y1 },
];

function cutPolygons(polys: readonly Polygon[], b: Bounds): Polygon[] {
  const paths: PathsD = polys.flatMap((p) => [p.outer, ...p.holes].map(toPath));
  return paths.length ? polygonsOf(intersectD(paths, [boxPath(b)], FillRule.NonZero, PRECISION)) : [];
}

/** The parts of the lines inside the box, cut exactly at its edges (Liang–Barsky per segment). */
export function clipLinesToBox(lines: readonly Polyline[], b: Bounds): Polyline[] {
  const out: Polyline[] = [];
  for (const line of lines) {
    const pts = line.points;
    const n = line.closed ? pts.length : pts.length - 1;
    let run: Point[] | null = null;
    const flush = () => {
      if (run && run.length > 1) out.push({ points: run, closed: false });
      run = null;
    };
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      let t0 = 0;
      let t1 = 1;
      let inside = true;
      for (const [p, q] of [[-dx, a[0] - b.x0], [dx, b.x1 - a[0]], [-dy, a[1] - b.y0], [dy, b.y1 - a[1]]] as const) {
        if (Math.abs(p) < 1e-12) {
          if (q < 0) inside = false;
        } else {
          const r = q / p;
          if (p < 0) t0 = Math.max(t0, r);
          else t1 = Math.min(t1, r);
        }
      }
      if (!inside || t0 > t1) {
        flush();
        continue;
      }
      const at = (t: number): Point => (t === 0 ? a : t === 1 ? c : [a[0] + dx * t, a[1] + dy * t]);
      if (t0 > 0) flush();
      if (!run) run = [at(t0)];
      run.push(at(t1));
      if (t1 < 1) flush();
    }
    flush();
  }
  return out;
}

/**
 * The scene with everything outside `b` (plus a little) left out: polygons and
 * lines cut at the box (the reveal too), props, labels and badges outside it
 * dropped. A cropped picture then holds only what it shows, which keeps it small
 * and keeps resvg clear of clipped or see-through groups far outside the page:
 * past twice the picture's size it panics, which kills the server (docs/API.md,
 * "resvg's layer limit"). Every picture of a frame goes through here.
 */
export function cropScene(scene: Scene, frame: Bounds): Scene {
  const b = { x0: frame.x0 - 0.5, y0: frame.y0 - 0.5, x1: frame.x1 + 0.5, y1: frame.y1 + 0.5 };
  const near = (x: Bounds) => x.x0 <= b.x1 && b.x0 <= x.x1 && x.y0 <= b.y1 && b.y0 <= x.y1;
  const around = (p: Point, r: number): Bounds => ({ x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r });
  const layers = scene.layers.flatMap((l): Layer[] => {
    switch (l.kind) {
      case 'rect':
        return [{ ...l, bounds: { x0: Math.max(l.bounds.x0, b.x0), y0: Math.max(l.bounds.y0, b.y0), x1: Math.min(l.bounds.x1, b.x1), y1: Math.min(l.bounds.y1, b.y1) } }];
      case 'fill':
      case 'pattern':
        return [{ ...l, polygons: cutPolygons(l.polygons, b) }];
      case 'stroke':
        return [{ ...l, lines: clipLinesToBox(l.lines, b) }];
      case 'dots':
        return [{ ...l, points: l.points.filter((p) => near(around(p, 0))) }];
      case 'text':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, i.size * Math.max(1, i.text.length)))) }];
      case 'tags':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, l.size * 3))) }];
      case 'markers':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, i.r))) }];
      case 'assets':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, (Math.hypot(i.w, i.h) / 2) * i.scale))) }];
      case 'inscriptions':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, (i.size ?? 0.8) * Math.max(1, i.text.length)))) }];
      case 'images':
        return [{ ...l, items: l.items.filter((i) => near(around(i.at, Math.hypot(i.w, i.h) / 2))) }];
    }
  });
  const clips: Record<string, Polygon[]> = {};
  for (const [k, v] of Object.entries(scene.clips)) clips[k] = cutPolygons(v, b);
  return { ...scene, layers, clips, ...(scene.reveal ? { reveal: { ...scene.reveal, polygons: cutPolygons(scene.reveal.polygons, b) } } : {}) };
}
