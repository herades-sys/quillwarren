// Floor numbers, stair labels (0A, 1A, 2A…), their GM marks, and solid cutouts.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildScene,
  chainLetter,
  describeMap,
  floorText,
  handoutSvg,
  labelText,
  renderSvg,
  solidCutouts,
  computeFloor,
  stairLabelOps,
  stairLabels,
  storeyTitle,
  toDungeonScrawl,
  validateMap,
  ValidationError,
  type DelveMap,
  type Layer,
  type MapObject,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const storey = (id: string, order: number | null, objects: MapObject[]): { id: string; map: DelveMap } => ({
  id,
  map: { ...testMap(), id, objects, ...(order === null ? {} : { level: { group: 'g', name: `Floor ${order}`, order } }) },
});
const stairs = (id: string, rect: [number, number, number, number]): MapObject => ({ id, type: 'stairs', shape: { rect }, direction: 'n' });
const ladder = (id: string, at: [number, number]): MapObject => ({ id, type: 'prop', asset: 'ladder', at });
const labelled = (o: MapObject, label: string) => ({ ...o, label }) as MapObject;
const flat = (labels: Map<string, Map<string, string>>) => Object.fromEntries([...labels].map(([k, v]) => [k, Object.fromEntries(v)]));
const layer = (layers: Layer[], name: string) => layers.find((l) => l.name === name);

describe('floor numbers', () => {
  it('shows below-ground floors with a proper minus sign', () => {
    expect([2, 1, 0, -1, -2].map(floorText)).toEqual(['2', '1', '0', '−1', '−2']);
    expect(labelText('-1C')).toBe('−1C');
    expect(labelText('2B')).toBe('2B');
  });

  it('titles storeys by floor for the storey picker', () => {
    expect(storeyTitle({ name: 'Tower', level: { group: 'g', name: "Wizard's floor", order: 2 } })).toBe("2 · Wizard's floor");
    expect(storeyTitle({ name: 'Tower', level: { group: 'g', name: 'Cellar', order: -1 } })).toBe('−1 · Cellar');
    expect(storeyTitle({ name: 'Crypt' })).toBe('Crypt');
  });

  it('says which floor a storey is in the description', () => {
    const map = { ...testMap(), level: { group: 'map_keep', name: 'Cellar', order: -1 } };
    expect(describeMap(map).split('\n')[1]).toBe('Floor −1 (Cellar) of map_keep.');
    expect(describeMap(testMap())).not.toContain('Floor ');
  });
});

