import { describe, expect, it } from 'vitest';
import { floorArea, guessRoles, mainColours, outlines, signedArea, toDungeonScrawl, traceImage, tracedMap, type RGB, type TraceRole } from '../src/index.ts';

const WHITE: RGB = { r: 240, g: 236, b: 226 };
const HOUSE: RGB = { r: 180, g: 150, b: 120 };
const WALL: RGB = { r: 30, g: 28, b: 26 };
const LINE: RGB = { r: 120, g: 120, b: 200 };

/** A small picture: a background colour and filled rectangles [x, y, w, h] painted in order. */
function picture(w: number, h: number, rects: [RGB, number, number, number, number][], bg = WHITE) {
  const rgba = new Uint8Array(w * h * 4);
  const paint = (c: RGB, x0: number, y0: number, rw: number, rh: number) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) rgba.set([c.r, c.g, c.b, 255], (y * w + x) * 4);
  };
  paint(bg, 0, 0, w, h);
  for (const r of rects) paint(...r);
  return { width: w, height: h, rgba };
}

const trace = (pic: ReturnType<typeof picture>, colours: RGB[], roles: TraceRole[], extra: Partial<Parameters<typeof traceImage>[0]> = {}) =>
  traceImage({ ...pic, colours, roles, pxPerSquare: 10, ...extra });
const rooms = (objects: ReturnType<typeof traceImage>['objects']) => objects.filter((o) => o.type === 'room');
const mapOf = (objects: ReturnType<typeof traceImage>['objects']) =>
  tracedMap({ objects, counts: {}, size: [0, 0] }, { id: 'map_trace000001', name: 'T', feetPerSquare: 5 });

