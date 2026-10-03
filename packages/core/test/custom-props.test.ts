// Custom props in core: the registry beside the built-in catalog, the checks a
// drawing must pass, the hand-inked line, and redrawing at another size.
import { afterEach, describe, expect, it } from 'vitest';
import {
  allAssets,
  ASSETS,
  COLOUR_ASSETS,
  assetInfo,
  buildScene,
  categoryOf,
  checkPropSize,
  checkPropSvg,
  customAssets,
  customAssetsVersion,
  flattenPath,
  inkBody,
  isCustomAsset,
  MAX_PROP_SVG_BYTES,
  parseAssetSvg,
  PROP_CATEGORIES,
  propBounds,
  propHidden,
  registerAssets,
  scaleBody,
  sceneToSvg,
  type AssetInfo,
  type DelveMap,
} from '../src/index.ts';

const custom = (id: string, o: Partial<AssetInfo> = {}): AssetInfo => ({ id, name: id, category: 'custom', kind: 'prop', w: 1, h: 1, tags: [], blocks: 'movement', file: `props/${id}.svg`, ...o });

afterEach(() => registerAssets([]));

describe('the custom prop registry', () => {
  it('adds custom props beside the built-in catalog, and replaces them as a whole', () => {
    const v = customAssetsVersion();
    registerAssets([custom('my-anvil', { w: 2, h: 1, category: 'workshop' }), custom('my-web', { category: 'symbols' })]);
    expect(customAssetsVersion()).toBe(v + 1);
    expect(assetInfo('my-anvil')).toMatchObject({ w: 2, h: 1, custom: true, category: 'workshop' });
    expect(allAssets().length).toBe(ASSETS.length + COLOUR_ASSETS.length + 2);
    expect(categoryOf('my-anvil')?.id).toBe('workshop');
    expect(propBounds({ asset: 'my-anvil', at: [3, 3.5] })).toEqual({ x0: 2, y0: 3, x1: 4, y1: 4 });
    // filed under GM symbols: GM view only, like the built-in ones
    expect(propHidden({ asset: 'my-web' })).toBe(true);
    registerAssets([custom('my-anvil')]);
    expect(assetInfo('my-web')).toBeUndefined();
    expect(customAssets().map((a) => a.id)).toEqual(['my-anvil']);
  });

  it('never lets a custom prop shadow a built-in one or skip the prefix', () => {
    registerAssets([custom('chair', { w: 3 }), custom('my-Bad'), custom('lava'), custom('my-ok', { kind: 'terrain' }), custom('my-good')]);
    expect(assetInfo('chair')).toMatchObject({ w: 1, category: 'furniture' });
    expect(assetInfo('chair')?.custom).toBeUndefined();
    expect(customAssets().map((a) => a.id)).toEqual(['my-good']);
    expect(isCustomAsset('my-good')).toBe(true);
    expect(isCustomAsset('chair')).toBe(false);
  });

  it('files custom props under Custom or any built-in prop category, never terrain', () => {
    expect(PROP_CATEGORIES.map((c) => c.id)).toContain('custom');
    expect(PROP_CATEGORIES.map((c) => c.id)).toContain('workshop');
    expect(PROP_CATEGORIES.map((c) => c.id)).not.toContain('terrain');
    registerAssets([custom('my-thing')]);
    expect(categoryOf('my-thing')).toMatchObject({ id: 'custom', name: 'Custom', layer: 'props' });
  });

  it('renders a registered prop at its footprint, and an unregistered one as the dashed 1×1', () => {
    const map: DelveMap = {
      format: 'delve.map',
      version: 1,
      id: 'map_custom01',
      name: 'Test',
      grid: { type: 'square' },
      objects: [
        { id: 'r1', type: 'room', shape: { rect: [0, 0, 6, 4] } },
        { id: 'i1', type: 'prop', asset: 'my-cart', at: [2, 2] },
      ],
    } as DelveMap;
    const body = '<rect x="10" y="10" width="180" height="80" fill="#999999"/>';
    registerAssets([custom('my-cart', { w: 2, h: 1 })]);
    const svg = sceneToSvg(buildScene(map, { assets: (id) => (id === 'my-cart' ? body : undefined) }));
    expect(svg).toContain('translate(2 2) scale(0.01) translate(-100 -50)');
    expect(svg).not.toContain('data-missing');
    registerAssets([]);
    const gone = sceneToSvg(buildScene(map, { assets: () => undefined }));
    expect(gone).toContain('data-missing="my-cart"');
    expect(gone).toMatch(/x="-0\.5" y="-0\.5" width="1" height="1"/);
  });
});

const STRONGBOX = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect x="20" y="29" width="60" height="42" rx="3" fill="#FFFFFF" stroke="none"/>
<rect x="31" y="29" width="7" height="42" fill="#999999" stroke="#000000" stroke-width="2"/>
<line x1="43" y1="39" x2="57" y2="40" stroke="#000000" stroke-width="1.5"/>
<rect x="49" y="64" width="2" height="4" fill="#000000" stroke="none"/>
<rect x="20" y="29" width="60" height="42" rx="3" fill="none" stroke="#000000" stroke-width="4"/>
</svg>`;

const svg = (inner: string, vb = '0 0 100 100') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}</svg>`;
const problemsOf = (s: string, w = 1, h = 1) => checkPropSvg(s, { w, h }).problems.join('\n');

