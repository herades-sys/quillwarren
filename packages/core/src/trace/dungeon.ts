// Tracing a dungeon or battle map picture: rooms drawn as light floor inside
// dark wall lines, often on a printed grid, with hatching or a flat colour
// outside, room numbers, doors and furniture on top. The floor becomes rooms
// and corridors (Delve draws the walls itself from the floor's edges); the wall
// lines, the hatching and everything outside are background.
//
// 1. Ink: pixels of the colours whose role is "wall". Thick ink (what survives an
//    opening a little thinner than the walls) is a wall; thin ink (grid lines,
//    text, hatching strokes, door leaves, furniture) is not.
// 2. The parts that thick ink encloses are tested: mostly floor coloured, walled
//    all round, not cut by the picture's edge, and (when the picture has a grid)
//    carrying the grid. The rest is background: the ground round the map, the
//    rock between rooms, the inside of pillars.
// 3. Holes in the floor bigger than a third of a square stay (pillars, pits);
//    smaller ones (text, symbols) are filled.
// 4. The floor grows half a wall into the walls, since a map's wall line is
//    drawn on the floor's edge. Two floors meeting inside a thin wall keep that
//    wall as a solid cutout.
// 5. Each floor area is split into rooms and corridors (rooms.ts), and outlines
//    are tidied onto the half-square grid (snap.ts).
import type { MapObject, Point } from '../schema.ts';
import { luminance } from './grid.ts';
import { close, dilate, open, open2, outlines, parts, signedArea, type Mask } from './raster.ts';
import { splitRooms } from './rooms.ts';
import { snapRing } from './snap.ts';

/** What a colour does in a dungeon picture (the trace roles, read for this mode). */
export type DungeonRole = 'floor' | 'ink' | 'terrain' | 'other';

export interface DungeonTraceOptions {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
  /** Each pixel's colour (an index into roles), 255 for none. */
  classes: Uint8Array;
  roles: readonly DungeonRole[];
  /** For terrain colours: the terrain asset. */
  terrain?: readonly (string | undefined)[];
  /** Picture pixels per square. */
  s: number;
  /** The picture pixel where square (0, 0) is: a grid line crossing, when there is a grid. */
  origin: [number, number];
  /** True when the picture has a printed grid at this scale (floors then have to show it). */
  grid?: boolean;
  /** Drop floor parts smaller than this many squares (default 0.5). */
  minArea?: number;
  /** Fill holes smaller than this many squares: text, symbols (default 0.35; bigger holes are pillars). */
  fillHoles?: number;
  /** Split the floor into rooms and corridors (default true). */
  split?: boolean;
  /** Move straight walls onto the half-square grid when they are this close (squares, default 0.2; 0: off). */
  snap?: number;
  /** The wall lines' thickness in pixels (found from the picture when left out). */
  wallWidth?: number;
  /** Filled in with the milliseconds each stage took (for the benchmark). */
  timings?: Record<string, number>;
}

export interface DungeonTraceResult {
  objects: MapObject[];
  rooms: number;
  corridors: number;
  pillars: number;
  walls: number;
  terrain: number;
  doors: number;
  /** The wall thickness found (or given), in pixels. */
  wallWidth: number;
  /** The floor (after growing into the walls), for drawing over the picture: 1 = floor. */
  floor?: Mask;
  /** Walls inside the floor (they became solid cutouts). */
  inside?: Mask;
}

type P = [number, number];

/**
 * The thickness of the wall lines in pixels: ink rows (and columns) at least `long`
 * pixels long are walls running along them; how thick those are across is the answer.
 */
export function wallThickness(ink: Uint8Array, w: number, h: number, long: number, max: number): number | null {
  const counts = new Float64Array(Math.ceil(max) + 2);
  const pass = (n: number, len: number, at: (line: number, i: number) => number) => {
    // pixels in long runs along the lines
    const along = new Uint8Array(w * h);
    for (let line = 0; line < n; line++) {
      let start = -1;
      for (let i = 0; i <= len; i++) {
        const on = i < len && ink[at(line, i)];
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if (i - start >= long) for (let k = start; k < i; k++) along[at(line, k)] = 1;
          start = -1;
        }
      }
    }
    // their thickness across
    for (let i = 0; i < len; i++) {
      let start = -1;
      for (let line = 0; line <= n; line++) {
        const on = line < n && along[at(line, i)];
        if (on && start < 0) start = line;
        if (!on && start >= 0) {
          const t = line - start;
          if (t <= max) counts[t]!++;
          start = -1;
        }
      }
    }
  };
  pass(h, w, (y, x) => y * w + x);
  pass(w, h, (x, y) => y * w + x);
  let total = 0;
  for (let t = 1; t < counts.length; t++) total += counts[t]!;
  if (total < 20) return null;
  // the median
  let acc = 0;
  for (let t = 1; t < counts.length; t++) {
    acc += counts[t]!;
    if (acc >= total / 2) return t;
  }
  return null;
}

