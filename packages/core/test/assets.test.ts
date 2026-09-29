// Props, terrain and storeys: the SVG whitelist, the catalog, rendering, and the model.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  ASSETS,
  assetInfo,
  buildScene,
  CATEGORIES,
  describeMap,
  levelSiblings,
  parseAssetSvg,
  PRESETS,
  propBounds,
  propCentre,
  recolor,
  sceneToSvg,
  terrainTint,
  validateMap,
  type DelveMap,
  type Layer,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const ASSET_DIR = resolve(import.meta.dirname, '../../../delve-props-design-system/assets');

describe('parseAssetSvg', () => {
  it('keeps plain shapes and drops everything else', () => {
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100" onload="alert(1)">
      <metadata><c2pa:manifest>AAAA</c2pa:manifest></metadata><title>t</title><!-- note -->
      <script>alert(1)</script><text x="1" y="1">A</text><image href="http://x/y.png"/>
      <g transform="translate(4 2)"><path d="M0 0L10 10Z" fill="#999999" stroke="#000000" stroke-width="4" onclick="x()" class="k"/>
      <rect x="1" y="2" width="3" height="4" fill="#fff" style="fill:red"/><circle cx="5" cy="5" r="2" fill="#123456"/></g>
      <foreignObject><div>hi</div></foreignObject><use href="#a"/></svg>`;
    const a = parseAssetSvg(svg);
    expect(a.w).toBe(2);
    expect(a.h).toBe(1);
    expect(a.body).toBe(
      '<g transform="translate(4 2)"><path d="M0 0L10 10Z" fill="#999999" stroke="#000000" stroke-width="4"/>' +
        '<rect x="1" y="2" width="3" height="4" fill="#FFFFFF"/><circle cx="5" cy="5" r="2" fill="#000000"/></g>',
    );
    for (const bad of ['script', 'alert', 'onclick', 'href', 'metadata', 'style', 'class', 'text', 'foreignObject']) expect(a.body).not.toContain(bad);
    expect(a.problems.join(' ')).toMatch(/colour #123456 snapped/);
  });

  it('closes open groups and needs a size', () => {
    expect(parseAssetSvg('<svg viewBox="0 0 100 100"><g><g><path d="M0 0"/></g>').body).toBe('<g><g><path d="M0 0"/></g></g>');
    expect(parseAssetSvg('<svg><path d="M0 0"/></svg>').problems).toContain('no usable size');
  });

  it('swaps the three inks per style', () => {
    expect(recolor('<path fill="#FFFFFF" stroke="#000000"/><rect fill="#999999"/>', { ink: '#111', paper: '#eee', shade: '#888' })).toBe(
      '<path fill="#eee" stroke="#111"/><rect fill="#888"/>',
    );
  });
});

describe('the asset catalog', () => {
  it('has every category, unique ids, and files that pass the whitelist at their stated size', () => {
    expect(ASSETS.length).toBeGreaterThan(100);
    expect(new Set(ASSETS.map((a) => a.id)).size).toBe(ASSETS.length);
    for (const c of CATEGORIES) expect(ASSETS.some((a) => a.category === c.id)).toBe(true);
    for (const a of ASSETS) {
      const parsed = parseAssetSvg(readFileSync(resolve(ASSET_DIR, a.file), 'utf8'));
      expect(parsed.problems, a.file).toEqual([]);
      expect([parsed.w, parsed.h], a.file).toEqual([a.w, a.h]);
      expect(parsed.body.length, a.file).toBeLessThan(300_000); // lava, the busiest tile, is about 116 KB
    }
  });

  it('knows terrain from props', () => {
    expect(assetInfo('water-shallow')).toMatchObject({ kind: 'terrain', w: 2, h: 2, tint: '#BFD8DC' });
    expect(assetInfo('chair')).toMatchObject({ kind: 'prop', category: 'furniture', w: 1, h: 1 });
    expect(assetInfo('table-round')?.category).toBe('furniture'); // a style-sheet sample, filed with its kind
  });
});

describe('prop footprints', () => {
  it('centre on at and swap sides when turned', () => {
    // bench is 2×1
    expect(propBounds({ asset: 'bench', at: [4, 5.5] })).toEqual({ x0: 3, y0: 5, x1: 5, y1: 6 });
    expect(propBounds({ asset: 'bench', at: [4, 5.5], rotation: 90 })).toEqual({ x0: 3.5, y0: 4.5, x1: 4.5, y1: 6.5 });
    expect(propBounds({ asset: 'bench', at: [4, 5.5], scale: 2 })).toEqual({ x0: 2, y0: 4.5, x1: 6, y1: 6.5 });
    expect(propBounds({ asset: 'nope', at: [1, 1] })).toEqual({ x0: 0.5, y0: 0.5, x1: 1.5, y1: 1.5 });
    expect(propCentre('bench', [3, 5])).toEqual([4, 5.5]);
    expect(propCentre('bench', [3, 5], 270)).toEqual([3.5, 6]);
  });
});

const withAssets = (): DelveMap =>
  applyOps(testMap(), [
    { op: 'add', object: { id: 'i1', type: 'prop', asset: 'chest-closed', at: [10.5, 27.5] } },
    { op: 'add', object: { id: 'i2', type: 'prop', asset: 'cracks', at: [9.5, 26.5] } },
    { op: 'add', object: { id: 'i3', type: 'prop', asset: 'trap', at: [11.5, 28.5] } },
    { op: 'add', object: { id: 'i4', type: 'prop', asset: 'compass-rose', at: [40.5, 1.5] } },
    { op: 'add', object: { id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [6, 2, 4, 4] } } },
  ]).map;

const bodies = (id: string) => (assetInfo(id) ? parseAssetSvg(readFileSync(resolve(ASSET_DIR, assetInfo(id)!.file), 'utf8')).body : undefined);
const names = (layers: Layer[]) => layers.map((l) => l.name);

describe('rendering props and terrain', () => {
  it('puts terrain over the floor, decals under the walls, props over the doors and GM symbols last', () => {
    const scene = buildScene(withAssets(), { assets: bodies });
    const n = names(scene.layers);
    const at = (x: string) => n.indexOf(x);
    expect(at('terrain:t1')).toBeGreaterThan(at('floor'));
    expect(at('terrain:t1')).toBeLessThan(at('grid'));
    expect(at('decals')).toBeLessThan(at('walls'));
    expect(at('props')).toBeGreaterThan(at('doors'));
    expect(at('symbols')).toBeGreaterThan(at('props'));
    const props = scene.layers.find((l) => l.name === 'props');
    expect(props?.kind === 'assets' && props.items.map((i) => i.asset)).toEqual(['chest-closed', 'compass-rose']);
  });

  it('hides GM symbols from players and grows the picture to fit props outside the dungeon', () => {
    expect(names(buildScene(withAssets(), { view: 'players' }).layers)).not.toContain('symbols');
    const plain = buildScene(testMap()).bounds;
    const furnished = buildScene(withAssets()).bounds;
    expect(furnished.x1).toBeGreaterThanOrEqual(42 + 1);
    expect(furnished.y0).toBe(plain.y0);
  });

  it('writes recoloured art, a tile pattern, and dashed stand-ins until the art is loaded', () => {
    const svg = sceneToSvg(buildScene(withAssets(), { assets: bodies }), { idPrefix: 'm-' });
    const ink = PRESETS['classic-hatching']!.props.ink;
    expect(svg).toContain(`stroke="${ink}"`);
    expect(svg).toMatch(/<pattern id="m-tile-water-shallow-[0-9A-F]+" patternUnits="userSpaceOnUse" x="0" y="0" width="2" height="2">/);
    expect(svg).toMatch(/fill="url\(#m-tile-water-shallow-/);
    expect(svg).toContain(`fill="${terrainTint('#BFD8DC', PRESETS['classic-hatching']!)}"`);
    expect(svg).toMatch(/translate\(10\.5 27\.5\) scale\(0\.01\) translate\(-50 -50\)/);
    const bare = sceneToSvg(buildScene(withAssets()));
    expect(bare).toContain('data-missing="chest-closed"');
    expect(bare).not.toContain('<pattern');
  });

  it('tints terrain per style: as given on parchment, gray for print', () => {
    expect(terrainTint('#BFD8DC', PRESETS['classic-hatching']!)).toBe('#BFD8DC');
    const print = terrainTint('#BFD8DC', PRESETS.print!);
    expect(print.slice(1, 3)).toBe(print.slice(3, 5));
    expect(print.slice(3, 5)).toBe(print.slice(5, 7));
  });
});

describe('terrain and storeys in the model', () => {
  it('validates terrain, moves it, and says what is where', () => {
    const map = withAssets();
    expect(() => validateMap(map)).not.toThrow();
    const moved = applyOps(map, [{ op: 'move', ids: ['t1'], dx: 1, dy: 0 }]).map;
    expect(moved.objects.find((o) => o.id === 't1')).toMatchObject({ shape: { rect: [7, 2, 4, 4] } });
    const text = describeMap(map);
    expect(text).toContain('Props:');
    expect(text).toMatch(/in 1 Entrance hall: Closed Chest \(i1\)/);
    expect(text).toMatch(/Terrain: t1 Shallow Water 4×4 in 5 Boss chamber/);
  });

  it('keeps storeys as a map field that update_map can change and undo', () => {
    const level = { group: 'map_aaaaaaaaaaaa', name: 'Cellar', order: -1 };
    const { map, inverse } = applyOps(testMap(), [{ op: 'update_map', set: { level } }]);
    expect(map.level).toEqual(level);
    expect(applyOps(map, inverse).map.level).toBeUndefined();
    expect(() => applyOps(testMap(), [{ op: 'update_map', set: { level: { group: 'x', name: '', order: 0 } } }])).toThrow();
  });

  it('lists a map with its storeys in order', () => {
    const g = { group: 'g1' };
    const maps = [
      { id: 'a', name: 'Tower', level: { ...g, name: 'Top', order: 2 } },
      { id: 'b', name: 'Tower', level: { ...g, name: 'Ground', order: 0 } },
      { id: 'c', name: 'Other' },
      { id: 'd', name: 'Tower', level: { ...g, name: 'Cellar', order: -1 } },
    ];
    expect(levelSiblings(maps, 'b').map((m) => m.id)).toEqual(['d', 'b', 'a']);
    expect(levelSiblings(maps, 'c').map((m) => m.id)).toEqual(['c']);
    expect(levelSiblings(maps, 'zz')).toEqual([]);
  });
});
