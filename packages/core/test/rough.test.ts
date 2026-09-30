import { describe, expect, it } from 'vitest';
import { buildScene, computeFloor, doorSegment, floorArea, scatterAlong, validateMap, type DelveMap, type Door, type Layer, type Point } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const layer = (map: DelveMap, name: string, view: 'gm' | 'players' = 'gm') => buildScene(map, { view }).layers.find((l) => l.name === name) as Extract<Layer, { kind: 'fill' | 'stroke' }> | undefined;
const floorOf = (map: DelveMap) => (layer(map, 'floor') as Extract<Layer, { kind: 'fill' }>).polygons;
const points = (map: DelveMap) => floorOf(map).reduce((n, p) => n + p.outer.length + p.holes.reduce((m, h) => m + h.length, 0), 0);
const areaOf = (polys: ReturnType<typeof floorOf>) => {
  const ring = (r: Point[]) => Math.abs(r.reduce((s, a, i) => s + a[0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * a[1], 0)) / 2;
  return polys.reduce((s, p) => s + ring(p.outer) - p.holes.reduce((m, h) => m + ring(h), 0), 0);
};

describe('wall roughness', () => {
  it('leaves a map without it exactly as it was', () => {
    const map = testMap();
    expect(floorOf(map)).toEqual(computeFloor(map));
  });

  it('is a whole number from 1 to 10, on the map and on rooms, corridors and cutouts', () => {
    expect(() => validateMap({ ...testMap(), roughness: 11 })).toThrow(/from 1 \(smooth\) to 10/);
    expect(() => validateMap({ ...testMap(), roughness: 2.5 })).toThrow();
    const map = testMap();
    map.objects = map.objects.map((o) => (o.type === 'room' || o.type === 'corridor' || o.type === 'cutout' ? { ...o, roughness: 7 } : o));
    expect(() => validateMap(map)).not.toThrow();
  });

  it('reshapes the floor itself at high levels, keeping about the same area', () => {
    const map = { ...testMap(), roughness: 10 };
    expect(points(map)).toBeGreaterThan(points(testMap()) * 5);
    const ratio = areaOf(floorOf(map)) / floorArea(testMap());
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.1);
    // the same map draws the same caves every time
    expect(floorOf(map)).toEqual(floorOf({ ...testMap(), roughness: 10 }));
  });

  it('keeps doors on straight wall, so every door still opens a gap', () => {
    const map = { ...testMap(), roughness: 10 };
    const walls = (layer(map, 'walls') as Extract<Layer, { kind: 'stroke' }>).lines;
    for (const d of map.objects.filter((o): o is Door => o.type === 'door' && o.style !== 'secret')) {
      const [a, b] = doorSegment(d);
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // no wall point sits in the middle of the doorway
      const near = walls.some((l) => l.points.some((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1]) < d.width / 2 - 0.1));
      expect(near, `door ${d.id}`).toBe(false);
    }
  });

  it('lets one room be a cave while the rest stay built', () => {
    const map = testMap();
    const cave = map.objects.find((o) => o.type === 'room')!;
    map.objects = map.objects.map((o) => (o.id === cave.id ? { ...o, roughness: 10 } : o));
    const plain = computeFloor(testMap()).flatMap((p) => [p.outer, ...p.holes]).flat();
    const onPlain = (p: Point) => plain.some((q) => Math.abs(q[0] - p[0]) < 1e-6 || Math.abs(q[1] - p[1]) < 1e-6);
    const moved = floorOf(map).flatMap((p) => [p.outer, ...p.holes]).flat().filter((p) => !onPlain(p));
    expect(moved.length).toBeGreaterThan(20);
    // everything that moved is near the cave room
    const b = ('rect' in cave.shape ? cave.shape.rect : [0, 0, 0, 0]) as [number, number, number, number];
    for (const p of moved) expect(p[0] > b[0] - 1 && p[0] < b[0] + b[2] + 1 && p[1] > b[1] - 1 && p[1] < b[1] + b[3] + 1).toBe(true);
  });

  it('draws perfectly straight walls at 1', () => {
    const smooth = (layer({ ...testMap(), roughness: 1 }, 'walls') as Extract<Layer, { kind: 'stroke' }>).lines;
    const styled = (layer(testMap(), 'walls') as Extract<Layer, { kind: 'stroke' }>).lines;
    const count = (ls: typeof smooth) => ls.reduce((n, l) => n + l.points.length, 0);
    expect(count(smooth)).toBeLessThan(count(styled)); // the classic style's hand wobble is gone
  });
});

describe('props along a path', () => {
  it('puts one every spacing squares when regular', () => {
    const spots = scatterAlong([[0, 0], [9, 0]], { spacing: 3, placement: 'regular', seed: 1 });
    expect(spots.map((s) => s.at)).toEqual([[0, 0], [3, 0], [6, 0], [9, 0]]);
    expect(spots.every((s) => s.rotation === 0 && s.scale === 1)).toBe(true);
    // round a corner too
    expect(scatterAlong([[0, 0], [2, 0], [2, 4]], { spacing: 3, placement: 'regular', seed: 1 }).map((s) => s.at)).toEqual([[0, 0], [2, 1], [2, 4]]);
  });

  it('skips spots that already have one', () => {
    const spots = scatterAlong([[0, 0], [9, 0]], { spacing: 3, placement: 'regular', seed: 1, avoid: [[3.2, 0.3]] });
    expect(spots.map((s) => s.at)).toEqual([[0, 0], [6, 0], [9, 0]]);
  });

  it('scatters irregularly within the spread, the same way for the same seed', () => {
    const path: Point[] = [[0, 5], [30, 5]];
    const a = scatterAlong(path, { spacing: 3, placement: 'irregular', spread: 1, seed: 42 });
    expect(a).toEqual(scatterAlong(path, { spacing: 3, placement: 'irregular', spread: 1, seed: 42 }));
    expect(a.length).toBeGreaterThan(6);
    expect(a.length).toBeLessThan(16);
    for (const s of a.slice(1)) expect(Math.abs(s.at[1] - 5)).toBeLessThanOrEqual(1);
    expect(new Set(a.map((s) => s.rotation)).size).toBeGreaterThan(3);
    expect(a.every((s) => s.scale >= 0.8 && s.scale <= 1.2)).toBe(true);
  });

  it('keeps the first copies when the path grows, so the preview never jumps', () => {
    const short = scatterAlong([[0, 0], [10, 0]], { spacing: 2, placement: 'irregular', spread: 1, seed: 7 });
    const long = scatterAlong([[0, 0], [10, 0], [10, 10]], { spacing: 2, placement: 'irregular', spread: 1, seed: 7 });
    expect(long.slice(0, short.length - 1)).toEqual(short.slice(0, -1));
  });
});
