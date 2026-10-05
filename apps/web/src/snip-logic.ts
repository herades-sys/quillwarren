// Snip: export exactly the part of the map you drag a box over, like the
// Windows Snipping Tool. The pure parts: snapping the box to whole squares,
// resizing it by its handles, its size in pixels, and the render URLs. The mode
// itself (veil, box, bar, keys) is snip.ts.
import { MAX_CROP, renderSizeProblem, type Bounds, type Point, type View } from '@delve/core';

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

/** What the snip bar sets; the view is the editor's own (the bar's GM / Players switch changes it). */
export interface SnipOptions {
  /** Pixels per square: 70 is Roll20's. */
  ppg: number;
  grid: boolean;
  /** No parchment: a transparent background. */
  transparent: boolean;
  /** Players' view only: just what the players have seen (fog of war). */
  revealed: boolean;
}

export const PPG_CHOICES = [50, 70, 100, 140, 200, 300] as const;
export const DEFAULT_OPTIONS: SnipOptions = { ppg: 70, grid: true, transparent: false, revealed: false };

const clampSize = (lo: number, hi: number, fixedLow: boolean): [number, number] => {
  if (hi - lo <= MAX_CROP) return [lo, hi];
  return fixedLow ? [lo, lo + MAX_CROP] : [hi - MAX_CROP, hi];
};

/** A box dragged from `a` to `b` (squares), out to every square it touches: at least 1 × 1, at most MAX_CROP each way. */
export function boxFromDrag(a: Point, b: Point): Bounds {
  let x0 = Math.floor(Math.min(a[0], b[0]) + 1e-9);
  let x1 = Math.ceil(Math.max(a[0], b[0]) - 1e-9);
  let y0 = Math.floor(Math.min(a[1], b[1]) + 1e-9);
  let y1 = Math.ceil(Math.max(a[1], b[1]) - 1e-9);
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  // the corner the drag started from stays put when the box is too big
  [x0, x1] = clampSize(x0, x1, a[0] <= b[0]);
  [y0, y1] = clampSize(y0, y1, a[1] <= b[1]);
  return { x0, y0, x1, y1 };
}

/** The box after dragging `h` by (dx, dy) squares from where it was: whole squares, never smaller than 1 × 1. */
export function adjust(box: Bounds, h: Handle, dx: number, dy: number): Bounds {
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (h === 'move') return { x0: box.x0 + rx, y0: box.y0 + ry, x1: box.x1 + rx, y1: box.y1 + ry };
  let { x0, y0, x1, y1 } = box;
  if (h.includes('w')) x0 = Math.max(Math.min(x0 + rx, x1 - 1), x1 - MAX_CROP);
  if (h.includes('e')) x1 = Math.min(Math.max(x1 + rx, x0 + 1), x0 + MAX_CROP);
  if (h.includes('n')) y0 = Math.max(Math.min(y0 + ry, y1 - 1), y1 - MAX_CROP);
  if (h.includes('s')) y1 = Math.min(Math.max(y1 + ry, y0 + 1), y0 + MAX_CROP);
  return { x0, y0, x1, y1 };
}

/**
 * What a press at `p` grabs: a corner, an edge, the inside (move), or nothing
 * (outside: a new box). `tol` is the grab distance in squares (a few pixels at
 * the current zoom); on a box narrower than that the nearer edge wins.
 */
export function handleAt(b: Bounds, p: Point, tol: number): Handle | null {
  const [x, y] = p;
  if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return null;
  const dx0 = Math.abs(x - b.x0);
  const dx1 = Math.abs(x - b.x1);
  const dy0 = Math.abs(y - b.y0);
  const dy1 = Math.abs(y - b.y1);
  const v = Math.min(dy0, dy1) <= tol ? (dy0 <= dy1 ? 'n' : 's') : '';
  const hz = Math.min(dx0, dx1) <= tol ? (dx0 <= dx1 ? 'w' : 'e') : '';
  if (v || hz) return (v + hz) as Handle;
  return x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 ? 'move' : null;
}