describe('stairLabels', () => {
  it("labels the user's example: a staircase from the ground to the 2nd floor, then a ladder to the 3rd", () => {
    const labels = stairLabels([
      storey('third', 3, [ladder('i1', [20.5, 3.5])]),
      storey('second', 2, [stairs('s1', [2, 2, 2, 3]), ladder('i1', [20.5, 3.5])]),
      storey('first', 1, [stairs('s1', [2, 2, 2, 3])]),
      storey('ground', 0, [stairs('s1', [2, 2, 2, 3])]),
    ]);
    expect(flat(labels)).toEqual({
      ground: { s1: '0A' },
      first: { s1: '1A' },
      second: { s1: '2A', i1: '2B' },
      third: { i1: '3B' },
    });
  });

  it('orders flights by their lowest floor, then top to bottom and left to right; loose ones get their own letter', () => {
    const labels = stairLabels([
      storey('up', 0, [stairs('a', [10, 10, 1, 2]), stairs('b', [2, 10, 1, 2]), stairs('c', [30, 1, 1, 2]), ladder('d', [2.5, 20.5])]),
      storey('down', -1, [stairs('x', [30, 1, 1, 2])]),
    ]);
    expect(flat(labels)).toEqual({
      down: { x: '-1A' }, // the flight to the cellar starts lowest
      up: { c: '0A', b: '0B', a: '0C', d: '0D' },
    });
  });

  it('numbers a map without storeys as floor 0', () => {
    expect(flat(stairLabels([storey('m', null, [stairs('s1', [0, 0, 1, 1]), ladder('i2', [5.5, 5.5])])]))).toEqual({ m: { s1: '0A', i2: '0B' } });
  });

  it('counts past Z', () => {
    expect([0, 25, 26, 27, 51, 52].map(chainLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });

  it('only changes the labels that differ', () => {
    const map: DelveMap = { ...testMap(), objects: [labelled(stairs('s1', [0, 0, 1, 1]), '0A'), ladder('i2', [5.5, 5.5]), { id: 'i3', type: 'prop', asset: 'chest-closed', at: [8.5, 8.5] }] };
    const ops = stairLabelOps(map, new Map([['s1', '0A'], ['i2', '0B']]));
    expect(ops).toEqual([{ op: 'update', id: 'i2', set: { label: '0B' } }]);
    expect(applyOps(map, ops).map.objects.find((o) => o.id === 'i2')).toMatchObject({ label: '0B' });
  });

  it('keeps labels short', () => {
    const bad = { ...testMap(), objects: [labelled(stairs('s1', [0, 0, 1, 1]), 'far too long')] };
    expect(() => validateMap(bad)).toThrow(ValidationError);
  });
});

describe('GM marks for storeys', () => {
  const tower = (): DelveMap => ({
    ...testMap(),
    level: { group: 'g', name: 'Cellar', order: -1 },
    objects: [...testMap().objects, labelled(stairs('s1', [8, 26, 2, 2]), '-1A'), ladder('i1', [16.5, 26.5])],
  });

  it('draws the floor number big in the top-left corner of the GM view only', () => {
    const scene = buildScene(tower());
    const l = layer(scene.layers, 'floor-number');
    expect(l?.kind === 'text' && l.items.map((i) => i.text)).toEqual(['−1']);
    if (l?.kind !== 'text') throw new Error('no floor number');
    expect(l.items[0]!.size).toBeGreaterThanOrEqual(1.6);
    expect(l.items[0]!.at[0]).toBeLessThan(scene.bounds.x0 + 3);
    expect(l.items[0]!.at[1]).toBeLessThan(scene.bounds.y0 + 2);
    expect(l.font).toBe('Marcellus SC');
    for (const s of [buildScene(tower(), { view: 'players' }), buildScene(tower(), { floorNumber: false }), buildScene(tower(), { background: false }), buildScene(testMap())]) {
      expect(layer(s.layers, 'floor-number')).toBeUndefined();
    }
    expect(handoutSvg(tower()).svg).not.toContain('−1');
  });

  it('tags every stair with its label in the GM view, "?" where one is missing', () => {
    const scene = buildScene(tower());
    const l = layer(scene.layers, 'stair-labels');
    if (l?.kind !== 'tags') throw new Error('no stair labels');
    expect(l.items).toEqual([
      { text: '−1A', at: [9, 27] },
      { text: '?', at: [16.5, 26.5] },
    ]);
    expect(l.size).toBe(0.5);
    const svg = renderSvg(tower());
    expect(svg).toContain('data-layer="stair-labels"');
    expect(svg).toMatch(/<rect x="8\.\d+" y="26\.75" width="[\d.]+" height="0\.5" rx="0\.125" fill="#1B1F24" fill-opacity="0\.9"\/><text x="9" y="[\d.]+" font-size="0\.34" text-anchor="middle" fill="#FFFFFF">−1A<\/text>/);
  });

  it('never shows stair labels to players, in handouts or in Dungeon Scrawl exports', () => {
    expect(layer(buildScene(tower(), { view: 'players' }).layers, 'stair-labels')).toBeUndefined();
    expect(handoutSvg(tower()).svg).not.toContain('−1A');
    const ds = JSON.stringify(toDungeonScrawl(tower(), { view: 'gm' }));
    expect(ds).not.toContain('-1A');
    expect(ds).not.toContain('−1A');
  });

  it('draws nothing new for a map whose stairs have no labels', () => {
    const map = { ...testMap(), objects: [...testMap().objects, stairs('s1', [8, 26, 2, 2])] };
    expect(layer(buildScene(map).layers, 'stair-labels')).toBeUndefined();
  });

  it('lists the stair labels in the description', () => {
    expect(describeMap(tower())).toContain('Stair labels (GM view): s1 -1A, i1 (none)');
  });
});

describe('solid cutouts', () => {
  const withPillars = (fill?: 'solid' | 'rock'): DelveMap => {
    const map = testMap();
    for (const o of map.objects) if (o.type === 'cutout' && fill) Object.assign(o, { fill });
    return map;
  };

  it('fills solid pillars with the wall colour, after the floor and before the walls, in both views', () => {
    for (const view of ['gm', 'players'] as const) {
      const names = buildScene(withPillars('solid'), { view }).layers.map((l) => l.name);
      expect(names).toContain('solid-cutouts');
      expect(names.indexOf('solid-cutouts')).toBeGreaterThan(names.indexOf('floor'));
      expect(names.indexOf('solid-cutouts')).toBeLessThan(names.indexOf('walls'));
    }
    const l = layer(buildScene(withPillars('solid')).layers, 'solid-cutouts');
    if (l?.kind !== 'fill') throw new Error('no fill');
    expect(l.color).toBe('#111111');
    expect(l.polygons).toHaveLength(4); // the boss chamber's four pillars
  });

  it('leaves rock cutouts and old maps exactly as they were', () => {
    expect(renderSvg(withPillars('rock'))).toBe(renderSvg(testMap()));
    expect(layer(buildScene(testMap()).layers, 'solid-cutouts')).toBeUndefined();
  });

  it('fills only the floor a cutout took away, and follows rough walls', () => {
    const map = withPillars('solid');
    const area = (polys: ReturnType<typeof solidCutouts>) =>
      polys.reduce((s, p) => s + Math.abs(p.outer.reduce((a, q, i) => a + q[0] * p.outer[(i + 1) % p.outer.length]![1] - p.outer[(i + 1) % p.outer.length]![0] * q[1], 0)) / 2, 0);
    const pillars = map.objects.filter((o) => o.type === 'cutout');
    const expected = pillars.reduce((s, o) => s + ('rect' in o.shape ? o.shape.rect[2] * o.shape.rect[3] : 'circle' in o.shape ? Math.PI * o.shape.circle[2] ** 2 : 0), 0);
    expect(area(solidCutouts(map, computeFloor(map)))).toBeCloseTo(expected, 1);
    // a cutout reaching out of the room fills only its part inside the room
    const edge = { ...map, objects: [...map.objects, { id: 'p9', type: 'cutout' as const, shape: { rect: [6, 24, 2, 2] as [number, number, number, number] }, fill: 'solid' as const }] };
    const extra = area(solidCutouts(edge, computeFloor(edge))) - expected;
    expect(extra).toBeGreaterThan(0.5);
    expect(extra).toBeLessThan(2);
    // with rough walls the fill still covers the whole hole
    const rough = { ...map, roughness: 9 };
    expect(layer(buildScene(rough).layers, 'solid-cutouts')).toBeDefined();
  });
});
