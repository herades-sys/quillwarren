// Terrain edges (render/terrain-edges.ts): terrain areas meet with ragged
// outlines and fade into each other in patches instead of at straight polygon
// edges. Defaults by material, hard / ragged / fade, the stacking order, the
// details along the edges, determinism, fog, and maps without terrain drawing
// byte for byte as before.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FillRule, intersectD } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import {
  polygonsOf,
  ASSETS,
  assetInfo,
  buildScene,
  COLOUR_ASSETS,
  computeFloor,
  defaultTerrainEdge,
  handoutSvg,
  insidePolygons,
  parseAssetSvg,
  PRESETS,
  renderSvg,
  terrainEdgeSettings,
  terrainEdgeText,
  terrainPolygons,
  validateMap,
  visiblePolygons,
  type AreaEdges,
  type DelveMap,
  type Layer,
  type MapObject,
  type Point,
  type Polygon,
  type Terrain,
} from '../src/index.ts';
import { toPath } from '../src/geometry/shapes.ts';
import { clearTerrainEdgeCaches, edgeRecipe, MATERIAL_STACK, pairEdge, terrainEdges, terrainMaterial } from '../src/render/terrain-edges.ts';
import { testMap } from './fixtures.ts';
import { legendKeep, oldStains } from './legend-maps.ts';

const ASSET_DIR = resolve(import.meta.dirname, '../../../delve-props-design-system/assets');
const body = (id: string) => (assetInfo(id) ? parseAssetSvg(readFileSync(resolve(ASSET_DIR, assetInfo(id)!.file), 'utf8'), assetInfo(id)).body : undefined);

const mapOf = (objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap =>
  validateMap({ format: 'delve.map', version: 1, id: 'edges', name: 'Edges', grid: { type: 'square' }, seed: 7, objects, ...extra });
const terrain = (id: string, asset: string, shape: Terrain['shape'], more: Partial<Terrain> = {}): Terrain => ({ id, type: 'terrain', asset, shape, ...more });

const ringArea = (r: readonly Point[]) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * p[1], 0) / 2);
const area = (polys: readonly Polygon[]) => polys.reduce((s, p) => s + ringArea(p.outer) - p.holes.reduce((t, h) => t + ringArea(h), 0), 0);
const points = (polys: readonly Polygon[]) => polys.flatMap((p) => [...p.outer, ...p.holes.flat()]);
const layersOf = (map: DelveMap, id: string, opts = {}) => buildScene(map, { assets: body, ...opts }).layers.filter((l) => l.name.endsWith(`:${id}`));
const patterns = (layers: Layer[]) => layers.filter((l): l is Extract<Layer, { kind: 'pattern' }> => l.kind === 'pattern');
const edgesOf = (map: DelveMap) => terrainEdges(map.objects.filter((o): o is Terrain => o.type === 'terrain'), computeFloor(map), map.seed ?? 0);

/** How much of an area shows at p: all of it in its core, else what its see-through steps over p add up to. */
const coverage = (e: AreaEdges, p: Point): number => {
  if (e.core && insidePolygons(e.core, p)) return 1;
  let rest = 1;
  for (const f of e.fades) if (insidePolygons(f.polygons, p)) rest *= 1 - f.alpha;
  return 1 - rest;
};

/** The coverage at `d` squares out from the long sides of a rect area (negative: inside), along both sides: its mean and spread. */
function across(e: AreaEdges, [rx, ry, w, h]: [number, number, number, number], d: number): { mean: number; sd: number } {
  const v: number[] = [];
  for (let x = rx + 2; x < rx + w - 2; x += 0.1) v.push(coverage(e, [x, ry - d]), coverage(e, [x, ry + h + d]));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, sd: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) };
}

/** Distance from p to a rectangle's outline. */
const toRect = ([x, y]: Point, [rx, ry, w, h]: [number, number, number, number]): number => {
  const dx = Math.max(rx - x, 0, x - (rx + w));
  const dy = Math.max(ry - y, 0, y - (ry + h));
  if (dx || dy) return Math.hypot(dx, dy);
  return Math.min(x - rx, rx + w - x, y - ry, ry + h - y);
};

