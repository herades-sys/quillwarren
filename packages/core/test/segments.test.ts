// Segments: saving a piece of a map, placing copies (turned, renumbered, with
// fresh ids), and filling the land around a dungeon with a tiled segment.
import { areaPathsD, FillRule, intersectD } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildScene,
  collectSegment,
  connectOps,
  corridorPath,
  doorSegment,
  fillArea,
  fillSegmentOps,
  floorArea,
  floorPaths,
  placeSegmentOps,
  propBounds,
  regionAround,
  renderSvg,
  roomsById,
  terrainArea,
  turnSegment,
  validateMap,
  ValidationError,
  type Corridor,
  type DelveMap,
  type Door,
  type MapObject,
  type Prop,
  type Room,
  type SegmentContent,
  type Stairs,
  type Terrain,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const empty = (objects: MapObject[] = []): DelveMap => ({ format: 'delve.map', version: 1, id: 'm1', name: 'M', grid: { type: 'square' }, seed: 7, objects });
const of = <T extends MapObject['type']>(m: { objects: MapObject[] }, t: T) => m.objects.filter((o): o is Extract<MapObject, { type: T }> => o.type === t);
const byId = (m: { objects: MapObject[] }, id: string) => m.objects.find((o) => o.id === id);

describe('collectSegment', () => {
  it('takes rooms with their doors, contents and the corridors between them', () => {
    const map = testMap();
    const seg = collectSegment(map, { ids: ['r1', 'r2'] });
    const ids = seg.objects.map((o) => o.id).sort();
    // c1 joins r1 and r2; c2–c4 lead to rooms that stay behind; d1 and d5 sit on r1's walls
    expect(ids).toEqual(['c1', 'd1', 'd5', 'r1', 'r2']);
    // top-left at 0,0 in whole squares: r2 starts at x 6, y 15
    expect(seg.size).toEqual([8, 16]);
    expect((byId(seg, 'r2') as Room).shape).toEqual({ rect: [0, 0, 8, 6] });
    expect((byId(seg, 'r1') as Room).shape).toEqual({ rect: [1, 10, 6, 6] });
    expect((byId(seg, 'c1') as Corridor).path).toEqual([
      [4, 10],
      [4, 6],
    ]);
    expect(() => validateMap(empty(seg.objects))).not.toThrow();
  });

  it('brings along what stands inside a room, but not a forest around it', () => {
    const map = testMap();
    map.objects.push(
      { id: 'i1', type: 'prop', asset: 'chest-closed', at: [8.5, 4.5] },
      { id: 't1', type: 'terrain', asset: 'carpet', shape: { rect: [8, 4, 4, 3] } },
      // centred inside r5, but it is the land around it
      { id: 't2', type: 'terrain', asset: 'grass', shape: { rect: [-10, -14, 40, 40] }, holes: [[[4, 1], [16, 1], [16, 11], [4, 11]]] },
      { id: 'l1', type: 'label', text: 'Altar', at: [10, 2] },
      { id: 'm1', type: 'marker', kind: 'trap', at: [5.5, 9.5], text: 'Darts' },
    );
    const seg = collectSegment(map, { ids: ['r5'] });
    // pillars p1–p4, doors d4 (south wall) and d6 (east wall), the chest, carpet, label and marker
    expect(seg.objects.map((o) => o.id).sort()).toEqual(['d4', 'd6', 'i1', 'l1', 'm1', 'p1', 'p2', 'p3', 'p4', 'r5', 't1']);
    expect(seg.size).toEqual([12, 10]);
    expect((byId(seg, 'i1') as Prop).at).toEqual([4.5, 3.5]);
  });

  it('keeps a picked corridor to a room left behind as a fixed path', () => {
    const map = applyOps(empty(), [
      { op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 6] } } },
      { op: 'add', object: { id: 'r2', type: 'room', shape: { rect: [0, 10, 8, 6] } } },
      { op: 'add', object: { id: 'c1', type: 'corridor', from: 'r1', to: 'r2', width: 2 } },
    ]).map;
    const seg = collectSegment(map, { ids: ['r1', 'c1'] });
    const c = byId(seg, 'c1') as Corridor;
    expect(c.from).toBe('r1');
    expect(c.to).toBeUndefined();
    expect(c.path).toEqual([
      [3, 6],
      [3, 10],
    ]);
    // without picking it, the corridor to r2 stays behind
    expect(collectSegment(map, { ids: ['r1'] }).objects.map((o) => o.id)).toEqual(['r1']);
  });

  it('takes everything inside a rectangle and cuts terrain to it', () => {
    const map = testMap();
    map.objects.push({ id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [-10, 0, 40, 40] } });
    const seg = collectSegment(map, { rect: [0, 12, 20, 20] });
    const ids = seg.objects.map((o) => o.id).sort();
    // c4 reaches up to r5 (outside); d4 and d6 sit on r5's walls
    expect(ids).toEqual(['c1', 'c2', 'c3', 'd1', 'd2', 'd3', 'd5', 'r1', 'r2', 'r3', 'r4', 't1']);
    expect(seg.size).toEqual([20, 20]);
    expect((byId(seg, 't1') as Terrain).shape).toEqual({ rect: [0, 0, 20, 20] });
  });

  it('says so when there is nothing to save', () => {
    expect(() => collectSegment(testMap(), { rect: [40, 40, 5, 5] })).toThrow(/nothing to save/);
    expect(() => collectSegment(testMap(), { ids: ['nope'] })).toThrow(ValidationError);
  });
});

