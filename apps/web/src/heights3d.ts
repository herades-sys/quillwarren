// Raised and sunken ground as three.js meshes, for the editor's 3D view
// (stack.ts) and Delve Table's (table/view3d.ts): the floor picture cut into
// plates at their heights (the same texture, mapped by position) and the faces
// between them, sheer for cliffs and steps, leaning for slopes and rock faces.
// The math is heights3d-logic.ts.
import { BufferGeometry, Float32BufferAttribute, Mesh, Path, Shape, ShapeGeometry, Vector2, type Material } from 'three';
import type { SceneHeights, ScenePolygon } from '@delve/table';
import { edgeQuads, floorUv, quadPositions } from './heights3d-logic.ts';

type Box = { x0: number; y0: number; x1: number; y1: number };
export type FaceKind = SceneHeights['edges'][number]['kind'];

/** Flat polygons (map squares) lying on y = 0, facing up, with UVs onto the floor picture over `box`. */
export function plateGeometry(polys: readonly ScenePolygon[], box: Box): ShapeGeometry | null {
  const shapes = polys
    .filter((p) => p.outer.length >= 3)
    .map((p) => {
      // shape y is minus map y: turned down onto the floor it lands on world z = map y, facing up
      const s = new Shape(p.outer.map(([x, y]) => new Vector2(x, -y)));
      for (const hole of p.holes) if (hole.length >= 3) s.holes.push(new Path(hole.map(([x, y]) => new Vector2(x, -y))));
      return s;
    });
  if (!shapes.length) return null;
  const geo = new ShapeGeometry(shapes);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) uv.set(floorUv(pos.getX(i), pos.getZ(i), box), i * 2);
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return geo;
}

/** The faces of these kinds as one geometry, or null. */
export function faceGeometry(h: SceneHeights, kinds: readonly FaceKind[]): BufferGeometry | null {
  const quads = h.edges.filter((e) => kinds.includes(e.kind)).flatMap(edgeQuads);
  if (!quads.length) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(quadPositions(quads), 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Everything the heights add to a floor: the plates (base at 0, each band at
 * its height, all with the floor's material) and the faces (`faces` gives each
 * kind its material). `lift` raises the plates a hair, as the flat floor was.
 */
export function heightMeshes(h: SceneHeights, o: { box: Box; floor: Material; faces: Record<FaceKind, Material>; lift?: number }): Mesh[] {
  const lift = o.lift ?? 0;
  const out: Mesh[] = [];
  const plate = (polys: readonly ScenePolygon[], y: number) => {
    const geo = plateGeometry(polys, o.box);
    if (!geo) return;
    const m = new Mesh(geo, o.floor);
    m.position.y = y + lift;
    m.receiveShadow = true;
    m.userData.plate = true;
    out.push(m);
  };
  plate(h.base, 0);
  for (const b of h.bands) plate(b.polygons, b.h);
  for (const kind of ['cliff', 'rock', 'slope', 'step'] as const) {
    const geo = faceGeometry(h, [kind]);
    if (!geo) continue;
    const m = new Mesh(geo, o.faces[kind]);
    m.castShadow = true;
    m.receiveShadow = true;
    out.push(m);
  }
  return out;
}
