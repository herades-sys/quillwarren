import { describe, expect, it } from 'vitest';
import { applyOps, buildScene, describeMap, markerAt, sceneToSvg, toDungeonScrawl, validateMap, type DelveMap, type Marker } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const withMarkers = (): DelveMap => {
  const map = testMap();
  map.objects.push(
    { id: 'm1', type: 'marker', kind: 'discover', at: [12.5, 5.5], text: 'A silver coin is hidden under the loose flagstone.' },
    { id: 'm2', type: 'marker', kind: 'interact', at: [14.5, 5.5], text: 'The lever for the trapdoor in room 4.' },
    { id: 'm3', type: 'marker', kind: 'trap', at: [16.5, 5.5], text: 'Poison dart trap with a pressure plate.', done: true },
  );
  return validateMap(map);
};

describe('GM markers', () => {
  it('are map objects with a kind, a spot and a note', () => {
    expect(() => withMarkers()).not.toThrow();
    const bad = testMap();
    bad.objects.push({ id: 'm9', type: 'marker', kind: 'secret', at: [1, 1], text: '' } as unknown as Marker);
    expect(() => validateMap(bad)).toThrow(/kind/);
  });

  it('show only in the GM view, tagged so the viewer can click them, struck through when done', () => {
    const map = withMarkers();
    const gm = buildScene(map, { view: 'gm' });
    const layer = gm.layers.at(-1)!;
    expect(layer).toMatchObject({ name: 'markers', kind: 'markers' });
    expect(layer.kind === 'markers' && layer.items.map((m) => [m.id, m.kind, m.done])).toEqual([
      ['m1', 'discover', false],
      ['m2', 'interact', false],
      ['m3', 'trap', true],
    ]);
    const svg = sceneToSvg(gm);
    expect(svg).toContain('data-marker="m1" data-kind="discover"');
    expect(svg).toContain('data-marker="m3" data-kind="trap" data-done=""');
    expect(buildScene(map, { view: 'players' }).layers.some((l) => l.name === 'markers')).toBe(false);
    expect(sceneToSvg(buildScene(map, { view: 'players', fog: 'hide' }))).not.toContain('data-marker');
    // they don't change the picture's size, so GM and players' exports line up
    expect(gm.bounds).toEqual(buildScene(testMap(), { view: 'gm' }).bounds);
  });

  it('are listed for Claude with their notes', () => {
    const text = describeMap(withMarkers());
    expect(text).toContain('GM markers (GM view only):');
    expect(text).toMatch(/\? m1 at 12\.5,5\.5 .*: "A silver coin/);
    expect(text).toMatch(/trap m3 .* \(done\): "Poison dart trap/);
  });

  it('move, change and strike through like any object', () => {
    let map = withMarkers();
    map = applyOps(map, [{ op: 'move', ids: ['m1'], dx: 2, dy: 1 }]).map;
    expect(map.objects.find((o) => o.id === 'm1')).toMatchObject({ at: [14.5, 6.5] });
    const done = applyOps(map, [{ op: 'update', id: 'm2', set: { done: true, text: '' } }]);
    expect(done.map.objects.find((o) => o.id === 'm2')).toMatchObject({ done: true, text: '' });
    expect(applyOps(done.map, done.inverse).map.objects.find((o) => o.id === 'm2')).not.toHaveProperty('done');
  });

  it('are found under the pointer, the nearest first', () => {
    const map = withMarkers();
    expect(markerAt(map.objects, [12.6, 5.4])?.id).toBe('m1');
    expect(markerAt(map.objects, [13.5, 5.5])).toBeNull();
    expect(markerAt(map.objects, [13.4, 5.5], 0.7)?.id).toBe('m1');
  });

  it('stay out of Dungeon Scrawl exports', () => {
    const ds = JSON.stringify(toDungeonScrawl(withMarkers()));
    expect(ds).not.toContain('silver coin');
  });
});
