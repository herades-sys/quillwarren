// Placing things by meaning (core places/): lengths with units, regions,
// props by place, rooms beside rooms, corridors round rooms, doors on walls,
// and the checks the tools report.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  besideRect,
  checkMap,
  checkMapText,
  checkObjects,
  corridorThrough,
  describeMap,
  doorCentre,
  doorOnRoomWall,
  fillRegion,
  lengthInSquares,
  lengthInUnits,
  parseLength,
  parsePlace,
  parseSquareUnit,
  placeProps,
  propBounds,
  resolveRegion,
  routeAround,
  shapeBounds,

  type Bounds,
  type DelveMap,
  type MapObject,
  type Point,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const add = (map: DelveMap, ...objects: MapObject[]): DelveMap => applyOps(map, objects.map((object) => ({ op: 'add' as const, object }))).map;
const empty = (unit = '5 ft'): DelveMap => ({ format: 'delve.map', version: 1, id: 'map_t', name: 't', grid: { type: 'square', unit }, seed: 1, objects: [] }) as DelveMap;
const within = (inner: Bounds, outer: Bounds) => inner.x0 >= outer.x0 - 1e-9 && inner.y0 >= outer.y0 - 1e-9 && inner.x1 <= outer.x1 + 1e-9 && inner.y1 <= outer.y1 + 1e-9;
const overlapArea = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const R2: Bounds = { x0: 6, y0: 15, x1: 14, y1: 21 };

describe('lengths with units', () => {
  const metric = parseSquareUnit('1.5 m');
  const feet = parseSquareUnit('5 ft');
  it('reads numbers, metres, feet and squares', () => {
    expect(parseLength(4)).toEqual({ n: 4, unit: null });
    expect(parseLength('5 m')).toEqual({ n: 5, unit: 'm' });
    expect(parseLength('10ft')).toEqual({ n: 10, unit: 'ft' });
    expect(parseLength('2,5 metres')).toEqual({ n: 2.5, unit: 'm' });
    expect(parseLength('3 squares')).toEqual({ n: 3, unit: 'sq' });
    expect(parseLength("-10'")).toEqual({ n: -10, unit: 'ft' });
    expect(parseLength('7')).toEqual({ n: 7, unit: null });
    expect(() => parseLength('5 parsecs', 'height')).toThrow(/height: a number, or a length with a unit/);
  });
  it('converts to squares with the map\'s square size', () => {
    expect(lengthInSquares('5 m', metric).squares).toBeCloseTo(10 / 3, 6);
    expect(lengthInSquares('5 m', metric).note).toBe('5 m = 3.33 squares (1 square = 1.5 m)');
    expect(lengthInSquares('10 ft', feet).squares).toBe(2);
    expect(lengthInSquares('3 squares', metric).squares).toBe(3);
    expect(lengthInSquares(4, metric)).toEqual({ squares: 4, note: '' });
    expect(lengthInSquares('3 m', feet).squares).toBeCloseTo(3 / 0.3048 / 5, 6);
  });
  it('converts heights to the map\'s own unit', () => {
    expect(lengthInUnits('5 m', metric)).toEqual({ value: 5, note: '5 m = 5 m' });
    expect(lengthInUnits('5 m', feet).value).toBe(16.4);
    expect(lengthInUnits('10 ft', metric).value).toBe(3.05);
    expect(lengthInUnits('2 squares', feet).value).toBe(10);
    expect(lengthInUnits(-10, feet)).toEqual({ value: -10, note: '' });
  });
});

