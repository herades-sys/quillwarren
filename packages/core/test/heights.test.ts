// Height areas: raised and sunken ground within one map. The object and its ops,
// the plan (regions, edges between heights, which side is low), "where you can
// go" (cliffs block, stairs and ladders cross, slopes and steps pass), the 3D
// scene, describe_map, segments and the drawing (hachures, rock faces, labels
// for the GM only, fog, seeded and stable).
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  blockingEdges,
  buildScene,
  collectSegment,
  describeMap,
  heightPlan,
  heightScene,
  heightText,
  renderSvg,
  rockWidth,
  stairsUphill,
  toDungeonScrawl,
  validateMap,
  ValidationError,
  walkableMap,
  type DelveMap,
  type HeightEdgeLine,
  type MapObject,
} from '../src/index.ts';

const mapOf = (objects: MapObject[], extra: Partial<DelveMap> = {}): DelveMap => ({
  format: 'delve.map',
  version: 1,
  id: 'm1',
  name: 'Heights',
  grid: { type: 'square' },
  seed: 3,
  objects,
  ...extra,
});

/** A hall with an archers' ledge along its north wall and stairs up at its east end. */
const hall = (): DelveMap =>
  mapOf([
    { id: 'r1', type: 'room', shape: { rect: [0, 0, 16, 10] }, label: '1', name: 'Great hall' },
    { id: 'h1', type: 'height', name: "Archers' ledge", shape: { rect: [0, 0, 16, 3] }, height: 10 },
    { id: 's1', type: 'stairs', shape: { rect: [12, 2, 2, 3] }, direction: 'n' },
  ]);

/** Snow outside: a hill with a crest, and a plateau with a rock face. */
const mountain = (): DelveMap =>
  mapOf([
    { id: 't1', type: 'terrain', asset: 'snow', shape: { rect: [0, 0, 40, 20] } },
    { id: 'h1', type: 'height', name: 'Hill', shape: { circle: [8, 10, 6] }, height: 5, edge: 'slope' },
    { id: 'h2', type: 'height', name: 'Crest', shape: { circle: [8, 10, 2.5] }, height: 10, edge: 'slope' },
    { id: 'h3', type: 'height', name: 'Plateau', shape: { rect: [24, 0, 16, 10] }, height: 20 },
  ]);

const along = (e: HeightEdgeLine) => e.points.map((p) => p.map((v) => Math.round(v * 1000) / 1000));

describe('the height object', () => {
  it('validates and goes through ops: add, move, update, undo', () => {
    const m = hall();
    expect(validateMap(m)).toBe(m);
    const { map: moved, inverse } = applyOps(m, [{ op: 'move', ids: ['h1'], dx: 1, dy: 1 }, { op: 'update', id: 'h1', set: { height: -5, edge: 'step' } }]);
    expect(moved.objects.find((o) => o.id === 'h1')).toMatchObject({ shape: { rect: [1, 1, 16, 3] }, height: -5, edge: 'step' });
    expect(applyOps(moved, inverse).map).toEqual(m);
  });

  it('names what is wrong', () => {
    const bad = (o: Record<string, unknown>) => () => validateMap(mapOf([{ id: 'h1', type: 'height', shape: { rect: [0, 0, 2, 2] }, height: 5, ...o } as MapObject]));
    expect(bad({ height: 'high' })).toThrow(ValidationError);
    expect(bad({ edge: 'cliffs' })).toThrow(/h1 \(objects\[0\]\) edge/);
    expect(bad({ height: 1e6 })).toThrow(/h1 \(objects\[0\]\) height/);
    expect(bad({ hidden: 'yes' })).toThrow(ValidationError);
  });

  it('writes heights in the map\'s units', () => {
    expect(heightText(10)).toBe('+10 ft');
    expect(heightText(-5)).toBe('−5 ft');
    expect(heightText(3, '1.5 m')).toBe('+3 m');
  });
});

