// Corridors between rooms that aren't rectangles (Corridor.route "outline",
// geometry/attach.ts), the doors connect puts in their mouths (turned in
// slanted walls, through geometry/doors.ts) and rerouting older corridors.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  autoRoute,
  computeFloor,
  computeWalls,
  connectOps,
  corridorPath,
  corridorRoute,
  doorBetween,
  doorCentre,
  doorSegment,
  floorArea,
  isTurned,
  mouthDoor,
  outlineRoute,
  pointInShape,
  rerouteOps,
  roomsById,
  segmentLength,
  shapeArea,
  shapeBounds,
  shapePath,
  validateMap,
  type DelveMap,
  type Door,
  type Point,
  type Polygon,
  type Shape,
} from '../src/index.ts';
import { fingerprint } from './compat-hash.ts';
import { testMap } from './fixtures.ts';
import { circle, grottoLike, hex, LAYOUTS, layoutMap, oct, rect, tri } from './layouts.ts';

const ring = (s: Shape): Point[] => shapePath(s).map((p) => [p.x, p.y] as Point);
const distToSeg = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
/** How far p lies from the shape's outline. */
const offOutline = (s: Shape, p: Point): number => {
  const r = ring(s);
  return Math.min(...r.map((a, i) => distToSeg(p, a, r[(i + 1) % r.length]!)));
};
const area = (r: readonly Point[]): number => {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i]![0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * r[i]![1];
  return Math.abs(s) / 2;
};

/** Everything that would read as a flaw in the floor: tiny pieces or holes, slivers of edge, spikes (of floor or of rock). */
function flaws(floor: readonly Polygon[]): string[] {
  const out: string[] = [];
  for (const p of floor) {
    if (area(p.outer) < 0.5) out.push(`tiny floor piece ${area(p.outer)}`);
    for (const h of p.holes) if (area(h) < 0.5) out.push(`tiny hole ${area(h)} at ${h[0]}`);
    for (const r of [p.outer, ...p.holes]) {
      for (let i = 0; i < r.length; i++) {
        const a = r[(i - 1 + r.length) % r.length]!;
        const b = r[i]!;
        const c = r[(i + 1) % r.length]!;
        const u = [a[0] - b[0], a[1] - b[1]];
        const v = [c[0] - b[0], c[1] - b[1]];
        const lu = Math.hypot(u[0]!, u[1]!);
        const lv = Math.hypot(v[0]!, v[1]!);
        if (lv < 0.02) out.push(`sliver of an edge at ${b} (${lv})`);
        const deg = (Math.acos(Math.max(-1, Math.min(1, (u[0]! * v[0]! + u[1]! * v[1]!) / (lu * lv)))) * 180) / Math.PI;
        if (deg < 40) out.push(`spike of ${deg.toFixed(1)}° at ${b}`);
      }
    }
  }
  return out;
}

