import { describe, expect, it } from 'vitest';
import { applyOps, buildScene, PRESETS, renderSvg, resolveStyle, type Layer, type Scene } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const layer = (scene: Scene, name: string): Layer | undefined => scene.layers.find((l) => l.name === name);
const strokes = (l: Layer | undefined): string[] =>
  l && l.kind === 'stroke' ? l.lines.map((x) => JSON.stringify(x.points)) : [];
const texts = (scene: Scene): string[] =>
  scene.layers.flatMap((l) => (l.kind === 'text' ? l.items.map((i) => i.text) : []));

describe('buildScene', () => {
  it('draws the layers in order, hatching behind the floor and walls on top', () => {
    const names = buildScene(testMap()).layers.map((l) => l.name);
    expect(names.slice(0, 6)).toEqual(['background', 'shading', 'hatching', 'shadow', 'floor', 'grid']);
    expect(names.indexOf('walls')).toBeGreaterThan(names.indexOf('floor'));
    expect(names.indexOf('room-numbers')).toBe(names.length - 1);
  });

  it('draws room numbers in the lining-figure face and free labels in the old-style one', () => {
    const { map } = applyOps(testMap(), [{ op: 'add', object: { id: 'l1', type: 'label', text: 'Altar', at: [10, 3] } }]);
    const scene = buildScene(map);
    const font = (name: string) => {
      const l = layer(scene, name);
      return l?.kind === 'text' ? l.font : undefined;
    };
    expect(font('room-numbers')).toBe('Marcellus SC');
    expect(font('labels')).toBe('IM FELL English');
  });

  it('keeps the whole dungeon plus hatching inside whole-square bounds', () => {
    const { bounds } = buildScene(testMap());
    // floor spans 0..20 × 1..31; hatching reach ~1.3 plus a 1-square margin
    expect(bounds.x0).toBeLessThan(-2);
    expect(bounds.x1).toBeGreaterThan(22);
    expect(Object.values(bounds).every(Number.isInteger)).toBe(true);
  });

  it('is deterministic', () => {
    expect(renderSvg(testMap())).toBe(renderSvg(testMap()));
  });

  it('keeps hatching in place when something far away changes', () => {
    const before = strokes(layer(buildScene(testMap()), 'hatching'));
    const { map } = applyOps(testMap(), [
      { op: 'add', object: { id: 'far', type: 'room', shape: { rect: [60, 60, 4, 4] } } },
    ]);
    const after = new Set(strokes(layer(buildScene(map), 'hatching')));
    expect(before.length).toBeGreaterThan(1000);
    expect(before.every((s) => after.has(s))).toBe(true);
  });

  it('shows room numbers and the secret door only to the GM', () => {
    const gm = buildScene(testMap(), { view: 'gm' });
    const players = buildScene(testMap(), { view: 'players' });
    expect(texts(gm)).toEqual(expect.arrayContaining(['1', '2', '3', '4', '5', '6', 'S']));
    expect(texts(players)).toEqual([]);
    // players get a solid wall across the secret passage (d6 at x 16, y 5..6)
    expect(strokes(layer(players, 'walls'))).toContain(JSON.stringify([[16, 5], [16, 6]]));
    expect(layer(players, 'secret-doors')).toBeUndefined();
  });

  it('renders every preset; styles without hatching have no hatch layer', () => {
    for (const preset of Object.keys(PRESETS)) {
      const map = { ...testMap(), style: { preset } };
      const scene = buildScene(map);
      expect(scene.layers.length).toBeGreaterThan(4);
      expect(Boolean(layer(scene, 'hatching'))).toBe(PRESETS[preset]!.hatching !== null);
    }
  });

  it('applies overrides, including dotted keys', () => {
    const style = resolveStyle({ style: { preset: 'clean', overrides: { 'walls.width': 0.2, grid: { color: '#ff0000' } } } });
    expect(style.walls.width).toBe(0.2);
    expect(style.walls.color).toBe(PRESETS.clean!.walls.color);
    expect(style.grid.color).toBe('#ff0000');
    expect(() => resolveStyle({ style: { preset: 'neon' } })).toThrow(/unknown style preset "neon"/);
  });
});

describe('sceneToSvg', () => {
  it('sizes the image at ppg pixels per square with a viewBox in squares', () => {
    const scene = buildScene(testMap());
    const svg = renderSvg(testMap(), { ppg: 70 });
    const w = scene.bounds.x1 - scene.bounds.x0;
    expect(svg).toMatch(new RegExp(`^<svg [^>]*width="${w * 70}"`));
    expect(svg).toContain(`viewBox="${scene.bounds.x0} ${scene.bounds.y0} `);
  });

  it('escapes label text', () => {
    const { map } = applyOps(testMap(), [{ op: 'add', object: { id: 'l1', type: 'label', text: 'Trap <here> & "there"', at: [10, 20] } }]);
    expect(renderSvg(map)).toContain('Trap &lt;here&gt; &amp; &quot;there&quot;');
  });
});
