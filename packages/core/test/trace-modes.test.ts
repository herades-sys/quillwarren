// The picture tracer's dungeon and painted-city modes, grid finding and role
// guessing, on small pictures drawn here (apps/server/test/trace-bench.test.ts
// checks the whole thing on real renders).
import { describe, expect, it } from 'vitest';
import {
  analysePicture,
  classify,
  colourStats,
  detectGrid,
  floorArea,
  guessDungeonRoles,
  guessPaintedRoles,
  kuwahara,
  mainColours,
  minAreaRect,
  snapRing,
  splitRooms,
  squareUp,
  textureShare,
  traceImage,
  tracedMap,
  type Mask,
  wallLattice,
  type RGB,
} from '../src/index.ts';

type Pic = { width: number; height: number; rgba: Uint8Array };

function canvas(w: number, h: number, bg: RGB): Pic {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([bg.r, bg.g, bg.b, 255], i * 4);
  return { width: w, height: h, rgba };
}
function rect(p: Pic, c: RGB, x0: number, y0: number, w: number, h: number): void {
  for (let y = Math.max(0, y0); y < Math.min(p.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(p.width, x0 + w); x++) p.rgba.set([c.r, c.g, c.b, 255], (y * p.width + x) * 4);
}
/** A rectangle outline `t` pixels thick, its inside edge at (x0, y0, w, h). */
function frame(p: Pic, c: RGB, x0: number, y0: number, w: number, h: number, t: number): void {
  rect(p, c, x0 - t, y0 - t, w + 2 * t, t);
  rect(p, c, x0 - t, y0 + h, w + 2 * t, t);
  rect(p, c, x0 - t, y0, t, h);
  rect(p, c, x0 + w, y0, t, h);
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAPER: RGB = { r: 240, g: 236, b: 226 };
const INK: RGB = { r: 25, g: 25, b: 25 };
const GRID: RGB = { r: 200, g: 196, b: 188 };

/**
 * A dungeon picture at s px per square: two rooms on a printed grid joined by a
 * corridor with a door, a door to the outside, hatching round the walls.
 */
function dungeon(s = 20) {
  const p = canvas(30 * s, 20 * s, PAPER);
  const rand = rng(3);
  // hatching: short dark strokes everywhere outside (the floors are painted over it)
  for (let k = 0; k < 900; k++) {
    const x = Math.floor(rand() * p.width);
    const y = Math.floor(rand() * p.height);
    const len = 4 + Math.floor(rand() * 6);
    if (rand() < 0.5) rect(p, INK, x, y, len, 1);
    else rect(p, INK, x, y, 1, len);
  }
  const floors: [number, number, number, number][] = [
    [3, 3, 8, 6], // room A
    [11, 5, 6, 2], // corridor
    [17, 2, 9, 12], // room B
  ];
  for (const [x, y, w, h] of floors) rect(p, PAPER, x * s, y * s, w * s, h * s);
  // the grid on the floors
  for (const [x, y, w, h] of floors) {
    for (let gx = x; gx <= x + w; gx++) rect(p, GRID, gx * s, y * s, 1, h * s);
    for (let gy = y; gy <= y + h; gy++) rect(p, GRID, x * s, gy * s, w * s, 1);
  }
  // walls, 3 px, centred on the floor's edge, with the corridor's openings left open
  const t = 3;
  const wall = (x0: number, y0: number, w: number, h: number) => rect(p, INK, x0 - 1, y0 - 1, w + 2, h + 2);
  wall(3 * s, 3 * s, 8 * s, 0); // A top
  wall(3 * s, 9 * s, 8 * s, 0); // A bottom
  wall(3 * s, 3 * s, 0, 6 * s); // A left
  wall(11 * s, 3 * s, 0, 2 * s); // A right, above the corridor
  wall(11 * s, 7 * s, 0, 2 * s); // A right, below it
  wall(11 * s, 5 * s, 6 * s, 0); // corridor top
  wall(11 * s, 7 * s, 6 * s, 0); // corridor bottom
  wall(17 * s, 2 * s, 9 * s, 0); // B top
  wall(17 * s, 14 * s, 3 * s, 0); // B bottom, left of the door out
  wall(22 * s, 14 * s, 4 * s, 0); // B bottom, right of it
  wall(26 * s, 2 * s, 0, 12 * s); // B right
  wall(17 * s, 2 * s, 0, 3 * s); // B left, above the corridor
  wall(17 * s, 7 * s, 0, 7 * s); // B left, below it
  // door leaves: between corridor and B (along y at x = 17), and out of B (along x at y = 14)
  frame(p, INK, 17 * s - 2, 5 * s + 3, 4, 2 * s - 6, 1);
  rect(p, PAPER, 17 * s - 2, 5 * s + 3, 4, 2 * s - 6);
  frame(p, INK, 20 * s + 3, 14 * s - 2, 2 * s - 6, 4, 1);
  rect(p, PAPER, 20 * s + 3, 14 * s - 2, 2 * s - 6, 4);
  void t;
  return { pic: p, area: 8 * 6 + 6 * 2 + 9 * 12 };
}

describe('finding a printed grid', () => {
  it('finds the cell size to a fraction of a pixel, and where the lines are', () => {
    const s = 23.4;
    const p = canvas(700, 500, PAPER);
    for (let x = 7; x < 700; x += s) rect(p, GRID, Math.round(x), 0, 1, 500);
    for (let y = 11; y < 500; y += s) rect(p, GRID, 0, Math.round(y), 700, 1);
    // noise: blobs and strokes that are not on the grid
    const rand = rng(9);
    for (let k = 0; k < 300; k++) rect(p, INK, Math.floor(rand() * 700), Math.floor(rand() * 500), 1 + Math.floor(rand() * 8), 1);
    const g = detectGrid(p.rgba, p.width, p.height)!;
    expect(g).not.toBeNull();
    expect(Math.abs(g.cell - s) / s).toBeLessThan(0.005);
    // a line goes through x = 7.5 and y = 11.5 (pixel centres), so the offsets sit there modulo the cell
    const near = (v: number, want: number) => Math.min(Math.abs(((v - want) % s + s) % s), s - Math.abs(((v - want) % s + s) % s));
    expect(near(g.offset[0], 7.5)).toBeLessThan(1);
    expect(near(g.offset[1], 11.5)).toBeLessThan(1);
  });

  it('finds the squares the walls stand on when no grid is printed', () => {
    const s = 20;
    const p = canvas(30 * s, 20 * s, PAPER);
    for (const [x, y, w, h] of [[3, 3, 8, 6], [17, 2, 9, 12], [11, 5, 6, 2]] as const) frame(p, INK, x * s - 1, y * s - 1, w * s + 2, h * s + 2, 3);
    const ink = new Uint8Array(p.width * p.height);
    for (let i = 0; i < ink.length; i++) ink[i] = p.rgba[i * 4]! < 100 ? 1 : 0;
    const g = wallLattice(ink, p.width, p.height, 26)!;
    expect(g).not.toBeNull();
    expect(g.cell).toBeCloseTo(20, 0);
  });

  it('takes the fundamental, not a harmonic, and finds nothing in a picture without a grid', () => {
    const { pic } = dungeon(20);
    const g = detectGrid(pic.rgba, pic.width, pic.height)!;
    expect(g.cell).toBeCloseTo(20, 0);
    const plain = canvas(600, 400, PAPER);
    rect(plain, INK, 100, 100, 300, 4);
    rect(plain, INK, 100, 250, 300, 4);
    expect(detectGrid(plain.rgba, plain.width, plain.height)).toBeNull();
  });
});

describe('tracing a dungeon picture', () => {
  it('turns the floor inside the walls into rooms and a corridor, with doors, and leaves the hatching out', () => {
    const { pic, area } = dungeon(20);
    const a = analysePicture(pic.rgba, pic.width, pic.height);
    expect(a.mode).toBe('dungeon');
    expect(a.grid?.cell).toBeCloseTo(20, 0);
    const r = traceImage({ ...pic, colours: a.colours.map((c) => c.colour), roles: a.roles, space: a.space, mode: 'dungeon', pxPerSquare: a.grid!.cell, origin: a.grid!.offset, printedGrid: true });
    const map = tracedMap(r, { id: 'map_dungeon01', name: 'D', unit: '1.5 m' });
    expect(map.grid.unit).toBe('1.5 m');
    // the door to the outside does not let the floor run out of the room
    expect(floorArea(map)).toBeGreaterThan(area * 0.95);
    expect(floorArea(map)).toBeLessThan(area * 1.05);
    expect(r.counts.room! + r.counts.corridor!).toBe(3);
    expect(r.counts.door).toBe(2);
    // straight walls sit on the half-square grid
    const pts = map.objects.flatMap((o) => (o.type === 'room' && 'poly' in o.shape ? o.shape.poly : []));
    const onHalf = pts.filter(([x, y]) => Math.abs(x * 2 - Math.round(x * 2)) < 0.05 && Math.abs(y * 2 - Math.round(y * 2)) < 0.05);
    expect(onHalf.length / pts.length).toBeGreaterThan(0.9);
    const doors = map.objects.filter((o) => o.type === 'door');
    expect(doors).toContainEqual(expect.objectContaining({ along: 'y', width: 2 }));
    expect(doors).toContainEqual(expect.objectContaining({ along: 'x', width: 2 }));
  });

  it('splits floor into rooms where a corridor opens into them', () => {
    const s = 12;
    const m: Mask = { w: 30 * s, h: 14 * s, px: new Uint8Array(30 * s * 14 * s) };
    const fill = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0 * s; y < (y0 + h) * s; y++) for (let x = x0 * s; x < (x0 + w) * s; x++) m.px[y * m.w + x] = 1;
    };
    fill(1, 1, 8, 8); // room
    fill(9, 4, 10, 2); // a long corridor, two wide
    fill(19, 2, 9, 10); // room
    const { pieces } = splitRooms(m, s);
    expect(pieces).toHaveLength(3);
    expect(pieces.filter((p) => p.corridor)).toHaveLength(1);
    expect(pieces.find((p) => p.corridor)!.width).toBeCloseTo(2, 0);
  });

  it('puts straight walls on the half-square grid and leaves curves alone', () => {
    // a 10 px square drawn 0.6 px off the grid, then a circle
    const ring: [number, number][] = [
      [10.6, 10.6],
      [30.6, 10.6],
      [30.6, 40.6],
      [10.6, 40.6],
    ];
    expect(snapRing(ring, { s: 10, origin: [0, 0] })).toEqual([
      [1, 1],
      [3, 1],
      [3, 4],
      [1, 4],
    ]);
    const circle = Array.from({ length: 64 }, (_, k) => [50 + 30.3 * Math.cos((k / 64) * 2 * Math.PI), 50 + 30.3 * Math.sin((k / 64) * 2 * Math.PI)] as [number, number]);
    const out = snapRing(circle, { s: 10, origin: [0, 0] });
    expect(out.length).toBeGreaterThan(12);
    for (const [x, y] of out) expect(Math.hypot(x - 5, y - 5)).toBeCloseTo(3.03, 1);
  });
});

