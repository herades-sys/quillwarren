// The ground's real shape (core surface.ts): profiles and their defaults, hills
// (zero at the foot, full at the top, ridges, seeded unevenness), ramps (width by
// the rise, clamped, narrowed by what's in the way), sheer cliffs, sunken areas,
// nesting, the 3D scene's draped pieces (and the players' cut), and the 2D map's
// contours and hillshade.
import { describe, expect, it } from 'vitest';
import { buildScene, contourInterval, heightProfile, heightScene, heightSurface, isolines, slopeRun, type DelveMap, type MapObject } from '../src/index.ts';

const mapOf = (objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id: 'm1',
  name: 'Hills',
  grid: { type: 'square' },
  seed: 3,
  objects,
  ...extra,
});
const ground = (w = 40, h = 30): MapObject => ({ id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, w, h] } });
const FT = { size: 5, name: 'ft' };

/** The highest (or with `sign` -1 the lowest) the ground goes in a box, sampled every tenth of a square. */
const extreme = (s: ReturnType<typeof heightSurface>, [x0, y0, x1, y1]: number[], sign = 1): number => {
  let best = -Infinity;
  for (let x = x0!; x <= x1!; x += 0.1) for (let y = y0!; y <= y1!; y += 0.1) best = Math.max(best, sign * s.at([x, y]));
  return sign * best;
};

describe('profiles', () => {
  it('default to a hill for a slope edge and a plateau for the rest; set ones win', () => {
    expect(heightProfile({ edge: 'slope' })).toBe('hill');
    for (const edge of ['cliff', 'rock', 'step', undefined] as const) expect(heightProfile({ edge })).toBe('plateau');
    expect(heightProfile({ edge: 'slope', profile: 'plateau' })).toBe('plateau');
    expect(heightProfile({ edge: 'cliff', profile: 'hill' })).toBe('hill');
  });
});

describe('a hill', () => {
  // 20 ft (4 squares) on a 5 ft grid: a circle of radius 6 in a big meadow
  const hill = () => mapOf([ground(), { id: 'h1', type: 'height', shape: { circle: [20, 15, 6] }, height: 20, edge: 'slope' }]);

  it('is full height at its top, low at its edge, and back at the ground past its foot', () => {
    const s = heightSurface(hill());
    const a = s.areas[0]!;
    expect(extreme(s, [16, 11, 24, 19])).toBeCloseTo(20, 1);
    const edge = s.at([26, 15]);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(20 * 0.4);
    // the foot spreads outside by what the slope needs beyond the area's own depth (slopeRun 8 − depth 6 = 2)
    expect(a.bandMax).toBeCloseTo(slopeRun(20, FT) - a.depth, 1);
    expect(s.at([28.5, 15])).toBe(0);
    // it rises all the way in
    const line = [26, 25, 24, 23, 22, 21].map((x) => s.at([x, 15]));
    for (let i = 1; i < line.length; i++) expect(line[i]!).toBeGreaterThan(line[i - 1]!);
  });

  it('turns a long thin area into a ridge', () => {
    const m = mapOf([ground(), { id: 'h1', type: 'height', shape: { rect: [5, 12, 30, 6] }, height: 10, edge: 'slope' }]);
    const s = heightSurface(m);
    // all along its middle it is near its full height, at its sides much lower
    for (const x of [10, 15, 20, 25, 30]) expect(s.at([x, 15])).toBeGreaterThan(8);
    for (const x of [10, 20, 30]) expect(s.at([x, 12.5])).toBeLessThan(6.5);
    for (const x of [10, 20, 30]) expect(s.at([x, 11.5])).toBeLessThan(3);
  });

  it('is uneven by its seed, the same every time, its top still at its height', () => {
    const one = heightSurface(hill());
    const again = heightSurface(hill());
    const other = heightSurface({ ...hill(), seed: 99 });
    const pts: [number, number][] = [[17, 13], [22, 18], [19, 17], [23, 12]];
    expect(pts.map((p) => again.at(p))).toEqual(pts.map((p) => one.at(p)));
    expect(pts.some((p) => Math.abs(other.at(p) - one.at(p)) > 0.05)).toBe(true);
    expect(extreme(other, [16, 11, 24, 19])).toBeCloseTo(20, 1);
  });

  it('sinks as a hollow, round from its rim', () => {
    const s = heightSurface(mapOf([ground(), { id: 'h1', type: 'height', shape: { circle: [20, 15, 6] }, height: -10, edge: 'slope' }]));
    expect(extreme(s, [16, 11, 24, 19], -1)).toBeCloseTo(-10, 1);
    expect(s.at([25.9, 15])).toBeGreaterThan(-1.5);
    expect(s.at([27, 15])).toBe(0);
  });
});