describe('regions', () => {
  const dungeon = testMap(); // rooms only: x 0–20, y 0–32 (grid.bounds)
  const outdoor = add(empty('1.5 m'), { id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 30, 20] } });

  it('a north edge band is at small y: just outside the rooms on a dungeon, inside the ground outdoors', () => {
    const top = Math.min(...dungeon.objects.flatMap((o) => (o.type === 'room' ? [shapeBounds(o.shape).y0] : [])));
    const band = resolveRegion(dungeon, { edge: 'north' });
    expect(band.bounds.y1).toBeLessThanOrEqual(top);
    expect(band.bounds).toEqual({ x0: 0, y0: -3.5, x1: 20, y1: -0.5 });
    expect(band.text).toContain('north edge');
    const inside = resolveRegion(outdoor, { edge: 'north', depth: 4 });
    expect(inside.bounds).toEqual({ x0: 0, y0: 0, x1: 30, y1: 4 });
    const south = resolveRegion(outdoor, { edge: 'S', depth: '3 m' });
    expect(south.bounds).toEqual({ x0: 0, y0: 18, x1: 30, y1: 20 }); // 3 m = 2 squares
    expect(south.notes[0]).toContain('3 m = 2 squares');
    expect(resolveRegion(dungeon, { edge: 'north', outside: false }).bounds).toEqual({ x0: 0, y0: 0, x1: 20, y1: 3 });
  });

  it('corners sit in their corner (sw: small x, big y)', () => {
    expect(resolveRegion(outdoor, { corner: 'sw', size: 8 }).bounds).toEqual({ x0: 0, y0: 12, x1: 8, y1: 20 });
    expect(resolveRegion(outdoor, { corner: 'north-east', size: 5 }).bounds).toEqual({ x0: 25, y0: 0, x1: 30, y1: 5 });
    const def = resolveRegion(outdoor, { corner: 'se' });
    expect(def.bounds.x1).toBe(30);
    expect(def.bounds.y1).toBe(20);
    expect(def.text).toMatch(/^the south-east corner of the map/);
  });

  it('in a room: all of it, or a band along one of its walls', () => {
    const all = resolveRegion(dungeon, { in: 'r5' });
    expect(all.shape).toEqual({ rect: [4, 1, 12, 10] });
    expect(all.offFloor).toBe(false);
    expect(resolveRegion(dungeon, { in: 'r2', edge: 'north', depth: 2 }).shape).toEqual({ rect: [6, 15, 8, 2] });
    expect(resolveRegion(dungeon, { in: 'r2', corner: 'se', size: 2 }).shape).toEqual({ rect: [12, 19, 2, 2] });
    // a round room: the band is cut to its outline
    const round = add(empty(), { id: 'r1', type: 'room', shape: { circle: [10, 10, 5] } });
    const cut = resolveRegion(round, { in: 'r1', edge: 'north', depth: 2 });
    expect('poly' in cut.shape).toBe(true);
    expect(cut.bounds.y0).toBeCloseTo(5, 3);
    expect(cut.bounds.y1).toBeCloseTo(7, 3);
  });

  it('a ring around something has a hole; a strip runs between two things', () => {
    const ring = resolveRegion(dungeon, { around: 'r6', margin: 1 });
    expect(ring.shape).toEqual({ rect: [16, 2, 5, 7] });
    expect(ring.holes).toHaveLength(1);
    const path = resolveRegion(add(outdoor, { id: 'h1', type: 'height', height: 5, shape: { rect: [0, 12, 8, 8] } }), { between: ['east', 'h1'], width: 2 });
    expect(path.line).toEqual([[30, 16], [4, 16]]);
    expect(path.bounds).toEqual({ x0: 4, y0: 15, x1: 30, y1: 17 });
    // between two rooms it stops at their walls: from r1's north wall (y 25) to r5's south wall (y 11)
    expect(resolveRegion(dungeon, { between: ['r1', 'r5'] }).bounds).toEqual({ x0: 9, y0: 11, x1: 11, y1: 25 });
  });

  it('says what is wrong', () => {
    expect(() => resolveRegion(dungeon, { edge: 'up-ish' })).toThrow(/region.edge: north, south, east or west/);
    expect(() => resolveRegion(dungeon, { edge: 'north', corner: 'ne' })).toThrow(/give one of/);
    expect(() => resolveRegion(dungeon, { in: 'r99' })).toThrow(/no object "r99"/);
    expect(() => resolveRegion(empty(), { edge: 'north' })).toThrow(/still empty/);
    expect(() => resolveRegion(dungeon, {})).toThrow(/or a shape such as \{"rect": \[x, y, width, height\]\}/);
    expect(() => resolveRegion(dungeon, { rect: [0, 0, -2, 3] })).toThrow(/region.rect: \[x, y, width, height\]/);
  });

  it('a plain shape is a region too, even on an empty map', () => {
    const r = resolveRegion(empty(), { rect: [0, 0, 30, 20] });
    expect(r.kind).toBe('shape');
    expect(r.shape).toEqual({ rect: [0, 0, 30, 20] });
    expect(r.text).toBe('the area x 0–30, y 0–20');
    const cut = resolveRegion(dungeon, { in: 'r2', rect: [0, 0, 10, 18] });
    expect(cut.shape).toEqual({ rect: [6, 15, 4, 3] });
    expect(resolveRegion(dungeon, { circle: [10, 10, 2] }).bounds).toEqual({ x0: 8, y0: 8, x1: 12, y1: 12 });
  });
});