describe('the plan', () => {
  it('finds the ledge edge, its heights and its low side', () => {
    const plan = heightPlan(hall());
    expect(plan.edges).toHaveLength(1);
    const e = plan.edges[0]!;
    expect(e).toMatchObject({ high: 10, low: 0, kind: 'cliff', owner: 'h1', other: null, indoors: true, closed: false });
    // along y = 3 from west to east: walking east, the low side (south) is on the right
    const pts = along(e);
    expect(pts[0]).toEqual([0, 3]);
    expect(pts[pts.length - 1]).toEqual([16, 3]);
    expect(plan.at([5, 1])).toBe(10);
    expect(plan.at([5, 6])).toBe(0);
    expect(plan.at([20, 1])).toBeNull(); // off the floor
  });

  it('only counts floor and terrain: the part of an area outside them changes nothing', () => {
    const plan = heightPlan(mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } }, { id: 'h1', type: 'height', shape: { rect: [2, 0, 6, 4] }, height: 10 }]));
    expect(plan.at([3, 2])).toBe(10);
    expect(plan.at([6, 2])).toBeNull();
    // the area runs into the wall at x = 4: only its west side is an edge
    expect(plan.edges.map(along)).toEqual([[[2, 0], [2, 4]]]);
  });

  it('nests: the area drawn last wins, and its edge is its own', () => {
    const plan = heightPlan(mountain());
    expect(plan.at([8, 10])).toBe(10);
    expect(plan.at([8, 14.5])).toBe(5);
    expect(plan.at([2, 2])).toBe(0);
    const crest = plan.edges.find((e) => e.owner === 'h2')!;
    expect(crest).toMatchObject({ high: 10, low: 5, kind: 'slope', other: 'h1', closed: true });
    const hill = plan.edges.find((e) => e.owner === 'h1')!;
    expect(hill).toMatchObject({ high: 5, low: 0, kind: 'slope', other: null, closed: true });
  });

  it('picks the edge by the drop: a cliff indoors, a rock face outdoors, a step for less than a square', () => {
    expect(heightPlan(mountain()).edges.find((e) => e.owner === 'h3')!.kind).toBe('rock');
    expect(heightPlan(hall()).edges[0]!.kind).toBe('cliff');
    const low = heightPlan(mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 8] } }, { id: 'h1', type: 'height', shape: { rect: [2, 2, 3, 3] }, height: 2 }]));
    expect(low.edges[0]!.kind).toBe('step');
    expect(rockWidth(10, { size: 5, name: 'ft' })).toBe(1);
    expect(rockWidth(100, { size: 5, name: 'ft' })).toBe(3);
  });

  it('puts the low side on the right for sunken areas too', () => {
    const plan = heightPlan(mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 10, 10] } }, { id: 'h1', type: 'height', shape: { rect: [3, 3, 4, 4] }, height: -10 }]));
    const e = plan.edges[0]!;
    expect(e).toMatchObject({ high: 0, low: -10, closed: true });
    // a point just right of the first segment lies in the pit
    const [a, b] = [e.points[0]!, e.points[1]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const right: [number, number] = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * 0.1, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * 0.1];
    expect(plan.at(right)).toBe(-10);
  });

  it('leaves hidden areas to the GM', () => {
    const m = mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 10, 10] } }, { id: 'h1', type: 'height', shape: { rect: [3, 3, 4, 4] }, height: -10, hidden: true }]);
    expect(heightPlan(m).edges).toHaveLength(1);
    expect(heightPlan(m, { view: 'players' }).edges).toHaveLength(0);
    expect(blockingEdges(m)).toEqual([]);
  });

  it('knows which way stairs between two heights go up', () => {
    const plan = heightPlan(hall());
    expect(stairsUphill(plan, { x0: 12, y0: 2, x1: 14, y1: 5 })).toBe('n');
    expect(stairsUphill(plan, { x0: 2, y0: 5, x1: 4, y1: 8 })).toBeNull();
  });
});

