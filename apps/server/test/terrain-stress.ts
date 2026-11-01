// The PNG stress run for terrain edges (terrain-edges.test.ts runs it as a child
// process: a resvg panic aborts the whole process, so in the test runner itself
// it would kill the run without a word). Renders terrain-heavy maps through the
// same paths the server uses: every style in both views (players with fog),
// cropped exports cut by cropScene, a framed Quillwarren Table page, the parchment
// handout on every paper and way round (also cropped and fogged), and a big map.
// Prints one line per picture before drawing it, so a crash names its case.
import { buildScene, cropScene, handoutSvg, PRESETS, resolveStyle, sceneToSvg, type DelveMap, type MapObject, type Paper, type Terrain } from '@delve/core';
import { assets } from '../src/assets.ts';
import { svgToPng } from '../src/png.ts';

let seed = 4242;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

/** A river valley: grass, a road, sand, shallows and a river, a pond, a dry patch with a long fade, a room with a planked floor, cave ground, every edge kind. */
function valley(): DelveMap {
  const t = (id: string, asset: string, shape: Terrain['shape'], more: Partial<Terrain> = {}): Terrain => ({ id, type: 'terrain', asset, shape, ...more });
  const objects: MapObject[] = [
    { id: 'r1', type: 'room', shape: { rect: [4, 3, 8, 6] } },
    { id: 'r2', type: 'room', shape: { rect: [30, 18, 9, 7] }, roughness: 8 },
    t('t1', 'c-ground-grass-short', { rect: [0, 0, 44, 28] }),
    t('t2', 'c-ground-dirt', { poly: [[0, 12], [10, 11], [22, 14], [44, 13], [44, 16], [22, 17], [10, 14], [0, 15]] }),
    t('t3', 'c-ground-sand', { poly: [[18, 0], [27, 0], [26, 28], [16, 28]] }, { fadeWidth: 3 }),
    t('t4', 'c-water-shallow', { poly: [[20, 0], [25, 0], [24, 28], [18, 28]] }),
    t('t5', 'c-water-river', { poly: [[21.5, 0], [23.5, 0], [22.5, 28], [20, 28]] }),
    t('t6', 'c-water-pond', { circle: [9, 22, 3] }, { edge: 'ragged' }),
    t('t7', 'c-ground-grass-dry', { poly: [[30, 2], [40, 3], [41, 9], [31, 10]] }, { fadeWidth: 5, stack: 6 }),
    t('t8', 'rubble-field', { circle: [36, 6, 2] }),
    t('t9', 'c-floor-planks-oak', { rect: [4, 3, 8, 6] }),
    t('t10', 'cave-floor', { rect: [30, 18, 9, 7] }),
    t('t11', 'lava', { circle: [34, 21, 1.5] }),
    t('t12', 'snow', { rect: [1, 18, 4, 8] }, { edgeDetails: false }),
    t('t13', 'c-lava-flow', { poly: [[40, 20], [44, 20], [44, 27], [41, 26]] }),
    t('t14', 'c-ground-moss', { rect: [5, 3, 3, 3] }, { edge: 'hard' }),
  ];
  return { format: 'delve.map', version: 1, id: 'stress-valley', name: 'Stress valley', grid: { type: 'square' }, seed: 11, objects, fog: { on: true, revealed: ['r2'], show: [{ circle: [22, 14, 6] }] } };
}

/** A big map: a 160 × 110 grass base with 120 blobs of every kind of ground, some with long fades. */
function bigMap(): DelveMap {
  const kinds = ['c-ground-dirt', 'c-ground-sand', 'c-water-shallow', 'c-ground-gravel', 'c-ground-moss', 'c-water-deep', 'mud', 'snow', 'c-ground-forest-floor', 'grass', 'c-water-river', 'water-deep', 'sand', 'chasm', 'c-ground-swamp'];
  const objects: MapObject[] = [{ id: 't0', type: 'terrain', asset: 'c-ground-grass-short', shape: { rect: [0, 0, 160, 110] } }];
  for (let k = 0; k < 120; k++) {
    const cx = 3 + rand() * 154;
    const cy = 3 + rand() * 104;
    const n = 7 + Math.floor(rand() * 7);
    const r = 1 + rand() * 7;
    const poly = Array.from({ length: n }, (_, q): [number, number] => {
      const a = (q / n) * Math.PI * 2;
      const rr = r * (0.6 + rand() * 0.6);
      return [Math.round((cx + Math.cos(a) * rr) * 2) / 2, Math.round((cy + Math.sin(a) * rr) * 2) / 2];
    });
    objects.push({ id: `t${k + 1}`, type: 'terrain', asset: pick(kinds), shape: { poly }, ...(rand() < 0.25 ? { fadeWidth: 1 + Math.round(rand() * 8) / 2 } : {}) });
  }
  return { format: 'delve.map', version: 1, id: 'stress-big', name: 'Stress big', grid: { type: 'square' }, seed: 5, objects };
}