describe('colours and roles', () => {
  it('merges shades that are nearly the same (Lab), keeps different ones apart', () => {
    const p = canvas(100, 100, { r: 240, g: 236, b: 226 });
    rect(p, { r: 236, g: 233, b: 222 }, 0, 0, 50, 100); // the floor, a shade off the paper
    rect(p, INK, 0, 40, 100, 10);
    const found = mainColours(p.rgba, 4);
    expect(found).toHaveLength(2);
    expect(found[0]!.share).toBeCloseTo(0.9, 1);
  });

  it('guesses dungeon roles from layout: dark ink for walls, the enclosed light colour for floor, blue water inside', () => {
    const { pic } = dungeon(16);
    rect(pic, { r: 70, g: 120, b: 200 }, 19 * 16, 4 * 16, 5 * 16, 4 * 16); // a pool in room B
    const cols = mainColours(pic.rgba, 6);
    const roles = guessDungeonRoles(colourStats(classify(pic.rgba, cols.map((c) => c.colour)), pic.width, pic.height, cols.map((c) => c.colour)), 16);
    const roleOf = (c: RGB) => roles[cols.findIndex((x) => Math.abs(x.colour.r - c.r) + Math.abs(x.colour.g - c.g) + Math.abs(x.colour.b - c.b) < 30)];
    expect(roleOf(INK)).toBe('wall');
    expect(roleOf(PAPER)).toBe('building');
    expect(roleOf({ r: 70, g: 120, b: 200 })).toBe('water');
  });

  it('guesses painted-city roles from hue: both roof shades build, pale cyan is water, greens grass', () => {
    const lab = (l: number, a: number, b: number) => ({ share: 0.05, lab: { l, a, b }, border: 0, enclosed: 1, thickness: 10, pieces: 40, pieceSize: 300 });
    const roles = guessPaintedRoles([lab(49, 15, 43), lab(35, 13, 36), lab(81, -15, 15), lab(77, -21, 75), lab(53, -2, 36), lab(93, -6, 14), lab(74, -9, 57)]);
    expect(roles).toEqual(['building', 'building', 'water', 'grass', 'wall', 'ignore', 'road']);
  });
});