describe('where you can go', () => {
  it('blocks the cliff, except where the stairs cross it', () => {
    const w = walkableMap(hall());
    const stairs = w.crossings.filter((c) => c.id === 's1');
    expect(stairs).toHaveLength(1);
    expect([stairs[0]!.a, stairs[0]!.b].map((p) => p.map((v) => Math.round(v * 1000) / 1000))).toEqual([[12, 3], [14, 3]]);
    expect(stairs[0]).toMatchObject({ kind: 'stairs', high: 10, low: 0, owner: 'h1' });
    const blocked = w.blocked.map((s) => [s.a[0], s.b[0]].map((v) => Math.round(v * 1000) / 1000));
    expect(blocked).toEqual([
      [0, 12],
      [14, 16],
    ]);
    // the walls block as before
    expect(w.walls.length).toBeGreaterThan(0);
    expect(w.bands.map((b) => b.height)).toEqual([0, 10]);
  });

  it('lets a ladder cross a cliff, and slopes and steps everywhere', () => {
    const m = hall();
    m.objects = m.objects.filter((o) => o.id !== 's1');
    m.objects.push({ id: 'i1', type: 'prop', asset: 'ladder', at: [3.5, 3] });
    const w = walkableMap(m);
    expect(w.crossings.filter((c) => c.kind === 'ladder').map((c) => c.id)).toEqual(['i1']);
    const slopes = walkableMap(mountain());
    expect(slopes.crossings.some((c) => c.kind === 'slope' && c.owner === 'h2' && c.other === 'h1')).toBe(true);
    expect(slopes.blocked.every((s) => s.owner === 'h3')).toBe(true);
  });

  it('hands Delve Table the blocking edges with their drop', () => {
    const edges = blockingEdges(hall());
    expect(edges).toEqual([
      { a: [0, 3], b: [12, 3], drop: 10 },
      { a: [14, 3], b: [16, 3], drop: 10 },
    ]);
  });

  it('treats shut doors as walls, open doors and archways not', () => {
    const m = hall();
    m.objects.push({ id: 'd1', type: 'door', at: [16, 6], along: 'y', width: 1 }, { id: 'd2', type: 'door', at: [16, 8], along: 'y', width: 1, open: true });
    const walls = walkableMap(m).walls.map((s) => JSON.stringify(s));
    expect(walls).toContain(JSON.stringify([[16, 6], [16, 7]]));
    expect(walls).not.toContain(JSON.stringify([[16, 8], [16, 9]]));
  });
});

describe('the 3D scene', () => {
  it('gives bands and faces in squares, the frame\'s rest at 0', () => {
    const s = heightScene(mountain(), { frame: { x0: 0, y0: 0, x1: 40, y1: 20 } })!;
    expect(s.bands.map((b) => b.h)).toEqual([1, 2, 4]);
    expect(s.base.length).toBeGreaterThan(0);
    const rock = s.edges.find((e) => e.kind === 'rock')!;
    expect(rock).toMatchObject({ hi: 4, lo: 0, run: 2 });
    expect(heightScene(mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 4, 4] } }]), { frame: { x0: 0, y0: 0, x1: 4, y1: 4 } })).toBeNull();
  });

  it('cuts it to what the players may see', () => {
    const region = [{ outer: [[0, 0], [10, 0], [10, 20], [0, 20]] as [number, number][], holes: [] }];
    const s = heightScene(mountain(), { view: 'players', frame: { x0: 0, y0: 0, x1: 40, y1: 20 }, region })!;
    expect(s.bands.map((b) => b.h)).toEqual([1, 2]); // the plateau lies outside
    expect(s.edges.every((e) => e.points.every(([x]) => x <= 10 + 1e-6))).toBe(true);
  });
});

describe('describe_map', () => {
  it('lists the heights, where they are and how they are reached', () => {
    const text = describeMap(hall());
    expect(text).toContain('h1 "Archers\' ledge": +10 ft, cliff edge, 16×3 sq at 0,0, along the north side of room 1 Great hall; reached by stairs s1 (up n)');
    expect(text).not.toMatch(/Also: .*height/);
    const m = describeMap(mountain());
    expect(m).toContain('h3 "Plateau": +20 ft, rock face');
    expect(m).toContain('no stairs or ladder: only by climbing, jumping or flying');
    expect(m).toContain('h2 "Crest": +10 ft hill, slope (walkable)');
  });
});

describe('segments', () => {
  it('copies a height area with its room', () => {
    const seg = collectSegment(hall(), { ids: ['r1'] });
    expect(seg.objects.map((o) => o.type).sort()).toEqual(['height', 'room', 'stairs']);
  });
});