describe('props by place', () => {
  const map = testMap();
  it('parses places', () => {
    expect(parsePlace('north wall')).toEqual({ kind: 'wall', side: 'north' });
    expect(parsePlace('against the East wall')).toEqual({ kind: 'wall', side: 'east' });
    expect(parsePlace('NE corner')).toEqual({ kind: 'corner', corner: 'ne' });
    expect(parsePlace('south-west corner')).toEqual({ kind: 'corner', corner: 'sw' });
    expect(parsePlace('centre')).toEqual({ kind: 'center' });
    expect(parsePlace('around i1')).toEqual({ kind: 'around', id: 'i1' });
    expect(parsePlace('next to i12')).toEqual({ kind: 'near', id: 'i12' });
    expect(() => parsePlace('on the ceiling')).toThrow(/place: one of/);
  });

  it('against a wall: inside the room, flush with it, turned to face into the room, doorways clear', () => {
    // room 2's north wall has corridor c4's mouth in its middle (x 9–11): the bar counter goes beside it
    const bar = placeProps(map, { asset: 'bar-counter', in: 'r2', place: 'north wall' });
    expect(bar.placed).toHaveLength(1);
    const p = bar.placed[0]!;
    const b = propBounds(p);
    expect(within(b, R2)).toBe(true);
    expect(b.y0).toBe(15);
    expect(p.rotation).toBe(0);
    expect(overlapArea(b, { x0: 9, y0: 15, x1: 11, y1: 16.5 })).toBe(0);
    expect(p.where).toContain('against the north wall of room 2 Crossroads (r2), facing south');
    const east = placeProps(map, { asset: 'bookshelf', in: 'r2', place: 'east wall' }).placed[0]!;
    expect(east.rotation).toBe(90);
    expect(propBounds(east).x1).toBe(14);
    expect(overlapArea(propBounds(east), { x0: 12.5, y0: 17, x1: 14, y1: 19 })).toBe(0); // c3's mouth
    // a 3-long bar counter can't stand flush with r2's east wall (6 long, corridor c3's mouth in its middle): near it, and the free walls are named
    const near = placeProps(map, { asset: 'bar-counter', in: 'r2', place: 'east wall' }).placed[0]!;
    expect(near.where).toMatch(/^near the east wall of room 2 Crossroads \(r2\) \(1\.5 squares off it: doorways, props or pillars take the wall; the north, south walls have room for it\)$/);
    expect(within(propBounds(near), R2)).toBe(true);
    // with a round table and its chairs in the middle nothing fits along the east wall: the walls with room are named
    const tavern = add(map, { id: 'i1', type: 'prop', asset: 'table-round', at: [10, 18] }, ...placeProps(add(map, { id: 'i1', type: 'prop', asset: 'table-round', at: [10, 18] }), { asset: 'chair', place: 'around i1', count: 4 }).placed.map((p, k) => ({ id: `i${k + 2}`, type: 'prop' as const, asset: p.asset, at: p.at, rotation: p.rotation })));
    const none = placeProps(tavern, { asset: 'bar-counter', in: 'r2', place: 'east wall' });
    expect(none.placed).toHaveLength(0);
    expect(none.notes[0]).toMatch(/^Along the east wall it does not fit \(doorways, props or pillars take it\); the north(, south)? walls? ha(s|ve) room for it\.$/);
    const west = placeProps(map, { asset: 'bookshelf', in: 'r3', place: 'west wall' }).placed[0]!;
    expect(west.rotation).toBe(270);
    expect(propBounds(west).x0 + 0).toBe(0);
  });

  it('in corners and the middle', () => {
    const ne = placeProps(map, { asset: 'chest-closed', in: 'r2', place: 'ne corner' }).placed[0]!;
    expect(propBounds(ne).x1).toBe(14);
    expect(propBounds(ne).y0).toBe(15);
    const sw = placeProps(map, { asset: 'chest-closed', in: 'r2', place: 'sw corner' }).placed[0]!;
    expect(propBounds(sw).x0).toBe(6);
    expect(propBounds(sw).y1).toBe(21);
    expect(sw.rotation).toBe(180);
    const mid = placeProps(map, { asset: 'table-rect', in: 'r2', place: 'center' }).placed[0]!;
    expect(mid.at).toEqual([10, 18]);
  });

  it('four chairs around a table, one on each side, each facing it and none on it', () => {
    const withTable = add(map, { id: 'i1', type: 'prop', asset: 'table-rect', at: [10, 18] });
    const chairs = placeProps(withTable, { asset: 'chair', place: 'around i1', count: 4 });
    expect(chairs.container?.id).toBe('r2');
    expect(chairs.missing).toBe(0);
    const table = propBounds({ asset: 'table-rect', at: [10, 18] });
    const facing: Record<string, number> = {};
    for (const c of chairs.placed) {
      const b = propBounds(c);
      expect(overlapArea(b, table)).toBe(0);
      expect(Math.min(Math.abs(b.y1 - table.y0), Math.abs(b.y0 - table.y1), Math.abs(b.x1 - table.x0), Math.abs(b.x0 - table.x1))).toBe(0);
      expect(within(b, R2)).toBe(true);
      facing[c.where.split(' ')[0]!] = c.rotation;
    }
    expect(facing).toEqual({ north: 0, south: 180, west: 270, east: 90 });
    for (let i = 0; i < chairs.placed.length; i++) for (let j = i + 1; j < chairs.placed.length; j++) expect(overlapArea(propBounds(chairs.placed[i]!), propBounds(chairs.placed[j]!))).toBe(0);
    // six: two on each long side
    const six = placeProps(withTable, { asset: 'chair', place: 'around i1', count: 6 });
    expect(six.placed.filter((c) => c.where.startsWith('north'))).toHaveLength(2);
    // near: next to it, not on it
    const near = placeProps(withTable, { asset: 'barrel', place: 'near i1' }).placed[0]!;
    expect(overlapArea(propBounds(near), table)).toBe(0);
  });

  it('several against one wall stand side by side; what does not fit is reported', () => {
    const beds = placeProps(map, { asset: 'bed-single', in: 'r3', place: 'north wall', count: 3 });
    expect(beds.placed).toHaveLength(3);
    for (const b of beds.placed) expect(propBounds(b).y0).toBe(13);
    const huge = placeProps(map, { asset: 'bed-single', in: 'r6', place: 'center', count: 20 });
    expect(huge.missing).toBeGreaterThan(0);
    expect(huge.notes[0]).toMatch(/^Only \d+ of 20 fit/);
    expect(() => placeProps(map, { asset: 'chair', place: 'north wall' })).toThrow(/in: say which room/);
  });

  it('a rug may lie under the table, but furniture keeps off furniture', () => {
    const withTable = add(map, { id: 'i1', type: 'prop', asset: 'table-rect', at: [10, 18] });
    const rug = placeProps(withTable, { asset: 'c-persian-red-a', in: 'r2', place: 'center' }).placed[0]!;
    expect(rug.at).toEqual([10, 18]);
    const table2 = placeProps(withTable, { asset: 'table-rect', in: 'r2', place: 'center' }).placed[0]!;
    expect(overlapArea(propBounds(table2), propBounds({ asset: 'table-rect', at: [10, 18] }))).toBe(0);
  });
});

