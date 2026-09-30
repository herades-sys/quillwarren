// Uploaded pictures on a map (the `image` object): schema, drawing order,
// views and fog, size helpers, ops, describe and the Dungeon Scrawl export.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildScene,
  describeMap,
  imageBounds,
  imageCentre,
  imageFit,
  objectBounds,
  onImage,
  sceneToSvg,
  toDungeonScrawl,
  validateMap,
  type DelveMap,
  type MapImage,
  type MapObject,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const SRC = `${'ab'.repeat(32)}.png`;
const RUG = `${'cd'.repeat(32)}.jpg`;
const table: MapImage = { id: 'img1', type: 'image', src: SRC, at: [2, 17], w: 2, h: 1, name: 'Table' }; // the middle of room 3 (x 0–4, y 13–21)
const rug: MapImage = { id: 'img2', type: 'image', src: RUG, at: [10, 18], w: 3, h: 2, layer: 'floor', opacity: 0.6 };
const note: MapImage = { id: 'img3', type: 'image', src: SRC, at: [18, 17], w: 1, h: 1, gmOnly: true, rotation: 45 };

const withImages = (...images: MapObject[]): DelveMap => validateMap({ ...testMap(), objects: [...testMap().objects, ...images] });
const names = (m: DelveMap, opts: Parameters<typeof buildScene>[1] = {}) => buildScene(m, opts).layers.map((l) => l.name);