describe('placeSegmentOps', () => {
  const temple = () => collectSegment(testMap(), { ids: ['r1', 'r2'] });

  it('adds a copy with fresh ids, the next room numbers and remapped corridors', () => {
    const map = testMap();
    const plan = placeSegmentOps(map, temple(), [30.4, -0.3]);
    expect(plan.at).toEqual([30, 0]);
    const after = applyOps(map, plan.ops).map;
    expect(new Set(after.objects.map((o) => o.id)).size).toBe(after.objects.length);
    for (const id of plan.ids) expect(map.objects.some((o) => o.id === id)).toBe(false);
    // r1 (1) and r2 (2) become rooms 7 and 8, in the same order
    expect(plan.rooms).toEqual([
      { id: 'r7', label: '7' },
      { id: 'r8', label: '8' },
    ]);
    expect((byId(after, 'r7') as Room).shape).toEqual({ rect: [31, 10, 6, 6] });
    const c = byId(after, 'c6') as Corridor;
    expect([c.from, c.to]).toEqual(['r7', 'r8']);
    expect(floorArea(after)).toBeCloseTo(floorArea(map) + 36 + 48 + 8, 6);
    // placing it again keeps counting
    const again = placeSegmentOps(after, temple(), [50, 0]);
    expect(again.rooms.map((r) => r.label)).toEqual(['9', '10']);
    expect(() => applyOps(after, again.ops)).not.toThrow();
  });

  it('turns rooms, corridors, doors, stairs and props a quarter turn clockwise', () => {
    const seg: SegmentContent = {
      size: [8, 16],
      objects: [
        { id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] }, label: '1' },
        { id: 'd1', type: 'door', at: [3, 6], along: 'x', width: 2 },
        { id: 's1', type: 'stairs', shape: { rect: [1, 1, 2, 3] }, direction: 'n' },
        { id: 'i1', type: 'prop', asset: 'bed-single', at: [6.5, 2] },
      ],
    };
    const turned = turnSegment(seg, 90);
    expect(turned.size).toEqual([16, 8]);
    // (x, y) -> (16 - y, x)
    expect((byId(turned, 'r1') as Room).shape).toEqual({ rect: [10, 0, 6, 8] });
    expect(byId(turned, 'd1')).toMatchObject({ at: [10, 3], along: 'y', width: 2 });
    expect(byId(turned, 's1')).toMatchObject({ shape: { rect: [12, 1, 3, 2] }, direction: 'e' });
    expect(byId(turned, 'i1')).toMatchObject({ at: [14, 6.5], rotation: 90 });
    // four quarter turns are no turn at all
    const round = [90, 90, 90].reduce((s, r) => turnSegment(s, r), turned);
    expect(round.objects).toEqual(seg.objects);
    expect(() => turnSegment(seg, 45)).toThrow(/rotation/);
  });

  it('keeps a turned auto-routed corridor meeting the doors at its ends', () => {
    const base = applyOps(empty(), [
      { op: 'add', object: { id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } } },
      { op: 'add', object: { id: 'r2', type: 'room', shape: { rect: [8, 6, 4, 6] } } },
    ]).map;
    const map = applyOps(base, connectOps(base, 'r1', 'r2', { doors: 'both' }).ops).map;
    const seg = collectSegment(map, { ids: ['r1', 'r2'] });
    for (const rotation of [0, 90, 180, 270]) {
      const plan = placeSegmentOps(testMap(), seg, [40, 40], rotation);
      const after = applyOps(testMap(), plan.ops).map;
      const c = after.objects.find((o): o is Corridor => o.type === 'corridor' && plan.ids.includes(o.id))!;
      const path = corridorPath(c, roomsById(after))!;
      const doors = after.objects.filter((o): o is Door => o.type === 'door' && plan.ids.includes(o.id));
      const mids = doors.map((d) => doorSegment(d)).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      expect(mids).toContainEqual(path[0]);
      expect(mids).toContainEqual(path.at(-1));
    }
  });
});

