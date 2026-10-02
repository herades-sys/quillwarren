// Open ends and open areas: outer archways leave the band outside the walls
// (hatching, shading, the drop shadow) out in front of their gap, and opening
// objects clear their shape of it, with `walls` the wall lines too.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildScene,
  clipLinesToBox,
  collectSegment,
  computeWalls,
  countsText,
  cropFrame,
  cropScene,
  cutSegments,
  describeMap,
  floorPaths,
  handoutSvg,
  insidePolygons,
  objectBounds,
  outerArchways,
  segmentCounts,
  toDungeonScrawl,
  validateMap,
  ValidationError,
  wholeSquares,
  type DelveMap,
  type Layer,
  type MapObject,
  type Point,
  type Polygon,
  type Polyline,
  type Scene,
} from '../src/index.ts';

const mapOf = (objects: MapObject[], overrides?: Record<string, unknown>): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id: 'm1',
  name: 'Open ends',
  grid: { type: 'square' },
  seed: 7,
  roughness: 1, // straight walls, so points on them can be checked exactly
  style: { preset: 'classic-hatching', ...(overrides ? { overrides } : {}) },
  objects,
});

// Room a (x 0–6, y 0–4) with an archway out through its north wall, a normal
// door out through its west wall, and a corridor to room b whose mouth has an
// archway too (floor on both sides of that one).
const base = (): MapObject[] => [
  { id: 'a', type: 'room', name: 'Hall', shape: { rect: [0, 0, 6, 4] } },
  { id: 'b', type: 'room', name: 'Shrine', shape: { rect: [10, 0, 4, 4] } },
  { id: 'c1', type: 'corridor', from: 'a', to: 'b', width: 2 },
  { id: 'd1', type: 'door', at: [2, 0], along: 'x', width: 2, style: 'archway' },
  { id: 'd2', type: 'door', at: [0, 1], along: 'y', width: 1, style: 'normal' },
  { id: 'd3', type: 'door', at: [6, 1], along: 'y', width: 2, style: 'archway' },
];

const layer = (s: Scene, name: string): Layer | undefined => s.layers.find((l) => l.name === name);
const fills = (s: Scene, name: string): Polygon[] => {
  const l = layer(s, name);
  return l?.kind === 'fill' ? l.polygons : [];
};
const lines = (s: Scene, name: string): Polyline[] => {
  const l = layer(s, name);
  return l?.kind === 'stroke' ? l.lines : [];
};
/** Is p on one of the polylines (within 1e-6)? */
function onLines(ls: readonly Polyline[], p: Point): boolean {
  for (const l of ls) {
    const n = l.closed ? l.points.length : l.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = l.points[i]!;
      const b = l.points[(i + 1) % l.points.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) < 1e-6) return true;
    }
  }
  return false;
}