describe('painted city maps', () => {
  const ROOF_LIT: RGB = { r: 180, g: 90, b: 50 };
  const ROOF_DARK: RGB = { r: 120, g: 60, b: 35 };
  const STREET: RGB = { r: 200, g: 180, b: 110 };
  const WALL: RGB = { r: 110, g: 105, b: 95 };

  /** Painted-looking houses (a lit and a shaded half, tile stripes, grain), two touching ones parted by a dark line, a city wall. */
  function town() {
    const p = canvas(240, 200, STREET);
    const house = (x: number, y: number, w: number, h: number) => {
      rect(p, ROOF_LIT, x, y, w, Math.floor(h / 2));
      rect(p, ROOF_DARK, x, y + Math.floor(h / 2), w, h - Math.floor(h / 2));
      for (let k = x + 2; k < x + w; k += 4) rect(p, { r: 160, g: 80, b: 45 }, k, y, 1, Math.floor(h / 2)); // tiles
    };
    house(20, 20, 30, 16);
    house(51, 20, 24, 16); // touches the first, a dark line between
    rect(p, { r: 10, g: 8, b: 6 }, 50, 20, 1, 16);
    house(100, 60, 20, 30);
    house(30, 110, 40, 20);
    rect(p, WALL, 5, 170, 230, 4); // the city wall along the bottom
    const rand = rng(5);
    for (let i = 0; i < p.width * p.height; i++) for (let k = 0; k < 3; k++) p.rgba[i * 4 + k] = Math.max(0, Math.min(255, p.rgba[i * 4 + k]! + Math.round((rand() - 0.5) * 30)));
    return p;
  }

  it('smooths texture away but keeps edges', () => {
    const p = town();
    expect(textureShare(p.rgba, p.width, p.height)).toBeGreaterThan(0.12);
    const sm = kuwahara(p.rgba, p.width, p.height, 2, 2);
    expect(textureShare(sm, p.width, p.height)).toBeLessThan(0.08);
  });

  it('traces each house as one squared-up room (lit and shaded halves together) and the wall as wall', () => {
    const p = town();
    const r = traceImage({
      ...p,
      colours: [STREET, ROOF_LIT, ROOF_DARK, WALL],
      roles: ['road', 'building', 'building', 'wall'],
      space: 'lab',
      mode: 'city',
      painted: true,
      pxPerSquare: 4,
    });
    expect(r.counts.building).toBe(4);
    expect(r.counts.wall).toBeGreaterThanOrEqual(1);
    const houses = r.objects.flatMap((o) => (o.type === 'room' && !o.name && 'poly' in o.shape ? [o.shape.poly] : []));
    // squared up: four corners each, all right angles
    for (const poly of houses) {
      expect(poly).toHaveLength(4);
      const [a, b, c] = poly as [[number, number], [number, number], [number, number]];
      expect(Math.abs((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]))).toBeLessThan(0.05);
    }
  });

  it('squares up a turned house and finds its rectangle', () => {
    const w = 60;
    const px: number[] = [];
    const ang = (20 * Math.PI) / 180;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x - 30) * Math.cos(ang) + (y - 30) * Math.sin(ang);
        const v = -(x - 30) * Math.sin(ang) + (y - 30) * Math.cos(ang);
        if (Math.abs(u) < 15 && Math.abs(v) < 8) px.push(y * w + x);
      }
    }
    const ring = squareUp(px, w)!;
    expect(ring).toHaveLength(4);
    const rect2 = minAreaRect(ring);
    expect(Math.abs(Math.max(rect2.w, rect2.h) - 30)).toBeLessThan(2);
    expect(Math.abs(Math.min(rect2.w, rect2.h) - 16)).toBeLessThan(2);
    expect((rect2.angle * 180) / Math.PI).toBeCloseTo(20, -1);
  });
});
