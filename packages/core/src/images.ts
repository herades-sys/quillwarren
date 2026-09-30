// Uploaded pictures placed on a map (the `image` object): where one sits, what
// it covers, and how big it starts out. The files themselves live on the
// server at /api/v1/images/<src>; a map keeps only the content-hash name.
import type { Bounds } from './geometry/shapes.ts';
import type { MapImage, Point } from './schema.ts';

type Placed = Pick<MapImage, 'at' | 'w' | 'h' | 'rotation'>;

/** Where browsers (and the server's PNG export) fetch an uploaded picture. */
export const imageUrl = (src: string): string => `/api/v1/images/${src}`;

/** Size in squares for a picture of pw × ph pixels: its longer side `long` squares, proportions kept. */
export function imageFit(pw: number, ph: number, long = 2): { w: number; h: number } {
  if (!(pw > 0) || !(ph > 0)) return { w: long, h: long };
  const r = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
  return pw >= ph ? { w: long, h: r((long * ph) / pw) } : { w: r((long * pw) / ph), h: long };
}

/** Half the width and height of the box a w × h rectangle covers when turned by deg (exact for quarter turns). */
function halfBox(w: number, h: number, deg: number): [number, number] {
  const q = (((deg % 360) + 360) % 360) / 90;
  if (Number.isInteger(q)) return q % 2 ? [h / 2, w / 2] : [w / 2, h / 2];
  const c = Math.abs(Math.cos((deg * Math.PI) / 180));
  const s = Math.abs(Math.sin((deg * Math.PI) / 180));
  return [(w * c + h * s) / 2, (w * s + h * c) / 2];
}

/** The box a (turned) picture covers. */
export function imageBounds(o: Placed): Bounds {
  const [hw, hh] = halfBox(o.w, o.h, o.rotation ?? 0);
  return { x0: o.at[0] - hw, y0: o.at[1] - hh, x1: o.at[0] + hw, y1: o.at[1] + hh };
}

/** Whether p lies on the picture itself (turned with it), or within tol squares of its edge. */
export function onImage(o: Placed, p: Point, tol = 0): boolean {
  const a = (-(o.rotation ?? 0) * Math.PI) / 180;
  const dx = p[0] - o.at[0];
  const dy = p[1] - o.at[1];
  // turn the point back into the picture's own frame
  const x = dx * Math.cos(a) - dy * Math.sin(a);
  const y = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(x) <= o.w / 2 + tol && Math.abs(y) <= o.h / 2 + tol;
}

/**
 * Where a picture of w × h squares turned by rotation goes for pointer p: like a
 * prop, the top-left corner of the box it covers snaps to the grid (step squares).
 */
export function imageCentre(p: Point, w: number, h: number, rotation: number, step: number): Point {
  const [hw, hh] = halfBox(w, h, rotation);
  const snap = (v: number) => Math.round(v / step) * step;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r(snap(p[0] - hw) + hw), r(snap(p[1] - hh) + hh)];
}