describe('defaults by material', () => {
  it('fades natural ground and water, keeps indoor floors hard and a chasm ragged', () => {
    for (const id of ['grass', 'dirt', 'mud', 'sand', 'snow', 'moss', 'water-deep', 'water-shallow', 'lava', 'swamp', 'cave-floor', 'ice', 'rubble-field']) expect(defaultTerrainEdge(id), id).toBe('fade');
    for (const id of ['flagstones', 'wood-planks', 'carpet', 'cobblestones']) expect(defaultTerrainEdge(id), id).toBe('hard');
    expect(defaultTerrainEdge('chasm')).toBe('ragged');
    const tiles = COLOUR_ASSETS.filter((a) => a.kind === 'terrain');
    for (const a of tiles) expect(defaultTerrainEdge(a.id), a.id).toBe(a.category === 'floors' ? 'hard' : 'fade');
    // every built-in texture but the floors has a material of its own (none falls back to the unknown default)
    const floors = new Set(['flagstones', 'wood-planks', 'carpet', 'cobblestones']);
    for (const a of [...ASSETS, ...tiles].filter((x) => x.kind === 'terrain' && x.category !== 'floors' && !floors.has(x.id))) expect(terrainMaterial(a.id), a.id).not.toBe('floor');
    expect(defaultTerrainEdge('no-such-terrain')).toBe('hard');
  });

  it('works out how two areas meet: a set edge wins over a default, else the harder one; against nothing at most ragged', () => {
    const s = (asset: string, more: Partial<Terrain> = {}) => ({ asset, ...terrainEdgeSettings({ asset, ...more }) });
    expect(pairEdge(s('c-ground-grass-short'), s('c-ground-dirt'))).toBe('fade');
    expect(pairEdge(s('c-ground-grass-short'), s('c-floor-planks-oak'))).toBe('hard');
    expect(pairEdge(s('c-ground-grass-short', { edge: 'fade' }), s('c-floor-planks-oak'))).toBe('fade');
    expect(pairEdge(s('c-ground-grass-short', { edge: 'ragged' }), s('c-ground-dirt'))).toBe('ragged');
    expect(pairEdge(s('c-ground-grass-short', { edge: 'fade' }), s('c-ground-dirt', { edge: 'hard' }))).toBe('hard');
    expect(pairEdge(s('c-ground-grass-short'), s('c-ground-grass-short'))).toBe('hard'); // one texture joins without a seam
    expect(pairEdge(s('c-ground-grass-short', { edge: 'fade' }), null)).toBe('ragged');
    expect(pairEdge(s('c-floor-planks-oak'), null)).toBe('hard');
    expect(terrainEdgeText({ asset: 'c-ground-sand', fadeWidth: 3 })).toBe('fades over 3 squares into the terrain under it (ragged against bare ground) (by material)');
    expect(terrainEdgeText({ asset: 'c-ground-sand', edge: 'hard', stack: 2, edgeDetails: false })).toBe('a hard edge, stack 2, no edge details');
  });
});