describe('open ends at outer archways', () => {
  it('finds only the archway on the outer edge, and which way is out', () => {
    const map = mapOf(base());
    const found = outerArchways(map, floorPaths(map), 1.3);
    expect(found.map((x) => x.door.id)).toEqual(['d1']);
    expect(found[0]!.out).toEqual([0, -1]); // north
  });

  it('leaves the shading and hatching out in front of an outer archway, in both views', () => {
    for (const view of ['gm', 'players'] as const) {
      const s = buildScene(mapOf(base()), { view });
      const shading = fills(s, 'shading');
      const outside = s.clips['outside-floor']!;
      // in front of the archway's gap (x 2–4 on y = 0): open
      expect(insidePolygons(shading, [3, -0.15])).toBe(false);
      expect(insidePolygons(outside, [3, -0.6])).toBe(false);
      expect(insidePolygons(outside, [3, -1.6])).toBe(false);
      // beside it the band carries on
      expect(insidePolygons(shading, [0.5, -0.15])).toBe(true);
      expect(insidePolygons(outside, [0.5, -0.6])).toBe(true);
      expect(insidePolygons(shading, [5.5, -0.15])).toBe(true);
    }
  });

  it('keeps the band at a normal door on an outer wall', () => {
    const s = buildScene(mapOf(base()));
    expect(insidePolygons(fills(s, 'shading'), [-0.15, 1.5])).toBe(true);
    expect(insidePolygons(s.clips['outside-floor']!, [-0.6, 1.5])).toBe(true);
  });

  it('changes nothing for an archway between two rooms, or for a map without archways', () => {
    const asNormal = base().map((o) => (o.id === 'd3' && o.type === 'door' ? { ...o, style: 'normal' as const } : o));
    const withArch = buildScene(mapOf(base()));
    const withDoor = buildScene(mapOf(asNormal));
    // d1 opens the north band either way; d3 (the corridor mouth) adds nothing
    expect(JSON.stringify(fills(withArch, 'shading'))).toBe(JSON.stringify(fills(withDoor, 'shading')));
    // no archway at all: the band is the plain outside band, as before
    const plain = mapOf(base().filter((o) => o.type !== 'door'));
    const s = buildScene(plain);
    expect(insidePolygons(fills(s, 'shading'), [3, -0.15])).toBe(true);
  });

  it('works with hatching off (shading only), as on the user’s Test 003', () => {
    const s = buildScene(mapOf(base(), { hatching: null }));
    expect(layer(s, 'hatching')).toBeUndefined();
    expect(insidePolygons(fills(s, 'shading'), [3, -0.15])).toBe(false);
    expect(insidePolygons(fills(s, 'shading'), [0.5, -0.15])).toBe(true);
  });

  it('keeps the wall cut at the gap and the doors as they are', () => {
    const s = buildScene(mapOf(base()));
    expect(onLines(lines(s, 'walls'), [3, 0])).toBe(false);
    expect(onLines(lines(s, 'walls'), [1, 0])).toBe(true);
    expect(onLines(lines(s, 'walls'), [5, 0])).toBe(true);
  });

  it('leaves the band alone when another room lies just beyond the archway', () => {
    const objects = [...base(), { id: 'n', type: 'room', shape: { rect: [0, -3, 6, 2] } } as MapObject];
    const map = mapOf(objects);
    expect(outerArchways(map, floorPaths(map), 1.3).map((x) => x.door.id)).toEqual([]);
    expect(insidePolygons(fills(buildScene(map), 'shading'), [3, -0.15])).toBe(true);
  });
});