describe('corridors to the real outline', () => {
  it('meets rooms of every shape on their outline, from inside one to inside the other', () => {
    for (const l of LAYOUTS) {
      const map = layoutMap(l, true);
      const rooms = roomsById(map);
      for (const c of map.objects) {
        if (c.type !== 'corridor') continue;
        const route = corridorRoute(c, rooms);
        expect(route, `${l.name} ${c.id}`).not.toBeNull();
        const [a, b] = [rooms.get(c.from!)!.shape, rooms.get(c.to!)!.shape];
        const { path, mouths } = route!;
        // (on a straight wall along the grid the end sits right on the wall, like a box room's corridor)
        const within = (s: Shape, p: Point) => pointInShape(s, p) || offOutline(s, p) < 1e-9;
        expect(within(a, path[0]!), `${l.name} ${c.id} starts in its room`).toBe(true);
        expect(within(b, path.at(-1)!), `${l.name} ${c.id} ends in its room`).toBe(true);
        // each mouth's corners lie on its room's outline, a corridor's width apart across it
        mouths.forEach(([p, q], i) => {
          const s = i === 0 ? a : b;
          expect(offOutline(s, p), `${l.name} ${c.id} mouth ${i}`).toBeLessThan(1e-5);
          expect(offOutline(s, q), `${l.name} ${c.id} mouth ${i}`).toBeLessThan(1e-5);
          const end = i === 0 ? [path[0]!, path[1]!] : [path.at(-1)!, path.at(-2)!];
          const len = Math.hypot(end[1]![0] - end[0]![0], end[1]![1] - end[0]![1]);
          const n = [-(end[1]![1] - end[0]![1]) / len, (end[1]![0] - end[0]![0]) / len];
          expect(Math.abs((q[0] - p[0]) * n[0]! + (q[1] - p[1]) * n[1]!)).toBeCloseTo(c.width, 5);
        });
        // the end reaches into the room by less than the corridor's width
        expect(offOutline(a, path[0]!), `${l.name} ${c.id}`).toBeLessThan(c.width);
        expect(offOutline(b, path.at(-1)!), `${l.name} ${c.id}`).toBeLessThan(c.width);
      }
    }
  });

  it('joins the floor seamlessly: one piece, no slivers, spikes, notches or tiny holes', () => {
    for (const l of LAYOUTS) {
      const map = layoutMap(l, true);
      const floor = computeFloor(map);
      expect(floor.length, l.name).toBe(1);
      expect(flaws(floor), l.name).toEqual([]);
      // corridors only ever add floor: every room is still whole
      const rooms = l.rooms.reduce((s, r) => s + shapeArea(r), 0);
      expect(floorArea(map)).toBeGreaterThan(rooms);
    }
  });

  it('leaves the floor flawed where the old box routing met slanted walls (the regression)', () => {
    // the octagon's diagonal side and the hexagon's point: the old route stops at the bounding box
    const bad = ['hex-diagonal', 'oct-circle-diagonal', 'blob-pentagon-diag'].filter((n) => {
      const map = layoutMap(LAYOUTS.find((l) => l.name === n)!, false);
      return computeFloor(map).length > 1 || flaws(computeFloor(map)).length > 0;
    });
    expect(bad.length).toBeGreaterThan(0);
  });

  it('meets a hexagon point on, an octagon side square on, and a circle radially', () => {
    // two hexagons side by side: straight between their points, on the half-square grid
    expect(outlineRoute(hex(0, 0, 8, 8), hex(12, 0, 8, 8), 2)!.path).toEqual([
      [7.4, 4],
      [12.6, 4],
    ]);
    // octagon to a circle straight east: square off the octagon's side, into the circle's east... west point
    const oc = outlineRoute(oct(0, 0, 10, 10), circle(22, 5, 5), 2)!;
    expect(oc.path.map((p) => p[1])).toEqual([5, 5]);
    expect(oc.path[0]![0]).toBe(10);
    const [p, q] = oc.mouths[1];
    expect(Math.hypot(p[0] - 22, p[1] - 5)).toBeLessThanOrEqual(5);
    expect(Math.abs(p[1] - 5)).toBeCloseTo(1, 6);
    expect(Math.abs(q[1] - 5)).toBeCloseTo(1, 6);
    // octagon to octagon diagonally: one 45° run between their diagonal sides
    const oo = outlineRoute(oct(0, 0, 10, 10), oct(13, 13, 10, 10), 2)!.path;
    expect(oo.length).toBe(2);
    expect(oo[1]![0] - oo[0]![0]).toBeCloseTo(oo[1]![1] - oo[0]![1], 6);
    // a triangle's point straight on: the corridor runs into it
    const tp = outlineRoute(oct(14, 0, 8, 8), tri(13, 15, 9, 8), 2)!.path;
    expect(tp).toEqual([
      [17.5, 8],
      [17.5, 16.877778],
    ]);
  });

  it('squares off a slanted wall with a stub before turning onto the grid', () => {
    // out of the circle's south-east face square to it, then along the grid into the box
    const path = outlineRoute(circle(5, 5, 5), rect(14, 8, 6, 6), 2)!.path;
    expect(path.length).toBe(3);
    expect(path[1]![0] - path[0]![0]).toBeCloseTo(path[1]![1] - path[0]![1], 6); // radial, at 45°
    expect(path[1]).toEqual([10, 10]); // the bend on the half-square grid
    expect(path[2]).toEqual([14, 10]); // straight into the box's west wall
    // a hexagon's slanted side, squared off, then the grid: the stub leaves square to that side
    const hs = outlineRoute(hex(0, 0, 12, 8), rect(9, 12, 6, 4), 2)!.path;
    for (const p of hs.slice(1, -1)) for (const v of p) expect(Math.abs(v * 2 - Math.round(v * 2)) < 1e-6 || p === hs[1]).toBe(true);
  });

  it('keeps the box route for two rectangles, and for corridors made before', () => {
    const a = rect(0, 0, 6, 6);
    const b = rect(10, 8, 6, 6);
    const map: DelveMap = {
      ...layoutMap({ name: 'rects', rooms: [a, b], links: [[0, 1]] }, true),
    };
    const c = map.objects.find((o) => o.type === 'corridor')!;
    expect(corridorPath(c as never, roomsById(map))).toEqual(autoRoute(shapeBounds(a), shapeBounds(b), 2));
    // an old corridor (no route) between polygons keeps routing between the boxes
    const old = layoutMap(LAYOUTS[0]!, false);
    const oc = old.objects.find((o) => o.type === 'corridor')!;
    expect(corridorPath(oc as never, roomsById(old))).toEqual(autoRoute(shapeBounds(LAYOUTS[0]!.rooms[0]!), shapeBounds(LAYOUTS[0]!.rooms[1]!), 2));
  });

  it('gives null for rooms that overlap', () => {
    expect(outlineRoute(hex(0, 0, 8, 8), hex(4, 2, 8, 8), 2)).toBeNull();
    expect(outlineRoute(circle(5, 5, 5), oct(6, 0, 8, 8), 2)).toBeNull();
  });

  it('is quick enough to follow a room being dragged', () => {
    const t0 = performance.now();
    for (let dx = 0; dx < 20; dx++) outlineRoute(hex(0, 0, 8, 8), oct(14 + dx * 0.5, 9, 10, 10), 2);
    expect((performance.now() - t0) / 20).toBeLessThan(40);
  });
});

