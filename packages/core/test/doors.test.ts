// Doors at any angle: the turned door's gap in slanted, curved and rough walls,
// snapping onto a wall, the players' view of turned secret doors, and old maps
// (doors without an angle) drawing and exporting exactly as before.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildScene,
  computeFloor,
  computeWalls,
  describeMap,
  doorAngle,
  doorCentre,
  doorFromCentre,
  doorOnWall,
  doorSegment,
  drawnFloor,
  floorPaths,
  fromDungeonScrawl,
  outerArchways,
  placeDoor,
  placeDoorBetween,
  renderSvg,
  shapeFromBox,
  toDungeonScrawl,
  turnSegment,
  validateMap,
  ValidationError,
  wallPolylines,
  type DelveMap,
  type Door,
  type Layer,
  type MapObject,
  type Point,
  type Segment,
} from '../src/index.ts';
import { axisDoorMap, mapWith } from './door-maps.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const strokes = (layers: Layer[], name: string): Point[][] => layers.flatMap((l) => (l.name === name && l.kind === 'stroke' ? l.lines.map((x) => x.points) : []));

/** How far p is from the line through a and b, and where along it (0 at a, 1 at b). */
function onLine(p: Point, [a, b]: Segment): { off: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return { off: Math.abs(((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len), t: ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len) };
}

/** Wall left inside the door's span, close to its line (none if the gap is open). */
function wallInGap(walls: readonly Segment[], d: Door, reach = 0.3): Segment[] {
  const line = doorSegment(d);
  return walls.filter(([p, q]) =>
    [0.25, 0.5, 0.75].some((k) => {
      const m: Point = [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
      const { off, t } = onLine(m, line);
      return off < reach && t > 0.02 && t < 0.98;
    }),
  );
}

/** The wall end nearest to a point. */
const nearestEnd = (walls: readonly Segment[], p: Point): number => Math.min(...walls.flat().map((q) => dist(p, q)));

const octagon = (): MapObject => ({ id: 'r1', type: 'room', shape: shapeFromBox('octagon', [0, 0, 10, 10]), label: '1' });

/** A door snapped onto the wall nearest p, the way the editor's Prop picker puts one. */
function snapped(map: DelveMap, p: Point, width: number, id = 'd1', style: Door['style'] = 'normal'): Door {
  const ends = doorOnWall(computeFloor(map), p, width)!;
  expect(ends).not.toBeNull();
  return { id, type: 'door', ...placeDoorBetween(computeFloor(map), ends[0], ends[1]), style };
}

describe('old doors (no angle)', () => {
  // recorded from the code before doors could turn (2ca35b5); every door style, smooth and rough
  const RENDERS: Record<string, string> = {
    'classic-hatching:gm': '633a9e6c8acfdc07',
    'classic-hatching:players': '5dbcdaa631428d3f',
    'classic-hatching+rough:gm': 'd7178346b6cebacb',
    'classic-hatching+rough:players': '2be62146aeacec63',
    'parchment:gm': 'ce1d662598f66a86',
    'parchment:players': 'c76de8203ff84d3f',
    'parchment+rough:gm': '9eaa7753053eb96a',
    'parchment+rough:players': 'd8ab03d1b3750bc0',
    'clean:gm': '4a218c6ae1ffccf5',
    'clean:players': 'ea8dc72e30247c37',
    'clean+rough:gm': '9bbfb63fea59e699',
    'clean+rough:players': '1f38f03323489b16',
  };

  it('render byte for byte as before, in every style and view, smooth and rough', () => {
    const got: Record<string, string> = {};
    for (const key of Object.keys(RENDERS)) {
      const [style, view] = key.split(':') as [string, 'gm' | 'players'];
      const [preset, rough] = style.split('+');
      got[key] = sha(renderSvg(axisDoorMap({ style: { preset: preset! }, ...(rough ? { roughness: 7 } : {}) }), { view }));
    }
    expect(got).toEqual(RENDERS);
  });

  it('export to Dungeon Scrawl, describe and cut walls exactly as before', () => {
    expect(sha(JSON.stringify(toDungeonScrawl(axisDoorMap(), { view: 'gm' })))).toBe('a2688dc1e2954106');
    expect(sha(JSON.stringify(toDungeonScrawl(axisDoorMap(), { view: 'players' })))).toBe('977a7b70b37b072e');
    expect(sha(describeMap(axisDoorMap()))).toBe('43c655b076d925da');
    expect(sha(JSON.stringify(computeWalls(axisDoorMap(), drawnFloor(axisDoorMap()))))).toBe('8c20274f963b947d');
    const rough = axisDoorMap({ roughness: 7 });
    expect(sha(JSON.stringify(computeWalls(rough, drawnFloor(rough))))).toBe('d999c85c41de7f43');
  });

  it('read along as 0° or 90°, and an angle of 0 or 90 gives the very same line', () => {
    const x: Door = { id: 'd1', type: 'door', at: [2, 3], along: 'x', width: 2 };
    const y: Door = { id: 'd2', type: 'door', at: [2, 3], along: 'y', width: 1.5 };
    expect([doorAngle(x), doorAngle(y)]).toEqual([0, 90]);
    expect(doorSegment({ ...x, angle: 0 })).toEqual(doorSegment(x));
    expect(doorSegment({ ...y, angle: 90 })).toEqual(doorSegment(y));
    expect(doorSegment({ ...y, angle: 450 })).toEqual(doorSegment(y));
    expect(doorCentre(x)).toEqual([3, 3]);
  });
});

describe('the angle field', () => {
  const problems = (door: Record<string, unknown>): string[] => {
    try {
      validateMap(mapWith([{ id: 'd1', type: 'door', at: [0, 0], along: 'x', width: 1, ...door } as MapObject]));
      return [];
    } catch (e) {
      if (e instanceof ValidationError) return e.problems;
      throw e;
    }
  };

  it('takes any turn in degrees, and still needs along', () => {
    expect(problems({ angle: 33.69 })).toEqual([]);
    expect(problems({ angle: -45 })).toEqual([]);
    expect(problems({ angle: 'north' }).join()).toMatch(/d1.*angle/);
    expect(problems({ angle: Number.NaN }).join()).toMatch(/angle/);
    expect(problems({ angle: Number.POSITIVE_INFINITY }).join()).toMatch(/angle/);
    expect(problems({ angle: 1e9 }).join()).toMatch(/angle/);
    expect(problems({ along: undefined, angle: 30 }).join()).toMatch(/along/);
  });

  it('is kept out of new doors on plain walls, so they stay old-style', () => {
    const map = mapWith([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 4] } }]);
    const floor = computeFloor(map);
    // the north wall: a straight wall along x
    expect(placeDoor(floor, [3, 0], 0, 2)).toEqual({ at: [2, 0], along: 'x' });
    expect(placeDoor(floor, [6, 2], 270, 1)).toEqual({ at: [6, 1.5], along: 'y' });
    // turned off the axis: an angle, and along says the nearest axis
    expect(placeDoor(floor, [3, 2], 30, 2)).toMatchObject({ along: 'x', angle: 30 });
    expect(placeDoor(floor, [3, 2], 100, 2)).toMatchObject({ along: 'y', angle: 100 });
    // doorFromCentre folds a door's turn into [0, 180): the same line either way round
    expect(doorFromCentre([0, 0], 210, 2)).toMatchObject({ angle: 30 });
  });
});