describe('a ramp (a flat area with a slope edge)', () => {
  const ramp = (extra: MapObject[] = []) => mapOf([ground(), { id: 'h1', type: 'height', shape: { rect: [15, 10, 10, 10] }, height: 10, edge: 'slope', profile: 'plateau' }, ...extra]);

  it('keeps its whole top and runs out on the low side over two and a half squares per square of rise', () => {
    const s = heightSurface(ramp());
    expect(slopeRun(10, FT)).toBe(5);
    expect(s.at([20, 15])).toBe(10);
    expect(s.at([15.01, 15])).toBe(10);
    expect(s.at([25.01, 15])).toBeCloseTo(10, 1);
    expect(s.at([27.5, 15])).toBeCloseTo(5, 1); // half way down: eased at both ends, steepest in the middle
    expect(s.at([29, 15])).toBeLessThan(1.2);
    expect(s.at([30.5, 15])).toBe(0);
  });

  it('is clamped between a square and eight', () => {
    expect(slopeRun(1, FT)).toBe(1);
    expect(slopeRun(100, FT)).toBe(8);
    expect(slopeRun(5, { size: 1, name: 'm' })).toBe(8);
  });

  it('narrows where the ground ends or another area is in the way, never below a square', () => {
    // the meadow ends 2 squares west of the plateau; a ledge 3 squares north of it
    const m = mapOf([{ id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [13, 0, 27, 30] } }, { id: 'h1', type: 'height', shape: { rect: [15, 10, 10, 10] }, height: 10, edge: 'slope', profile: 'plateau' }, { id: 'h2', type: 'height', shape: { rect: [15, 2, 10, 5] }, height: 5, edge: 'cliff' }]);
    const s = heightSurface(m);
    const a = s.areas[0]!;
    const widths = [...a.band!.width];
    expect(Math.max(...widths)).toBeCloseTo(5, 1);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(Math.min(...widths)).toBeLessThan(3.2);
    expect(s.at([12.9, 15])).toBe(0); // off the ground
  });

  it('sinks the other way: a pit keeps its rim and ramps down inside', () => {
    const s = heightSurface(mapOf([ground(), { id: 'h1', type: 'height', shape: { rect: [10, 5, 20, 20] }, height: -10, edge: 'slope', profile: 'plateau' }]));
    expect(s.at([9.9, 15])).toBe(0);
    expect(s.at([10.1, 15])).toBeGreaterThan(-0.5);
    expect(s.at([12.5, 15])).toBeCloseTo(-5, 1);
    expect(s.at([20, 15])).toBe(-10);
  });
});

describe('cliffs and nesting', () => {
  it('keeps a cliff sheer: full height right at its edge, none just outside', () => {
    const s = heightSurface(mapOf([ground(), { id: 'h1', type: 'height', shape: { rect: [15, 10, 10, 10] }, height: 10, edge: 'cliff' }]));
    expect(s.at([15.01, 15])).toBe(10);
    expect(s.at([14.99, 15])).toBe(0);
    expect(s.pieces).toEqual([]); // nothing varies: no draped pieces at all
  });

  it('stands a cliff-edged top at its own height on a hill, and a small hill rises out of a big one to its own height', () => {
    const m = mapOf([
      ground(),
      { id: 'h1', type: 'height', shape: { circle: [20, 15, 10] }, height: 10, edge: 'slope' },
      { id: 'h2', type: 'height', shape: { rect: [18, 6, 4, 3] }, height: 25, edge: 'cliff' },
      { id: 'h3', type: 'height', shape: { circle: [20, 18, 2.5] }, height: 15, edge: 'slope' },
    ]);
    const s = heightSurface(m);
    expect(s.at([20, 7.5])).toBe(25);
    expect(extreme(s, [17, 15, 23, 21])).toBeCloseTo(15, 1); // not 10 + 15
    expect(s.at([20, 7.5 + 1.6])).toBeLessThan(10); // the hill just below the cliff
  });
});