describe('fillSegmentOps', () => {
  const forest: SegmentContent = {
    size: [6, 6],
    objects: [
      { id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 6, 6] } },
      { id: 'i1', type: 'prop', asset: 'tree', at: [1.5, 1.5] },
      { id: 'i2', type: 'prop', asset: 'bush', at: [4.5, 4.5] },
      { id: 'i3', type: 'prop', asset: 'boulder', at: [4.5, 1.5] },
      { id: 'l1', type: 'label', text: 'Mixed Forest', at: [3, 3] },
    ],
  };

  it('fills the land around the rooms and keeps the floor clear', () => {
    const map = testMap();
    map.objects.push({ id: 'i1', type: 'prop', asset: 'compass-rose', at: [23, 3] });
    const region = regionAround(map, 5)!;
    expect(region).toEqual({ rect: [-5, -4, 30, 40] });
    const fill = fillSegmentOps(map, forest, region, { seed: 3 });
    expect(fill.tiles).toBe(5 * 7);
    expect(fill.left).toEqual(['label']);
    expect(fill.props).toBeGreaterThan(40);
    expect(fill.terrain).toBe(1);
    const after = applyOps(map, fill.ops).map;
    // the grass goes in under everything else, with the dungeon cut out of it
    const grass = after.objects[0] as Terrain;
    expect(grass.type).toBe('terrain');
    expect(grass.holes?.length).toBeGreaterThan(0);
    const floor = floorPaths(map);
    expect(Math.abs(areaPathsD(intersectD(terrainArea(grass), floor, FillRule.NonZero, 6)))).toBeLessThan(1e-6);
    // no tree, bush or rock within half a square of a room or corridor, or on the compass rose
    const clear = fillArea(map, region, 0.5);
    const rose = propBounds(map.objects.at(-1) as Prop);
    for (const p of of(after, 'prop').filter((o) => fill.ids.includes(o.id))) {
      const b = propBounds(p);
      const corners: [number, number][] = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
      const box = [corners.map(([x, y]) => ({ x, y }))];
      expect(Math.abs(areaPathsD(intersectD(box, floor, FillRule.NonZero, 6)))).toBeLessThan(1e-9);
      expect(Math.abs(areaPathsD(intersectD(box, clear, FillRule.NonZero, 6)))).toBeCloseTo((b.x1 - b.x0) * (b.y1 - b.y0), 4);
      expect(Math.min(b.x1, rose.x1) - Math.max(b.x0, rose.x0) <= 0.05 || Math.min(b.y1, rose.y1) - Math.max(b.y0, rose.y0) <= 0.05).toBe(true);
    }
  });

  it('varies the copies unless asked not to, and is repeatable', () => {
    const map = testMap();
    const region = regionAround(map, 5)!;
    const a = fillSegmentOps(map, forest, region, { seed: 1 });
    expect(fillSegmentOps(map, forest, region, { seed: 1 })).toEqual(a);
    const stamped = fillSegmentOps(map, forest, region, { vary: false });
    const at = (r: typeof a) => r.ops.flatMap((o) => (o.op === 'add' && o.object.type === 'prop' ? [o.object.at] : []));
    // stamped copies sit exactly on the tile grid
    for (const [x, y] of at(stamped)) expect([(x + 5) % 6, (y + 4) % 6].every((v) => [1.5, 4.5].includes(v))).toBe(true);
    expect(at(a)).not.toEqual(at(stamped));
  });

  it('keeps props off the map\'s other terrain and refuses a segment with nothing to tile', () => {
    const map = empty([{ id: 't1', type: 'terrain', asset: 'water-deep', shape: { rect: [0, 0, 12, 12] } }]);
    const fill = fillSegmentOps(map, forest, { rect: [0, 0, 24, 12] }, { vary: false });
    const props = fill.ops.flatMap((o) => (o.op === 'add' && o.object.type === 'prop' ? [o.object] : []));
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(p.at[0]).toBeGreaterThan(12);
    expect(() => fillSegmentOps(map, { size: [4, 4], objects: [{ id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } }] }, { rect: [0, 0, 8, 8] })).toThrow(/place it instead/);
  });
});