describe('filling a region with the brush', () => {
  it('a forest along the north edge stays north of the rooms and off them', () => {
    const map = testMap();
    const region = resolveRegion(map, { edge: 'north', depth: 4 });
    const fill = fillRegion(map, region, { asset: 'c-oak-a', seed: 7 });
    expect(fill.copies.length).toBeGreaterThanOrEqual(5);
    expect(new Set(fill.copies.map((c) => c.asset)).size).toBeGreaterThan(1);
    for (const c of fill.copies) expect(c.at[1]).toBeLessThan(1);
  });
  it('inside a room the copies stay on its floor', () => {
    const map = testMap();
    const fill = fillRegion(map, resolveRegion(map, { in: 'r5' }), { asset: 'barrel', seed: 3, spacing: 2 });
    expect(fill.copies.length).toBeGreaterThan(5);
    for (const c of fill.copies) expect(within(propBounds(c), { x0: 4, y0: 1, x1: 16, y1: 11 })).toBe(true);
  });
});

describe('rooms beside rooms', () => {
  const map = testMap();
  it('east of room 1: lined up, 2 squares off, clear of every room', () => {
    const r = besideRect(map, { beside: 'r1', side: 'east', w: 6, h: 4, corridorWidth: 2 });
    expect(r.rect).toEqual([15, 26, 6, 4]);
    expect(r.text).toContain('east of room 1 Entrance hall (r1), 2 squares from it');
  });
  it('never overlaps another room: it slides or moves further out', () => {
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      for (const beside of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
        const r = besideRect(map, { beside, side, w: 5, h: 5, corridorWidth: 2 });
        const b: Bounds = { x0: r.rect[0], y0: r.rect[1], x1: r.rect[0] + r.rect[2], y1: r.rect[1] + r.rect[3] };
        for (const o of map.objects) if (o.type === 'room') expect(overlapArea(b, shapeBounds(o.shape)), `${beside} ${side} vs ${o.id}`).toBe(0);
        const next = add(map, { id: 'r9', type: 'room', shape: { rect: r.rect } });
        expect(checkMap(next).filter((p) => p.ids.includes('r9')), `${beside} ${side}`).toEqual([]);
      }
    }
  });
  it('a crowded side: north of room 2 is the boss chamber, so the new room slides aside, still north of room 2', () => {
    const r = besideRect(map, { beside: 'r2', side: 'north', w: 4, h: 4, corridorWidth: 2 });
    const b: Bounds = { x0: r.rect[0], y0: r.rect[1], x1: r.rect[0] + 4, y1: r.rect[1] + 4 };
    expect(overlapArea(b, { x0: 4, y0: 1, x1: 16, y1: 11 })).toBe(0);
    expect(b.y1).toBeLessThanOrEqual(13);
    expect(r.text).toMatch(/^north of room 2 Crossroads \(r2\), 2 squares from it, slid \d+ squares (east|west) to keep clear/);
  });
  it('unknown rooms are refused', () => {
    expect(() => besideRect(map, { beside: 'r42', side: 'east', w: 4, h: 4 })).toThrow(/no room "r42"/);
  });
});