describe('doors across corridor mouths', () => {
  it('are old-style on walls along the grid and turned in slanted walls, spanning the mouth', () => {
    for (const [a, b] of [
      [hex(0, 0, 8, 8), oct(13, 13, 10, 10)],
      [oct(0, 0, 10, 10), circle(22, 5, 5)],
      [tri(0, 0, 8, 8), rect(12, 2, 6, 6)],
    ] as [Shape, Shape][]) {
      const route = outlineRoute(a, b, 2)!;
      for (const mouth of route.mouths) {
        const d = { id: 'd', type: 'door', ...mouthDoor(mouth) } as Door;
        const [p, q] = doorSegment(d);
        const same = (x: Point, y: Point) => Math.hypot(x[0] - y[0], x[1] - y[1]) < 1e-3;
        expect((same(p, mouth[0]) && same(q, mouth[1])) || (same(p, mouth[1]) && same(q, mouth[0]))).toBe(true);
        const axis = Math.abs(mouth[0][0] - mouth[1][0]) < 1e-9 || Math.abs(mouth[0][1] - mouth[1][1]) < 1e-9;
        expect(isTurned(d)).toBe(!axis);
      }
    }
    // the same thing doorBetween makes, old-style where it can be
    expect(mouthDoor([[2, 6], [4, 6]])).toEqual(doorBetween([2, 6], [4, 6], false));
    expect(mouthDoor([[2, 6], [4, 6]])).toEqual({ at: [2, 6], along: 'x', width: 2 });
  });

  // (doorBetween rounds a width to 1e-4, so a turned door's end may reach a hair into the wall beside the mouth: its slot then takes out that hair)
  it('cut no wall: across a mouth there is none, so the walls stay as they are', () => {
    for (const l of LAYOUTS) {
      const map = layoutMap(l, true);
      const rooms = roomsById(map);
      const doors: Door[] = [];
      for (const c of map.objects) {
        if (c.type !== 'corridor') continue;
        corridorRoute(c, rooms)!.mouths.forEach((m, i) => doors.push({ id: `d${c.id}${i}`, type: 'door', ...mouthDoor(m), style: 'normal' }));
      }
      const length = (m: DelveMap) => computeWalls(m).reduce((sum, w) => sum + segmentLength(w), 0);
      expect(length({ ...map, objects: [...map.objects, ...doors] }), l.name).toBeCloseTo(length(map), 2);
    }
  });
});