describe('turned doors in slanted, curved and rough walls', () => {
  it('cut their gap in an octagon’s slanted wall, the wall meeting the door end to end', () => {
    const base = mapWith([octagon()]);
    const d = snapped(base, [1.4, 1.6], 2);
    expect(d.angle).toBeCloseTo(135, 1);
    const map = mapWith([octagon(), d]);
    const walls = computeWalls(map);
    expect(wallInGap(computeWalls(base), d).length).toBeGreaterThan(0);
    expect(wallInGap(walls, d)).toEqual([]);
    const [a, b] = doorSegment(d);
    expect(nearestEnd(walls, a)).toBeLessThan(1e-3);
    expect(nearestEnd(walls, b)).toBeLessThan(1e-3);
    // the gap is the door's width, no more
    const total = (ws: Segment[]) => ws.reduce((s, [p, q]) => s + dist(p, q), 0);
    expect(total(computeWalls(base)) - total(walls)).toBeCloseTo(2, 3);
    // and the drawn walls are open there too
    const lines = wallPolylines(map).flatMap((l) => l.points.slice(1).map((p, i): Segment => [l.points[i]!, p]));
    expect(wallInGap(lines, d)).toEqual([]);
  });

  it('sit in a hexagon’s slanted wall wherever it is clicked', () => {
    const hex: MapObject = { id: 'r1', type: 'room', shape: shapeFromBox('hexagon', [0, 0, 12, 10]) };
    const base = mapWith([hex]);
    const d = snapped(base, [1.5, 3], 1.5);
    const map = mapWith([hex, d]);
    expect(Math.abs(doorAngle(d) % 90)).toBeGreaterThan(10);
    expect(wallInGap(computeWalls(map), d)).toEqual([]);
    expect(describeMap(map)).toMatch(/d1 \(normal, turned [\d.]+°\): .*leads outside/);
  });

  it('are chords of a circle: both ends on the wall, the curve between them open, no crack beside it', () => {
    const circle: MapObject = { id: 'r1', type: 'room', shape: { circle: [10, 10, 4] } };
    const base = mapWith([circle]);
    for (const p of [[10, 5.8], [13.1, 7.2], [6.5, 12.9]] as Point[]) {
      const d = snapped(base, p, 2);
      const map = mapWith([circle, d]);
      const walls = computeWalls(map);
      expect(wallInGap(walls, d, 0.5)).toEqual([]);
      for (const end of doorSegment(d)) {
        expect(Math.abs(dist(end, [10, 10]) - 4)).toBeLessThan(0.02); // on the wall
        expect(nearestEnd(walls, end)).toBeLessThan(0.02); // the wall comes right up to it
      }
    }
  });

  it('keep the old form on a circle’s top only if that would still cut the curve: it wouldn’t, so they turn', () => {
    const base = mapWith([{ id: 'r1', type: 'room', shape: { circle: [10, 10, 4] } }]);
    const d = snapped(base, [10, 6], 1);
    expect(d.angle).toBe(0);
    expect(wallInGap(computeWalls(mapWith([...base.objects, d])), d, 0.5)).toEqual([]);
  });

  it('keep the cave wall straight at the door and still open it', () => {
    const cave: MapObject = { id: 'r1', type: 'room', shape: shapeFromBox('octagon', [0, 0, 12, 12]), roughness: 9 };
    const base = mapWith([cave]);
    const d = snapped(base, [1.6, 1.9], 1.5);
    const map = mapWith([cave, d], { roughness: 9 });
    const floor = drawnFloor(map);
    // the rough floor passes through both ends of the door, and its walls leave the door's gap open
    const rings = floor.flatMap((p) => [p.outer, ...p.holes]);
    const near = (q: Point) => Math.min(...rings.flat().map((r) => dist(q, r)));
    for (const end of doorSegment(d)) expect(near(end)).toBeLessThan(0.3);
    const walls = computeWalls(map, floor);
    expect(wallInGap(walls, d, 0.45)).toEqual([]);
    for (const end of doorSegment(d)) expect(nearestEnd(walls, end)).toBeLessThan(0.02);
  });

  it('draw their leaf, bars and keyhole turned with them', () => {
    const base = mapWith([octagon()]);
    const doors = [snapped(base, [1.4, 1.6], 2, 'd1', 'locked'), snapped(base, [8.6, 8.4], 2, 'd2', 'portcullis')];
    const scene = buildScene(mapWith([octagon(), ...doors]));
    const leaves = scene.layers.find((l) => l.name === 'doors');
    expect(leaves?.kind).toBe('fill');
    // the leaf's long sides run along the door
    const leaf = leaves?.kind === 'fill' ? leaves.polygons[0]!.outer : [];
    const line = doorSegment(doors[0]!);
    for (const p of leaf) expect(onLine(p, line).off).toBeLessThan(0.16);
    // the portcullis bars stand across the door
    const bars = strokes(scene.layers, 'door-marks').filter((l) => dist(l[0]!, l[1]!) < 0.3);
    expect(bars.length).toBeGreaterThan(4);
    const u = doorSegment(doors[1]!);
    for (const [p, q] of bars) {
      const along = Math.abs(((q![0] - p![0]) * (u[1][0] - u[0][0]) + (q![1] - p![1]) * (u[1][1] - u[0][1])) / dist(u[0], u[1]));
      expect(along).toBeLessThan(1e-9);
    }
  });

  it('as secret doors look like plain wall to players: no gap, and on a curve no chord beside it', () => {
    const circle: MapObject = { id: 'r1', type: 'room', shape: { circle: [10, 10, 4] } };
    const base = mapWith([circle]);
    const d = snapped(base, [13.1, 7.2], 2, 'd1', 'secret');
    const map = mapWith([circle, d]);
    const players = buildScene(map, { view: 'players' });
    const plain = buildScene(base, { view: 'players' });
    expect(strokes(players.layers, 'walls')).toEqual(strokes(plain.layers, 'walls'));
    expect(players.layers.some((l) => l.name === 'secret-doors' || l.name === 'secret-marks')).toBe(false);
    // the GM sees it: the gap, the dashed line and the S
    const gm = buildScene(map, { view: 'gm' });
    expect(strokes(gm.layers, 'secret-doors')).toHaveLength(1);
  });

  it('across an opening (no wall along them) close it with their own line for players', () => {
    const map = mapWith([
      { id: 'r1', type: 'room', shape: { rect: [0, 0, 10, 10] } },
      { id: 'd1', type: 'door', at: [2, 2], along: 'x', angle: 45, width: 2, style: 'secret' },
    ]);
    const lines = strokes(buildScene(map, { view: 'players' }).layers, 'walls');
    expect(lines).toContainEqual(doorSegment(map.objects[1] as Door));
  });

  it('give an outer archway in a slanted wall its open end, facing out', () => {
    const base = mapWith([octagon()]);
    const d = snapped(base, [1.4, 1.6], 2, 'd1', 'archway');
    const arches = outerArchways(mapWith([octagon(), d]), floorPaths(mapWith([octagon(), d])), 1.3);
    expect(arches).toHaveLength(1);
    // out of the room: up and to the left
    expect(arches[0]!.out[0]).toBeLessThan(0);
    expect(arches[0]!.out[1]).toBeLessThan(0);
  });

  it('turn with a placed segment and stay on their wall', () => {
    const base = mapWith([octagon()]);
    const d = snapped(base, [1.4, 1.6], 2);
    const seg = { size: [10, 10] as [number, number], objects: [octagon(), d] };
    const turned = turnSegment(seg, 90);
    const td = turned.objects.find((o) => o.id === 'd1') as Door;
    expect(doorAngle(td)).toBeCloseTo((doorAngle(d) + 90) % 360, 1);
    const map = mapWith(turned.objects);
    expect(wallInGap(computeWalls(map), td)).toEqual([]);
    const round = [90, 90, 90].reduce((s, r) => turnSegment(s, r), turned);
    expect(doorSegment(round.objects.find((o) => o.id === 'd1') as Door)[0]).toEqual(doorSegment(d)[0]);
  });

  it('go to Dungeon Scrawl as a turned rectangle and come back turned', () => {
    const base = mapWith([octagon()]);
    const d = snapped(base, [1.4, 1.6], 2);
    const map = mapWith([octagon(), d]);
    const doc = toDungeonScrawl(map);
    const nodes = Object.values(doc.state.document.nodes) as { name?: string; geometryId?: string }[];
    const geo = doc.data.geometry[nodes.find((n) => n.name === 'Door geometry')!.geometryId!]!;
    const [a, b] = doorSegment(d);
    // the jambs start at the door's ends (36 px a square)
    expect(dist(geo.polylines[0]![0]! as Point, [a[0] * 36, a[1] * 36])).toBeLessThan(0.01);
    expect(dist(geo.polylines[1]![1]! as Point, [b[0] * 36, b[1] * 36])).toBeLessThan(0.01);
    const back = fromDungeonScrawl(doc, { id: 'back' }).map.objects.find((o): o is Door => o.type === 'door')!;
    expect(back.angle).toBeDefined();
    expect(doorAngle(back) % 180).toBeCloseTo(doorAngle(d) % 180, 0);
    expect(back.width).toBeCloseTo(2, 1);
  });
});

describe('doorOnWall', () => {
  it('centres a door on a straight wall and slides it back from the corner', () => {
    const floor = computeFloor(mapWith([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 4] } }]));
    expect(doorOnWall(floor, [3.2, 0.3], 2)).toEqual([[2.2, 0], [4.2, 0]]);
    const [a, b] = doorOnWall(floor, [5.8, 0.1], 2)!;
    expect(Math.max(a[0], b[0])).toBeCloseTo(6, 9);
    expect(a[1]).toBe(0);
    expect(doorOnWall(floor, [3, 2], 1)).toBeNull(); // the middle of the room: no wall within a square
  });
});