describe('the stacking order', () => {
  it('puts water lowest, then sand and mud, dirt and gravel, grass, moss and forest floor, snow, indoor floors', () => {
    const order = ['c-water-deep', 'c-water-river', 'c-water-shallow', 'c-ground-sand', 'c-ground-dirt', 'c-ground-grass-short', 'c-ground-snow', 'c-floor-planks-oak'];
    const stacks = order.map((id) => terrainEdgeSettings({ asset: id }).stack);
    expect([...stacks].sort((a, b) => a - b)).toEqual(stacks);
    expect(new Set(stacks).size).toBe(order.length);
    for (const [a, b] of [['c-ground-mud', 'c-ground-sand'], ['c-ground-gravel', 'c-ground-dirt'], ['c-ground-moss', 'c-ground-forest-floor'], ['water-deep', 'c-water-deep'], ['grass', 'c-ground-meadow']]) {
      expect(terrainEdgeSettings({ asset: a! }).stack, `${a} ~ ${b}`).toBe(terrainEdgeSettings({ asset: b! }).stack);
    }
    expect(terrainEdgeSettings({ asset: 'c-water-deep', stack: 9 }).stack).toBe(9);
    expect(MATERIAL_STACK.deep).toBe(0);
  });

  it('keeps what covers what by map order: a pond drawn over a field stays a pond, one drawn under it stays covered', () => {
    const field = terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 20, 14] });
    const pond = terrain('t2', 'c-water-calm', { circle: [10, 7, 3] });
    const over = edgesOf(mapOf([field, pond]));
    expect(insidePolygons(over.areas.get('t2')!.core!, [10, 7])).toBe(true);
    const under = mapOf([pond, field]);
    const names = buildScene(under, { assets: body }).layers.map((l) => l.name).filter((n) => n.startsWith('terrain:'));
    expect(names).toEqual(['terrain:t2', 'terrain:t1']);
    expect(insidePolygons(edgesOf(under).areas.get('t1')!.core ?? terrainPolygons(field), [10, 7])).toBe(true);
  });

  it('lets the higher of two areas form the patches: changing an area\'s stack changes its fade', () => {
    const base = terrain('t1', 'c-ground-dirt', { rect: [0, 0, 20, 14] });
    const grass = terrain('t2', 'c-ground-grass-short', { rect: [4, 3, 12, 8] });
    const a = edgesOf(mapOf([base, grass])).areas.get('t2')!;
    const b = edgesOf(mapOf([base, { ...grass, stack: 1 }])).areas.get('t2')!;
    expect(JSON.stringify(a.core)).not.toBe(JSON.stringify(b.core));
    // roughly as much of each either way: only the shapes of the patches change
    expect(Math.abs(area(a.core!) - area(b.core!))).toBeLessThan(0.15 * area(a.core!));
  });
});

