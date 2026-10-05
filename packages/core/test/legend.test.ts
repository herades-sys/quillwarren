// The handout's legend: which entries it lists (variants merged, nothing hidden
// from players, fog and crop respected), their names and order, where the box
// goes (inside the sheet, clear of the map, title, compass and scale bar; the
// map shrunk or the fitted sheet widened when no corner has room, with the frame
// following), the cap, and that without it the sheet is byte for byte the old one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetInfo,
  groupName,
  groupVariants,
  handoutSvg,
  inscriptionBounds,
  LEGEND_CAP,
  parseAssetSvg,
  propBounds,
  propHidden,
  shapeBounds,
  validateMap,
  type Bounds,
  type DelveMap,
  type Handout,
  type HandoutOptions,
  type Inscription,
  type MapObject,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';
import { hardTerrain, legendKeep } from './legend-maps.ts';

const ASSET_DIR = resolve(import.meta.dirname, '../../../delve-props-design-system/assets');
const body = (id: string) => (assetInfo(id) ? parseAssetSvg(readFileSync(resolve(ASSET_DIR, assetInfo(id)!.file), 'utf8'), assetInfo(id)).body : undefined);
const sheet = (map: DelveMap, o: HandoutOptions = {}): Handout => handoutSvg(validateMap(map), { assets: body, ...o });
const names = (map: DelveMap, o: HandoutOptions = {}): string[] => sheet(map, o).legend?.entries ?? [];
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** The legend's box in map squares. */
function inSquares(h: Handout): Bounds {
  const { x, y, k, x0, y0 } = h.frame;
  const L = h.legend!;
  return { x0: x0 + (L.x - x) / k, y0: y0 + (L.y - y) / k, x1: x0 + (L.x + L.w - x) / k, y1: y0 + (L.y + L.h - y) / k };
}
const overlap = (a: Bounds, b: Bounds) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const grown = (b: Bounds, d: number): Bounds => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

/** What the map draws, in squares: floor objects with their hatching around them, terrain, height areas, and the props players see. */
function drawnParts(map: DelveMap): Bounds[] {
  return map.objects.flatMap((o: MapObject): Bounds[] => {
    if (o.type === 'room' || o.type === 'terrain' || o.type === 'height') return [grown(shapeBounds(o.shape), o.type === 'room' ? 1.15 : 0)];
    if (o.type === 'prop' && !propHidden(o)) return [propBounds(o)];
    return [];
  });
}

/** The title, the compass rose and the scale bar on the sheet, in points, read back from the SVG. */
function sheetParts(svg: string, title: string): Bounds[] {
  const out: Bounds[] = [];
  const t = new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)" font-size="([\\d.]+)" text-anchor="middle" fill="#2E1F11">${title}</text>`).exec(svg);
  if (t) {
    const [x, y, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
    out.push({ x0: x - title.length * s * 0.25, y0: y - s * 0.75, x1: x + title.length * s * 0.25, y1: y + s * 0.3 });
  }
  const c = /<text x="([\d.]+)" y="([\d.]+)" font-size="([\d.]+)" text-anchor="middle" fill="#2E1F11">N<\/text>/.exec(svg);
  if (c) {
    const [x, y, s] = [Number(c[1]), Number(c[2]), Number(c[3])];
    const r = s / 0.42;
    out.push({ x0: x - r, y0: y - s, x1: x + r, y1: y + r * 2.2 });
  }
  const bar = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="4.5"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  if (bar.length) out.push({ x0: bar[0]![0], y0: bar[0]![1], x1: bar.at(-1)![0] + bar.at(-1)![2], y1: bar[0]![1] + 18 });
  return out;
}