let count = 0;
async function png(label: string, svg: string): Promise<void> {
  console.log(label);
  const out = await svgToPng(svg);
  if (out.length < 60) throw new Error(`${label}: no picture`);
  count++;
}

const t0 = Date.now();
const map = valley();
const styles = Object.keys(PRESETS);
for (const preset of styles) {
  const m: DelveMap = { ...map, style: { preset } };
  for (const view of ['gm', 'players'] as const) {
    const scene = buildScene(m, { view, assets: assets.body, ...(view === 'players' ? { fog: 'hide' as const } : { fog: 'dim' as const }) }, resolveStyle(m));
    await png(`${preset} ${view}`, sceneToSvg(scene, { ppg: 14 }));
  }
}
// cropped exports, as the render route draws them (cut to the frame by cropScene); the crops stay near the map
for (let k = 0; k < 40; k++) {
  const w = 1 + Math.floor(rand() * 20);
  const h = 1 + Math.floor(rand() * 16);
  const x0 = Math.floor(-6 + rand() * 46);
  const y0 = Math.floor(-6 + rand() * 30);
  const preset = pick(styles);
  const view = pick(['gm', 'players'] as const);
  const m: DelveMap = { ...map, style: { preset } };
  const scene = buildScene(m, { view, assets: assets.body, frame: { x0, y0, x1: x0 + w, y1: y0 + h }, ...(view === 'players' && rand() < 0.5 ? { fog: 'hide' as const } : {}) }, resolveStyle(m));
  await png(`crop ${preset} ${view} ${x0},${y0},${x0 + w},${y0 + h}`, sceneToSvg(cropScene(scene, scene.bounds), { ppg: Math.min(70, Math.floor(700 / Math.max(w, h))) }));
}
// a Quillwarren Table page: the whole map in a frame a little wider, not cut (as table/vision-render.ts draws it)
for (const view of ['gm', 'players'] as const) {
  const scene = buildScene(map, { view, assets: assets.body, frame: { x0: -2, y0: -2, x1: 46, y1: 30 }, reveal: [{ outer: [[10, 5], [36, 5], [36, 24], [10, 24]], holes: [] }] }, resolveStyle(map));
  await png(`table page ${view}`, sceneToSvg(scene, { ppg: 12 }));
}
// the handout on every paper and way round, then cropped and fogged ones
const PAPERS: Paper[] = ['a4', 'a3', 'letter', 'fit'];
for (const paper of PAPERS) {
  for (const orientation of ['auto', 'portrait', 'landscape'] as const) await png(`handout ${paper} ${orientation}`, handoutSvg(map, { paper, orientation, dpi: 40, assets: assets.body }).svg);
}
for (let k = 0; k < 12; k++) {
  const w = 3 + Math.floor(rand() * 20);
  const h = 3 + Math.floor(rand() * 14);
  const x0 = Math.floor(-3 + rand() * 40);
  const y0 = Math.floor(-3 + rand() * 24);
  const paper = pick(PAPERS);
  const orientation = pick(['auto', 'portrait', 'landscape'] as const);
  await png(`handout crop ${paper} ${orientation} ${x0},${y0},${x0 + w},${y0 + h}`, handoutSvg(map, { paper, orientation, dpi: 40, assets: assets.body, crop: { x0, y0, x1: x0 + w, y1: y0 + h }, revealedOnly: rand() < 0.4 }).svg);
}
// a big map, whole and in pieces
const big = bigMap();
for (const preset of ['classic-hatching', 'parchment', 'old-school-blue']) {
  const m: DelveMap = { ...big, style: { preset } };
  await png(`big ${preset}`, sceneToSvg(buildScene(m, { assets: assets.body }, resolveStyle(m)), { ppg: 5 }));
}
await png('big handout', handoutSvg(big, { paper: 'a3', dpi: 30, assets: assets.body }).svg);
for (let k = 0; k < 6; k++) {
  const x0 = Math.floor(rand() * 140);
  const y0 = Math.floor(rand() * 90);
  const scene = buildScene(big, { assets: assets.body, frame: { x0, y0, x1: x0 + 20, y1: y0 + 20 } }, resolveStyle(big));
  await png(`big crop ${x0},${y0}`, sceneToSvg(cropScene(scene, scene.bounds), { ppg: 30 }));
}
console.log(`ok ${count} pictures in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