describe('connect and reroute', () => {
  it('connects odd shapes with doors in the walls they meet', () => {
    const map: DelveMap = { ...layoutMap({ name: 'x', rooms: [hex(0, 0, 8, 8), oct(13, 13, 10, 10)], links: [] }, true) };
    const plan = connectOps(map, 'r1', 'r2', { doors: 'both' });
    expect(plan.corridor.route).toBe('outline');
    const after = applyOps(map, plan.ops).map;
    const doors = after.objects.filter((o): o is Door => o.type === 'door');
    expect(doors.length).toBe(2);
    // the octagon's diagonal side: a turned door, across the corridor's mouth on that wall
    const slanted = doors.filter(isTurned);
    expect(slanted.length).toBeGreaterThan(0);
    const route = corridorRoute(plan.corridor, roomsById(after))!;
    doors.forEach((d, i) => {
      const [a, b] = doorSegment(d);
      const [p, q] = route.mouths[i]!;
      const same = (x: Point, y: Point) => Math.hypot(x[0] - y[0], x[1] - y[1]) < 1e-3;
      expect((same(a, p) && same(b, q)) || (same(a, q) && same(b, p))).toBe(true);
    });
    expect(validateMap(after)).toBe(after);
  });

  it('keeps rectangle doors where they were', () => {
    const { map } = applyOps(layoutMap({ name: 'x', rooms: [rect(0, 0, 6, 6), rect(0, 10, 8, 6)], links: [] }, true), []);
    const plan = connectOps(map, 'r1', 'r2', { doors: 'both' });
    const doors = applyOps(map, plan.ops).map.objects.filter((o): o is Door => o.type === 'door');
    expect(doors.map(({ at, along, width, angle }) => ({ at, along, width, angle }))).toEqual([
      { at: [2, 6], along: 'x', width: 2, angle: undefined },
      { at: [2, 10], along: 'x', width: 2, angle: undefined },
    ]);
  });

  it('reroutes the Grotto: old corridors and hand-made paths meet the real outlines, in one undo step', () => {
    const map = grottoLike();
    const before = flaws(computeFloor(map));
    const plan = rerouteOps(map);
    expect(plan.skipped).toEqual([]);
    expect(plan.rerouted.map((r) => `${r.id} ${r.from}-${r.to}`)).toEqual(['c1 r1-r2', 'c4 r2-r5', 'c5 r5-r4', 'c2 r1-r3', 'c3 r4-r3']);
    const { map: after, inverse } = applyOps(map, plan.ops);
    for (const c of after.objects) {
      if (c.type !== 'corridor') continue;
      expect(c.route).toBe('outline');
      expect(c.path).toBeUndefined();
    }
    expect(computeFloor(after).length).toBe(1);
    expect(flaws(computeFloor(after))).toEqual([]);
    expect(computeFloor(map).length > 1 || before.length > 0).toBe(true);
    // undo puts every corridor back as it was
    expect(applyOps(after, inverse).map).toEqual(map);
    // nothing left to do the second time
    expect(rerouteOps(after).ops).toEqual([]);
  });

  it('moves the doors across a corridor end to the new mouth, and reports what it cannot do', () => {
    const map = layoutMap({ name: 'x', rooms: [hex(0, 0, 8, 8), oct(13, 13, 10, 10)], links: [[0, 1]] }, false);
    const old = corridorPath(map.objects.find((o) => o.type === 'corridor') as never, roomsById(map))!;
    // a door at each old end, as connect used to put them
    const ends = [
      { id: 'd1', type: 'door', ...doorBetween(...endMouth(old, 0), false), style: 'locked' },
      { id: 'd2', type: 'door', ...doorBetween(...endMouth(old, 1), false), style: 'normal', open: true },
    ] as Door[];
    const withDoors = { ...map, objects: [...map.objects, ...ends] };
    const plan = rerouteOps(withDoors, ['c1', 'c9']);
    expect(plan.skipped).toEqual([{ id: 'c9', reason: 'no corridor with id "c9"' }]);
    expect(plan.rerouted[0]!.doors.sort()).toEqual(['d1', 'd2']);
    const after = applyOps(withDoors, plan.ops).map;
    const route = corridorRoute(after.objects.find((o) => o.type === 'corridor') as never, roomsById(after))!;
    for (const [i, id] of ['d1', 'd2'].entries()) {
      const d = after.objects.find((o): o is Door => o.id === id)!;
      const m = doorCentre(d);
      const [p, q] = route.mouths[i]!;
      expect(Math.hypot(m[0] - (p[0] + q[0]) / 2, m[1] - (p[1] + q[1]) / 2)).toBeLessThan(1e-4);
    }
    expect(after.objects.find((o): o is Door => o.id === 'd2')!.open).toBe(true);
    // a corridor that leads nowhere is left alone
    const lone = { ...map, objects: [map.objects[0]!, { id: 'c1', type: 'corridor', width: 2, path: [[30, 30], [40, 30]] }] } as DelveMap;
    expect(rerouteOps(lone).skipped).toEqual([{ id: 'c1', reason: "it doesn't run between two rooms" }]);
  });
});