describe('picture tracing', () => {
  it('finds the main colours and how much of the picture each covers', () => {
    const pic = picture(100, 100, [[HOUSE, 0, 0, 50, 100], [WALL, 50, 0, 10, 100]]);
    const found = mainColours(pic.rgba, 3);
    expect(found.map((c) => Math.round(c.share * 100))).toEqual([50, 40, 10]);
    expect(found[0]!.colour).toEqual(HOUSE);
    expect(found[2]!.colour).toEqual(WALL);
  });

  it('traces outlines clockwise, holes the other way', () => {
    const px = new Uint8Array(25).fill(1);
    px[12] = 0;
    const rings = outlines({ w: 5, h: 5, px });
    expect(rings.map((r) => signedArea(r)).sort((a, b) => a - b)).toEqual([-1, 25]);
  });

  it('turns building blocks into rooms, in grid squares', () => {
    const pic = picture(100, 80, [[HOUSE, 10, 10, 30, 20], [HOUSE, 60, 40, 20, 30]]);
    const { objects, counts, size } = trace(pic, [WHITE, HOUSE], ['ignore', 'building']);
    expect(counts).toEqual({ building: 2 });
    expect(size).toEqual([10, 8]);
    const shapes = rooms(objects).map((r) => ('poly' in r.shape ? [...r.shape.poly].sort() : []));
    expect(shapes).toContainEqual([[1, 1], [1, 3], [4, 1], [4, 3]]);
    expect(shapes).toContainEqual([[6, 4], [6, 7], [8, 4], [8, 7]]);
  });

  it('fills text holes in houses but keeps courtyards', () => {
    const pic = picture(120, 120, [
      [HOUSE, 0, 0, 50, 50], [WHITE, 20, 22, 8, 5], // a word printed on a house
      [HOUSE, 60, 60, 60, 60], [WHITE, 70, 70, 40, 40], // a courtyard of 16 squares
    ]);
    const { objects } = trace(pic, [WHITE, HOUSE], ['ignore', 'building']);
    expect(rooms(objects)).toHaveLength(2);
    expect(objects.filter((o) => o.type === 'cutout')).toHaveLength(1);
    expect(floorArea(mapOf(objects))).toBeCloseTo(25 + 36 - 16, 5);
  });

  it('removes thin grid lines, even where they cross a house', () => {
    const pic = picture(100, 100, [[HOUSE, 20, 20, 60, 60], [LINE, 0, 50, 100, 1], [LINE, 50, 0, 1, 100]]);
    const { objects } = trace(pic, [WHITE, HOUSE, LINE], ['ignore', 'building', 'water']);
    expect(rooms(objects)).toHaveLength(1);
    expect(objects.filter((o) => o.type === 'terrain')).toHaveLength(0);
    expect(floorArea(mapOf(objects))).toBeCloseTo(36, 5);
  });

  it('removes a printed grid but keeps the outlines between houses', () => {
    // a real picture is big next to one house, so its outline crosses only a few percent of it
    const pic = picture(400, 400, [[HOUSE, 20, 20, 80, 30], [WALL, 59, 20, 2, 30], [WALL, 0, 35, 400, 1], [WALL, 150, 0, 1, 400]]);
    const { objects } = trace(pic, [WHITE, HOUSE, WALL], ['ignore', 'building', 'ignore'], { join: false });
    expect(rooms(objects)).toHaveLength(2);
    expect(floorArea(mapOf(objects))).toBeCloseTo(24 - 0.6, 1);
    const kept = trace(pic, [WHITE, HOUSE, WALL], ['ignore', 'building', 'ignore'], { join: false, grid: false });
    expect(rooms(kept.objects)).toHaveLength(4);
  });

  it('drops wall-coloured text and outlines thinner than the minimum width', () => {
    const pic = picture(120, 60, [[WALL, 0, 0, 120, 10], [WALL, 10, 30, 30, 3], [WALL, 60, 30, 3, 20]]);
    expect(trace(pic, [WHITE, WALL], ['ignore', 'wall'], { grid: false }).counts.wall).toBe(1);
    expect(trace(pic, [WHITE, WALL], ['ignore', 'wall'], { grid: false, minWidth: { wall: 0 } }).counts.wall).toBe(3);
  });

  it('splits a ring wall into solid pieces that still cover it', () => {
    const pic = picture(120, 120, [[WALL, 10, 10, 100, 100], [WHITE, 20, 20, 80, 80]]);
    const { objects, counts } = trace(pic, [WHITE, WALL], ['ignore', 'wall']);
    expect(counts.wall).toBeGreaterThanOrEqual(2);
    expect(rooms(objects).every((r) => r.name === 'Wall')).toBe(true);
    expect(floorArea(mapOf(objects))).toBeCloseTo(100 - 64, 5);
  });

  it('puts terrain under walls and houses', () => {
    const pic = picture(100, 100, [[{ r: 70, g: 130, b: 200 }, 0, 0, 100, 30], [HOUSE, 20, 50, 30, 30], [WALL, 60, 50, 30, 10]]);
    const colours = [WHITE, { r: 70, g: 130, b: 200 }, HOUSE, WALL];
    const { objects } = trace(pic, colours, ['ignore', 'water', 'building', 'wall']);
    expect(objects.map((o) => (o.type === 'terrain' ? o.asset : o.type === 'room' ? (o.name ?? 'house') : o.type))).toEqual(['water-deep', 'Wall', 'house']);
  });

  it('guesses roles from the colours', () => {
    const colours = [WHITE, HOUSE, WALL, { r: 70, g: 130, b: 200 }, { r: 90, g: 160, b: 80 }, { r: 200, g: 200, b: 200 }];
    const shares = [0.5, 0.2, 0.1, 0.1, 0.07, 0.03];
    expect(guessRoles(colours.map((colour, i) => ({ colour, share: shares[i]! })))).toEqual(['ignore', 'building', 'wall', 'water', 'grass', 'ignore']);
  });

  it('makes a valid map that exports to Dungeon Scrawl', () => {
    const pic = picture(100, 100, [[HOUSE, 10, 10, 30, 30], [HOUSE, 50, 50, 40, 20]]);
    const map = tracedMap(trace(pic, [WHITE, HOUSE], ['ignore', 'building']), { id: 'map_trace000002', name: '  Old Town ', feetPerSquare: 10 });
    expect(map).toMatchObject({ name: 'Old Town', grid: { unit: '10 ft' }, style: { preset: 'clean' } });
    expect(Object.values(toDungeonScrawl(map).data.geometry)[0]!.polygons).toHaveLength(2);
  });
});
