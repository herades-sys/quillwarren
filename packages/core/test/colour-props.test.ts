// Colour props: the palette whitelist, the catalog from catalog-colour.json,
// the colours per style, the floor layer, hidden ones, the brush's variants
// and the modular ruin walls.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  assetInfo,
  buildScene,
  COLOUR_ASSETS,
  COLOUR_CATEGORIES,
  COLOUR_HEX,
  COLOUR_PALETTE,
  colourMap,
  groupVariants,
  HIDDEN_ASSETS,
  hiddenByDefault,
  lightness,
  modularAt,
  parseAssetSvg,
  PRESETS,
  propHidden,
  propLayer,
  rampLevels,
  scatterAlong,
  sceneToSvg,
  validateMap,
  type DelveMap,
  type Layer,
  type Prop,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const ASSET_DIR = resolve(ROOT, 'delve-props-design-system/assets');
const body = (id: string) => (assetInfo(id) ? parseAssetSvg(readFileSync(resolve(ASSET_DIR, assetInfo(id)!.file), 'utf8'), assetInfo(id)).body : undefined);

const withProps = (...props: Omit<Prop, 'type'>[]): DelveMap => {
  const map = testMap();
  map.objects.push(...props.map((p) => ({ type: 'prop' as const, ...p })));
  return validateMap(map);
};
const assetLayers = (layers: Layer[]) => layers.flatMap((l) => (l.kind === 'assets' ? [{ name: l.name, assets: l.items.map((i) => i.asset), colours: l.colours }] : []));

