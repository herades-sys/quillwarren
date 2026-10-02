// Splitting a traced floor into rooms and corridors. Every floor pixel gets its
// local thickness: the radius of the biggest disk inside the floor that covers
// it (worked out on a coarse copy, about six pixels per square). Within a room
// the thickness changes gently (round rooms, ovals and triangles included);
// where a corridor or doorway opens into a room it jumps. Pieces are the
// stretches of gentle change; crumbs are merged into a neighbour, and long
// narrow pieces are corridors.
import { close, distanceTransform, fillHoles, type Mask } from './raster.ts';

export interface RoomPiece {
  /** Label in `labels` (1-based). */
  id: number;
  corridor: boolean;
  /** Width in squares (twice the typical local thickness). */
  width: number;
}

export interface Split {
  /** A piece label for each pixel of the mask (0 outside it). */
  labels: Int32Array;
  pieces: RoomPiece[];
}

/** Thickness steps above this ratio between neighbouring pixels separate pieces. */
const STEP = 1.4;

/**
 * Local thickness with squares: for each pixel, half the side of the biggest
 * axis-aligned square inside the mask that covers it.
 */
export function squareThickness(m: Mask): Float32Array {
  const { w, h, px } = m;
  // distance (in rows) to the nearest 0 along each row, then the Chebyshev distance
  const row = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let d = 0;
    for (let x = 0; x < w; x++) row[y * w + x] = px[y * w + x] ? (d = d + 1) : (d = 0);
    d = 0;
    for (let x = w - 1; x >= 0; x--) {
      d = px[y * w + x] ? d + 1 : 0;
      if (d < row[y * w + x]!) row[y * w + x] = d;
    }
  }
  const cheb = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!px[i]) continue;
      // the nearest 0 k rows up or down is max(k, its distance along that row) away; outside the mask counts as 0
      let best = row[i]!;
      for (let k = 1; k < best; k++) {
        const up = y - k >= 0 ? row[(y - k) * w + x]! : 0;
        const down = y + k < h ? row[(y + k) * w + x]! : 0;
        const v = Math.max(k, Math.min(up, down));
        if (v < best) best = v;
      }
      cheb[i] = best;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = cheb[i]!;
      if (r <= 0) continue;
      if (r > out[i]!) out[i] = r;
      let dominated = false;
      for (let dy = -1; dy <= 1 && !dominated; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && cheb[yy * w + xx]! >= r + 1) {
            dominated = true;
            break;
          }
        }
      }
      if (dominated) continue;
      const k = Math.ceil(r) - 1;
      for (let yy = Math.max(0, y - k); yy <= Math.min(h - 1, y + k); yy++) {
        for (let xx = Math.max(0, x - k); xx <= Math.min(w - 1, x + k); xx++) {
          const j = yy * w + xx;
          if (out[j]! < r) out[j] = r;
        }
      }
    }
  }
  return out;
}

/**
 * Splits one connected floor area (a mask in picture pixels, `s` pixels per
 * square) into rooms and corridors.
 */
