import { describe, expect, it } from 'vitest';
import { applyOps, buildScene, describeMap, floorArea, fogShade, revealedBounds, sceneToSvg, updateFog, visibleFloor, visiblePaths, type DelveMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const withFog = (fog: DelveMap['fog']): DelveMap => ({ ...testMap(), ...(fog ? { fog } : {}) });
const area = (polys: { outer: [number, number][]; holes: [number, number][][] }[]) => {
  const ring = (r: [number, number][]) => Math.abs(r.reduce((s, [x, y], i) => s + x * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * y, 0)) / 2;
  return polys.reduce((s, p) => s + ring(p.outer) - p.holes.reduce((t, h) => t + ring(h), 0), 0);
};

describe('updateFog', () => {
  it('reveals and covers rooms, turns fog on when revealing, and checks ids', () => {
    const map = testMap();
    const f1 = updateFog(map, { reveal: ['r1', 'c1'] });
    expect(f1).toEqual({ on: true, revealed: ['r1', 'c1'] });
    const f2 = updateFog({ ...map, fog: f1 }, { cover: ['c1'], coverArea: { rect: [7, 25, 2, 2] } });
    expect(f2).toEqual({ on: true, revealed: ['r1'], hide: [{ rect: [7, 25, 2, 2] }] });
    // revealing r1 again lifts the cover-up that lies over it
    expect(updateFog({ ...map, fog: f2 }, { reveal: ['r1'] }).hide).toBeUndefined();
    expect(() => updateFog(map, { reveal: ['nope', 'd1'] })).toThrow(/nope, d1 are not rooms/);
    expect(updateFog(map, { revealAll: true }).revealed?.length).toBe(map.objects.filter((o) => o.type === 'room' || o.type === 'corridor').length);
    expect(updateFog({ ...map, fog: f1 }, { reset: true })).toEqual({ on: true });
    expect(updateFog({ ...map, fog: f1 }, { on: false })).toEqual({ on: false, revealed: ['r1', 'c1'] });
    // revealing both ends of a corridor reveals the corridor too (c1 joins r1 and r2)
    expect(updateFog(map, { reveal: ['r1', 'r2'] }).revealed).toEqual(['r1', 'r2', 'c1']);
  });
});

describe('what the players can see', () => {
  it('is nothing until something is revealed, then the revealed floor plus a margin for walls', () => {
    expect(visibleFloor(withFog({ on: true }))).toEqual([]);
    expect(area(visibleFloor(withFog({ on: false })))).toBeCloseTo(floorArea(testMap()));
    const one = withFog({ on: true, revealed: ['r1'] });
    expect(area(visibleFloor(one))).toBeCloseTo(36.6); // room 1 (6×6) plus the 0.3 margin into the 2-wide corridor mouth
    expect(revealedBounds(one)).toEqual({ x0: 6.7, y0: 24.7, x1: 13.3, y1: 31.3 });
    expect(visiblePaths(withFog({ on: true, show: [{ rect: [0, 0, 2, 2] }] })).length).toBe(1);
  });

  it('shades the rest in the GM view and leaves it out in the players view', () => {
    const map = withFog({ on: true, revealed: ['r1'] });
    const gm = buildScene(map, { fog: 'dim' });
    const shade = gm.layers.find((l) => l.name === 'fog');
    expect(shade).toMatchObject({ kind: 'fill', opacity: 0.5 });
    expect(gm.layers.at(-1)?.name).toBe('room-numbers'); // numbers stay readable over the shade
    expect(fogShade(withFog({ on: false, revealed: ['r1'] }), 1)).toEqual([]);

    // fog off, or no fog option: the players' picture is the whole map
    const whole = (m: DelveMap, o: Parameters<typeof buildScene>[1]) => sceneToSvg(buildScene(m, o));
    expect(whole(withFog({ on: false }), { view: 'players', fog: 'hide' })).toBe(whole(withFog({ on: false }), { view: 'players' }));
  });

  it('builds the players picture only from what they have seen', () => {
    const map: DelveMap = {
      ...withFog({ on: true, revealed: ['r1'] }),
      objects: [
        ...testMap().objects,
        { id: 'i1', type: 'prop', asset: 'chest-closed', at: [10.5, 27.5] }, // in room 1
        { id: 'i2', type: 'prop', asset: 'throne', at: [10, 3] }, // in the unrevealed boss chamber
        { id: 'l1', type: 'label', text: 'Secret lair', at: [10, 5] },
        { id: 't1', type: 'terrain', asset: 'lava', shape: { rect: [6, 2, 4, 4] } },
      ],
    };
    const s = buildScene(map, { view: 'players', fog: 'hide' });
    const layer = (n: string) => s.layers.find((l) => l.name === n);
    const floor = layer('floor');
    expect(floor?.kind === 'fill' && area(floor.polygons)).toBeCloseTo(36.6);
    const props = layer('props');
    expect(props?.kind === 'assets' && props.items.map((i) => i.id)).toEqual(['i1']);
    expect(layer('labels')).toBeUndefined();
    expect(s.layers.some((l) => l.name.startsWith('terrain:'))).toBe(false);
    // walls: only the pieces around room 1 (x 7–13, y 25–31, with the 0.3 margin)
    const walls = layer('walls');
    const pts = walls?.kind === 'stroke' ? walls.lines.flatMap((l) => l.points) : [];
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every(([x, y]) => x > 6.6 && x < 13.4 && y > 24.6 && y < 31.4)).toBe(true);
    // the picture is framed on what's seen, not the whole dungeon
    const free: DelveMap = { ...map, grid: { type: 'square', unit: '5 ft' } }; // no fixed canvas size
    expect(buildScene(free, { view: 'players', fog: 'hide' }).bounds.y0).toBeGreaterThan(buildScene(free, { view: 'players' }).bounds.y0);
    // nothing revealed yet: an empty picture
    const none = buildScene({ ...map, fog: { on: true } }, { view: 'players', fog: 'hide' });
    const nf = none.layers.find((l) => l.name === 'floor');
    expect(nf?.kind === 'fill' && nf.polygons).toEqual([]);
  });

  it('is in the map summary and survives undo', () => {
    const { map, inverse } = applyOps(testMap(), [{ op: 'update_map', set: { fog: { on: true, revealed: ['r1'] } } }]);
    expect(describeMap(map)).toContain('Fog of war: on. Revealed: 1 Entrance hall [r1].');
    expect(applyOps(map, inverse).map.fog).toBeUndefined();
  });
});