describe('drawing', () => {
  const layers = (m: DelveMap, view: 'gm' | 'players' = 'gm', fog?: 'hide') => buildScene(m, { view, ...(fog ? { fog } : {}) }).layers;
  const names = (m: DelveMap, view: 'gm' | 'players' = 'gm', fog?: 'hide') => layers(m, view, fog).map((l) => l.name);

  it('draws a ledge as a firm line with ticks, the GM\'s label, and the stairs\' arrow', () => {
    const gm = names(hall());
    expect(gm).toEqual(expect.arrayContaining(['height-tone:h1', 'height-cliffs', 'height-cliff-ticks', 'stairs-arrows', 'height-labels']));
    const ticks = layers(hall()).find((l) => l.name === 'height-cliff-ticks');
    expect(ticks?.kind === 'stroke' && ticks.lines.length).toBeGreaterThan(40);
    // ticks lie on the low side (south of y = 3), none under the stairs
    if (ticks?.kind === 'stroke') {
      expect(ticks.lines.every((l) => l.points.every(([, y]) => y >= 3))).toBe(true);
      expect(ticks.lines.some((l) => l.points[0]![0] > 12.1 && l.points[0]![0] < 13.9)).toBe(false);
    }
    const label = layers(hall()).find((l) => l.name === 'height-labels');
    expect(label?.kind === 'tags' && label.items.map((i) => i.text)).toEqual(['+10 ft']);
  });

  it('shows players the edges but not the labels', () => {
    const players = names(hall(), 'players');
    expect(players).toContain('height-cliffs');
    expect(players).not.toContain('height-labels');
    expect(renderSvg(hall(), { view: 'players' })).not.toContain('+10 ft');
  });

  it('draws rock faces as a band with hachures, stipple and a ragged foot', () => {
    const n = names(mountain());
    expect(n).toEqual(expect.arrayContaining(['height-rock', 'height-rock-hachures', 'height-rock-stipple', 'height-rock-foot', 'height-rock-top', 'height-slope-contours']));
    // the hill and its crest are shaded and contoured, not toned flat, and have no brow line
    expect(n.filter((x) => x.startsWith('height-tone'))).toEqual(['height-tone:h3']);
    expect(n).not.toContain('height-slopes');
    const band = layers(mountain()).find((l) => l.name === 'height-rock');
    // on the low side of the plateau's edge (west of x = 24 and south of y = 10), about a square wide per 10 ft
    if (band?.kind === 'fill') {
      const pts = band.polygons.flatMap((p) => p.outer);
      expect(Math.min(...pts.map((p) => p[0]))).toBeGreaterThan(21);
      expect(Math.max(...pts.map((p) => p[1]))).toBeLessThan(13.5);
    } else throw new Error('no rock band');
  });

  it('draws the same every time (seeded), and with another seed differently', () => {
    expect(renderSvg(mountain())).toBe(renderSvg(mountain()));
    expect(renderSvg({ ...mountain(), seed: 99 })).not.toBe(renderSvg(mountain()));
  });

  it('shades sunken ground darker and raised ground lighter, in every style', () => {
    for (const preset of ['classic-hatching', 'clean', 'old-school-blue', 'print', 'parchment']) {
      const m = { ...mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 10, 10] } }, { id: 'h1', type: 'height', shape: { rect: [1, 1, 3, 3] }, height: -10 }, { id: 'h2', type: 'height', shape: { rect: [6, 6, 3, 3] }, height: 10 }]), style: { preset } };
      const tone = layers(m).filter((l) => l.name.startsWith('height-tone'));
      expect(tone.map((l) => (l.kind === 'fill' ? l.color : ''))).toEqual([expect.not.stringMatching(/^#FFFFFF$/), '#FFFFFF']);
      expect(renderSvg(m)).not.toContain('feDisplacementMap');
    }
  });

  it('keeps heights out of what fogged players haven\'t seen', () => {
    const m = { ...hall(), fog: { on: true, show: [{ rect: [0, 5, 16, 5] as [number, number, number, number] }] } };
    expect(names(m, 'players', 'hide')).not.toContain('height-tone:h1');
    const seen = { ...hall(), fog: { on: true, revealed: ['r1'] } };
    expect(names(seen, 'players', 'hide')).toContain('height-cliffs');
  });

  it('leaves a hidden area out of the players\' view', () => {
    const m = hall();
    (m.objects[1] as Extract<MapObject, { type: 'height' }>).hidden = true;
    expect(names(m, 'players').some((n) => n.startsWith('height-'))).toBe(false);
    expect(names(m, 'gm')).toContain('height-cliffs');
  });
});

describe('Dungeon Scrawl', () => {
  it('leaves height areas out of the export', () => {
    const ds = JSON.stringify(toDungeonScrawl(hall()));
    expect(ds).not.toContain('Archers');
    expect(ds).not.toContain('"height"');
  });
});