describe('backwards compatibility', () => {
  // Fingerprints taken from the code before outline routing and slanted doors
  // (compat-hash.ts: every style in both views, walls, describeMap, .ds export).
  const BEFORE: Record<string, string> = {
    'test-map-4p': 'af261e79108f96cd',
    'grotto-like': 'e255ce538fa24b86',
    'hex-side-by-side': '8a78fce7de42a035',
    'hex-diagonal': '5a2bbc1e9ebad95f',
    'oct-circle-diagonal': 'dd764cebc78a07ad',
    'tri-rect-right': '721d740fba678f08',
    'blob-pentagon': '1a922ae79d4163f6',
    'circle-rect': '828d290251dc639c',
    mixed: 'c5c6135d724ab353',
  };

  it('draws maps made before exactly as before: their corridors, doors and walls', () => {
    expect(fingerprint(testMap())).toBe(BEFORE['test-map-4p']);
    expect(fingerprint(grottoLike())).toBe(BEFORE['grotto-like']);
    for (const l of LAYOUTS) if (BEFORE[l.name]) expect(fingerprint(layoutMap(l, false)), l.name).toBe(BEFORE[l.name]);
  });
});

/** The mouth across an old box route's end (where connect used to put a door). */
function endMouth(path: readonly Point[], i: 0 | 1): [Point, Point] {
  const [p, q] = i === 0 ? [path[0]!, path[1]!] : [path.at(-1)!, path.at(-2)!];
  return p[0] === q[0]
    ? [
        [p[0] - 1, p[1]],
        [p[0] + 1, p[1]],
      ]
    : [
        [p[0], p[1] - 1],
        [p[0], p[1] + 1],
      ];
}