describe('handout legend: what it lists', () => {
  it('lists each kind of thing players see once, in order: doors, stairs, ladders and trapdoors, terrain, heights, props by count', () => {
    const h = sheet(legendKeep());
    expect(h.legend!.entries).toEqual([
      'Door',
      'Double door',
      'Locked door',
      'Stairs',
      'Ladder Down',
      'Trapdoor',
      'Lava',
      'Water, calm',
      'Cliff',
      'Barrel', // 3
      'Oak', // c-oak-a, c-oak-b and c-oak-c: one entry
      'Persian rug, red', // two variants of the red rug
      'Round Table with Chairs',
      'Spike Trap', // a hidden trap the GM has shown (gmOnly: false)
    ]);
    expect(h.legend!.more).toBe(0);
    // never the hidden traps, GM symbols, GM-only props, markers, secret doors or room numbers
    for (const hidden of ['Pressure Plate', 'Hidden trapdoor', 'Trap Marker', 'Treasure Chest', 'Secret', 'Spikes under the leaves']) expect(h.svg).not.toContain(hidden);
    expect(h.svg).not.toContain('data-layer="room-numbers"');
    expect(h.svg.match(/>Oak<\/text>/g)).toHaveLength(1);
    // the pictures: the art as on the map (an oak's colours, the lava's own tile) and the name in IM FELL, like the title
    expect(h.svg).toContain('data-legend=""');
    expect(h.svg).toContain('>Legend</text>');
    expect(h.svg).toMatch(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" viewBox="[-\d. ]+"><defs>.*?<\/defs><g data-layer="legend-prop">/);
    expect(h.svg).toMatch(/data-layer="legend-terrain"><path d="[^"]+" fill="#[0-9A-F]{6}" fill-rule="evenodd"\/><path d="[^"]+" fill="url\(#h-tile-lava-/);
    expect(h.svg).toMatch(/^<svg [^>]*font-family="IM FELL English, Georgia, serif"/);
  });

  it('keeps to what the players have seen and to the crop', () => {
    const fogged = legendKeep({ fog: { on: true, revealed: ['r1'] } });
    // only the hall: its door to the corridor, barrels, the table and the rugs (not the double door to the cellar, nor the secret one)
    expect(names(fogged, { revealedOnly: true })).toEqual(['Door', 'Barrel', 'Persian rug, red', 'Round Table with Chairs']);
    // without revealedOnly the whole map, fog or not
    expect(names(fogged)).toHaveLength(14);
    // the garden only: its locked door, the oaks and the found trap
    expect(names(legendKeep(), { crop: { x0: 9, y0: 0, x1: 17, y1: 6 } })).toEqual(['Locked door', 'Oak', 'Spike Trap']);
    // the cellar: no hall barrels, and the ledge's cliff
    const cellar = names(legendKeep(), { crop: { x0: 0, y0: 9, x1: 8, y1: 16 } });
    expect(cellar).toEqual(['Double door', 'Stairs', 'Ladder Down', 'Trapdoor', 'Lava', 'Water, calm', 'Cliff']);
  });

  it('names a group of variants from the catalog', () => {
    const named = (g: string) => groupName(g, groupVariants(`c-${g}-a`).map((id) => assetInfo(id)!.name));
    expect(named('oak')).toBe('Oak');
    expect(groupName('rug-persian-red', ['Persian rug, red', 'Persian rug, red (lobed medallion)'])).toBe('Persian rug, red');
    expect(groupName('stall', ['Market stall, red awning', 'Market stall, fish'])).toBe('Market stall');
    expect(groupName('dead', ['Dead tree', 'Dead tree, big', 'Dead sapling'])).toBe('Dead tree');
    expect(groupName('fur', ['Bearskin rug', 'Wolf pelt', 'Sheepskin'])).toBe('Fur');
    expect(groupName('carpet-arcane', ['Arcane rune carpet', 'Star map rug'], 'Star map rug')).toBe('Star map rug');
    // two groups that would share a name get their fuller ones
    const map = legendKeep();
    map.objects.push({ id: 'i90', type: 'prop', asset: 'c-oak-autumn-a', at: [11.5, 4.5] });
    expect(names(map)).toEqual(expect.arrayContaining(['Oak', 'Oak, autumn']));
  });

  it('caps a long legend, with "and N more"', () => {
    const map = legendKeep();
    const many = ['chair', 'bench', 'crate', 'sack', 'urns', 'coins', 'books', 'mirror', 'statue', 'font', 'lectern', 'obelisk', 'idol', 'rubble', 'cage', 'stocks', 'anvil', 'cauldron', 'brazier', 'candles'];
    many.forEach((asset, i) => map.objects.push({ id: `i${100 + i}`, type: 'prop', asset, at: [0.5 + (i % 8), 6.5 + Math.floor(i / 8)] }));
    const h = sheet(map, { paper: 'a3' });
    expect(h.legend!.entries).toHaveLength(LEGEND_CAP);
    expect(h.legend!.more).toBe(14 + many.length - LEGEND_CAP);
    expect(h.svg).toContain(`>and ${h.legend!.more} more</text>`);
  });
});

describe('handout legend: where it goes', () => {
  it('sits in a free corner inside the sheet, clear of the map, the title, the compass and the scale bar, on every paper', () => {
    const map = validateMap(legendKeep());
    const parts = drawnParts(map);
    for (const paper of ['a4', 'a3', 'letter', 'fit'] as const) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        const h = sheet(map, { paper, orientation });
        const L = h.legend!;
        expect(L, `${paper} ${orientation}`).toBeDefined();
        // well inside the sheet, inside the frame's margin
        expect(L.x).toBeGreaterThanOrEqual(30);
        expect(L.y).toBeGreaterThanOrEqual(30);
        expect(L.x + L.w).toBeLessThanOrEqual(h.width - 30);
        expect(L.y + L.h).toBeLessThanOrEqual(h.height - 30);
        // off the map
        const box = inSquares(h);
        for (const p of parts) expect(overlap(box, p), `${paper} ${orientation}: ${JSON.stringify(p)}`).toBe(false);
        // off the title, the compass rose and the scale bar
        const sheetBox = { x0: L.x, y0: L.y, x1: L.x + L.w, y1: L.y + L.h };
        const others = sheetParts(h.svg, 'The Legend Keep');
        expect(others).toHaveLength(3);
        for (const o of others) expect(overlap(sheetBox, o), `${paper} ${orientation}: ${JSON.stringify(o)}`).toBe(false);
      }
    }
  });

  it('keeps clear of handwritten notes', () => {
    const plain = sheet(legendKeep(), { paper: 'a4', orientation: 'landscape' });
    // a note right where the legend was
    const b = inSquares(plain);
    const map = legendKeep();
    map.objects.push({ id: 'w1', type: 'inscription', text: 'Here be dragons', at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], size: 1 });
    const h = sheet(map, { paper: 'a4', orientation: 'landscape' });
    expect(overlap(inSquares(h), inscriptionBounds(map.objects.at(-1) as Inscription))).toBe(false);
  });

  it('moves or shrinks the map when no corner has room, or widens a fitted sheet, and the frame says where the map went', () => {
    // a hall filling its whole sheet: its floor reaches every corner of the map
    const hall: DelveMap = { format: 'delve.map', version: 1, id: 'hall', name: 'Hall', grid: { type: 'square' }, seed: 2, objects: [{ id: 'r1', type: 'room', shape: { rect: [0, 0, 16, 10] } }] };
    const props = ['barrel', 'chair', 'bench', 'crate', 'sack', 'urns', 'coins', 'books'];
    props.forEach((asset, i) => hall.objects.push({ id: `i${i}`, type: 'prop', asset, at: [1.5 + i * 1.8, 5] }));
    const floor = { x0: -1.15, y0: -1.15, x1: 17.15, y1: 11.15 };
    for (const o of [{ paper: 'a4', orientation: 'landscape' }, { paper: 'a4', orientation: 'portrait' }, { paper: 'letter' }] as HandoutOptions[]) {
      const without = sheet(hall, { ...o, legend: false });
      const h = sheet(hall, o);
      expect(h.legend!.entries).toHaveLength(props.length);
      expect(overlap(inSquares(h), floor)).toBe(false);
      expect(h.frame.k).toBeLessThanOrEqual(without.frame.k + 1e-9);
      expect(h.frame.k).toBeGreaterThan(without.frame.k * 0.6);
      // the map is drawn exactly where the frame says (the handout page's Notes tool relies on it): its box starts at
      // (x, y) and is a whole number of squares of k points
      const drawn = new RegExp(`<svg xmlns="http://www.w3.org/2000/svg" x="${n(h.frame.x)}" y="${n(h.frame.y)}" width="([\\d.]+)" height="([\\d.]+)" viewBox="${h.frame.x0} ${h.frame.y0} `).exec(h.svg);
      expect(drawn).not.toBeNull();
      expect(Number(drawn![1]) / h.frame.k).toBeCloseTo(Math.round(Number(drawn![1]) / h.frame.k), 2);
    }
    // a sheet fitted to the map keeps the map's size and grows a strip instead
    const without = sheet(hall, { paper: 'fit', legend: false });
    const fit = sheet(hall, { paper: 'fit' });
    expect(fit.frame.k).toBe(without.frame.k);
    expect(fit.width * fit.height).toBeGreaterThan(without.width * without.height);
    expect(overlap(inSquares(fit), floor)).toBe(false);
  });
});

