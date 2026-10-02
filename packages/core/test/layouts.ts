// Test layouts for corridors between rooms that aren't rectangles: pairs of
// shapes at different relative positions (side by side, diagonal, too close
// for an L), plus a cavern in the style of the user's "The Grotto" (shapes
// only). Pure data plus core's shape presets, so a copy of this file also runs
// against older code (the backwards-compatibility hashes in attach.test.ts).
import { shapeFromBox, type DelveMap, type MapObject, type Point, type Shape } from '../src/index.ts';

export const hex = (x: number, y: number, w: number, h: number): Shape => shapeFromBox('hexagon', [x, y, w, h]);
export const oct = (x: number, y: number, w: number, h: number): Shape => shapeFromBox('octagon', [x, y, w, h]);
export const tri = (x: number, y: number, w: number, h: number): Shape => shapeFromBox('triangle', [x, y, w, h]);
export const oval = (x: number, y: number, w: number, h: number): Shape => shapeFromBox('oval', [x, y, w, h]);
export const rect = (x: number, y: number, w: number, h: number): Shape => ({ rect: [x, y, w, h] });
export const circle = (cx: number, cy: number, r: number): Shape => ({ circle: [cx, cy, r] });
export const poly = (pts: Point[], dx = 0, dy = 0): Shape => ({ poly: pts.map(([x, y]) => [x + dx, y + dy] as Point) });

/** A freehand blob, as the Room tool's freehand mode makes them (quarter squares). */
export const BLOB: Point[] = [
  [2, 0.5],
  [4.25, 0],
  [6, 1],
  [7.25, 2.75],
  [7, 5],
  [5.5, 6.75],
  [3.25, 7.25],
  [1.25, 6.25],
  [0, 4],
  [0.5, 1.75],
];

export const pentagon = (cx: number, cy: number, r: number): Shape => ({
  poly: Array.from({ length: 5 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    return [Math.round((cx + r * Math.cos(a)) * 100) / 100, Math.round((cy + r * Math.sin(a)) * 100) / 100] as Point;
  }),
});

export interface Layout {
  name: string;
  rooms: Shape[];
  /** [from room index, to room index, width?] */
  links: [number, number, number?][];
}

export const LAYOUTS: Layout[] = [
  { name: 'hex-side-by-side', rooms: [hex(0, 0, 8, 8), hex(12, 0, 8, 8)], links: [[0, 1]] },
  { name: 'hex-wide-side', rooms: [hex(0, 0, 12, 8), hex(16, 0, 12, 8)], links: [[0, 1]] },
  { name: 'hex-diagonal', rooms: [hex(0, 0, 8, 8), hex(12, 9, 8, 8)], links: [[0, 1]] },
  { name: 'hex-stacked-offset', rooms: [hex(0, 0, 8, 8), hex(5, 12, 8, 8)], links: [[0, 1]] },
  { name: 'hex-close', rooms: [hex(0, 0, 6, 6), hex(7, 5, 6, 6)], links: [[0, 1]] },
  { name: 'oct-circle-diagonal', rooms: [oct(0, 0, 10, 10), circle(19, 19, 5)], links: [[0, 1]] },
  { name: 'oct-circle-aligned', rooms: [oct(0, 0, 10, 10), circle(22, 5, 5)], links: [[0, 1]] },
  { name: 'oct-circle-offset', rooms: [oct(0, 0, 10, 10), circle(21, 12, 4)], links: [[0, 1, 1]] },
  { name: 'oct-oct-diagonal', rooms: [oct(0, 0, 10, 10), oct(13, 13, 10, 10)], links: [[0, 1]] },
  { name: 'tri-rect-right', rooms: [tri(0, 0, 8, 8), rect(12, 2, 6, 6)], links: [[0, 1]] },
  { name: 'tri-rect-below', rooms: [tri(0, 0, 8, 8), rect(9, 11, 6, 6)], links: [[0, 1]] },
  { name: 'tri-rect-close', rooms: [tri(0, 0, 8, 8), rect(9, 7, 5, 5)], links: [[0, 1]] },
  { name: 'hex-rect-close', rooms: [hex(0, 0, 8, 8), rect(10, 9, 5, 5)], links: [[0, 1]] },
  { name: 'oct-hex-close', rooms: [oct(0, 0, 8, 8), hex(9, 7, 8, 6)], links: [[0, 1]] },
  { name: 'blob-pentagon', rooms: [poly(BLOB), pentagon(17, 6, 5)], links: [[0, 1]] },
  { name: 'blob-pentagon-diag', rooms: [poly(BLOB), pentagon(15, 17, 5)], links: [[0, 1]] },
  { name: 'circle-rect', rooms: [circle(5, 5, 5), rect(14, 8, 6, 6)], links: [[0, 1]] },
  { name: 'oval-hex', rooms: [oval(0, 0, 12, 7), hex(15, 6, 8, 8)], links: [[0, 1]] },
  {
    name: 'mixed',
    rooms: [hex(0, 0, 8, 8), oct(14, 0, 8, 8), circle(4, 18, 4), tri(13, 15, 9, 8), poly(BLOB, 28, 4), rect(28, 17, 6, 5)],
    links: [[0, 1], [0, 2], [1, 3], [2, 3], [1, 4], [3, 5], [4, 5, 1]],
  },
];