describe('opening objects', () => {
  const opening = (o: Partial<Extract<MapObject, { type: 'opening' }>> = {}): MapObject => ({ id: 'o1', type: 'opening', shape: { rect: [0, 4, 3, 2] }, ...o });

  it('validates: a shape and an optional walls switch, nothing else', () => {
    expect(() => validateMap(mapOf([...base(), opening()]))).not.toThrow();
    expect(() => validateMap(mapOf([...base(), opening({ walls: true, name: 'Ledge' })]))).not.toThrow();
    expect(() => validateMap(mapOf([...base(), opening({ shape: { rect: [0, 4, -3, 2] } })]))).toThrow(/o1 \(objects\[6\]\) shape.rect\[2\]: must be greater than 0/);
    expect(() => validateMap(mapOf([...base(), { ...opening(), walls: 'yes' } as unknown as MapObject]))).toThrow(ValidationError);
    expect(() => validateMap(mapOf([...base(), { ...opening(), fill: 'solid' } as unknown as MapObject]))).toThrow(/unknown field "fill"/);
  });

  it('clears the hatching, shading and shadow inside its shape and keeps the walls', () => {
    const s = buildScene(mapOf([...base(), opening()]));
    // under the south wall (y = 4), x 0–3 is open, x 3–6 isn't
    expect(insidePolygons(fills(s, 'shading'), [1.5, 4.15])).toBe(false);
    expect(insidePolygons(fills(s, 'shading'), [4.5, 4.15])).toBe(true);
    expect(insidePolygons(s.clips['outside-floor']!, [1.5, 4.8])).toBe(false);
    expect(insidePolygons(s.clips['outside-floor']!, [4.5, 4.8])).toBe(true);
    expect(insidePolygons(fills(s, 'shadow'), [1.5, 4.1])).toBe(false);
    expect(insidePolygons(fills(s, 'shadow'), [4.5, 4.1])).toBe(true);
    expect(onLines(lines(s, 'walls'), [1.5, 4])).toBe(true);
    // never drawn itself: no layer of its own, and the rest of the picture is the same
    expect(s.layers.some((l) => l.name.includes('o1') || l.name.includes('opening'))).toBe(false);
    const without = buildScene(mapOf(base()));
    expect(s.layers.map((l) => l.name)).toEqual(without.layers.map((l) => l.name));
  });

  it('with walls, leaves the walls inside it out too, and the wall it is drawn against from outside', () => {
    const s = buildScene(mapOf([...base(), opening({ walls: true })]));
    const w = lines(s, 'walls');
    expect(onLines(w, [1.5, 4])).toBe(false);
    expect(onLines(w, [2.9, 4])).toBe(false);
    expect(onLines(w, [3.5, 4])).toBe(true);
    expect(onLines(w, [0, 3.5])).toBe(true); // the west wall stays
    expect(computeWalls(mapOf([...base(), opening({ walls: true })])).some(([a, b]) => a[1] === 4 && b[1] === 4 && Math.min(a[0], b[0]) < 3)).toBe(false);
  });

  it('keeps the side walls running along an open area that reaches into the room', () => {
    // y 3–5: the south wall (x 0–3) lies inside it; the west wall's last square (y 3–4) runs along its edge, on the floor side
    const s = buildScene(mapOf([...base(), opening({ walls: true, shape: { rect: [0, 3, 3, 2] } })]));
    const w = lines(s, 'walls');
    expect(onLines(w, [1.5, 4])).toBe(false);
    expect(onLines(w, [0, 3.5])).toBe(true);
    expect(onLines(w, [0, 2.5])).toBe(true);
  });

  it('cuts segments exactly where they cross the shape', () => {
    const ring: Point[] = [[1, -1], [3, -1], [3, 1], [1, 1]];
    expect(cutSegments([[[0, 0], [4, 0]]], [ring])).toEqual([[[0, 0], [1, 0]], [[3, 0], [4, 0]]]);
    expect(cutSegments([[[0, 5], [4, 5]]], [ring])).toEqual([[[0, 5], [4, 5]]]);
    // along an edge: kept without a floor test; gone when the ring is on the open side
    expect(cutSegments([[[0, 1], [4, 1]]], [ring])).toEqual([[[0, 1], [4, 1]]]);
    expect(cutSegments([[[0, 1], [4, 1]]], [ring], (p) => p[1] > 1)).toEqual([[[0, 1], [1, 1]], [[3, 1], [4, 1]]]);
    expect(cutSegments([[[0, 1], [4, 1]]], [ring], (p) => p[1] < 1)).toEqual([[[0, 1], [4, 1]]]);
  });

  it('is listed by describeMap, moves and undoes like any shape', () => {
    const map = mapOf([...base(), opening({ walls: true, name: 'Ledge' })]);
    const text = describeMap(map);
    expect(text).toContain('Open areas (no hatching or shading inside; never drawn themselves):');
    expect(text).toContain('o1 "Ledge": 3×2 sq at 0,4, at Hall');
    expect(text).toContain('walls inside it are left out too');
    expect(describeMap(mapOf(base()))).toContain('d1 (archway): Hall, leads outside (an open end');
    const { map: moved, inverse } = applyOps(map, [{ op: 'move', ids: ['o1'], dx: 2, dy: -1 }]);
    expect(moved.objects.find((o) => o.id === 'o1')).toMatchObject({ shape: { rect: [2, 3, 3, 2] } });
    expect(objectBounds(moved.objects.find((o) => o.id === 'o1')!, moved)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 5 });
    expect(applyOps(moved, inverse).map).toEqual(map);
    const { map: open } = applyOps(map, [{ op: 'update', id: 'o1', unset: ['walls'] }]);
    expect(open.objects.find((o) => o.id === 'o1')).not.toHaveProperty('walls');
  });

  it('comes along with the room it touches in a segment, and the .ds export leaves it out', () => {
    const map = mapOf([...base(), opening()]);
    const seg = collectSegment(map, { ids: ['a'] });
    expect(seg.objects.map((o) => o.id)).toContain('o1');
    expect(countsText(segmentCounts(seg.objects))).toContain('1 open area');
    const nodes = (m: DelveMap) => Object.keys(toDungeonScrawl(m).state.document.nodes).length;
    expect(nodes(map)).toBe(nodes(mapOf(base())));
  });
});