describe('image objects', () => {
  it('only point at uploaded pictures by their content hash', () => {
    expect(() => withImages(table, rug, note)).not.toThrow();
    for (const src of ['../../etc/passwd', `${'ab'.repeat(32)}.svg`, `${'AB'.repeat(32)}.png`, 'https://example.com/x.png', `/api/v1/images/${SRC}`]) {
      expect(() => withImages({ ...table, src })).toThrow(/src: must be the "<sha256>/);
    }
    expect(() => withImages({ ...table, w: 0 })).toThrow(/w: must be greater than 0/);
    expect(() => withImages({ ...table, opacity: 1.5 })).toThrow(/opacity/);
    expect(() => withImages({ ...table, layer: 'ceiling' } as unknown as MapImage)).toThrow(/layer/);
  });

  it('draw floor pictures under the grid and walls, the others over the props and under GM symbols', () => {
    const map = withImages(table, rug, { id: 'i1', type: 'prop', asset: 'chest-closed', at: [1.5, 14.5] }, { id: 'i2', type: 'prop', asset: 'trap', at: [2.5, 14.5] });
    const order = names(map);
    const at = (n: string) => order.indexOf(n);
    expect(at('floor-images')).toBe(at('floor') + 1);
    expect(at('floor-images')).toBeLessThan(at('grid'));
    expect(at('floor-images')).toBeLessThan(at('walls'));
    expect(at('images')).toBe(at('props') + 1);
    expect(at('images')).toBeGreaterThan(at('walls'));
    expect(at('images')).toBeLessThan(at('symbols'));
    const svg = sceneToSvg(buildScene(map));
    expect(svg).toContain(`<image data-image="img1" href="/api/v1/images/${SRC}" x="1" y="16.5" width="2" height="1" preserveAspectRatio="none"/>`);
    expect(svg).toContain(`<image data-image="img2" href="/api/v1/images/${RUG}" x="8.5" y="17" width="3" height="2" preserveAspectRatio="none" opacity="0.6"/>`);
  });

  it('turn about their centre, and GM-only ones stay out of the players view', () => {
    const map = withImages(table, note);
    const gm = sceneToSvg(buildScene(map, { view: 'gm' }));
    expect(gm).toContain('data-image="img3"');
    expect(gm).toContain('transform="rotate(45 18 17)"');
    const players = sceneToSvg(buildScene(map, { view: 'players' }));
    expect(players).toContain('data-image="img1"');
    expect(players).not.toContain('data-image="img3"');
  });

  it('respect fog of war: players see only pictures in what they have seen, the GM sees them dimmed', () => {
    const map: DelveMap = { ...withImages(table, rug), fog: { on: true, revealed: ['r3'] } };
    const players = buildScene(map, { view: 'players', fog: 'hide' });
    const pics = players.layers.flatMap((l) => (l.kind === 'images' ? l.items.map((i) => i.id) : []));
    expect(pics).toEqual(['img1']); // the rug lies in the unrevealed crossroads
    const gm = buildScene(map, { view: 'gm', fog: 'dim' });
    expect(gm.layers.flatMap((l) => (l.kind === 'images' ? l.items.map((i) => i.id) : []))).toEqual(['img2', 'img1']);
    expect(gm.layers.some((l) => l.name === 'fog')).toBe(true);
  });

  it('leave maps without pictures exactly as they were, and widen the picture only when they stick out', () => {
    const plain = testMap();
    expect(sceneToSvg(buildScene(plain))).toBe(sceneToSvg(buildScene(validateMap(structuredClone(plain)))));
    expect(names(plain).some((n) => n.includes('images'))).toBe(false);
    expect(buildScene(withImages(table)).bounds).toEqual(buildScene(plain).bounds);
    const far = withImages({ ...table, at: [30, 17] });
    expect(buildScene(far).bounds.x1).toBeGreaterThan(buildScene(plain).bounds.x1);
    // a GM-only picture doesn't widen the players' picture
    expect(buildScene(withImages({ ...note, at: [30, 17] }), { view: 'players' }).bounds).toEqual(buildScene(plain, { view: 'players' }).bounds);
  });

  it('cover a turned footprint, are hit on the picture itself, and snap like props', () => {
    expect(imageBounds(table)).toEqual({ x0: 1, y0: 16.5, x1: 3, y1: 17.5 });
    expect(imageBounds({ ...table, rotation: 90 })).toEqual({ x0: 1.5, y0: 16, x1: 2.5, y1: 18 });
    const b = imageBounds({ at: [0, 0], w: 2, h: 2, rotation: 45 });
    expect(b.x1).toBeCloseTo(Math.SQRT2);
    expect(objectBounds(table, testMap())).toEqual(imageBounds(table));
    expect(onImage(table, [2.9, 17.4])).toBe(true);
    expect(onImage({ ...table, rotation: 90 }, [2.9, 17.4])).toBe(false);
    expect(onImage({ ...table, rotation: 90 }, [2.2, 17.9])).toBe(true);
    expect(imageFit(1200, 800)).toEqual({ w: 2, h: 1.33 });
    expect(imageFit(300, 600)).toEqual({ w: 1, h: 2 });
    expect(imageFit(0, 0)).toEqual({ w: 2, h: 2 });
    // top-left corner of the footprint on the grid, around the pointer
    expect(imageCentre([5.2, 5.1], 2, 1, 0, 1)).toEqual([5, 5.5]);
    expect(imageCentre([5.2, 5.1], 2, 1, 90, 1)).toEqual([5.5, 5]);
  });

  it('move and change like any object, and undo exactly', () => {
    const map = withImages(table);
    const moved = applyOps(map, [{ op: 'move', ids: ['img1'], dx: 1, dy: -2 }]);
    expect(moved.map.objects.find((o) => o.id === 'img1')).toMatchObject({ at: [3, 15] });
    const changed = applyOps(moved.map, [{ op: 'update', id: 'img1', set: { w: 3, h: 1.5, rotation: 90, layer: 'floor', gmOnly: true } }]);
    expect(changed.map.objects.find((o) => o.id === 'img1')).toMatchObject({ w: 3, h: 1.5, rotation: 90, layer: 'floor', gmOnly: true });
    expect(applyOps(changed.map, changed.inverse).map).toEqual(moved.map);
    expect(() => applyOps(map, [{ op: 'update', id: 'img1', set: { src: '../secret.png' } }])).toThrow(/src/);
  });

  it('are listed for Claude with where they are, and stay out of Dungeon Scrawl exports', () => {
    const text = describeMap(withImages(table, rug));
    expect(text).toContain('Images (uploaded pictures):');
    expect(text).toContain(`img1 "Table": 2×1 sq centred at 2,17 in 3 Barracks (src ${SRC})`);
    expect(text).toContain('img2: 3×2 sq centred at 10,18 in 2 Crossroads, on the floor, opacity 0.6');
    expect(text).not.toMatch(/Also: .*image/);
    expect(JSON.stringify(toDungeonScrawl(withImages(table)))).not.toContain(SRC);
  });
});