const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };
export const cursorFor = (h: Handle | null): string => (h ? CURSORS[h] : 'crosshair');

/** Arrow keys: move the box a square; with Shift, grow or shrink it from its east and south edges. */
export function keyAdjust(box: Bounds, key: string, shift: boolean): Bounds | null {
  const d: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const v = d[key];
  if (!v) return null;
  if (!shift) return adjust(box, 'move', v[0], v[1]);
  return adjust(box, v[0] ? 'e' : 's', v[0], v[1]);
}

export const squaresOf = (b: Bounds): { w: number; h: number } => ({ w: b.x1 - b.x0, h: b.y1 - b.y0 });

/** "12 × 8 squares · 840 × 560 px" */
export function sizeLabel(b: Bounds, ppg: number): string {
  const { w, h } = squaresOf(b);
  return `${w} × ${h} square${w * h === 1 ? '' : 's'} · ${Math.round(w * ppg)} × ${Math.round(h * ppg)} px`;
}

/** Why the PNG can't be made (the server's own limit, core MAX_RENDER_*), or null. */
export function sizeProblem(b: Bounds, ppg: number): string | null {
  const { w, h } = squaresOf(b);
  return renderSizeProblem(w, h, ppg);
}

/** The PNG and SVG of the box (the render route's frame), and the parchment handout cropped to it. */
export function snipUrls(mapId: string, b: Bounds, view: View, o: SnipOptions, style: string | null): { png: string; svg: string; handout: string } {
  const frame = `${b.x0},${b.y0},${b.x1},${b.y1}`;
  const q = new URLSearchParams({ view, ppg: String(o.ppg), frame });
  if (style) q.set('style', style);
  if (!o.grid) q.set('grid', '0');
  if (o.transparent) q.set('background', '0');
  if (view === 'players' && o.revealed) q.set('fog', '1');
  const enc = encodeURIComponent(mapId);
  return {
    png: `/api/v1/maps/${enc}/render.png?${q}`,
    svg: `/api/v1/maps/${enc}/render.svg?${q}`,
    handout: `/maps/${enc}/handout?crop=${frame}`,
  };
}

/** The file name from a Content-Disposition header, or a fallback. */
export function fileNameOf(header: string | null, fallback: string): string {
  const m = header ? /filename="([^"]+)"/.exec(header) : null;
  return m?.[1] ?? fallback;
}

// ---------- remembered per map (each storey is its own map) ----------

export const memoryKey = (mapId: string): string => `delve-snip:${mapId}`;

export interface SnipMemory {
  box: Bounds;
  options: SnipOptions;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 100_000;

/** The last snip of a map, from localStorage; anything malformed is ignored. */
export function parseMemory(text: string | null): SnipMemory | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as { box?: Partial<Bounds>; options?: Partial<SnipOptions> };
  const b = r?.box;
  if (!b || !isInt(b.x0) || !isInt(b.y0) || !isInt(b.x1) || !isInt(b.y1) || b.x1 <= b.x0 || b.y1 <= b.y0) return null;
  if (b.x1 - b.x0 > MAX_CROP || b.y1 - b.y0 > MAX_CROP) return null;
  const o = r.options ?? {};
  const ppg = isInt(o.ppg) && o.ppg >= 10 && o.ppg <= 300 ? o.ppg : DEFAULT_OPTIONS.ppg;
  return {
    box: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
    options: {
      ppg,
      grid: typeof o.grid === 'boolean' ? o.grid : DEFAULT_OPTIONS.grid,
      transparent: typeof o.transparent === 'boolean' ? o.transparent : DEFAULT_OPTIONS.transparent,
      revealed: typeof o.revealed === 'boolean' ? o.revealed : DEFAULT_OPTIONS.revealed,
    },
  };
}