describe('the 3D scene', () => {
  const hill = () => mapOf([ground(), { id: 'h1', type: 'height', shape: { circle: [20, 15, 6] }, height: 20, edge: 'slope' }, { id: 'h2', type: 'height', shape: { rect: [19, 14, 2, 2] }, height: 30, edge: 'cliff' }]);
  const frame = { x0: 0, y0: 0, x1: 40, y1: 30 };

  it('drapes the ground: the hill as a piece with a grid (in squares), the cliff top flat', () => {
    const s = heightScene(hill(), { frame })!;
    expect(s.step).toBe(0.25);
    const top = s.pieces.find((p) => !p.grid)!;
    expect(top.h).toBe(6);
    const slope = s.pieces.find((p) => p.grid)!;
    expect(slope.grid!.max).toBeLessThanOrEqual(4 + 1e-9);
    expect(slope.grid!.max).toBeGreaterThan(3);
    expect(slope.grid!.cols * slope.grid!.rows).toBeLessThan(10_000);
    expect(s.rock).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('cuts the pieces and their grids to what the players may see', () => {
    const region = [{ outer: [[0, 0], [17, 0], [17, 30], [0, 30]] as [number, number][], holes: [] }];
    const s = heightScene(hill(), { view: 'players', frame, region })!;
    expect(s.pieces.every((p) => p.polygons.every((q) => q.outer.every(([x]) => x <= 17 + 1e-6)))).toBe(true);
    expect(s.pieces.some((p) => !p.grid)).toBe(false); // the cliff top lies outside
    const g = s.pieces.find((p) => p.grid)!.grid!;
    // the posts past the cut carry nothing: all at the grid's lowest
    const bin = atob(g.z);
    const at = (c: number, r: number) => bin.charCodeAt((r * g.cols + c) * 2) | (bin.charCodeAt((r * g.cols + c) * 2 + 1) << 8);
    const c = Math.round(22 / 0.25) - g.i0;
    const r = Math.round(15 / 0.25) - g.j0;
    expect(c).toBeLessThan(g.cols);
    expect(at(c, r)).toBe(0);
    // hidden areas never reach them
    const hidden = { ...hill(), objects: hill().objects.map((o) => (o.type === 'height' ? { ...o, hidden: true } : o)) };
    expect(heightScene(hidden, { view: 'players', frame })).toBeNull();
  });
});

describe('the 2D map', () => {
  const names = (m: DelveMap) => buildScene(m, { view: 'gm' }).layers.map((l) => l.name);

  it('shades and contours a hill instead of a flat tone, with its tag on its top', () => {
    const m = mapOf([ground(), { id: 'h1', type: 'height', shape: { circle: [20, 15, 6] }, height: 20, edge: 'slope' }]);
    const n = names(m);
    expect(n).toEqual(expect.arrayContaining(['height-slope-contours', 'height-slope-light-1', 'height-slope-shadow-1']));
    expect(n.some((x) => x.startsWith('height-tone'))).toBe(false);
    const tags = buildScene(m, { view: 'gm' }).layers.find((l) => l.name === 'height-labels');
    const top = heightSurface(m).areas[0]!.top;
    expect(tags?.kind === 'tags' && tags.items[0]!.text).toBe('+20 ft');
    if (tags?.kind === 'tags') expect(Math.hypot(tags.items[0]!.at[0] - top[0], tags.items[0]!.at[1] - top[1])).toBeLessThan(1.5);
    expect(buildScene(m, { view: 'players' }).layers.some((l) => l.name === 'height-labels')).toBe(false);
  });

  it('picks contour intervals of 1, 2 or 5 times a power of ten, about six over the rise', () => {
    expect(contourInterval(5, { size: 1, name: 'm' })).toBe(1);
    expect(contourInterval(20, { size: 1, name: 'm' })).toBe(5);
    expect(contourInterval(10, FT)).toBe(2);
    expect(contourInterval(40, FT)).toBe(10);
    expect(contourInterval(1, { size: 1.5, name: 'm' })).toBe(0.5);
  });

  it('traces closed lines round a peak (marching squares)', () => {
    const cols = 9;
    const rows = 9;
    const z = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = 4 - Math.hypot(c - 4, r - 4);
    const lines = isolines({ z, cols, rows, x0: 0, y0: 0, step: 1 }, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closed).toBe(true);
    for (const [x, y] of lines[0]!.points) expect(Math.hypot(x - 4, y - 4)).toBeCloseTo(2, 0);
  });
});