describe('handout legend: on and off', () => {
  it('shows from 2 entries, can be asked for with 1, and legend: false gives the old sheet byte for byte', () => {
    // the test dungeon has only plain doors (and a secret one): a legend of one, so none by default
    expect(handoutSvg(testMap()).svg).not.toContain('data-legend');
    expect(handoutSvg(testMap(), { legend: true }).legend?.entries).toEqual(['Door']);
    expect(sheet(legendKeep()).svg).toContain('data-legend');
    // hashes taken from the code before the legend (c.f. legend-maps.ts); the sheets that show the
    // garden's oaks re-taken with the canopy layer, which draws trees over the other props
    // (terrain pinned hard: the hashes are from before soft terrain edges, and hard draws terrain as before)
    const keep = hardTerrain(legendKeep());
    const fogged = hardTerrain(legendKeep({ fog: { on: true, revealed: ['r1'] } }));
    const old: [string, DelveMap, HandoutOptions][] = [
      ['35ca81fed8cacdf9', keep, {}],
      ['6af6c62de4af87d0', keep, { paper: 'a3', orientation: 'landscape', names: true }],
      ['2992cf2c714aa41e', keep, { paper: 'letter', orientation: 'portrait' }],
      ['e03dfeb368fd363b', keep, { paper: 'fit' }],
      ['bb6e5f925414c92e', fogged, { revealedOnly: true }],
      ['1580c027047fefd3', keep, { crop: { x0: 9, y0: 0, x1: 17, y1: 6 } }],
    ];
    for (const [want, map, o] of old) expect(hash(handoutSvg(map, { ...o, assets: body, legend: false }).svg)).toBe(want);
    expect(hash(handoutSvg(keep, { title: '', compass: false, scaleBar: false, frame: false, stains: false, legend: false }).svg)).toBe('04242008df587712');
    expect(hash(handoutSvg(testMap()).svg)).toBe('db5dae6a7cb69c7e');
    expect(hash(handoutSvg(testMap(), { paper: 'fit' }).svg)).toBe('f94850a32a8209dc');
  });

  it('draws the same legend every time', () => {
    expect(sheet(legendKeep()).svg).toBe(sheet(legendKeep()).svg);
  });
});