/** A map of a layout: rooms r1…, corridors c1… (outline-routed when `outline`). */
export function layoutMap(l: Layout, outline: boolean): DelveMap {
  const objects: MapObject[] = l.rooms.map((shape, i) => ({ id: `r${i + 1}`, type: 'room', shape, label: String(i + 1) }));
  l.links.forEach(([a, b, w], i) => {
    objects.push({ id: `c${i + 1}`, type: 'corridor', from: `r${a + 1}`, to: `r${b + 1}`, width: w ?? 2, ...(outline ? { route: 'outline' as const } : {}) });
  });
  return { format: 'delve.map', version: 1, id: `m_${l.name.replace(/-/g, '_')}`, name: l.name, grid: { type: 'square' }, style: { preset: 'classic-hatching' }, seed: 7, objects };
}

/**
 * A cavern like the user's "The Grotto": four polygon rooms and a cell, joined
 * the old way (three corridors routed between the rooms' boxes, two with their
 * own paths), plus doors of every style along x and y.
 */
export function grottoLike(): DelveMap {
  const objects: MapObject[] = [
    { type: 'room', id: 'r1', shape: { poly: [[4, 28], [16, 26], [30, 28], [36, 34], [34, 44], [20, 48], [8, 46], [2, 38]] }, label: '1' },
    { type: 'room', id: 'r2', shape: { poly: [[8, 6], [18, 5], [22, 10], [20, 17], [10, 18], [6, 12]] }, label: '2' },
    { type: 'room', id: 'r3', shape: { poly: [[44, 26], [56, 25], [58, 33], [52, 38], [43, 35]] }, label: '3' },
    { type: 'room', id: 'r4', shape: { poly: [[43.5, 8], [48.5, 8], [52, 11.5], [52, 16.5], [48.5, 20], [43.5, 20], [40, 16.5], [40, 11.5]] }, label: '4' },
    { type: 'room', id: 'r5', shape: { rect: [26, 6, 8, 6] }, label: '5' },
    { type: 'corridor', id: 'c1', from: 'r1', to: 'r2', width: 2 },
    { type: 'corridor', id: 'c4', from: 'r2', to: 'r5', width: 1 },
    { type: 'corridor', id: 'c5', from: 'r5', to: 'r4', width: 1 },
    { type: 'corridor', id: 'c2', width: 2, path: [[31, 31], [45, 31]] },
    { type: 'corridor', id: 'c3', width: 2, path: [[49, 19], [49, 27]] },
    { type: 'cutout', id: 'p1', shape: { rect: [12, 36, 2, 2] }, fill: 'solid' },
    { type: 'door', id: 'd1', at: [28, 12], along: 'x', width: 2, style: 'normal' },
    { type: 'door', id: 'd2', at: [34, 7], along: 'y', width: 2, style: 'double' },
    { type: 'door', id: 'd3', at: [26, 7], along: 'y', width: 1, style: 'locked' },
    { type: 'door', id: 'd4', at: [30, 6], along: 'x', width: 2, style: 'secret' },
    { type: 'door', id: 'd5', at: [52, 12.5], along: 'y', width: 2, style: 'portcullis' },
    { type: 'door', id: 'd6', at: [44, 8], along: 'x', width: 2, style: 'archway', open: true },
  ];
  return { format: 'delve.map', version: 1, id: 'm_grotto_like', name: 'Grotto-like', grid: { type: 'square' }, style: { preset: 'classic-hatching' }, seed: 33454630, objects };
}