/** For each pixel, how much it looks like a thin line along x or y (for grid evidence), only where asked. */
function thinAt(lum: Uint8Array, w: number, h: number, x: number, y: number, vertical: boolean): number {
  const c = lum[y * w + x]!;
  let best = 0;
  for (let d = 1; d <= 3; d++) {
    const ax = vertical ? x - d : x;
    const bx = vertical ? x + d : x;
    const ay = vertical ? y : y - d;
    const by = vertical ? y : y + d;
    if (ax < 0 || ay < 0 || bx >= w || by >= h) break;
    const a = lum[ay * w + ax]!;
    const b = lum[by * w + bx]!;
    const r = Math.max(Math.min(a, b) - c, c - Math.max(a, b));
    if (r > best) best = r;
  }
  return best;
}

const shiftRing = (r: readonly P[], dx: number, dy: number): P[] => r.map(([x, y]) => [x + dx, y + dy]);

/** A door leaf: a small light rectangle in an ink outline, as maps draw a closed door across a gap in the wall. */
export interface DoorLeaf {
  /** The leaf's inside, in picture pixels (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The leaf with its outline. */
  outer: [number, number, number, number];
  /** The leaf and its outline carried on along the leaf to the wall ends: what closes the gap. */
  seal: [number, number, number, number];
  /** 'x': the leaf lies along x (in a wall that runs along x). */
  along: 'x' | 'y';
}

/** Door leaves: light rectangles a quarter of a square thick, half a square to three squares long, inside an ink outline. */
export function findDoorLeaves(ink: Uint8Array, w: number, h: number, s: number): DoorLeaf[] {
  const light: Mask = { w, h, px: ink.map((v) => (v ? 0 : 1)) };
  const { labels, sizes } = parts(light, true);
  const L = sizes.length;
  const box = new Int32Array(L * 4).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (!l || sizes[l]! > 1.5 * s * s || sizes[l]! < 0.02 * s * s) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = l * 4;
    if (box[b] === -1) {
      box[b] = box[b + 2] = x;
      box[b + 1] = box[b + 3] = y;
    } else {
      if (x < box[b]!) box[b] = x;
      if (x > box[b + 2]!) box[b + 2] = x;
      if (y > box[b + 3]!) box[b + 3] = y;
    }
  }
  const e = Math.max(2, Math.round(0.07 * s));
  const out: DoorLeaf[] = [];
  for (let l = 1; l < L; l++) {
    const b = l * 4;
    if (box[b] === -1) continue;
    const [x0, y0, x1, y1] = [box[b]!, box[b + 1]!, box[b + 2]!, box[b + 3]!];
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const short = Math.min(bw, bh) / s;
    const long = Math.max(bw, bh) / s;
    if (short < 0.08 || short > 0.5 || long < 0.4 || long > 3.3 || long < 1.8 * short) continue;
    if (sizes[l]! < 0.75 * bw * bh) continue;
    // an ink outline all round: from nearly every pixel along each side, ink within e pixels outwards
    let along = 0;
    let found = 0;
    let reachOut = 0;
    const probe = (x: number, y: number, sx: number, sy: number) => {
      along++;
      for (let k = 1; k <= e; k++) {
        const xx = x + sx * k;
        const yy = y + sy * k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
        if (ink[yy * w + xx]) {
          found++;
          // how far the outline goes on: the leaf's outer edge
          let j = k;
          while (j < 3 * e && x + sx * (j + 1) >= 0 && y + sy * (j + 1) >= 0 && x + sx * (j + 1) < w && y + sy * (j + 1) < h && ink[(y + sy * (j + 1)) * w + x + sx * (j + 1)]) j++;
          if (sx || sy) reachOut = Math.max(reachOut, Math.min(j, e + 1));
          return;
        }
      }
    };
    for (let x = x0; x <= x1; x++) (probe(x, y0, 0, -1), probe(x, y1, 0, 1));
    for (let y = y0; y <= y1; y++) (probe(x0, y, -1, 0), probe(x1, y, 1, 0));
    if (found < 0.85 * along) continue;
    // the outline, and along the leaf on to the wall ends (maps leave a hair of a gap there)
    const m = Math.max(1, reachOut);
    const end = m + Math.round(0.15 * s);
    const mx = bw >= bh ? end : m;
    const my = bw >= bh ? m : end;
    out.push({ x0, y0, x1, y1, outer: [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(w - 1, x1 + m), Math.min(h - 1, y1 + m)], seal: [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(w - 1, x1 + mx), Math.min(h - 1, y1 + my)], along: bw >= bh ? 'x' : 'y' });
  }
  return out;
}