describe('hard, ragged and fade edges', () => {
  it('draws a hard area exactly as its shape', () => {
    const map = mapOf([terrain('t1', 'c-ground-sand', { rect: [2, 2, 6, 4] }, { edge: 'hard' }), terrain('t2', 'c-floor-planks-oak', { rect: [10, 2, 6, 4] })]);
    for (const id of ['t1', 't2']) {
      expect(edgesOf(map).areas.get(id)!.core).toBeNull();
      const ls = layersOf(map, id);
      expect(ls.map((l) => l.name)).toEqual([`terrain:${id}`]);
      expect(patterns(ls)[0]!.polygons).toEqual(terrainPolygons(map.objects.find((o) => o.id === id) as Terrain));
    }
  });

  it('gives ground against bare ground a ragged outline with no straight runs, close to the shape', () => {
    const rect: [number, number, number, number] = [2, 2, 10, 6];
    const map = mapOf([terrain('t1', 'c-ground-sand', { rect })]);
    const e = edgesOf(map).areas.get('t1')!;
    expect(e.core).not.toBeNull();
    const pts = points(e.core!);
    expect(Math.max(...pts.map((p) => toRect(p, rect)))).toBeLessThan(0.3);
    expect(pts.some((p) => toRect(p, rect) > 0.05)).toBe(true);
    expect(Math.abs(area(e.core!) - 60)).toBeLessThan(3);
    for (const p of e.core!) for (let i = 0; i < p.outer.length; i++) {
      const a = p.outer[i]!;
      const b = p.outer[(i + 1) % p.outer.length]!;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(1.2);
    }
    // ragged, not faded: even set to fade it doesn't fade into the paper
    const faded = edgesOf(mapOf([terrain('t1', 'c-ground-sand', { rect }, { edge: 'fade', fadeWidth: 4 })])).areas.get('t1')!;
    expect(Math.max(...points([...faded.core!, ...faded.fades.flatMap((f) => f.polygons)]).map((p) => toRect(p, rect)))).toBeLessThan(0.4);
  });

  const sandIn = (width?: number) => {
    const rect: [number, number, number, number] = [10, 6, 20, 12];
    const map = mapOf([terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 40, 24] }), terrain('t2', 'c-ground-sand', { rect }, width ? { fadeWidth: width } : {})]);
    return { rect, map, e: edgesOf(map), sand: edgesOf(map).areas.get('t2')! };
  };

  it('fades sand into grass in patches over a short width, with soft rims and the grass running on under it', () => {
    const { rect, map, e, sand } = sandIn();
    // two see-through rims round the patches
    expect(sand.fades.map((f) => f.alpha)).toEqual([0.3, 0.5]);
    // patches out a little past the edge, cracks a little inside it: either all sand or none at most spots
    const reach = Math.max(...points(sand.core!).filter((p) => !(p[0] > rect[0] && p[0] < rect[0] + rect[2] && p[1] > rect[1] && p[1] < rect[1] + rect[3])).map((p) => toRect(p, rect)));
    expect(reach).toBeGreaterThan(0.2);
    expect(reach).toBeLessThan(0.8);
    expect(across(sand, rect, 0).sd).toBeGreaterThan(0.35);
    expect(across(sand, rect, -0.5).mean).toBeGreaterThan(0.97);
    expect(across(sand, rect, 0.6).mean).toBeLessThan(0.03);
    // the grass runs on under it (here it is drawn whole there anyway), so nothing but grass or sand shows near the edge
    const grass = e.areas.get('t1')!.core ?? terrainPolygons(map.objects[0] as Terrain);
    for (let y = rect[1] + 0.5; y < rect[1] + rect[3]; y += 0.5) expect(insidePolygons(grass, [rect[0] + 0.3, y])).toBe(true);
    // in the scene: core, then the rims (see-through), then the details; a rim is a see-through copy of the tile
    expect(layersOf(map, 't2').map((l) => `${l.name.split(':')[0]}:${l.kind}`).slice(0, 3)).toEqual(['terrain:pattern', 'terrain-fade:pattern', 'terrain-fade:pattern']);
    const svg = renderSvg(map, { assets: body });
    expect(svg).toMatch(/<pattern id="tile-c-ground-sand-[^"]*-a300"[^>]*><rect [^>]*fill="url\(#tile-c-ground-sand-[^"]*\)" opacity="0.3"\/><\/pattern>/);
    expect(svg).toMatch(/fill="url\(#tile-c-ground-sand-[^"]+-a300\)" fill-rule="evenodd"\/>/);
  });

  it('turns a long fade into a gradual change: coverage falling evenly across the width, mottled, not a straight gradient', () => {
    for (const width of [3, 5]) {
      const { rect, sand } = sandIn(width);
      const hw = width / 2;
      // more see-through steps, every one see-through
      expect(sand.fades.length, `${width}`).toBe(5);
      expect(sand.fades.every((f) => f.alpha > 0 && f.alpha < 1)).toBe(true);
      const at = (k: number) => across(sand, rect, k * hw);
      // all sand well inside, none well outside, about half at the drawn edge, falling steadily in between
      expect(at(-1.2).mean, `${width}`).toBeGreaterThan(0.97);
      expect(at(1.2).mean, `${width}`).toBeLessThan(0.03);
      expect(at(0).mean, `${width}`).toBeGreaterThan(0.4);
      expect(at(0).mean, `${width}`).toBeLessThan(0.6);
      const profile = [-0.8, -0.4, 0, 0.4, 0.8].map((k) => at(k).mean);
      for (let k = 1; k < profile.length; k++) expect(profile[k]!, `${width}: ${profile.map((v) => v.toFixed(2))}`).toBeLessThan(profile[k - 1]! - 0.08);
      // mottled: it varies along the edge, but most spots are part way, not a splatter of all or nothing
      const mid = at(0);
      expect(mid.sd, `${width}`).toBeGreaterThan(0.05);
      expect(mid.sd, `${width}`).toBeLessThan(0.25);
    }
  });

  it('leaves few isolated bits far out on a long fade', () => {
    const { rect, sand } = sandIn(5);
    const pieces = [...sand.core!, ...sand.fades.flatMap((f) => f.polygons)];
    // pieces lying wholly past most of the fade's width: a few faint ones at most
    const far = pieces.filter((p) => p.outer.every((q) => toRect(q, rect) > 0.9 * 2.5 && !(q[0] > rect[0] && q[0] < rect[0] + rect[2] && q[1] > rect[1] && q[1] < rect[1] + rect[3])));
    expect(far.length).toBeLessThan(6);
    expect(far.every((p) => sand.core!.indexOf(p) < 0)).toBe(true);
  });

  it('keeps a short fade as it was when an area elsewhere on the map has a long one', () => {
    const { rect, sand } = sandIn();
    // a field with a long fade to dirt further down the map
    const both = mapOf([
      terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 40, 24] }),
      terrain('t2', 'c-ground-sand', { rect }),
      terrain('t3', 'c-ground-grass-short', { rect: [0, 32, 40, 20] }),
      terrain('t4', 'c-ground-dirt', { rect: [10, 38, 20, 8] }, { fadeWidth: 5 }),
    ]);
    expect(edgesOf(both).areas.get('t4')!.fades.length).toBe(5);
    expect(JSON.stringify(edgesOf(both).areas.get('t2'))).toBe(JSON.stringify(sand));
  });

  it('runs an area on under a later one that fades over it, so no gap opens between neighbours', () => {
    // two areas side by side (no overlap): the earlier one grows under the later one's soft edge
    const map = mapOf([terrain('t1', 'c-ground-dirt', { rect: [0, 0, 10, 10] }), terrain('t2', 'c-ground-grass-short', { rect: [10, 0, 10, 10] })]);
    const e = edgesOf(map);
    const dirt = e.areas.get('t1')!.core!;
    for (let y = 1; y < 9; y += 0.25) for (const x of [10.1, 10.3]) expect(insidePolygons(dirt, [x, y]), `${x},${y}`).toBe(true);
  });

  it('keeps edges along walls as drawn, so a texture never wobbles past a wall or fades through it', () => {
    const map = mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] } }, terrain('t1', 'c-ground-moss', { rect: [0, 0, 8, 6] })]);
    expect(edgesOf(map).areas.get('t1')!.core).toBeNull();
    // half in the room: along the walls it stays straight; on the bare floor and out over the hatching it is ragged
    const half = mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] } }, terrain('t1', 'c-ground-moss', { rect: [4, 0, 8, 6] })]);
    const core = edgesOf(half).areas.get('t1')!.core!;
    for (let x = 4.8; x < 7.4; x += 0.1) {
      for (const [inside, outside] of [[0.02, -0.02], [5.98, 6.02]] as const) {
        expect(insidePolygons(core, [x, inside]), `${x},${inside}`).toBe(true);
        expect(insidePolygons(core, [x, outside]), `${x},${outside}`).toBe(false);
      }
    }
    expect(points(core).some((p) => p[0] < 3.97)).toBe(true);
    expect(points(core).some((p) => p[0] > 8.8 && (p[1] < -0.03 || p[1] > 6.03))).toBe(true);
  });
});