describe('corridors round rooms', () => {
  it('finds a way round a room in the way, a square clear of it', () => {
    // r1 and r2 side by side, r3 right between them
    const map = add(empty(), { id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } }, { id: 'r2', type: 'room', shape: { rect: [16, 0, 4, 4] } }, { id: 'r3', type: 'room', shape: { rect: [7, -2, 6, 8] } });
    expect(corridorThrough(map, [[4, 2], [16, 2]], 2, ['r1', 'r2'])).toEqual(['r3']);
    const path = routeAround(map, 'r1', 'r2', 2)!;
    expect(path).not.toBeNull();
    expect(corridorThrough(map, path, 2, ['r1', 'r2'])).toEqual([]);
    // it leaves r1 and enters r2 at their walls
    const [s, e] = [path[0]!, path.at(-1)!] as [Point, Point];
    expect(s[0] === 4 || s[1] === 0 || s[1] === 4 || s[0] === 0).toBe(true);
    expect(e[0] === 16 || e[1] === 0 || e[1] === 4 || e[0] === 20).toBe(true);
    // axis-aligned runs only
    for (let k = 1; k < path.length; k++) expect(path[k]![0] === path[k - 1]![0] || path[k]![1] === path[k - 1]![1]).toBe(true);
  });
});

describe('doors on walls', () => {
  it('in the middle of a free wall, on the wall line', () => {
    const map = add(empty(), { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 4] } });
    const d = doorOnRoomWall(map, 'r1', 'east', 1);
    expect(d.line).toEqual({ at: [6, 1.5], along: 'y' });
    expect(d.text).toBe('on the east wall of room r1, in its middle, leads outside');
    const n = doorOnRoomWall(map, 'r1', 'north', 2);
    expect(n.line).toEqual({ at: [2, 0], along: 'x' });
  });
  it('beside a corridor mouth when the middle is taken, never in it', () => {
    const map = testMap();
    const d = doorOnRoomWall(map, 'r2', 'north', 1);
    const c = doorCentre({ ...d.line, width: 1 });
    expect(c[1]).toBe(15);
    expect(c[0] < 9 || c[0] > 11).toBe(true);
    const check = checkObjects(add(map, { id: 'd9', type: 'door', ...d.line, width: 1, style: 'secret' }), ['d9']);
    expect(check).toMatch(/^Check: on the north wall of r2/);
  });
  it('a wall taken by a corridor mouth and its door says what to do instead', () => {
    // r2's west wall is 4 long; corridor c1 from r1 enters it in the middle with door d1
    const base = add(empty(), { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 4] } }, { id: 'r2', type: 'room', shape: { rect: [8, 0, 4, 4] } });
    const map = add(base, { id: 'c1', type: 'corridor', from: 'r1', to: 'r2', width: 2 }, { id: 'd1', type: 'door', at: [8, 1], along: 'y', width: 2, style: 'normal' });
    expect(() => doorOnRoomWall(map, 'r2', 'west', 1)).toThrow(/Door d1 \(normal\) is in that wall already: update \{"id": "d1", "set": \{"style": "secret"\}\} changes its style\. Free walls of r2: north, south, east\./);
  });
  it('a wall that is all open is refused', () => {
    const map = add(empty(), { id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } }, { id: 'r2', type: 'room', shape: { rect: [4, 0, 4, 4] } });
    expect(() => doorOnRoomWall(map, 'r1', 'east', 1)).toThrow(/no free stretch of 1 square on the east wall of r1/);
  });
  it('round rooms get a door on their most northern wall', () => {
    const map = add(empty(), { id: 'r1', type: 'room', shape: { circle: [10, 10, 4] } });
    const d = doorOnRoomWall(map, 'r1', 'north', 1);
    const c = doorCentre({ ...d.line, width: 1 });
    expect(c[1]).toBeLessThan(6.2);
    expect(Math.abs(c[0] - 10)).toBeLessThan(0.7);
  });
});