describe('the palette whitelist', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  const leaf = '<path d="M10 10L90 90Z" fill="#4f803c" stroke="#000000" stroke-width="4"/>';
  const dashed = '<path d="M11 11L89 11" stroke="#C0524A" stroke-width="2" stroke-dasharray="7 5"/>';

  it('keeps the palette for colour props and the root group with its inherited attributes', () => {
    const a = parseAssetSvg(svg(leaf), { palette: 'colour' });
    expect(a.problems).toEqual([]);
    expect(a.body).toBe('<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10L90 90Z" fill="#4F803C" stroke="#000000" stroke-width="4"/></g>');
  });

  it('refuses the palette for ink props: they keep the three inks', () => {
    const a = parseAssetSvg(svg(leaf));
    expect(a.body).toContain('fill="#999999"');
    expect(a.body).not.toContain('#4F803C');
    expect(a.problems.join(' ')).toMatch(/colour #4f803c snapped to #999999/);
  });

  it('snaps a colour off the palette to the nearest one', () => {
    const a = parseAssetSvg(svg('<rect x="1" y="1" width="9" height="9" fill="#4F803D"/>'), { palette: 'colour' });
    expect(a.body).toContain('fill="#4F803C"');
    expect(a.problems.join(' ')).toMatch(/snapped to #4F803C/);
  });

  it('allows a dash pattern only on hidden colour props (their GM outline)', () => {
    expect(parseAssetSvg(svg(dashed), { palette: 'colour', hidden: true }).body).toContain('stroke-dasharray="7 5"');
    for (const opts of [{ palette: 'colour' as const }, {}]) {
      const a = parseAssetSvg(svg(dashed), opts);
      expect(a.body).not.toContain('dasharray');
      expect(a.problems.join(' ')).toMatch(/stroke-dasharray=.* dropped/);
    }
  });

  it('is the palette of the prompt pack, exactly', () => {
    const pack = readFileSync(resolve(ROOT, 'docs/ASSETS-COLOUR.md'), 'utf8');
    const part = pack.slice(pack.indexOf('THE DELVE PALETTE'), pack.indexOf('FILES:', pack.indexOf('THE DELVE PALETTE')));
    const named = Object.fromEntries([...part.matchAll(/([a-z-]+) (#[0-9A-F]{6})/g)].map((m) => [m[1], m[2]]));
    expect(named).toEqual(COLOUR_PALETTE);
    expect(COLOUR_HEX.size).toBe(55);
  });
});

describe('the colour catalog', () => {
  it('has prefixed ids that clash with nothing, and files that pass the whitelist at their size', () => {
    expect(COLOUR_ASSETS.length).toBeGreaterThan(300);
    const ids = COLOUR_ASSETS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('c-'))).toBe(true);
    expect(ASSETS.some((a) => a.id.startsWith('c-'))).toBe(false);
    for (const a of COLOUR_ASSETS) {
      expect(a.palette).toBe('colour');
      expect(['prop', 'terrain']).toContain(a.kind);
      expect(['floor', 'props']).toContain(a.layer);
      const parsed = parseAssetSvg(readFileSync(resolve(ASSET_DIR, a.file), 'utf8'), a);
      expect(parsed.problems, a.file).toEqual([]);
      expect([parsed.w, parsed.h], a.file).toEqual([a.w, a.h]);
    }
    expect(COLOUR_CATEGORIES.map((c) => c.id)).toEqual(expect.arrayContaining(['trees', 'plants', 'rocks', 'carpets', 'ruins']));
  });

  it('carries the manifest fields: palette, layer, group, hidden', () => {
    // ink stalagmites and colour rocks/stalagmites live side by side
    expect(assetInfo('stalagmites')?.palette).toBeUndefined();
    expect(assetInfo('c-stalagmites')).toMatchObject({ category: 'rocks', palette: 'colour', layer: 'props', file: 'colour/rocks/stalagmites.svg' });
    expect(assetInfo('c-oak-a')).toMatchObject({ w: 3, h: 3, blocks: 'sight', group: 'oak', layer: 'props' });
    expect(assetInfo('c-persian-red-a')).toMatchObject({ layer: 'floor', blocks: 'none', group: 'rug-persian-red' });
    expect(assetInfo('c-hidden-trapdoor-stone')).toMatchObject({ hidden: true, layer: 'floor' });
    expect(assetInfo('c-wall-1')).toMatchObject({ modular: true, group: 'ruin-wall' });
    expect(assetInfo('c-tower-round')?.modular).toBeUndefined();
    // seamless textures are terrain, not props; water you swim in is difficult
    expect(assetInfo('c-floor-planks-oak')).toMatchObject({ kind: 'terrain', palette: 'colour', w: 2, h: 2, group: 'floor-planks' });
    expect(assetInfo('c-water-calm')).toMatchObject({ kind: 'terrain', w: 3, h: 3, difficult: true });
    expect(assetInfo('c-ground-grass-short')?.difficult).toBeUndefined();
    expect(COLOUR_CATEGORIES.find((c) => c.id === 'floors')?.layer).toBe('terrain');
  });
});

describe('colours per style', () => {
  const ramp = (preset: string) => [...COLOUR_HEX].map((h) => [lightness(h), lightness(colourMap(PRESETS[preset]!)!.get(h)!)] as const).sort((a, b) => a[0] - b[0]);

  it('draws them as drawn in classic hatching and clean', () => {
    expect(colourMap(PRESETS['classic-hatching']!)).toBeNull();
    expect(colourMap(PRESETS.clean!)).toBeNull();
    const svg = sceneToSvg(buildScene(withProps({ id: 'i1', asset: 'c-oak-a', at: [10.5, 27.5] }), { assets: body }));
    expect(svg).toContain('#4F803C');
  });

  it('maps them by lightness onto the ramp in old-school blue and print: monotone, a few tones, ink, shade and paper exact', () => {
    for (const preset of ['old-school-blue', 'print']) {
      const style = PRESETS[preset]!;
      const map = colourMap(style)!;
      const pairs = ramp(preset);
      for (let i = 1; i < pairs.length; i++) expect(pairs[i]![1], preset).toBeGreaterThanOrEqual(pairs[i - 1]![1] - 1e-9);
      expect(map.get('#000000')).toBe(style.props.ink);
      expect(map.get('#999999')).toBe(style.props.shade);
      expect(map.get('#FFFFFF')).toBe(style.props.paper);
      const tones = new Set(map.values());
      expect(tones.size).toBeLessThanOrEqual(1 + (style.colours.mode === 'ramp' ? style.colours.steps : 0));
      expect(tones.size).toBeGreaterThanOrEqual(5);
    }
    // print stays gray
    for (const v of colourMap(PRESETS.print!)!.values()) expect(v.slice(1, 3) === v.slice(3, 5) && v.slice(3, 5) === v.slice(5, 7)).toBe(true);
    expect(rampLevels(6)).toHaveLength(6);
  });

  it('tones them toward sepia on parchment, keeping them apart', () => {
    const style = PRESETS.parchment!;
    const map = colourMap(style)!;
    const chroma = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
    };
    expect(map.get('#000000')).toBe(style.props.ink);
    expect(map.get('#FFFFFF')).toBe(style.props.paper);
    // a vivid green becomes an olive brown: less colourful, still darker than a pale one
    expect(chroma(map.get(COLOUR_PALETTE.witchfire)!)).toBeLessThan(chroma(COLOUR_PALETTE.witchfire));
    expect(lightness(map.get(COLOUR_PALETTE['leaf-deep'])!)).toBeLessThan(lightness(map.get(COLOUR_PALETTE['leaf-pale'])!));
    expect(new Set(map.values()).size).toBeGreaterThan(45);
  });

  it('writes the style’s colours into the picture, and leaves ink props alone', () => {
    const map = { ...withProps({ id: 'i1', asset: 'c-oak-a', at: [10.5, 27.5] }, { id: 'i2', asset: 'chest-closed', at: [12.5, 27.5] }), style: { preset: 'print' } };
    const svg = sceneToSvg(buildScene(map, { assets: body }));
    expect(svg).not.toContain('#4F803C');
    expect(svg).toContain(colourMap(PRESETS.print!)!.get('#4F803C'));
    // no colour props, no colours on the layer: old maps draw as before
    expect(assetLayers(buildScene({ ...withProps({ id: 'i2', asset: 'chest-closed', at: [12.5, 27.5] }), style: { preset: 'print' } }).layers).every((l) => l.colours === undefined)).toBe(true);
  });
});

describe('colour terrain textures', () => {
  const withTerrain = (preset: string): DelveMap => {
    const map = testMap();
    map.objects.push(
      { type: 'terrain', id: 't1', asset: 'c-water-calm', shape: { rect: [40, 2, 6, 6] } },
      { type: 'terrain', id: 't2', asset: 'c-water-calm', shape: { rect: [46, 2, 6, 6] } },
      { type: 'terrain', id: 't3', asset: 'water-shallow', shape: { rect: [40, 10, 4, 4] } },
    );
    return { ...validateMap(map), style: { preset } };
  };

  it('repeat at their own size from the grid origin, in their own colours, with no tint', () => {
    const scene = buildScene(withTerrain('classic-hatching'), { assets: body });
    const t1 = scene.layers.find((l) => l.name === 'terrain:t1');
    expect(t1).toMatchObject({ kind: 'pattern', colour: { size: [3, 3] } });
    expect(t1?.kind === 'pattern' && t1.tint).toBeUndefined();
    const svg = sceneToSvg(scene, { idPrefix: 'm-' });
    // one pattern for both areas, so they join without a seam, at x 0 y 0 like the ink tiles
    expect(svg.match(/<pattern id="m-tile-c-water-calm-[^"]*" patternUnits="userSpaceOnUse" x="0" y="0" width="3" height="3">/g)).toHaveLength(1);
    expect(svg).toContain(COLOUR_PALETTE.water);
    // the ink tile keeps its tint and its 2×2 pattern
    expect(svg).toMatch(/<pattern id="m-tile-water-shallow-[0-9A-F]+" patternUnits="userSpaceOnUse" x="0" y="0" width="2" height="2">/);
  });

  it('take the style’s colours, with a pattern per set of colours', () => {
    const print = sceneToSvg(buildScene(withTerrain('print'), { assets: body }), { idPrefix: 'p-' });
    expect(print).not.toContain(COLOUR_PALETTE.water);
    expect(print).toContain(colourMap(PRESETS.print!)!.get(COLOUR_PALETTE.water));
    const blue = sceneToSvg(buildScene(withTerrain('old-school-blue'), { assets: body }), { idPrefix: 'p-' });
    const id = (s: string) => /id="(p-tile-c-water-calm-[^"]*)"/.exec(s)![1];
    expect(id(print)).not.toBe(id(blue));
  });
});

describe('floor props and hidden props', () => {
  it('lays floor colour props with the decals, under furniture', () => {
    const map = withProps({ id: 'i1', asset: 'table-round', at: [10, 27] }, { id: 'i2', asset: 'c-persian-red-a', at: [10, 27] }, { id: 'i3', asset: 'c-boulder-a', at: [20.5, 27.5] });
    expect(propLayer('c-persian-red-a')).toBe('decals');
    expect(propLayer('c-boulder-a')).toBe('props');
    const layers = assetLayers(buildScene(map).layers);
    expect(layers.map((l) => l.name)).toEqual(['decals', 'props']);
    expect(layers[0]!.assets).toEqual(['c-persian-red-a']);
    expect(layers[1]!.assets).toEqual(['table-round', 'c-boulder-a']);
    const names = buildScene(map).layers.map((l) => l.name);
    expect(names.indexOf('decals')).toBeLessThan(names.indexOf('walls'));
  });

  it('hides hidden colour props from players by default, as the manifest says', () => {
    expect(hiddenByDefault('c-hidden-trapdoor-stone')).toBe(true);
    expect(propHidden({ asset: 'c-hidden-trapdoor-stone' })).toBe(true);
    expect(propHidden({ asset: 'c-hidden-trapdoor-stone', gmOnly: false })).toBe(false);
    expect(propHidden({ asset: 'c-trapdoor-wood' })).toBe(false);
    // the ink catalog's three, now from catalog.json
    expect([...HIDDEN_ASSETS].sort()).toEqual(['pressure-plate', 'rune', 'spike-trap']);
    for (const id of HIDDEN_ASSETS) expect(hiddenByDefault(id)).toBe(true);
    const map = withProps({ id: 'i1', asset: 'c-hidden-trapdoor-stone', at: [10.5, 27.5] }, { id: 'i2', asset: 'c-trapdoor-wood', at: [12.5, 27.5] });
    const drawn = (view: 'gm' | 'players') => assetLayers(buildScene(map, { view }).layers).flatMap((l) => l.assets);
    expect(drawn('gm')).toEqual(['c-hidden-trapdoor-stone', 'c-trapdoor-wood']);
    expect(drawn('players')).toEqual(['c-trapdoor-wood']);
  });
});

describe('the brush and groups', () => {
  const path: [number, number][] = [[0, 0], [30, 0], [30, 12]];

  it('knows a prop’s variants by its group', () => {
    const oaks = groupVariants('c-oak-a');
    expect(oaks).toEqual(expect.arrayContaining(['c-oak-a', 'c-oak-b', 'c-oak-c', 'c-oak-old']));
    expect(oaks.every((id) => assetInfo(id)?.group === 'oak')).toBe(true);
    expect(groupVariants('chair')).toEqual(['chair']);
  });

  it('mixes them at random, seeded: the same stroke gives the same forest, on the same spots as without', () => {
    const variants = groupVariants('c-oak-a');
    const opts = { spacing: 2, placement: 'irregular' as const, seed: 42, variants };
    const a = scatterAlong(path, opts);
    expect(scatterAlong(path, opts)).toEqual(a);
    expect(a.map(({ asset: _a, ...s }) => s)).toEqual(scatterAlong(path, { ...opts, variants: undefined }));
    expect(new Set(a.map((s) => s.asset)).size).toBeGreaterThan(2);
    for (let i = 1; i < a.length; i++) expect(a[i]!.asset).not.toBe(a[i - 1]!.asset);
    expect(scatterAlong(path, { ...opts, seed: 43 }).map((s) => s.asset)).not.toEqual(a.map((s) => s.asset));
    expect(scatterAlong(path, { spacing: 2, placement: 'regular', seed: 1 }).every((s) => s.asset === undefined)).toBe(true);
  });

  it('puts modular ruin walls on whole squares, so their open ends meet', () => {
    expect(modularAt({ asset: 'c-wall-2', at: [4.5, 5.5] })).toEqual([5, 5.5]);
    expect(modularAt({ asset: 'c-wall-2', at: [4.5, 5.5], rotation: 90 })).toEqual([4.5, 6]);
    expect(modularAt({ asset: 'c-wall-1', at: [3.5, 5.5] })).toEqual([3.5, 5.5]);
    const at: [number, number] = [4.5, 5.5];
    expect(modularAt({ asset: 'c-oak-a', at })).toBe(at);
  });
});