describe('details along the edges', () => {
  const kindsOf = (map: DelveMap, id: string) => edgesOf(map).areas.get(id)!.details.map((d) => `${d.kind}:${d.tone.tone}`).sort();

  it('draws a shoreline where water meets land, tufts over a road, patches elsewhere, nothing along floors or when turned off', () => {
    const base = (asset: string, more: Partial<Terrain> = {}) => mapOf([terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 30, 20] }), terrain('t2', asset, { rect: [8, 6, 14, 8] }, more)]);
    expect(edgeRecipe('shallow', 'green')).toBe('shore');
    expect(edgeRecipe('earth', 'green')).toBe('tufts');
    expect(edgeRecipe('sand', 'earth')).toBe('patches');
    expect(edgeRecipe('floor', 'green')).toBeNull();
    const shore = kindsOf(base('c-water-shallow'), 't2');
    for (const k of ['stroke:foam', 'fill:light', 'fill:stone']) expect(shore).toContain(k);
    const road = kindsOf(base('c-ground-dirt'), 't2');
    for (const k of ['stroke:main', 'stroke:dark', 'dots:main']) expect(road).toContain(k);
    expect(kindsOf(mapOf([terrain('t1', 'c-ground-sand', { rect: [0, 0, 30, 20] }), terrain('t2', 'c-ground-dirt', { rect: [8, 6, 14, 8] })]), 't2')).toContain('fill:main');
    expect(kindsOf(base('c-floor-planks-oak', { edge: 'fade' }), 't2')).toEqual([]);
    expect(kindsOf(base('c-water-shallow', { edgeDetails: false }), 't2')).toEqual([]);
    // never against nothing
    expect(kindsOf(mapOf([terrain('t2', 'c-water-shallow', { rect: [8, 6, 14, 8] })]), 't2')).toEqual([]);
  });

  it('draws them in each style\'s colours: colour textures through the style\'s palette, ink tiles from their tint', () => {
    const map = mapOf([terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 30, 20] }), terrain('t2', 'c-ground-dirt', { rect: [8, 6, 14, 8] })]);
    const colours = (preset: string) => new Set(buildScene({ ...map, style: { preset } }, { assets: body }).layers.filter((l) => l.name.startsWith('terrain-edge:')).map((l) => ('color' in l ? l.color : '')));
    expect(colours('classic-hatching')).toContain('#345F34'); // leaf-dark, as drawn
    expect(colours('parchment')).not.toContain('#345F34'); // toned
    const ink = mapOf([terrain('t1', 'grass', { rect: [0, 0, 30, 20] }), terrain('t2', 'dirt', { rect: [8, 6, 14, 8] })]);
    expect(buildScene(ink, { assets: body }).layers.filter((l) => l.name.startsWith('terrain-edge:')).length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  const valley = () =>
    mapOf([
      terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 40, 24] }),
      terrain('t2', 'c-ground-dirt', { poly: [[0, 10], [14, 9], [26, 12], [40, 11], [40, 14], [26, 15], [14, 12], [0, 13]] }),
      terrain('t3', 'c-water-shallow', { poly: [[18, 0], [22, 0], [21, 12], [24, 24], [17, 24], [18, 12]] }),
      terrain('t4', 'c-water-river', { poly: [[19, 0], [21, 0], [20, 12], [22, 24], [19, 24], [19.5, 12]] }),
      terrain('t5', 'c-ground-sand', { circle: [32, 5, 3] }, { fadeWidth: 2.5 }),
    ]);

  it('draws the same picture every time, from the cache or worked out afresh', () => {
    const svg = renderSvg(valley(), { assets: body });
    expect(renderSvg(valley(), { assets: body })).toBe(svg);
    clearTerrainEdgeCaches();
    expect(renderSvg(valley(), { assets: body })).toBe(svg);
  });

  it('leaves an area as it is when something far from it changes', () => {
    const map = valley();
    const before = JSON.stringify(edgesOf(map).areas.get('t5'));
    clearTerrainEdgeCaches();
    const moved = { ...map, objects: map.objects.map((o) => (o.id === 't2' ? { ...o, shape: { poly: (o as Terrain & { shape: { poly: Point[] } }).shape.poly.map(([x, y]) => [x, y + 1] as Point) } } : o)) };
    expect(JSON.stringify(edgesOf(moved).areas.get('t5'))).toBe(before);
    // another seed is another wobble
    expect(JSON.stringify(edgesOf({ ...map, seed: 8 }).areas.get('t5'))).not.toBe(before);
  });
});

