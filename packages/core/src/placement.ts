// Keeping props off each other. Trees (canopies, saplings too) and props that
// stand up and block (boulders, ruin walls, columns, tables: blocks movement or
// sight) are obstacles. The prop brush and MCP add_props_along skip spots where
// a new one would stand on an obstacle (or on a copy from the same stroke);
// add_prop and apply_ops say which ones a new prop overlaps, and add_prop where
// it would be free. Floor props (rugs, leaf piles) and other props you walk
// over (blocks none: candles, mushrooms, ferns) are neither obstacles nor kept
// off them, so a table stands on a rug and a candle on a table.
import { assetInfo, modularAt, propLayer } from './assets/catalog.ts';
import type { Bounds } from './geometry/shapes.ts';
import type { MapObject, Point, Prop } from './schema.ts';

/**
 * How deep two footprints may reach into each other, in squares, and still
 * count as clear (a quarter of the smaller one's shorter side if that is
 * less): trees in a wood touch at their edges, a boulder never stands under one.
 */
export const OVERLAP_TOLERANCE = 0.25;

/** A prop as placed (or about to be). */
export type Placed = Pick<Prop, 'asset' | 'at' | 'rotation' | 'scale'> & { id?: string };

/**
 * Does this prop stand in the way of others: every tree (a sapling's crown
 * hides what stands under it too), and whatever else blocks movement or sight
 * and stands up (props layer, not the floor or a GM symbol)? Unknown assets don't.
 */
export function isObstacle(asset: string): boolean {
  const info = assetInfo(asset);
  if (!info || info.kind !== 'prop') return false;
  if (info.canopy) return true;
  return info.blocks !== 'none' && propLayer(asset) === 'props';
}

/**
 * What overlap tests compare: square footprints are discs (a tree's crown, a
 * boulder, a column: the same whichever way they are turned), the others the
 * turned rectangle (a wall piece, a cart, a long table).
 */
interface Footprint {
  at: Point;
  w: number;
  h: number;
  cos: number;
  sin: number;
  round: boolean;
  box: Bounds;
}