describe('checking a custom prop drawing', () => {
  it('accepts a drawing that follows the rules, inks it, and adds round caps', () => {
    const r = checkPropSvg(STRONGBOX, { w: 1, h: 1, seed: 'my-strongbox' });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/added round caps and joins to 3 strokes/);
    // every shape is a hand-drawn path now, except the tiny keyhole
    expect(r.body).not.toMatch(/<rect x="20"/);
    expect(r.body).toContain('<rect x="49" y="64" width="2" height="4" fill="#000000" stroke="none"/>');
    expect(r.body.match(/<path d="M[^"]*C/g)?.length).toBe(4);
    expect(r.body).toContain('stroke-linecap="round" stroke-linejoin="round"');
    // what's stored passes the renderer's whitelist untouched
    expect(parseAssetSvg(svg(r.body)).problems).toEqual([]);
  });

  it('refuses other colours', () => {
    expect(problemsOf(svg('<circle cx="50" cy="50" r="20" fill="#FF0000" stroke="#000000" stroke-width="4"/>'))).toMatch(/colour #FF0000 snapped/);
    expect(problemsOf(svg('<circle cx="50" cy="50" r="20" fill="red"/>'))).toMatch(/colour "red" replaced by ink/);
    expect(problemsOf(svg('<circle cx="50" cy="50" r="20" fill="#FFFFFF" fill-opacity="0.5"/>'))).toMatch(/no opacity/);
  });

  it('refuses scripts, event handlers, images, links and CSS', () => {
    expect(problemsOf(svg('<script>alert(1)</script><rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>'))).toMatch(/no scripts/);
    expect(problemsOf(svg('<rect x="10" y="10" width="20" height="20" fill="#FFFFFF" onload="alert(1)"/>'))).toMatch(/no event handlers/);
    const img = problemsOf(svg('<image href="https://evil.example/x.png" x="0" y="0" width="100" height="100"/>'));
    expect(img).toMatch(/no <image>/);
    expect(img).toMatch(/no links or external references/);
    expect(problemsOf(svg('<use xlink:href="#a"/><rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>'))).toMatch(/no <use>/);
    expect(problemsOf(svg('<rect x="10" y="10" width="20" height="20" fill="url(#g)"/>'))).toMatch(/no url\(/);
    expect(problemsOf(svg('<rect x="10" y="10" width="20" height="20" style="fill:#FFFFFF"/>'))).toMatch(/no CSS/);
    expect(problemsOf(svg('<foreignObject><div>hi</div></foreignObject><rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>'))).toMatch(/no <foreignObject>/);
    expect(problemsOf(svg('<filter id="f"/><rect x="10" y="10" width="20" height="20" fill="#FFFFFF" filter="url(#f)"/>'))).toMatch(/no filters/);
    expect(problemsOf(svg('<text x="10" y="50">A</text><rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>'))).toMatch(/no text/);
    expect(problemsOf(`<!DOCTYPE svg [<!ENTITY x "y">]>${svg('<rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>')}`)).toMatch(/no DOCTYPE/);
  });

  it('needs the viewBox of the footprint', () => {
    const rect = '<rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/>';
    expect(problemsOf(svg(rect), 2, 1)).toMatch(/viewBox "0 0 100 100" doesn't fit a 2×1 footprint: use viewBox="0 0 200 100"/);
    expect(problemsOf(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${rect}</svg>`)).toMatch(/needs viewBox="0 0 100 100"/);
    expect(problemsOf(svg(rect, '10 10 100 100'))).toMatch(/doesn't fit/);
    expect(problemsOf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300">${rect}</svg>`)).toMatch(/width="300" should be 100/);
    expect(checkPropSvg(svg(rect, '0 0 150 250'), { w: 1.5, h: 2.5 }).ok).toBe(true);
  });

  it('caps the size and keeps footprints between half a square and 6, in half squares', () => {
    const big = svg(`<path d="M10 10 ${'L20 20 '.repeat(10000)}" fill="none" stroke="#000000" stroke-width="2"/>`);
    expect(big.length).toBeGreaterThan(MAX_PROP_SVG_BYTES);
    expect(problemsOf(big)).toMatch(/too big; keep it under 64 KB/);
    expect(checkPropSize(0.5, 6)).toEqual([]);
    expect(checkPropSize(0.25, 7).join(' ')).toMatch(/w: from 0\.5 to 6.*h: from 0\.5 to 6/);
    expect(checkPropSize(1.3, 1).join(' ')).toMatch(/whole or half squares/);
  });

  it('wants the three line weights, a fill on every shape, everything inside the footprint, and no scale()', () => {
    expect(problemsOf(svg('<rect x="10" y="10" width="20" height="20" fill="#FFFFFF" stroke="#000000" stroke-width="3"/>'))).toMatch(/stroke-width="3": only 4/);
    expect(problemsOf(svg('<rect x="10" y="10" width="20" height="20" fill="#FFFFFF" stroke="#000000"/>'))).toMatch(/no stroke-width/);
    expect(problemsOf(svg('<path d="M10 10 L30 30 L10 30 Z" stroke="#000000" stroke-width="2"/>'))).toMatch(/<path> #1 has no fill/);
    expect(problemsOf(svg('<rect x="80" y="10" width="30" height="20" fill="#FFFFFF"/>'))).toMatch(/reaches past the 100×100 footprint/);
    expect(problemsOf(svg('<g transform="scale(2)"><rect x="10" y="10" width="20" height="20" fill="#FFFFFF"/></g>'))).toMatch(/no scale\(\)/);
    expect(problemsOf(svg('<line x1="10" y1="10" x2="30" y2="30"/>'))).toMatch(/draws nothing/);
    expect(problemsOf(svg(''))).toMatch(/nothing to draw/);
    // paint inherited from a <g> counts; rotate() and translate() are fine
    expect(checkPropSvg(svg('<g fill="#999999" stroke="#000000" stroke-width="2" transform="translate(5 5) rotate(10 45 45)"><rect x="30" y="30" width="30" height="30"/></g>'), { w: 1, h: 1 }).ok).toBe(true);
  });

  it('notes marks inside the 4-unit margin and harmless leftovers instead of refusing them', () => {
    const r = checkPropSvg(svg('<title>Box</title><rect id="a" x="2" y="10" width="20" height="20" fill="#FFFFFF"/>'), { w: 1, h: 1 });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/inside the 4-unit margin/);
    expect(r.notes.join(' ')).toMatch(/rect id= dropped/);
  });
});

describe('the hand-inked line', () => {
  const twins = '<rect x="20" y="20" width="60" height="50" fill="#FFFFFF" stroke="none"/><rect x="20" y="20" width="60" height="50" fill="none" stroke="#000000" stroke-width="4"/>';

  it('is seeded: the same drawing inks the same, another prop differently, and a fill stays under its outline', () => {
    const a = inkBody(twins, 'my-a');
    expect(inkBody(twins, 'my-a')).toBe(a);
    expect(inkBody(twins, 'my-b')).not.toBe(a);
    const ds = [...a.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(ds).toHaveLength(2);
    expect(ds[0]).toBe(ds[1]);
  });

  it('stays close to the drawn shape', () => {
    const d = /d="([^"]+)"/.exec(inkBody('<circle cx="50" cy="50" r="30" fill="#FFFFFF" stroke="#000000" stroke-width="4"/>', 'my-c'))![1]!;
    const pts = flattenPath(d)[0]!.pts;
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x - 50, y - 50) - 30)).toBeLessThan(1.2);
  });

  it('keeps lines open, never filled, and leaves ink:false drawings alone', () => {
    const line = inkBody('<g fill="#FFFFFF"><line x1="10" y1="50" x2="90" y2="52" stroke="#000000" stroke-width="2"/></g>', 'my-l');
    expect(line).toMatch(/<path d="M[^"Z]*" fill="none" stroke="#000000"/);
    const kept = checkPropSvg(STRONGBOX, { w: 1, h: 1, ink: false });
    expect(kept.body).toContain('<rect x="20" y="29" width="60" height="42" rx="3"');
  });

  it('reads every path command, arcs included', () => {
    const [ring] = flattenPath('M50 14 A36 36 0 1 1 49.9 14 Z');
    expect(ring!.closed).toBe(true);
    for (const [x, y] of ring!.pts) expect(Math.abs(Math.hypot(x - 50, y - 50) - 36)).toBeLessThan(0.3);
    const rel = flattenPath('m10 10 h20 v20 h-20 z M50 50 c10 0 10 10 0 10 s-10 10 0 20 q5 5 10 0 t10 0 L60 90');
    expect(rel).toHaveLength(2);
    expect(rel[0]!.pts).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
    expect(rel[1]!.pts.at(-1)).toEqual([60, 90]);
  });
});

describe('redrawing at another size', () => {
  it('scales the geometry through its transforms and keeps the line weights', () => {
    const out = scaleBody('<g stroke="#000000" stroke-width="2" transform="translate(10 0)"><rect x="10" y="10" width="20" height="10" fill="#FFFFFF"/></g><line x1="10" y1="50" x2="50" y2="50" stroke="#000000" stroke-width="1.5"/>', 2, 1);
    expect(out).toContain('<path d="M40 10L80 10L80 20L40 20Z" stroke="#000000" stroke-width="2" fill="#FFFFFF"/>');
    expect(out).toContain('<path d="M20 50L100 50" stroke="#000000" stroke-width="1.5" fill="none"/>');
    expect(checkPropSvg(svg(out, '0 0 200 100'), { w: 2, h: 1 }).ok).toBe(true);
  });
});
