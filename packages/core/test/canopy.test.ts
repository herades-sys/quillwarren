// The canopy layer: trees (colour props of the category trees, the ink trees
// and the giant mushroom) draw after every other prop, so whatever stands under
// a crown is hidden by it; floor props stay at the bottom, labels, notes, fog,
// room numbers and markers stay on top, and maps without trees draw byte for
// byte as before.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetInfo,
  buildScene,
  CANOPY_INK,
  COLOUR_ASSETS,
  handoutSvg,
  isCanopy,
  parseAssetSvg,
  PRESETS,
  propLayer,
  renderSvg,
  validateMap,
  type DelveMap,
  type Layer,
} from '../src/index.ts';
import { clearing, grove } from './canopy-maps.ts';
import { hardTerrain, legendKeep, oldStains } from './legend-maps.ts';
import { testMap } from './fixtures.ts';

const ASSET_DIR = resolve(import.meta.dirname, '../../../delve-props-design-system/assets');
const body = (id: string) => (assetInfo(id) ? parseAssetSvg(readFileSync(resolve(ASSET_DIR, assetInfo(id)!.file), 'utf8'), assetInfo(id)).body : undefined);
const assetLayers = (layers: Layer[]) => layers.flatMap((l) => (l.kind === 'assets' ? [{ name: l.name, assets: l.items.map((i) => i.id) }] : []));

/** Every style in both views, the GM's fog shade and the handout, with the art. */
function fingerprint(map: DelveMap): string {
  map = validateMap(map);
  const h = createHash('sha256');
  for (const preset of Object.keys(PRESETS).sort()) {
    const styled: DelveMap = { ...map, style: { preset } };
    for (const view of ['gm', 'players'] as const) h.update(renderSvg(styled, { view, assets: body }));
  }
  h.update(renderSvg({ ...map, fog: { on: true, revealed: [] } }, { view: 'gm', fog: 'dim', assets: body }));
  h.update(oldStains(handoutSvg(map, { assets: body }).svg));
  return h.digest('hex').slice(0, 16);
}

describe('which props are canopies', () => {
  it('every colour tree, the ink trees and the giant mushroom; not bushes, stumps, logs or boulders', () => {
    const trees = COLOUR_ASSETS.filter((a) => a.category === 'trees');
    expect(trees.length).toBeGreaterThan(100);
    expect(trees.every((a) => a.canopy && propLayer(a.id) === 'canopy')).toBe(true);
    expect(COLOUR_ASSETS.filter((a) => a.canopy).length).toBe(trees.length);
    expect([...CANOPY_INK].sort()).toEqual(['mushroom-giant', 'tree', 'tree-dead']);
    for (const id of CANOPY_INK) expect([isCanopy(id), propLayer(id)]).toEqual([true, 'canopy']);
    for (const id of ['bush', 'stump', 'log', 'boulder', 'c-boulder-a', 'c-bush-a', 'c-wall-2', 'c-persian-red-a', 'chair']) expect(isCanopy(id)).toBe(false);
    expect(propLayer('c-persian-red-a')).toBe('decals');
    expect(propLayer('c-boulder-a')).toBe('props');
  });
});

describe('the canopy layer', () => {
  it('draws a boulder under a tree before the tree, over the other props and pictures, under symbols, labels, notes, fog and markers', () => {
    const map = validateMap(grove());
    const layers = buildScene({ ...map, fog: { on: true, revealed: [] } }, { view: 'gm', fog: 'dim', assets: body }).layers;
    const names = layers.map((l) => l.name);
    const assets = assetLayers(layers);
    expect(assets.map((l) => l.name)).toEqual(['decals', 'props', 'canopy', 'symbols']);
    expect(assets.find((l) => l.name === 'canopy')!.assets).toEqual(['i20', 'i21', 'i22', 'i23', 'i24']);
    // the mossy boulder under the oak, the stump under the tree, the rubble pile under the dead tree
    const props = assets.find((l) => l.name === 'props')!.assets;
    for (const id of ['i4', 'i10', 'i8']) expect(props).toContain(id);
    const at = (n: string) => names.indexOf(n);
    expect(at('props')).toBeLessThan(at('canopy'));
    for (const above of ['symbols', 'labels', 'fog', 'inscriptions', 'room-numbers', 'markers']) expect(at('canopy')).toBeLessThan(at(above));
    // in the SVG too: the boulder's group comes before the trees'
    const svg = renderSvg(map, { view: 'gm', assets: body });
    expect(svg.indexOf('data-layer="props"')).toBeLessThan(svg.indexOf('data-layer="canopy"'));
    expect(svg.indexOf('data-layer="canopy"')).toBeLessThan(svg.indexOf('data-layer="symbols"'));
  });

  it('keeps floor props at the bottom, under the walls, and pictures under the canopies', () => {
    const map = validateMap(
      clearing([
        { id: 'i30', type: 'prop', asset: 'c-oak-a', at: [8, 10] },
        { id: 'p1', type: 'image', src: `${'a'.repeat(64)}.png`, at: [8, 10], w: 2, h: 2 },
      ]),
    );
    const names = buildScene(map).layers.map((l) => l.name);
    expect(assetLayers(buildScene(map).layers).find((l) => l.name === 'decals')!.assets).toEqual(['i15']); // the rug under the oak
    expect(names.indexOf('decals')).toBeLessThan(names.indexOf('walls'));
    expect(names.indexOf('images')).toBeLessThan(names.indexOf('canopy'));
  });

  it('draws the same canopy for players, without the GM symbols', () => {
    const players = assetLayers(buildScene(validateMap(grove()), { view: 'players' }).layers);
    expect(players.map((l) => l.name)).toEqual(['decals', 'props', 'canopy']);
  });

  it('leaves maps without trees byte for byte as they were, and redraws maps with trees', () => {
    // hashes taken with canopy-maps.ts against the code before the canopy layer (84c8003)
    for (const o of clearing().objects) if (o.type === 'prop' || o.type === 'terrain') expect(assetInfo(o.asset), o.asset).toBeDefined();
    expect(fingerprint(clearing())).toBe('baf8a54e6141be4a');
    expect(fingerprint(testMap())).toBe('403e19c3a7a61067');
    // (its terrain pinned hard: hard draws terrain as it was before soft terrain edges)
    const keep = hardTerrain(legendKeep());
    keep.objects = keep.objects.filter((o) => !(o.type === 'prop' && o.asset.startsWith('c-oak')));
    expect(fingerprint(keep)).toBe('a1b40e915aab8550');
    expect(fingerprint(grove())).not.toBe('224be06647ec3ffa'); // the grove as it was drawn before
  });
});
