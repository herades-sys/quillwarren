// Painting props along a path: the editor's Shift-drag brush and MCP's
// add_props_along. Regular placement drops a copy exactly every `spacing`
// squares; irregular varies the gaps, strays to the sides and turns and sizes
// each copy a little, so a row of trees reads as a wood rather than a hedge.
import { rng } from './render/rng.ts';
import type { Point } from './schema.ts';

export interface ScatterOptions {
  /** Squares between copies along the path. */
  spacing: number;
  placement: 'regular' | 'irregular';
  /** Irregular: how far a copy may stray to either side of the path, in squares. */
  spread?: number;
  /** Same seed and path, same result: the preview and the placed props agree. */
  seed: number;
  /** Regular: the rotation of every copy. */
  rotation?: number;
  /** Spots already taken (e.g. props of the same kind): no copy lands nearer than 0.6 × spacing to one. */
  avoid?: readonly Point[];
}

export interface Placement {
  at: Point;
  rotation: number;
  scale: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function scatterAlong(path: readonly Point[], o: ScatterOptions): Placement[] {
  if (!path.length) return [];
  const spacing = Math.max(0.25, o.spacing);
  const rand = rng(o.seed);
  const irregular = o.placement === 'irregular';
  const spread = irregular ? Math.max(0, o.spread ?? spacing * 0.35) : 0;
  const keepOff = spacing * 0.6;
  const taken: Point[] = [...(o.avoid ?? [])];
  const out: Placement[] = [];
  const place = (p: Point, nx: number, ny: number) => {
    const off = irregular ? (rand() - 0.5) * 2 * spread : 0;
    const rotation = irregular ? Math.round(rand() * 360) % 360 : (o.rotation ?? 0);
    const scale = irregular ? Math.round((0.8 + rand() * 0.4) * 20) / 20 : 1;
    const at: Point = [r2(p[0] + nx * off), r2(p[1] + ny * off)];
    if (taken.some((t) => Math.hypot(t[0] - at[0], t[1] - at[1]) < keepOff)) return;
    taken.push(at);
    out.push({ at, rotation, scale });
  };

  place(path[0]!, 0, 0);
  let next = irregular ? spacing * (0.65 + rand() * 0.7) : spacing;
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    // the path's normal here, for straying to the sides
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    while (walked + len >= next) {
      const t = (next - walked) / len;
      place([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], nx, ny);
      next += irregular ? spacing * (0.65 + rand() * 0.7) : spacing;
    }
    walked += len;
  }
  return out;
}