describe('a fogged picture at full size', () => {
  it("keeps the players' picture as big as without fog, so a tabletop page lines up", () => {
    // a map without grid.bounds, whose picture would otherwise shrink to what is revealed
    const plain = { ...testMap(), grid: { type: 'square' as const } };
    const fogged: DelveMap = { ...plain, fog: { on: true, revealed: ['r1'] } };
    const whole = buildScene(plain, { view: 'players' }).bounds;
    expect(buildScene(fogged, { view: 'players', fog: 'hide' }).bounds).not.toEqual(whole);
    expect(buildScene(fogged, { view: 'players', fog: 'hide', fullBounds: true }).bounds).toEqual(whole);
    // still nothing unrevealed in it
    expect(area(buildScene(fogged, { view: 'players', fog: 'hide', fullBounds: true }).clips.floor!)).toBeLessThan(floorArea(testMap()) / 2);
  });
});

describe('a picture in a fixed frame', () => {
  it('draws exactly the frame it is given, in both views', () => {
    const frame = { x0: -3, y0: -3, x1: 23, y1: 35 };
    const fogged = withFog({ on: true, revealed: ['r1'] });
    expect(buildScene(fogged, { view: 'gm', fog: 'dim', frame }).bounds).toEqual(frame);
    expect(buildScene(fogged, { view: 'players', fog: 'hide', frame }).bounds).toEqual(frame);
  });
});