describe('terrain holes', () => {
  const holed = (): DelveMap =>
    empty([
      { id: 'r1', type: 'room', shape: { rect: [3, 3, 4, 4] } },
      { id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 10, 10] }, holes: [[[2, 2], [8, 2], [8, 8], [2, 8]]] },
    ]);

  it('draws terrain without its holes, with and without fog', () => {
    const layer = buildScene(holed()).layers.find((l) => l.name === 'terrain:t1');
    expect(layer?.kind).toBe('pattern');
    if (layer?.kind !== 'pattern') return;
    expect(layer.polygons).toHaveLength(1);
    expect(layer.polygons[0]!.holes).toHaveLength(1);
    const map = { ...holed(), fog: { on: true, show: [{ rect: [0, 0, 5, 5] as [number, number, number, number] }] } };
    const fogged = buildScene(map, { view: 'players', fog: 'hide' }).layers.find((l) => l.name === 'terrain:t1');
    if (fogged?.kind !== 'pattern') throw new Error('no terrain layer');
    // only the seen corner, and still without the hole: an L-shaped piece
    const area = fogged.polygons.reduce((s, p) => s + Math.abs(areaPathsD([p.outer.map(([x, y]) => ({ x, y }))])) - p.holes.reduce((t, h) => t + Math.abs(areaPathsD([h.map(([x, y]) => ({ x, y }))])), 0), 0);
    expect(area).toBeGreaterThan(5.3 * 5.3 - 3.3 * 3.3 - 0.5);
    expect(area).toBeLessThan(5.3 * 5.3 - 3.3 * 3.3 + 0.5);
    expect(renderSvg(holed())).toContain('fill-rule="evenodd"');
  });

  it('moves holes with their terrain and checks their rings', () => {
    const moved = applyOps(holed(), [{ op: 'move', ids: ['t1'], dx: 1, dy: 2 }]).map;
    expect((byId(moved, 't1') as Terrain).holes).toEqual([[[3, 4], [9, 4], [9, 10], [3, 10]]]);
    expect(() => validateMap(empty([{ id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 4, 4] }, holes: [[[1, 1], [2, 2]]] }]))).toThrow(/at least 3 points/);
  });

  it('leaves maps without holes as they were', () => {
    const map = testMap();
    map.objects.push({ id: 't1', type: 'terrain', asset: 'water-shallow', shape: { circle: [10, 5, 2] } });
    const layer = buildScene(map).layers.find((l) => l.name === 'terrain:t1');
    if (layer?.kind !== 'pattern') throw new Error('no terrain layer');
    expect(layer.polygons).toHaveLength(1);
    expect(layer.polygons[0]!.holes).toEqual([]);
    expect(layer.polygons[0]!.outer).toHaveLength(64);
  });
});

it('stairs placed from a segment point the turned way up', () => {
  const seg: SegmentContent = { size: [2, 4], objects: [{ id: 's1', type: 'stairs', shape: { rect: [0, 0, 2, 4] }, direction: 's' }] };
  const plan = placeSegmentOps(empty(), seg, [0, 0], 270);
  expect((plan.ops[0] as { object: Stairs }).object).toMatchObject({ id: 's1', shape: { rect: [0, 0, 4, 2] }, direction: 'e' });
});