describe('crop frames', () => {
  const map = mapOf([...base(), { id: 'o1', type: 'opening', shape: { rect: [2, -2, 2, 2] } }]);

  it('covers the objects plus a margin, in whole squares', () => {
    expect(cropFrame(map, { around: ['a'] })).toEqual({ x0: -1, y0: -1, x1: 7, y1: 5 });
    expect(cropFrame(map, { around: ['a', 'o1'], margin: 0 })).toEqual({ x0: 0, y0: -2, x1: 6, y1: 4 });
    expect(cropFrame(map, { around: ['d1'], margin: 0.5 })).toEqual({ x0: 1, y0: -1, x1: 5, y1: 1 });
    expect(cropFrame(map, { crop: [2.5, 0, 4.7, 4] })).toEqual({ x0: 2, y0: 0, x1: 8, y1: 4 });
    // both: one frame around both
    expect(cropFrame(map, { crop: [20, 20, 1, 1], around: ['b'], margin: 0 })).toEqual({ x0: 10, y0: 0, x1: 21, y1: 21 });
    expect(cropFrame(map, {})).toBeNull();
    expect(wholeSquares({ x0: 1.0000000001, y0: 0, x1: 2.9999999999, y1: 1 })).toEqual({ x0: 1, y0: 0, x1: 3, y1: 1 });
  });

  it('names what is wrong', () => {
    expect(() => cropFrame(map, { around: ['r99'] })).toThrow(/around: no object with id "r99"/);
    expect(() => cropFrame(map, { crop: [0, 0, 0, 3] })).toThrow(/crop: \[x, y, width, height\]/);
    expect(() => cropFrame(map, { crop: [0, 0, 2000, 3] })).toThrow(/at most 1000 squares/);
  });

  it('draws exactly the frame', () => {
    const f = cropFrame(map, { around: ['a'] })!;
    expect(buildScene(map, { frame: f }).bounds).toEqual(f);
  });

  it('cuts lines exactly at a box', () => {
    const box = { x0: 0, y0: 0, x1: 4, y1: 4 };
    expect(clipLinesToBox([{ points: [[-2, 1], [2, 1], [2, 6]], closed: false }], box)).toEqual([{ points: [[0, 1], [2, 1], [2, 4]], closed: false }]);
    expect(clipLinesToBox([{ points: [[5, 5], [6, 6]], closed: false }], box)).toEqual([]);
    // in, out and in again: two pieces
    expect(clipLinesToBox([{ points: [[1, 1], [1, 6], [3, 6], [3, 1]], closed: false }], box)).toEqual([
      { points: [[1, 1], [1, 4]], closed: false },
      { points: [[3, 4], [3, 1]], closed: false },
    ]);
  });

  it('cuts a cropped scene down to the frame (cropped handouts hold only what they show)', () => {
    const f = { x0: 1, y0: -1, x1: 5, y1: 3 };
    const s = cropScene(buildScene(map, { frame: f }), f);
    for (const l of s.layers) {
      if (l.kind === 'fill') for (const p of l.polygons) for (const [x, y] of p.outer) expect(x >= 0.5 - 1e-9 && x <= 5.5 + 1e-9 && y >= -1.5 - 1e-9 && y <= 3.5 + 1e-9).toBe(true);
      if (l.kind === 'stroke') for (const line of l.lines) for (const [x, y] of line.points) expect(x >= 0.5 - 1e-9 && x <= 5.5 + 1e-9 && y >= -1.5 - 1e-9 && y <= 3.5 + 1e-9).toBe(true);
    }
    // room b (x 10–14) is gone from the floor, room a's part is there
    const floor = s.layers.find((l) => l.name === 'floor');
    expect(floor?.kind === 'fill' && insidePolygons(floor.polygons, [3, 2])).toBe(true);
    expect(floor?.kind === 'fill' && insidePolygons(floor.polygons, [12, 2])).toBe(false);
    const h = handoutSvg(map, { crop: f, paper: 'fit' });
    expect(h.svg).toContain('viewBox="1 -1 4 4"');
  });
});