describe('fog of war', () => {
  it('never draws terrain, a fade or a detail outside what the players have seen, and draws the seen part as the GM sees it', () => {
    const map = mapOf(
      [
        { id: 'r1', type: 'room', shape: { rect: [14, 8, 12, 8] } },
        terrain('t1', 'c-ground-grass-short', { rect: [0, 0, 40, 24] }),
        terrain('t2', 'c-ground-dirt', { poly: [[0, 10], [14, 9], [26, 12], [40, 11], [40, 14], [26, 15], [14, 12], [0, 13]] }, { fadeWidth: 2 }),
        terrain('t3', 'c-water-shallow', { circle: [20, 4, 4] }),
      ],
      { fog: { on: true, revealed: ['r1'] } },
    );
    const seen = visiblePolygons(map);
    const layers = buildScene(map, { view: 'players', fog: 'hide', assets: body }).layers.filter((l) => l.name.startsWith('terrain'));
    for (const prefix of ['terrain:', 'terrain-fade:', 'terrain-edge:']) expect(layers.some((l) => l.name.startsWith(prefix)), prefix).toBe(true);
    for (const l of layers) {
      // polygons are cut exactly at the seen area's edge; lines in short steps (a hair over at most)
      const [pts, tol] = l.kind === 'pattern' || l.kind === 'fill' ? [points(l.polygons), 1e-3] : l.kind === 'stroke' ? [l.lines.flatMap((x) => x.points), 0.06] : l.kind === 'dots' ? [l.points, 0] : [[], 0];
      for (const p of pts as Point[]) expect(insidePolygons(seen, p) || nearEdge(seen, p, tol), `${l.name} ${p}`).toBe(true);
    }
    // where the players see the road, it is the GM's road cut to the seen area
    const cut = (polys: readonly Polygon[]) => polygonsOf(intersectD(polys.flatMap((p) => [p.outer, ...p.holes].map(toPath)), seen.flatMap((p) => [p.outer, ...p.holes].map(toPath)), FillRule.NonZero, 6));
    const gm = patterns(layersOf(map, 't2')).filter((l) => l.name === 'terrain:t2' || l.name === 'terrain-fade:t2');
    const pl = patterns(layers).filter((l) => l.name === 'terrain:t2' || l.name === 'terrain-fade:t2');
    expect(pl.length).toBe(gm.length);
    pl.forEach((l, k) => expect(Math.abs(area(l.polygons) - area(cut(gm[k]!.polygons)))).toBeLessThan(1e-3));
  });
});

