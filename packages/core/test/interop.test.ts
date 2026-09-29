import { areaPathsD, FillRule, xorD } from 'clipper2-ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOps, DsImportError, floorArea, floorPaths, fromDungeonScrawl, toDungeonScrawl, type DelveMap, type Door } from '../src/index.ts';
import { testMap } from './fixtures.ts';

/** The whole "map" JSON of the Dungeon Scrawl fixture. */
function dsFixture(): unknown {
  const buf = readFileSync(resolve(import.meta.dirname, '../../../fixtures/dungeonscrawl/test-map-4p.ds'));
  const size = buf.readUInt32LE(18);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  return JSON.parse(buf.subarray(start, start + size).toString('utf8'));
}

const sameFloor = (a: DelveMap, b: DelveMap) => Math.abs(areaPathsD(xorD(floorPaths(a), floorPaths(b), FillRule.NonZero, 6)));
const doorsOf = (m: DelveMap) =>
  m.objects
    .filter((o): o is Door => o.type === 'door')
    .map((d) => `${d.at.join(',')} ${d.along} ${d.width}`)
    .sort();
const shifted = (m: DelveMap, dx: number, dy: number): DelveMap =>
  applyOps(m, [{ op: 'move', ids: m.objects.map((o) => o.id), dx, dy }]).map;

describe('Dungeon Scrawl import', () => {
  it('brings in the original dungeon: floor, pillars, doors and text', () => {
    const { map, notes } = fromDungeonScrawl(dsFixture(), { id: 'imported' });
    expect(floorArea(map)).toBe(296);
    expect(map.objects.filter((o) => o.type === 'room')).toHaveLength(1); // DS merges the floor into one outline
    expect(map.objects.filter((o) => o.type === 'cutout')).toHaveLength(4);
    // the .ds dungeon sits (+9, +2) squares from ours; its 5 door assets are our d1..d5
    const ours = testMap();
    expect(sameFloor(map, shifted(ours, 9, 2))).toBeLessThan(1e-9);
    const oursNonSecret = { ...ours, objects: ours.objects.filter((o) => !(o.type === 'door' && o.style === 'secret')) };
    expect(doorsOf(map)).toEqual(doorsOf(shifted(oursNonSecret, 9, 2)));
    expect(map.objects.filter((o) => o.type === 'label').map((l) => (l as { text: string }).text).sort()).toEqual(['1', '2', '3', '4', '5', '6', 'S']);
    expect(notes[0]).toContain('1 area');
  });

  it('refuses things that are not Dungeon Scrawl maps', () => {
    expect(() => fromDungeonScrawl({ hello: 1 }, { id: 'x' })).toThrow(DsImportError);
    expect(() => fromDungeonScrawl({ state: { document: { nodes: {} } }, data: { geometry: {} } }, { id: 'x' })).toThrow(/no dungeon floor/);
  });
});

describe('Dungeon Scrawl export', () => {
  it('round-trips the test dungeon: same floor, same doors, numbers and the S mark as text', () => {
    const ours = testMap();
    const back = fromDungeonScrawl(toDungeonScrawl(ours), { id: 'back' }).map;
    expect(sameFloor(back, ours)).toBeLessThan(1e-9);
    const oursNonSecret = { ...ours, objects: ours.objects.filter((o) => !(o.type === 'door' && o.style === 'secret')) };
    expect(doorsOf(back)).toEqual(doorsOf(oursNonSecret));
    const texts = back.objects.filter((o) => o.type === 'label') as { text: string; at: [number, number] }[];
    expect(texts.map((t) => t.text).sort()).toEqual(['1', '2', '3', '4', '5', '6', 'S']);
    // text lands back near where it started (room 1 is centred on 10, 28)
    const one = texts.find((t) => t.text === '1')!;
    expect(Math.abs(one.at[0] - 10)).toBeLessThan(0.3);
    expect(Math.abs(one.at[1] - 28)).toBeLessThan(0.3);
  });

  it('writes the structure Dungeon Scrawl expects', () => {
    const ds = toDungeonScrawl(testMap());
    const nodes = Object.values(ds.state.document.nodes);
    const count = (t: string) => nodes.filter((n) => n.type === t).length;
    expect(count('DOCUMENT')).toBe(1);
    expect(count('TEMPLATE')).toBe(1);
    expect(count('DUNGEON_ASSET')).toBe(5);
    expect(count('TEXT')).toBe(7);
    const page = nodes.find((n) => n.type === 'PAGE')!;
    expect((page.grid as { cellDiameter: number }).cellDiameter).toBe(36);
    // every child reference points at a real node, every geometry id at real geometry
    for (const n of nodes) {
      for (const c of (n.children as string[] | undefined) ?? []) expect(ds.state.document.nodes[c]).toBeDefined();
      if (n.geometryId) expect(ds.data.geometry[n.geometryId as string]).toBeDefined();
    }
  });

  it('is deterministic and leaves GM-only text out of the players\' version', () => {
    expect(JSON.stringify(toDungeonScrawl(testMap()))).toBe(JSON.stringify(toDungeonScrawl(testMap())));
    const players = Object.values(toDungeonScrawl(testMap(), { view: 'players' }).state.document.nodes);
    expect(players.filter((n) => n.type === 'TEXT')).toHaveLength(0);
  });
});
