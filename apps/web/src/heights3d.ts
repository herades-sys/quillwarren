// Raised and sunken ground as three.js meshes, for the editor's 3D view
// (stack.ts) and Delve Table's (table/view3d.ts): the floor picture draped over
// the ground (core heightScene's pieces: flat ones as they are, hills and ramps
// cut along the height lattice so every post sits at its height), and sheer
// faces of rock where a piece stands above the ground beside it. The math is
// heights3d-logic.ts.
import { BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Mesh, MeshStandardMaterial, RepeatWrapping, ShapeUtils, SRGBColorSpace, Vector2, type Material } from 'three';
import type { SceneHeights, ScenePolygon } from '@delve/table';
import { faceEdges, floorUv, latticeSplit, pieceFaces, pieceHeight, surfaceParts, zipEdges } from './heights3d-logic.ts';

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Where the ground isn't the plain floor at 0: the boxes of the scene's pieces (for laying overlays over it). */
export function pieceBoxes(h: SceneHeights): Box[] {
  return (withPieces(h).pieces ?? []).map((p) => {
    const pts = p.polygons.flatMap((q) => q.outer);
    return { x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])) };
  });
}

/** The scene's ground as pieces; scenes from before the draped ground give their bands as flat pieces. */
export function withPieces(h: SceneHeights): SceneHeights {
  return h.pieces ? h : { ...h, pieces: h.bands.map((b) => ({ polygons: b.polygons, h: b.h })) };
}

/**
 * Polygons (map squares) laid over the ground: triangulated, cut along the
 * lattice where `step` is given, every corner at `heightAt` and facing up, with
 * UVs onto the floor picture over `box`. Shared corners are one vertex, so the
 * normals run smooth over hills.
 */
export function drapedGeometry(polys: readonly ScenePolygon[], heightAt: (x: number, y: number) => number, box: Box, step: number | null, only?: readonly Box[]): BufferGeometry | null {
  // `only`: cut just the triangles that reach into these boxes (the rest lie on flat ground)
  const reaches = (tri: readonly [number, number][]) => {
    if (!only) return true;
    const xs = tri.map((p) => p[0]);
    const ys = tri.map((p) => p[1]);
    const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    return only.some((o) => o.x0 <= b.x1 && b.x0 <= o.x1 && o.y0 <= b.y1 && b.y0 <= o.y1);
  };
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const seen = new Map<string, number>();
  const vert = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let i = seen.get(key);
    if (i === undefined) {
      i = pos.length / 3;
      seen.set(key, i);
      pos.push(x, heightAt(x, y), y);
      uv.push(...floorUv(x, y, box));
    }
    return i;
  };
  for (const poly of polys) {
    if (poly.outer.length < 3) continue;
    const contour = poly.outer.map(([x, y]) => new Vector2(x, y));
    const holes = poly.holes.filter((h) => h.length >= 3).map((h) => h.map(([x, y]) => new Vector2(x, y)));
    const tris = ShapeUtils.triangulateShape(contour, holes);
    const all = [...contour, ...holes.flat()];
    for (const t of tris) {
      const tri = t.map((k) => [all[k]!.x, all[k]!.y] as [number, number]);
      for (const part of step && reaches(tri) ? latticeSplit(tri, step) : [tri]) {
        const ids = part.map(([x, y]) => vert(x, y));
        for (let k = 1; k + 1 < part.length; k++) {
          const [a, b, c] = [part[0]!, part[k]!, part[k + 1]!];
          // facing up: clockwise on the map (y down) is counter-clockwise seen from above
          const turn = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (turn < 0) index.push(ids[0]!, ids[k]!, ids[k + 1]!);
          else if (turn > 0) index.push(ids[0]!, ids[k + 1]!, ids[k]!);
        }
      }
    }
  }
  if (!index.length) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** The sheer faces between pieces as one geometry, raised by `lift` like the ground (rock texture UVs: a repeat every 4 squares along and up), or null. */