/** Cuts the bounding box of one label out of a label map, as a mask. */
function cropLabel(labels: Int32Array, w: number, box: [number, number, number, number], l: number): { mask: Mask; x0: number; y0: number } {
  const [x0, y0, x1, y1] = box;
  const mw = x1 - x0 + 1;
  const mh = y1 - y0 + 1;
  const px = new Uint8Array(mw * mh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === l) px[(y - y0) * mw + x - x0] = 1;
  return { mask: { w: mw, h: mh, px }, x0, y0 };
}

export function traceDungeon(o: DungeonTraceOptions): DungeonTraceResult {
  const { width: w, height: h, classes, s } = o;
  const n = w * h;
  const role = (i: number): DungeonRole => (classes[i]! < o.roles.length ? o.roles[classes[i]!]! : 'other');
  const ink = new Uint8Array(n);
  const floorish = new Uint8Array(n);
  const lum = luminance(o.rgba, w, h);
  // the soft edges of the walls (blur, anti-aliasing) have colours of their own: darker than halfway
  // between ink and floor counts as ink, so thin or blurred walls keep their width
  const histInk = new Float64Array(256);
  const histFloor = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    const r = role(i);
    if (r === 'ink') histInk[lum[i]!]!++;
    else if (r === 'floor') histFloor[lum[i]!]!++;
  }
  const median = (hist: Float64Array) => {
    let total = 0;
    for (const v of hist) total += v;
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]!) >= total / 2) return v;
    return -1;
  };
  const inkL = median(histInk);
  const floorL = median(histFloor);
  const mid = inkL >= 0 && floorL > inkL ? (inkL + floorL) / 2 : -1;
  for (let i = 0; i < n; i++) {
    const r = role(i);
    if (r === 'ink' || (r === 'other' && lum[i]! < mid)) ink[i] = 1;
    else if (r === 'floor' || r === 'terrain') floorish[i] = 1;
  }
  const t0 = Date.now();
  let tl = t0;
  const lap = (stage: string) => {
    if (!o.timings) return;
    const now = Date.now();
    o.timings[stage] = (o.timings[stage] ?? 0) + now - tl;
    tl = now;
  };
  // 1. walls: the ink that's about as thick as the walls
  const t = o.wallWidth ?? wallThickness(ink, w, h, Math.max(10, 0.6 * s), Math.max(4, 0.45 * s)) ?? Math.max(2, Math.round(0.12 * s));
  const rOpen = Math.max(1, Math.floor((t - 1) * 0.375));
  // (walls three pixels thin or less: a 2 × 2 opening, which still drops one-pixel strokes)
  const thick = (t <= 3.5 ? open2({ w, h, px: ink }) : open({ w, h, px: ink }, rOpen)).px;
  // the opening nicks thin walls where they run at a slant: ink right next to what survived comes back
  for (let k = 0; k < 2; k++) {
    const grown = dilate({ w, h, px: thick }, 1).px;
    for (let i = 0; i < n; i++) if (grown[i] && ink[i]) thick[i] = 1;
  }
  lap('open');
  // door leaves close their gap in the wall while the floor is looked for, so a door to the outside doesn't open the floor to it
  const leaves = findDoorLeaves(ink, w, h, s);
  const sealed = thick.slice();
  for (const d of leaves) for (let y = d.seal[1]; y <= d.seal[3]; y++) for (let x = d.seal[0]; x <= d.seal[2]; x++) sealed[y * w + x] = 1;
  lap('leaves');
  // 2. the parts thick ink encloses (4-connected, so a diagonal wall line closes them)
  const notWall: Mask = { w, h, px: sealed.map((v) => (v ? 0 : 1)) };
  const { labels, sizes } = parts(notWall, true);
  const L = sizes.length;
  const touches = new Uint8Array(L);
  const floorPx = new Float64Array(L);
  const inkPx = new Float64Array(L);
  const edge = new Float64Array(L);
  const box = new Int32Array(L * 4).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i]!;
      if (!l) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches[l] = 1;
      if (floorish[i]) floorPx[l]!++;
      if (ink[i]) inkPx[l]!++;
      if ((x > 0 && sealed[i - 1]) || (x < w - 1 && sealed[i + 1]) || (y > 0 && sealed[i - w]) || (y < h - 1 && sealed[i + w])) edge[l]!++;
      const b = l * 4;
      if (box[b] === -1) {
        box[b] = box[b + 2] = x;
        box[b + 1] = box[b + 3] = y;
      } else {
        if (x < box[b]!) box[b] = x;
        if (x > box[b + 2]!) box[b + 2] = x;
        if (y > box[b + 3]!) box[b + 3] = y;
      }
    }
  }
  lap('parts');
  // grid evidence: pixels on the grid's lines that show a thin line
  const latt = new Float64Array(L);
  const hits = new Float64Array(L);
  if (o.grid) {
    const [ox, oy] = o.origin;
    for (let gx = ox - Math.floor(ox / s) * s; gx < w; gx += s) {
      const c0 = Math.floor(gx - 0.5);
      for (let y = 0; y < h; y += 2) {
        for (const c of [c0, c0 + 1]) {
          if (c < 0 || c >= w) continue;
          const l = labels[y * w + c]!;
          if (!l) continue;
          latt[l]! += 0.5;
          if (thinAt(lum, w, h, c, y, true) >= 6) hits[l]! += 0.5;
        }
      }
    }
    for (let gy = oy - Math.floor(oy / s) * s; gy < h; gy += s) {
      const r0 = Math.floor(gy - 0.5);
      for (let x = 0; x < w; x += 2) {
        for (const r of [r0, r0 + 1]) {
          if (r < 0 || r >= h) continue;
          const l = labels[r * w + x]!;
          if (!l) continue;
          latt[l]! += 0.5;
          if (thinAt(lum, w, h, x, r, false) >= 6) hits[l]! += 0.5;
        }
      }
    }
  }
  const minPx = (o.minArea ?? 0.5) * s * s;
  const evidence = (l: number) => (latt[l]! >= 10 ? hits[l]! / latt[l]! : -1);
  const looksFloor = (l: number) =>
    sizes[l]! >= minPx && !touches[l] && floorPx[l]! >= 0.5 * sizes[l]! && edge[l]! > 0 && inkPx[l]! <= 0.3 * sizes[l]!;
  let best = 0;
  if (o.grid) for (let l = 1; l < L; l++) if (looksFloor(l) && sizes[l]! >= 4 * minPx) best = Math.max(best, evidence(l));
  const isFloor = new Uint8Array(L);
  for (let l = 1; l < L; l++) {
    if (!looksFloor(l)) continue;
    const ev = evidence(l);
    if (best >= 0.25) {
      // floors show the grid; the rock between rooms and inside pillars doesn't
      if (ev >= 0 ? ev < 0.35 * best : sizes[l]! < 1.0 * s * s) continue;
    } else if (inkPx[l]! > 0.12 * sizes[l]!) continue; // no grid to go by: hatched rock is full of strokes, a floor isn't
    isFloor[l] = 1;
  }
  if (best < 0.25) {
    // no grid to go by: a small part walled in on all four sides by one bigger floor is the inside of a pillar or pit
    for (let l = 1; l < L; l++) {
      if (!isFloor[l] || sizes[l]! > 6 * s * s) continue;
      const [x0, y0, x1, y1] = [box[l * 4]!, box[l * 4 + 1]!, box[l * 4 + 2]!, box[l * 4 + 3]!];
      const cx = (x0 + x1) >> 1;
      const cy = (y0 + y1) >> 1;
      const reach = Math.round(t + 0.6 * s);
      const look = (dx: number, dy: number, fx: number, fy: number) => {
        for (let k = 1; k <= reach; k++) {
          const x = fx + dx * k;
          const y = fy + dy * k;
          if (x < 0 || y < 0 || x >= w || y >= h) return -1;
          const m = labels[y * w + x]!;
          if (m && m !== l && isFloor[m]) return m;
        }
        return 0;
      };
      const around = [look(-1, 0, x0, cy), look(1, 0, x1, cy), look(0, -1, cx, y0), look(0, 1, cx, y1)];
      const m = around[0]!;
      if (m > 0 && around.every((v) => v === m) && sizes[m]! > 4 * sizes[l]!) isFloor[l] = 0;
    }
  }
  lap('grid');
  // doors: with floor on both sides the floor carries on under the leaf (the two sides become one part);
  // a door to the outside stays on the floor's edge
  const doorObjects: MapObject[] = [];
  // each door opening, with a floor pixel beside it (to find its part after growing) and the side the floor is on
  const openings: { at: Point; along: 'x' | 'y'; width: number; side: number; part: number; depth: number }[] = [];
  {
    const up = Int32Array.from({ length: L }, (_, i) => i);
    const find = (a: number): number => (up[a] === a ? a : (up[a] = find(up[a]!)));
    const reach = Math.max(2, Math.round(0.3 * s));
    const floorAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h && isFloor[labels[y * w + x]!] ? labels[y * w + x]! : 0);
    const fills: [DoorLeaf, number, number][] = []; // leaf, floor part, side the floor is on (-1 top or left, 1 bottom or right, 0 both)
    for (const d of leaves) {
      const cx = (d.x0 + d.x1) >> 1;
      const cy = (d.y0 + d.y1) >> 1;
      let a = 0;
      let b = 0;
      let pa = -1;
      let pb = -1;
      for (let k = 1; k <= reach && (!a || !b); k++) {
        const [axp, ayp, bxp, byp] = d.along === 'x' ? [cx, d.outer[1] - k, cx, d.outer[3] + k] : [d.outer[0] - k, cy, d.outer[2] + k, cy];
        if (!a && (a = floorAt(axp, ayp))) pa = ayp * w + axp;
        if (!b && (b = floorAt(bxp, byp))) pb = byp * w + bxp;
      }
      if (!a && !b) continue;
      if (a && b) up[find(b)] = find(a);
      fills.push([d, a || b, a && b ? 0 : a ? -1 : 1]);
      // the Delve door: on the half-square grid, as long as the gap
      const [ox, oy] = o.origin;
      const len = ((d.along === 'x' ? d.x1 - d.x0 : d.y1 - d.y0) + 1) / s;
      const width = Math.max(0.5, Math.round((len + 0.12) * 2) / 2);
      const mx = ((d.x0 + d.x1 + 1) / 2 - ox) / s;
      const my = ((d.y0 + d.y1 + 1) / 2 - oy) / s;
      const half = (v: number) => Math.round(v * 2) / 2;
      const at: Point = d.along === 'x' ? [half(mx - width / 2), half(my)] : [half(mx), half(my - width / 2)];
      doorObjects.push({ id: `d${doorObjects.length + 1}`, type: 'door', at, along: d.along, width });
      openings.push({ at, along: d.along, width, side: a && b ? 0 : a ? -1 : 1, part: a ? pa : pb, depth: Math.ceil(((d.along === 'x' ? d.outer[3] - d.outer[1] : d.outer[2] - d.outer[0]) + 1) / 2) });
    }
    for (let i = 0; i < n; i++) if (labels[i]) labels[i] = find(labels[i]!);
    for (const [d, a, side] of fills) {
      const l = find(a);
      // a door to the outside: the floor reaches the middle of the leaf (the wall line), not past it
      const cx = (d.x0 + d.x1 + 1) / 2;
      const cy = (d.y0 + d.y1 + 1) / 2;
      for (let y = d.outer[1]; y <= d.outer[3]; y++) {
        for (let x = d.outer[0]; x <= d.outer[2]; x++) {
          if (thick[y * w + x]) continue;
          const c = d.along === 'x' ? y + 0.5 - cy : x + 0.5 - cx;
          if ((side < 0 && c > 0) || (side > 0 && c < 0)) continue;
          labels[y * w + x] = l;
        }
      }
    }
  }
  lap('doors');
  // 3. the floor, with small holes (text, symbols, door leaves) filled; pillars and pits stay
  const floor = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (isFloor[labels[i]!]) floor[i] = 1;
  const holeMax = (o.fillHoles ?? 0.35) * s * s;
  {
    const notFloor: Mask = { w, h, px: floor.map((v) => (v ? 0 : 1)) };
    const holes = parts(notFloor, false);
    const owner = new Int32Array(holes.sizes.length).fill(0); // the one floor part around a hole, -1 if several or the edge
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const k = holes.labels[i]!;
        if (!k) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) owner[k] = -1;
        if (owner[k] === -1) continue;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (j < 0 || !floor[j]) continue;
          const f = labels[j]!;
          if (owner[k] === 0) owner[k] = f;
          else if (owner[k] !== f) owner[k] = -1;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const k = holes.labels[i]!;
      if (k && owner[k]! > 0 && holes.sizes[k]! < holeMax) {
        floor[i] = 1;
        labels[i] = owner[k]!;
      }
    }
  }
  lap('holes');
  // 4. a wall with floor right behind it on both sides is a wall inside the floor (between two rooms, or a
  //    partition): it stays, as a solid cutout. The other walls are the floor's edge: the floor grows half a wall into them.
  const internal = new Uint8Array(n);
  {
    // (up to 0.4 squares: rooms that close are kept apart by a wall, not by rock)
    const reachWall = Math.max(Math.ceil(t) + 1, Math.round(0.4 * s));
    const near = new Uint8Array(n); // bit per direction: floor within reach that way
    const scan = (starts: number[], step: number, len: number, bit: number) => {
      for (const start of starts) {
        let last = -Infinity;
        for (let k = 0; k < len; k++) {
          const i = start + k * step;
          if (floor[i]) last = k;
          else if (thick[i] && k - last <= reachWall) near[i]! |= bit;
        }
      }
    };
    const rows = Array.from({ length: h }, (_, y) => y * w);
    const cols = Array.from({ length: w }, (_, x) => x);
    scan(rows, 1, w, 1);
    scan(rows.map((r) => r + w - 1), -1, w, 2);
    scan(cols, w, h, 4);
    scan(cols.map((c) => c + (h - 1) * w), -w, h, 8);
    // and the wall has to run on along itself (half a square at least): the cap of a round pillar is no wall between floors
    const along = 0.5 * s;
    const runOf = (pick: (i: number) => boolean, step: number, lines: number[], len: number) => {
      for (const start of lines) {
        for (let k = 0; k < len; ) {
          if (!pick(start + k * step)) {
            k++;
            continue;
          }
          let e = k;
          while (e < len && pick(start + e * step)) e++;
          if (e - k >= along) for (let q = k; q < e; q++) internal[start + q * step] = 1;
          k = e;
        }
      }
    };
    // floor left and right: a wall running up and down; floor above and below: one running across
    runOf((i) => (near[i]! & 3) === 3, w, cols, h);
    runOf((i) => (near[i]! & 12) === 12, 1, rows, w);
  }
  lap('insideWalls');
  const grow = Math.max(0, Math.round(t / 2));
  const own = new Int32Array(n); // floor part per pixel, -1 where two meet
  for (let i = 0; i < n; i++) if (floor[i]) own[i] = labels[i]!;
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) if (own[i]! > 0) frontier.push(i);
  for (let step = 0; step < grow; step++) {
    const claim = new Map<number, number>();
    for (const i of frontier) {
      const l = own[i]!;
      if (l <= 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; // square steps: corners of straight walls stay square
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (own[j] || !thick[j] || internal[j]) continue;
          const c = claim.get(j);
          if (c === undefined) claim.set(j, l);
          else if (c !== l) claim.set(j, -1);
        }
      }
    }
    frontier = [];
    for (const [j, l] of claim) {
      own[j] = l;
      if (l > 0) frontier.push(j);
    }
  }
  lap('grow');
  // door openings: the floor runs through the whole (snapped) opening, past the wall ends that poke into it
  for (const g of openings) {
    const l = own[g.part]!;
    if (l <= 0) continue;
    const [ox, oy] = o.origin;
    const reachIn = Math.max(Math.ceil(t / 2) + 1, g.depth);
    const ax = g.at[0] * s + ox;
    const ay = g.at[1] * s + oy;
    const x0 = Math.round(g.along === 'x' ? ax : ax - (g.side <= 0 ? reachIn : 0));
    const x1 = Math.round(g.along === 'x' ? ax + g.width * s : ax + (g.side >= 0 ? reachIn : 0));
    const y0 = Math.round(g.along === 'y' ? ay : ay - (g.side <= 0 ? reachIn : 0));
    const y1 = Math.round(g.along === 'y' ? ay + g.width * s : ay + (g.side >= 0 ? reachIn : 0));
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = y * w + x;
        if (own[i]! <= 0) own[i] = l;
        internal[i] = 0;
      }
    }
  }
  // walls inside the floor (and where different parts met while growing): solid cutouts later; the floor runs under them
  const between = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (internal[i] || own[i] === -1) between[i] = 1;
  {
    // each inside wall goes to a floor part beside it, so the floor runs on under it
    let todo: number[] = [];
    for (let i = 0; i < n; i++) if (between[i] && own[i]! <= 0) todo.push(i);
    for (let pass = 0; pass < 2 * Math.ceil(t) + 4 && todo.length; pass++) {
      const set: [number, number][] = [];
      const rest: number[] = [];
      for (const i of todo) {
        const x = i % w;
        const y = (i - x) / w;
        let l = 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && own[j]! > 0) l = own[j]!;
        if (l) set.push([i, l]);
        else rest.push(i);
      }
      for (const [i, l] of set) own[i] = l;
      todo = rest;
    }
  }
  lap('inside');
  // small notches in a part's edge (where a door leaf's end meets a wall) are closed
  {
    const r = Math.max(1, Math.round(t / 2));
    const boxes = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < n; i++) {
      const l = own[i]!;
      if (l <= 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const b = boxes.get(l);
      if (!b) boxes.set(l, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
    for (const [l, b] of boxes) {
      const x0 = Math.max(0, b[0] - r - 1);
      const y0 = Math.max(0, b[1] - r - 1);
      const x1 = Math.min(w - 1, b[2] + r + 1);
      const y1 = Math.min(h - 1, b[3] + r + 1);
      const mw = x1 - x0 + 1;
      const m: Mask = { w: mw, h: y1 - y0 + 1, px: new Uint8Array(mw * (y1 - y0 + 1)) };
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (own[y * w + x] === l) m.px[(y - y0) * mw + x - x0] = 1;
      const c = close(m, r);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (c.px[(y - y0) * mw + x - x0] && !own[i] && !between[i]) own[i] = l;
        }
      }
    }
  }
  const objects: MapObject[] = [];
  let nId = 0;
  const id = (p: string) => `${p}${++nId}`;
  const out = { rooms: 0, corridors: 0, pillars: 0, walls: 0, terrain: 0, doors: doorObjects.length };
  const origin = o.origin;
  const blockedFor = (l: number) => (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false;
    const v = own[yi * w + xi]!;
    return v !== 0 && v !== l;
  };
  const snapTol = o.snap ?? 0.2;
  const ring = (r: readonly P[], l: number): Point[] => snapRing(r, { s, origin, snap: snapTol, blocked: blockedFor(l) });
  lap('notches');
  // terrain first, under the rooms in the list (it's drawn over the floor anyway)
  if (o.terrain) {
    const assets = [...new Set(o.terrain.filter((a): a is string => Boolean(a)))];
    for (const asset of assets) {
      const m: Mask = { w, h, px: new Uint8Array(n) };
      for (let i = 0; i < n; i++) if (classes[i]! < o.roles.length && o.terrain[classes[i]!] === asset) m.px[i] = 1;
      const cleaned = open(dilate(m, 2), 3);
      const ps = parts(cleaned, false);
      for (let k = 1; k < ps.sizes.length; k++) {
        if (ps.sizes[k]! < 0.5 * s * s) continue;
        const b = [w, h, 0, 0] as [number, number, number, number];
        for (let i = 0; i < n; i++) {
          if (ps.labels[i] !== k) continue;
          const x = i % w;
          const y = (i - x) / w;
          if (x < b[0]) b[0] = x;
          if (y < b[1]) b[1] = y;
          if (x > b[2]) b[2] = x;
          if (y > b[3]) b[3] = y;
        }
        const crop = cropLabel(ps.labels, w, b, k);
        for (const r of outlines(crop.mask)) {
          if (signedArea(r) <= 0) continue;
          const poly = snapRing(shiftRing(r, crop.x0, crop.y0), { s, origin, snap: snapTol });
          if (poly.length >= 3) {
            objects.push({ id: id('t'), type: 'terrain', asset, shape: { poly } });
            out.terrain++;
          }
        }
      }
    }
  }
  lap('terrain');
  // 5. rooms and corridors, per floor part
  const partBox = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < n; i++) {
    const l = own[i]!;
    if (l <= 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = partBox.get(l);
    if (!b) partBox.set(l, [x, y, x, y]);
    else {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  for (const [l, b] of partBox) {
    // the part plus the thin walls it borders (those come back as solid cutouts), one pixel round for overlap
    const x0 = Math.max(0, b[0] - 2);
    const y0 = Math.max(0, b[1] - 2);
    const x1 = Math.min(w - 1, b[2] + 2);
    const y1 = Math.min(h - 1, b[3] + 2);
    const mw = x1 - x0 + 1;
    const mh = y1 - y0 + 1;
    const mask: Mask = { w: mw, h: mh, px: new Uint8Array(mw * mh) };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (own[y * w + x] === l) mask.px[(y - y0) * mw + x - x0] = 1;
    if (mask.px.reduce((a, v) => a + v, 0) < minPx) continue;
    const near = dilate(mask, 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (between[y * w + x] && near.px[(y - y0) * mw + x - x0]) mask.px[(y - y0) * mw + x - x0] = 1;
    // holes: pillars and pits (solid when they're mostly ink)
    for (const r of outlines(mask)) {
      if (-signedArea(r) < 0.25 * s * s) continue;
      if (signedArea(r) > 0) continue;
      const poly = ring(shiftRing(r, x0, y0), l);
      if (poly.length < 3) continue;
      let inkIn = 0;
      let all = 0;
      const rb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of r) (rb[0] = Math.min(rb[0]!, x)), (rb[1] = Math.min(rb[1]!, y)), (rb[2] = Math.max(rb[2]!, x)), (rb[3] = Math.max(rb[3]!, y));
      for (let y = rb[1]!; y < rb[3]!; y++) for (let x = rb[0]!; x < rb[2]!; x++) if (!mask.px[y * mw + x]) (all++, (inkIn += ink[(y + y0) * w + x + x0]!));
      objects.push({ id: id('p'), type: 'cutout', shape: { poly }, ...(all && inkIn > 0.7 * all ? { fill: 'solid' as const } : {}) });
      out.pillars++;
    }
    const wallsIn = new Uint8Array(mw * mh);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (between[y * w + x]) wallsIn[(y - y0) * mw + x - x0] = 1;
    const split = o.split === false ? { labels: Int32Array.from(mask.px), pieces: [{ id: 1, corridor: false, width: 0 }] } : splitRooms(mask, s, { barrier: wallsIn });
    // each piece in a mask just round it (with a pixel of overlap with its neighbours, so they join without a seam)
    const pbox = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < split.labels.length; i++) {
      const id2 = split.labels[i]!;
      if (!id2) continue;
      const x = i % mw;
      const y = (i - x) / mw;
      const b = pbox.get(id2);
      if (!b) pbox.set(id2, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
    for (const piece of split.pieces) {
      const b = pbox.get(piece.id);
      if (!b) continue;
      const px0 = Math.max(0, b[0] - 2);
      const py0 = Math.max(0, b[1] - 2);
      const pw = Math.min(mw - 1, b[2] + 2) - px0 + 1;
      const ph = Math.min(mh - 1, b[3] + 2) - py0 + 1;
      const pm: Mask = { w: pw, h: ph, px: new Uint8Array(pw * ph) };
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (split.labels[(y + py0) * mw + x + px0] === piece.id) pm.px[y * pw + x] = 1;
      const grown = dilate(pm, 1);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) pm.px[y * pw + x] = grown.px[y * pw + x]! & mask.px[(y + py0) * mw + x + px0]!;
      for (const r of outlines(pm)) {
        if (signedArea(r) < 0.2 * s * s) continue; // holes come from the floor part (above)
        const poly = ring(shiftRing(r, x0 + px0, y0 + py0), l);
        if (poly.length < 3) continue;
        objects.push({ id: id('r'), type: 'room', shape: { poly }, ...(piece.corridor ? { name: 'Corridor' } : {}) });
        if (piece.corridor) out.corridors++;
        else out.rooms++;
      }
    }
  }
  lap('rooms');
  // thin walls between floor parts, as solid cutouts
  {
    const wm: Mask = { w, h, px: between };
    const ps = parts(wm, false);
    for (let k = 1; k < ps.sizes.length; k++) {
      if (ps.sizes[k]! < 0.3 * s * Math.max(2, t)) continue;
      const b = [w, h, 0, 0] as [number, number, number, number];
      for (let i = 0; i < n; i++) {
        if (ps.labels[i] !== k) continue;
        const x = i % w;
        const y = (i - x) / w;
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
      const crop = cropLabel(ps.labels, w, b, k);
      for (const r of outlines(crop.mask)) {
        if (signedArea(r) <= 0) continue;
        const poly = snapRing(shiftRing(r, crop.x0, crop.y0), { s, origin, snap: 0 });
        if (poly.length >= 3) {
          objects.push({ id: id('w'), type: 'cutout', shape: { poly }, fill: 'solid', name: 'Wall' });
          out.walls++;
        }
      }
    }
  }
  for (const d of doorObjects) objects.push({ ...d, id: id('d') });
  lap('cutouts');
  const floorOut = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (own[i] !== 0) floorOut[i] = 1;
  return { objects, ...out, wallWidth: t, floor: { w, h, px: floorOut }, inside: { w, h, px: between } };
}