describe('maps without terrain', () => {
  it('draw byte for byte as before (every style, both views, fog, the handout), and get no terrain layers', () => {
    // hashes taken with this fingerprint from the code before terrain edges (59f4155)
    const fingerprint = (map: DelveMap) => {
      map = validateMap(map);
      const h = createHash('sha256');
      for (const preset of Object.keys(PRESETS).sort()) for (const view of ['gm', 'players'] as const) h.update(renderSvg({ ...map, style: { preset } }, { view, assets: body }));
      h.update(renderSvg({ ...map, fog: { on: true, revealed: [] } }, { view: 'gm', fog: 'dim', assets: body }));
      h.update(renderSvg({ ...map, fog: { on: true, revealed: ['r1'] } }, { view: 'players', fog: 'hide', assets: body }));
      h.update(oldStains(handoutSvg(map, { assets: body }).svg));
      return h.digest('hex').slice(0, 16);
    };
    const keep = legendKeep();
    keep.objects = keep.objects.filter((o) => o.type !== 'terrain');
    expect(fingerprint(testMap())).toBe('b12108f5448c8cd6');
    expect(fingerprint(keep)).toBe('9a080b4cbd506267');
    expect(fingerprint({ ...testMap(), roughness: 6 })).toBe('45c55118121be529');
    expect(buildScene(keep).layers.some((l) => l.name.startsWith('terrain'))).toBe(false);
  });
});

// ---------- helpers ----------

/** Within `tol` of the polygons' outlines? */
function nearEdge(polys: readonly Polygon[], p: Point, tol: number): boolean {
  for (const poly of polys) {
    for (const r of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i]!;
        const b = r[(i + 1) % r.length]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
        if (Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) <= tol) return true;
      }
    }
  }
  return false;
}