function footprint(p: Placed): Footprint {
  const info = assetInfo(p.asset);
  const s = p.scale ?? 1;
  const w = (info?.w ?? 1) * s;
  const h = (info?.h ?? 1) * s;
  const a = ((p.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const round = Math.abs(w - h) < 1e-9;
  const hw = round ? w / 2 : (w * Math.abs(cos) + h * Math.abs(sin)) / 2;
  const hh = round ? w / 2 : (w * Math.abs(sin) + h * Math.abs(cos)) / 2;
  return { at: p.at, w, h, cos, sin, round, box: { x0: p.at[0] - hw, y0: p.at[1] - hh, x1: p.at[0] + hw, y1: p.at[1] + hh } };
}

/** How far a disc reaches into a turned rectangle (its centre inside: more than its radius). */
function discInBox(d: Footprint, b: Footprint): number {
  const dx = d.at[0] - b.at[0];
  const dy = d.at[1] - b.at[1];
  // the disc's centre in the rectangle's own axes (turned clockwise, y down)
  const ox = Math.abs(dx * b.cos + dy * b.sin) - b.w / 2;
  const oy = Math.abs(-dx * b.sin + dy * b.cos) - b.h / 2;
  if (ox <= 0 && oy <= 0) return d.w / 2 + Math.min(-ox, -oy);
  return d.w / 2 - Math.hypot(Math.max(ox, 0), Math.max(oy, 0));
}

/** How far two turned rectangles reach into each other: the least overlap over their four axes. */
function boxInBox(a: Footprint, b: Footprint): number {
  const dx = b.at[0] - a.at[0];
  const dy = b.at[1] - a.at[1];
  const half = (f: Footprint, nx: number, ny: number) => (f.w / 2) * Math.abs(f.cos * nx + f.sin * ny) + (f.h / 2) * Math.abs(-f.sin * nx + f.cos * ny);
  let least = Infinity;
  for (const [nx, ny] of [[a.cos, a.sin], [-a.sin, a.cos], [b.cos, b.sin], [-b.sin, b.cos]] as const) {
    least = Math.min(least, half(a, nx, ny) + half(b, nx, ny) - Math.abs(dx * nx + dy * ny));
  }
  return least;
}

/** How far one footprint reaches into the other, in squares (0 or less: they are apart). */
function depth(a: Footprint, b: Footprint): number {
  if (a.round && b.round) return a.w / 2 + b.w / 2 - Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
  if (a.round) return discInBox(a, b);
  if (b.round) return discInBox(b, a);
  return boxInBox(a, b);
}

const touching = (a: Bounds, b: Bounds) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function overlap(a: Footprint, b: Footprint): boolean {
  if (!touching(a.box, b.box)) return false;
  return depth(a, b) > Math.min(OVERLAP_TOLERANCE, 0.25 * Math.min(a.w, a.h, b.w, b.h)) + 1e-9;
}

/** Do these two props overlap by more than the tolerance? (whatever they are; isObstacle says whether it matters) */
export function propsOverlap(a: Placed, b: Placed): boolean {
  return overlap(footprint(a), footprint(b));
}

interface Entry {
  id?: string;
  fp: Footprint;
  /** Order of adding (map order for the map's props). */
  n: number;
}

/** Obstacles in buckets of CELL squares, so a stroke of 500 copies over a big forest stays quick. */
const CELL = 4;
class Obstacles {
  private cells = new Map<string, Entry[]>();
  private count = 0;
  private each(b: Bounds, fn: (key: string) => void): void {
    for (let x = Math.floor(b.x0 / CELL); x <= Math.floor(b.x1 / CELL); x++) for (let y = Math.floor(b.y0 / CELL); y <= Math.floor(b.y1 / CELL); y++) fn(`${x},${y}`);
  }
  add(fp: Footprint, id?: string): void {
    const e: Entry = { fp, n: this.count++, ...(id ? { id } : {}) };
    this.each(fp.box, (k) => {
      const list = this.cells.get(k);
      if (list) list.push(e);
      else this.cells.set(k, [e]);
    });
  }
  /** The obstacles that fp overlaps, each once, in the order they were added. */
  hits(fp: Footprint): Entry[] {
    const out = new Set<Entry>();
    this.each(fp.box, (k) => {
      for (const e of this.cells.get(k) ?? []) if (!out.has(e) && overlap(fp, e.fp)) out.add(e);
    });
    return [...out].sort((a, b) => a.n - b.n);
  }
}

function obstaclesOf(objects: readonly MapObject[], skip?: string): Obstacles {
  const index = new Obstacles();
  for (const o of objects) if (o.type === 'prop' && o.id !== skip && isObstacle(o.asset)) index.add(footprint(o), o.id);
  return index;
}

/**
 * The obstacles on the map a prop stands on, in map order (itself, by id, left
 * out). Empty when the prop isn't an obstacle itself: floor props and props you
 * walk over may go anywhere.
 */
export function blockingProps(objects: readonly MapObject[], p: Placed): Prop[] {
  if (!isObstacle(p.asset)) return [];
  const fp = footprint(p);
  return objects.filter((o): o is Prop => o.type === 'prop' && o.id !== p.id && isObstacle(o.asset) && overlap(fp, footprint(o)));
}

/**
 * The nearest spot to `p.at` where the prop stands clear of every obstacle:
 * tried in half-square steps outward (nearest first, then clockwise from
 * north), up to `radius` squares away; modular pieces (ruin walls) on whole
 * squares, as modularAt puts them. null when there is none that near.
 */
export function freeSpot(objects: readonly MapObject[], p: Placed, radius = 6): Point | null {
  const index = obstaclesOf(objects, p.id);
  const modular = assetInfo(p.asset)?.modular === true;
  const steps = Math.floor(radius * 2);
  const offsets: { dx: number; dy: number; d: number; turn: number }[] = [];
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const d = Math.hypot(i, j) / 2;
      if (d > radius) continue;
      offsets.push({ dx: i / 2, dy: j / 2, d, turn: (Math.atan2(i, -j) + 2 * Math.PI) % (2 * Math.PI) });
    }
  }
  offsets.sort((a, b) => a.d - b.d || a.turn - b.turn);
  const r = (v: number) => Math.round(v * 100) / 100;
  const tried = new Set<string>();
  for (const o of offsets) {
    let at: Point = [r(p.at[0] + o.dx), r(p.at[1] + o.dy)];
    if (modular) at = modularAt({ ...p, at });
    const key = at.join(',');
    if (tried.has(key)) continue;
    tried.add(key);
    if (!index.hits(footprint({ ...p, at })).length) return at;
  }
  return null;
}

/**
 * A brush stroke's copies (the prop brush, MCP add_props_along) without the
 * ones that would stand on an obstacle on the map or on a copy kept before
 * them, in stroke order. Copies that aren't obstacles themselves are all kept.
 */
export function keepClear<T extends Placed>(objects: readonly MapObject[], copies: readonly T[]): { kept: T[]; skipped: number } {
  if (!copies.some((c) => isObstacle(c.asset))) return { kept: [...copies], skipped: 0 };
  const index = obstaclesOf(objects);
  const kept: T[] = [];
  for (const c of copies) {
    if (!isObstacle(c.asset)) {
      kept.push(c);
      continue;
    }
    const fp = footprint(c);
    if (index.hits(fp).length) continue;
    index.add(fp);
    kept.push(c);
  }
  return { kept, skipped: copies.length - kept.length };
}

/**
 * For props just added (MCP apply_ops): each one that stands on obstacles, with
 * their ids. A pair of new props is told once, at the later one.
 */
export function overlapReport(objects: readonly MapObject[], ids: readonly string[]): { id: string; on: string[] }[] {
  const wanted = new Set(ids);
  const added = objects.filter((o): o is Prop => o.type === 'prop' && wanted.has(o.id) && isObstacle(o.asset));
  if (!added.length) return [];
  const index = obstaclesOf(objects);
  const order = new Map(objects.map((o, i) => [o.id, i]));
  const out: { id: string; on: string[] }[] = [];
  for (const p of added) {
    const on = index.hits(footprint(p)).flatMap((e) => (e.id && e.id !== p.id && (!wanted.has(e.id) || order.get(e.id)! < order.get(p.id)!) ? [e.id] : []));
    if (on.length) out.push({ id: p.id, on });
  }
  return out;
}