export function splitRooms(m: Mask, s: number, o: { minRoom?: number; barrier?: Uint8Array } = {}): Split {
  const f = Math.max(1, Math.round(s / 6));
  const cw = Math.ceil(m.w / f);
  const ch = Math.ceil(m.h / f);
  const cs = s / f; // coarse pixels per square
  // coarse copy: a cell is floor when most of it is (holes such as pillars filled: they don't make rooms)
  const coarse: Mask = { w: cw, h: ch, px: new Uint8Array(cw * ch) };
  const barrierCell = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let on = 0;
      let all = 0;
      let wall = 0;
      for (let y = cy * f; y < Math.min(m.h, cy * f + f); y++) {
        for (let x = cx * f; x < Math.min(m.w, cx * f + f); x++) {
          all++;
          on += m.px[y * m.w + x]!;
          if (o.barrier?.[y * m.w + x]) wall++;
        }
      }
      // walls inside the floor (a thin wall between two rooms) part rooms even when they fill only a slice of a cell
      coarse.px[cy * cw + cx] = on * 2 >= all ? 1 : 0;
      if (wall * 4 >= all) barrierCell[cy * cw + cx] = 1;
    }
  }
  // (notches a cell or two wide, where a door leaf meets a wall, are closed: they would cut the squares below)
  const solid = fillHoles(close(coarse, 1), 6 * cs * cs); // pillar-sized holes; a courtyard inside a ring of corridors stays
  for (let i = 0; i < solid.px.length; i++) if (barrierCell[i]) solid.px[i] = 0;
  const d = distanceTransform(solid, true);
  // local thickness: paint each disk that isn't inside a neighbour's disk with its radius
  const lt = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const r = d[i]!;
      if (r <= 0) continue;
      if (r > lt[i]!) lt[i] = r;
      let dominated = false;
      for (let dy = -1; dy <= 1 && !dominated; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
          if (d[yy * cw + xx]! >= r + Math.hypot(dx, dy) - 0.2) {
            dominated = true;
            break;
          }
        }
      }
      if (dominated) continue;
      const rr = r - 0.5;
      const k = Math.floor(rr);
      for (let yy = Math.max(0, y - k); yy <= Math.min(ch - 1, y + k); yy++) {
        const span = Math.floor(Math.sqrt(Math.max(0, rr * rr - (yy - y) ** 2)));
        for (let xx = Math.max(0, x - span); xx <= Math.min(cw - 1, x + span); xx++) {
          const j = yy * cw + xx;
          if (solid.px[j] && lt[j]! < r) lt[j] = r;
        }
      }
    }
  }
  // the same with squares: in front of a corridor's mouth the disks grow gradually into the room
  // (each touches both corners of the opening), squares jump right at the wall line
  const ls = squareThickness(solid);
  // pieces: neighbours with a gentle change of both thicknesses belong together (union-find)
  const parent = new Int32Array(cw * ch).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const near = (a: number, b: number) => Math.max(a, b) <= STEP * Math.min(a, b) + 0.75;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      if (!solid.px[i]) continue;
      if (x + 1 < cw && solid.px[i + 1] && near(lt[i]!, lt[i + 1]!) && near(ls[i]!, ls[i + 1]!)) join(i, i + 1);
      if (y + 1 < ch && solid.px[i + cw] && near(lt[i]!, lt[i + cw]!) && near(ls[i]!, ls[i + cw]!)) join(i, i + cw);
    }
  }
  // piece sizes and shared borders
  const root = new Int32Array(cw * ch).fill(-1);
  const ids = new Map<number, number>();
  for (let i = 0; i < cw * ch; i++) {
    if (!solid.px[i]) continue;
    const r = find(i);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    root[i] = id;
  }
  let count = ids.size;
  const area = new Float64Array(count);
  const ltSum = new Float64Array(count);
  for (let i = 0; i < cw * ch; i++) {
    if (root[i]! < 0) continue;
    area[root[i]!]!++;
    ltSum[root[i]!]! += lt[i]!;
  }
  // crumbs (smaller than about a square, or a doorway between two rooms) join the neighbour they share most border with
  const minRoom = (o.minRoom ?? 1.2) * cs * cs;
  const alias = Int32Array.from({ length: count }, (_, i) => i);
  const resolve = (a: number): number => (alias[a] === a ? a : (alias[a] = resolve(alias[a]!)));
  for (let pass = 0; pass < 8; pass++) {
    const borders = new Map<string, number>();
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        if (root[i]! < 0) continue;
        const a = resolve(root[i]!);
        for (const j of [x + 1 < cw ? i + 1 : -1, y + 1 < ch ? i + cw : -1]) {
          if (j < 0 || root[j]! < 0) continue;
          const b = resolve(root[j]!);
          if (a === b) continue;
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          borders.set(key, (borders.get(key) ?? 0) + 1);
        }
      }
    }
    const best = new Map<number, [number, number]>();
    for (const [key, n] of borders) {
      const [a, b] = key.split(',').map(Number) as [number, number];
      for (const [p, q] of [[a, b], [b, a]] as const) {
        const cur = best.get(p);
        if (!cur || n > cur[1]) best.set(p, [q, n]);
      }
    }
    let merged = false;
    const order = [...best.keys()].sort((p, q) => area[p]! - area[q]!);
    for (const p of order) {
      // a crumb: small, or a strip thinner than about half a square along a wall
      if (resolve(p) !== p || (area[p]! >= minRoom && (2 * ltSum[p]!) / area[p]! >= 0.55 * cs)) continue;
      const q = resolve(best.get(p)![0]);
      if (q === p) continue;
      alias[p] = q;
      area[q]! += area[p]!;
      ltSum[q]! += ltSum[p]!;
      merged = true;
    }
    if (!merged) break;
  }
  // final pieces, numbered from 1
  const final = new Map<number, number>();
  const coarseLabel = new Int32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    if (root[i]! < 0) continue;
    const r = resolve(root[i]!);
    let id = final.get(r);
    if (id === undefined) final.set(r, (id = final.size + 1));
    coarseLabel[i] = id;
  }
  count = final.size;
  // width and length of each piece: corridors are long and narrow
  const thick = Array.from({ length: count + 1 }, () => [] as number[]);
  const cells = new Float64Array(count + 1);
  for (let i = 0; i < cw * ch; i++) {
    const l = coarseLabel[i]!;
    if (!l) continue;
    cells[l]!++;
    thick[l]!.push(lt[i]!);
  }
  const pieces: RoomPiece[] = [];
  for (let l = 1; l <= count; l++) {
    const t = thick[l]!.sort((a, b) => a - b);
    const width = (2 * (t[Math.floor(t.length / 2)] ?? 0)) / cs;
    const areaSq = cells[l]! / (cs * cs);
    pieces.push({ id: l, width, corridor: width > 0 && width <= 2.6 && areaSq / (width * width) >= 3 });
  }
  // back to full size: each pixel takes its cell's piece, edge pixels the nearest piece
  const labels = new Int32Array(m.w * m.h);
  const queue = new Int32Array(m.w * m.h);
  let tail = 0;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (!m.px[i]) continue;
      const l = coarseLabel[Math.floor(y / f) * cw + Math.floor(x / f)]!;
      if (l) {
        labels[i] = l;
        queue[tail++] = i;
      }
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!;
    const x = i % m.w;
    const y = (i - x) / m.w;
    for (const j of [x > 0 ? i - 1 : -1, x < m.w - 1 ? i + 1 : -1, y > 0 ? i - m.w : -1, y < m.h - 1 ? i + m.w : -1]) {
      if (j >= 0 && m.px[j] && !labels[j]) {
        labels[j] = labels[i]!;
        queue[tail++] = j;
      }
    }
  }
  // a part cut off from every piece (it can happen on very thin floors) becomes one more piece
  for (let i = 0; i < labels.length; i++) {
    if (!m.px[i] || labels[i]) continue;
    const id = pieces.length + 1;
    pieces.push({ id, width: 0, corridor: false });
    let h2 = 0;
    let t2 = 0;
    queue[t2++] = i;
    labels[i] = id;
    while (h2 < t2) {
      const k = queue[h2++]!;
      const x = k % m.w;
      const y = (k - x) / m.w;
      for (const j of [x > 0 ? k - 1 : -1, x < m.w - 1 ? k + 1 : -1, y > 0 ? k - m.w : -1, y < m.h - 1 ? k + m.w : -1]) {
        if (j >= 0 && m.px[j] && !labels[j]) {
          labels[j] = id;
          queue[t2++] = j;
        }
      }
    }
  }
  return { labels, pieces };
}
