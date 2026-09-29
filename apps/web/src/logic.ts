// Pure viewer logic (no DOM), so it can be unit-tested.
import type { Bounds, Op } from '@delve/core';

/** Ids of objects an op batch added, changed or moved (deleted ones are gone, nothing to show). */
export function changedIds(ops: readonly Op[]): string[] {
  const out = new Set<string>();
  const walk = (list: readonly Op[]) => {
    for (const op of list) {
      if (op.op === 'add') out.add(op.object.id);
      else if (op.op === 'update') out.add(op.id);
      else if (op.op === 'move') op.ids.forEach((id) => out.add(id));
      else if (op.op === 'batch') walk(op.ops);
    }
  };
  walk(ops);
  return [...out];
}

/** Area an object covers, for zooming to it and highlighting it (now shared from core). */
export { objectBounds } from '@delve/core';

export function unionBounds(list: readonly (Bounds | null)[]): Bounds | null {
  const bs = list.filter((b): b is Bounds => b !== null);
  if (!bs.length) return null;
  return {
    x0: Math.min(...bs.map((b) => b.x0)),
    y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)),
    y1: Math.max(...bs.map((b) => b.y1)),
  };
}

export function pad(b: Bounds, by: number): Bounds {
  return { x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by };
}

/**
 * Zoom a view box by `factor` (>1 zooms out) keeping map point p fixed on
 * screen. Width stays between minW squares and maxW squares.
 */
export function zoomAt(vb: Bounds, p: [number, number], factor: number, minW: number, maxW: number): Bounds {
  const w = vb.x1 - vb.x0;
  const f = Math.min(Math.max(factor, minW / w), maxW / w);
  return {
    x0: p[0] - (p[0] - vb.x0) * f,
    y0: p[1] - (p[1] - vb.y0) * f,
    x1: p[0] + (vb.x1 - p[0]) * f,
    y1: p[1] + (vb.y1 - p[1]) * f,
  };
}

export const lerpBounds = (a: Bounds, b: Bounds, t: number): Bounds => ({
  x0: a.x0 + (b.x0 - a.x0) * t,
  y0: a.y0 + (b.y0 - a.y0) * t,
  x1: a.x1 + (b.x1 - a.x1) * t,
  y1: a.y1 + (b.y1 - a.y1) * t,
});

export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** "just now", "12 s ago", "3 min ago". */
export function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function countOps(ops: readonly Op[]): number {
  return ops.reduce((n, op) => n + (op.op === 'batch' ? countOps(op.ops) : 1), 0);
}