describe('checks', () => {
  it('the test dungeon is clean', () => {
    expect(checkMap(testMap())).toEqual([]);
    expect(checkMapText(testMap())).toMatch(/^No problems found/);
  });
  it('finds overlaps, touching rooms, corridors through rooms, doors off walls, props outside, on each other, in doorways', () => {
    const map = add(
      testMap(),
      { id: 'i9', type: 'prop', asset: 'bar-counter', at: [10, 15] },
      { id: 'i7', type: 'prop', asset: 'table-rect', at: [8, 18] },
      { id: 'i8', type: 'prop', asset: 'chair', at: [8, 18] },
      { id: 'd9', type: 'door', at: [8, 27], along: 'y', width: 1, style: 'secret' },
      { id: 'r9', type: 'room', shape: { rect: [13, 25, 4, 4] } },
      { id: 'r10', type: 'room', shape: { rect: [15, 9, 4, 4] } },
      { id: 'c9', type: 'corridor', from: 'r3', to: 'r4', width: 2, path: [[4, 20], [10, 20], [16, 20]] },
    );
    const kinds = checkMap(map).map((p) => p.kind);
    for (const k of ['rooms-overlap', 'rooms-touch', 'corridor-through-room', 'door-off-wall', 'prop-outside-room', 'prop-overlap', 'prop-in-doorway'] as const) expect(kinds).toContain(k);
    expect(checkObjects(map, ['i9'])).toMatch(/^Check: WARNING: half of i9 \(Bar Counter with Tankards\) is outside r2: it sticks out past the north wall/);
    expect(checkObjects(map, ['d9'])).toMatch(/door d9 is not on a wall: it floats inside r1/);
    expect(checkObjects(map, ['r9'])).toMatch(/r9 touches r1/);
    expect(checkObjects(map, ['r10'])).toMatch(/r10 and r5 overlap/);
    expect(checkObjects(map, ['c9'])).toMatch(/corridor c9 runs through r2/);
  });
  it('lists a problem once, not once from each side', () => {
    const map = add(
      testMap(),
      { id: 'i1', type: 'prop', asset: 'table-rect', at: [10, 18] },
      { id: 'i2', type: 'prop', asset: 'chair', at: [9.5, 18] },
      { id: 'i3', type: 'prop', asset: 'chair', at: [10.5, 18] },
      { id: 'c9', type: 'corridor', from: 'r3', to: 'r6', width: 1, path: [[2, 13], [2, 5.5], [17, 5.5]] },
    );
    const problems = checkMap(map);
    expect(problems.filter((p) => p.kind === 'prop-overlap').map((p) => p.text)).toEqual(['i1 (Rectangular Table) overlaps i2 (Wooden Chair), i3 (Wooden Chair)']);
    expect(problems.filter((p) => p.kind === 'corridor-through-room').map((p) => p.text)).toEqual(['corridor c9 runs through r5']);
  });
  it('says what is fine in a few words', () => {
    const map = add(testMap(), { id: 'i1', type: 'prop', asset: 'table-rect', at: [10, 18] });
    expect(checkObjects(map, ['i1'])).toBe('Check: inside r2, doorways clear, no overlaps.');
    expect(checkObjects(map, ['d5'])).toBe('Check: on the south wall of r1.');
    expect(checkObjects(map, ['r1'])).toMatch(/^Check: clear of other rooms \(nearest r2, 4 squares away\)\.$/);
  });
});

describe('describe_map says which way is north and where rooms are', () => {
  it('orientation and positions in words', () => {
    const text = describeMap(testMap(), { where: true });
    expect(text.split('\n')[1]).toBe('Orientation: north is up (small y), south is down (big y), west is left (small x), east is right (big x). The map covers x 0–20, y 0–32.');
    expect(text).toContain('  5 Boss chamber [r5]: 12×10 sq (60 ft × 50 ft) at 4,1 (x 4–16, y 1–11; north part of the map)');
    expect(text).toContain('[r1]: 6×6 sq (30 ft × 30 ft) at 7,25 (x 7–13, y 25–31; south part of the map)');
    expect(text).toContain('[r6]: 3×5 sq (15 ft × 25 ft) at 17,3 (x 17–20, y 3–8; north-east part of the map)');
    expect(text).toContain('[r2]: 8×6 sq (40 ft × 30 ft) at 6,15 (x 6–14, y 15–21; middle of the map)');
  });
});