export function faceGeometry(h: SceneHeights, lift = 0): BufferGeometry | null {
  const faces = pieceFaces(h);
  if (!faces.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const R = 4;
  for (const f of faces) {
    const [left, right] = faceEdges(f);
    const onLeft = new Set(left);
    for (const tri of zipEdges(left, right)) {
      for (const p of tri) {
        pos.push(p[0], p[1] + lift, p[2]);
        uv.push((onLeft.has(p) ? f.u[0] : f.u[1]) / R, p[1] / R);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ---------- rock ----------

const hash = (i: number, j: number, seed: number): number => {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Value noise that repeats every `cells` lattice cells across a tile of `size` pixels (`rows` down it, default the same). */
function tileNoise(x: number, y: number, size: number, cells: number, seed: number, rows = cells): number {
  const gx = (x / size) * cells;
  const gy = (y / size) * rows;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const w = (i: number, n = cells) => ((i % n) + n) % n;
  const v = (i: number, j: number) => hash(w(i), w(j, rows), seed);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * A seamless tile of rock drawn in code in the given tone: blocks wider than
 * tall (bedded stone, a wrapped Voronoi), each its own shade, dark joints
 * between them, a lighter lip along each block's top, mottling and grit.
 */
export function rockCanvas(tone: string, size = 256): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const v = parseInt(/^#[0-9a-f]{6}$/i.test(tone) ? tone.slice(1) : '9e9586', 16);
  const base = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  // the blocks' seeds, scattered
  const seeds: [number, number, number][] = [];
  for (let k = 0; k < 13; k++) seeds.push([hash(k, 1, 7) * size, hash(k, 2, 9) * size, hash(k, 3, 13)]);
  const wrap = (d: number) => {
    const a = ((d % size) + size) % size;
    return a > size / 2 ? a - size : a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // the joints wander: the point is pushed about by noise before it finds its block
      const wx = x + 14 * (tileNoise(x, y, size, 5, 3) - 0.5);
      const wy = y + 14 * (tileNoise(x, y, size, 5, 4) - 0.5);
      let d1 = Infinity;
      let d2 = Infinity;
      let shade = 0;
      let dyTop = 0;
      for (const [sx, sy, s] of seeds) {
        // blocks a little wider than tall: x distances count for less
        const dx = wrap(wx - sx) / 1.3;
        const dy = wrap(wy - sy);
        const d = Math.hypot(dx, dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          shade = s;
          dyTop = dy;
        } else if (d < d2) d2 = d;
      }
      const joint = d2 - d1;
      const n = 0.6 * tileNoise(x, y, size, 8, 23) + 0.4 * tileNoise(x, y, size, 32, 37);
      // weathering: faint streaks running down the face
      const streak = tileNoise(x, y, size, 48, 41, 3) * tileNoise(x, y, size, 2, 43);
      const grit = hash(x, y, 97) - 0.5;
      let k = 0.78 + 0.2 * shade + 0.22 * (n - 0.5) + 0.07 * grit - 0.12 * streak;
      if (joint < 1.6) k *= 0.55 + 0.25 * (joint / 1.6);
      else if (joint < 5 && dyTop < 0) k *= 1.07; // a block's upper rim catches the light
      const o = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = Math.max(0, Math.min(255, Math.round(base[ch]! * k)));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const rocks = new Map<string, MeshStandardMaterial>();
/** The rock material for faces in a tone (made once per tone). */
export function rockMaterial(tone: string | undefined, anisotropy = 1): MeshStandardMaterial {
  const key = tone ?? '#9e9586';
  let m = rocks.get(key);
  if (m) return m;
  const tex = new CanvasTexture(rockCanvas(key));
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  m = new MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0, side: DoubleSide });
  m.userData.shared = true; // kept across rebuilds: never disposed
  rocks.set(key, m);
  return m;
}

/**
 * Everything the heights add to a floor: the draped ground (the plain ground
 * at 0 and every piece at its height, all with the floor's material) and the
 * rock faces between them. `lift` raises the ground a hair, as the flat floor was.
 */
export function heightMeshes(h0: SceneHeights, o: { box: Box; floor: Material; lift?: number; anisotropy?: number }): Mesh[] {
  const h = withPieces(h0);
  const lift = o.lift ?? 0;
  const out: Mesh[] = [];
  const step = h.step ?? 1;
  for (const part of surfaceParts(h)) {
    const piece = part.piece >= 0 ? h.pieces![part.piece]! : null;
    const at = piece ? (x: number, y: number) => pieceHeight(h, piece, x, y) + lift : () => lift;
    const geo = drapedGeometry(part.polygons, at, o.box, piece?.grid ? step : null);
    if (!geo) continue;
    const m = new Mesh(geo, o.floor);
    m.receiveShadow = true;
    m.castShadow = Boolean(piece && (piece.grid || piece.h > 0));
    m.userData.plate = true;
    out.push(m);
  }
  const faces = faceGeometry(h, lift);
  if (faces) {
    const m = new Mesh(faces, rockMaterial(h.rock, o.anisotropy));
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.rock = true;
    out.push(m);
  }
  return out;
}
