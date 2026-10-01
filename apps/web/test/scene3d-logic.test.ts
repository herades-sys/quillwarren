import type { Member, Token } from '@delve/table';
import { describe, expect, it } from 'vitest';
import {
  ALL_BASE,
  baseColor,
  doorPieces,
  faceYaw,
  fitView,
  followStep,
  followSubject,
  GM_BASE,
  gridSegments,
  groundHit,
  lerpView,
  miniShape,
  pickable,
  pickLights,
  pxPerCell,
  shadowSpan,
  shownTokens,
  stairSteps,
  tagParts,
  tokenCentre,
  topView,
  wallPiece,
} from '../src/table/scene3d-logic.ts';
import { wallBox } from '../src/stack-logic.ts';

const gm: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#d4a017' };
const ana: Member = { id: 'p1', name: 'Ana', role: 'player', color: '#e05252' };
const tok = (over: Partial<Token> = {}): Token => ({ id: 'k1', pageId: 'pg1', layer: 'tokens', x: 2, y: 3, w: 1, h: 1, image: '/x.png', controlledBy: [], ...over });
const box = { x0: 0, y0: 0, x1: 20, y1: 10 };

describe('3D table camera', () => {
  it('frames a page at an angle from the south, and straight down for Top', () => {
    const v = fitView(box, 40, 1.5);
    expect(v.target).toEqual([10, 0, 5]);
    expect(v.position[1]).toBeGreaterThan(5);
    expect(v.position[2]).toBeGreaterThan(5); // south of the middle
    // a bigger page sits further away
    const far = fitView({ x0: 0, y0: 0, x1: 80, y1: 40 }, 40, 1.5);
    expect(far.position[1]).toBeGreaterThan(v.position[1] * 3);
    const top = topView(box, 40, 1.5);
    expect(top.target).toEqual([10, 0, 5]);
    expect(top.position[0]).toBe(10);
    expect(top.position[2] - 5).toBeGreaterThan(0);
    expect(top.position[2] - 5).toBeLessThan(0.1);
    // tall narrow windows need more distance for the width
    expect(topView(box, 40, 0.5).position[1]).toBeGreaterThan(top.position[1]);
  });

  it('eases between views and follows a mini without changing the angle', () => {
    const a = { position: [0, 10, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
    const b = { position: [10, 10, 20] as [number, number, number], target: [10, 0, 10] as [number, number, number] };
    expect(lerpView(a, b, 0)).toEqual(a);
    expect(lerpView(a, b, 1)).toEqual(b);
    expect(lerpView(a, b, 0.5).target).toEqual([5, 0, 5]);
    const f = followStep(a, [4, 0, 2], 0.5);
    expect(f.target).toEqual([2, 0, 1]);
    expect(f.position).toEqual([2, 10, 11]);
  });

  it('finds the floor under the pointer', () => {
    expect(groundHit([0, 10, 0], [0, -1, 0])).toEqual([0, 0]);
    expect(groundHit([2, 10, 3], [1, -1, 1])).toEqual([12, 13]);
    expect(groundHit([0, 10, 0], [1, 0, 0])).toBeNull(); // along the floor
    expect(groundHit([0, 10, 0], [0, 1, 0])).toBeNull(); // away from it
    expect(pxPerCell(10, 90, 200)).toBeCloseTo(10);
    expect(shadowSpan({ x0: 0, y0: 0, x1: 6, y1: 8 }, 0)).toBe(5);
  });
});

describe('minis', () => {
  it('stand on a base in the controlling member’s colour', () => {
    expect(baseColor(tok({ controlledBy: ['p1'] }), [gm, ana])).toBe('#e05252');
    expect(baseColor(tok({ controlledBy: ['all', 'p1'] }), [gm, ana])).toBe('#e05252');
    expect(baseColor(tok({ controlledBy: ['all'] }), [gm, ana])).toBe(ALL_BASE);
    expect(baseColor(tok({ controlledBy: [] }), [gm, ana])).toBe(GM_BASE);
    expect(baseColor(tok({ controlledBy: ['p9'] }), [gm, ana])).toBe(GM_BASE); // a member who left
  });

  it('are sized by w and h: upright cards, flat discs, and map tokens on the floor', () => {
    const up = miniShape(tok(), 1, false);
    expect(up).toMatchObject({ flat: false, baseH: 0.1 });
    expect(up.rx).toBeCloseTo(0.46);
    expect(up.cardH).toBeCloseTo(up.cardW);
    expect(up.top).toBeCloseTo(0.1 + up.cardH);
    const tall = miniShape(tok({ w: 2, h: 2 }), 1.5, false);
    expect(tall.cardW).toBeCloseTo(1.76);
    expect(tall.cardH).toBeCloseTo(2.64);
    expect(miniShape(tok(), 10, false).cardH).toBeCloseTo(up.cardW * 1.8); // a very tall picture is capped
    const disc = miniShape(tok({ w: 2, h: 1 }), 1, true);
    expect(disc).toMatchObject({ flat: true });
    expect([disc.rx, disc.rz]).toEqual([0.92, 0.46]);
    expect(disc.cardW / disc.cardH).toBeCloseTo(2);
    expect(miniShape(tok({ layer: 'map', w: 3, h: 2 }), 1, false)).toMatchObject({ flat: true, baseH: 0, cardW: 3, cardH: 2 });
  });

  it('turn to face the camera', () => {
    expect(faceYaw(0, 0, 0, 5)).toBe(0); // camera to the south: the card's front faces +z already
    expect(faceYaw(0, 0, 5, 0)).toBeCloseTo(Math.PI / 2);
    expect(faceYaw(0, 0, 0, -5)).toBeCloseTo(Math.PI);
  });

  it('show names like the 2D table, and bars when they are big enough to read', () => {
    const t = tok({ name: 'Goblin', bars: [{ value: 3, max: 6 }, { value: 2 }] });
    expect(tagParts(t, false, false, 40)).toEqual({ name: null, bars: [{ fraction: 0.5, color: '#3FA34D' }, { fraction: null, color: '#3B7DD8' }] });
    expect(tagParts(t, true, false, 40).name).toBe('Goblin');
    expect(tagParts(t, false, true, 40).name).toBe('Goblin');
    expect(tagParts({ ...t, showName: true }, false, false, 5)).toEqual({ name: 'Goblin', bars: [] });
  });

  it('leave the gm layer out when the GM looks as the players do, and the map layer never catches the pointer', () => {
    const list = [tok({ id: 'a' }), tok({ id: 'b', layer: 'gm' }), tok({ id: 'c', layer: 'map' })];
    expect(shownTokens(list, 'gm').map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(shownTokens(list, 'players').map((t) => t.id)).toEqual(['a', 'c']);
    expect(list.filter(pickable).map((t) => t.id)).toEqual(['a', 'b']);
    expect(tokenCentre(tok({ x: 2, y: 3, w: 2, h: 1 }))).toEqual([3, 0, 3.5]);
  });

  it('follow the selected mini, else the member’s own', () => {
    const list = [tok({ id: 'ogre' }), tok({ id: 'hero', controlledBy: ['p1'] }), tok({ id: 'rug', layer: 'map', controlledBy: ['p1'] })];
    expect(followSubject(list, new Set(['ogre']), ana)).toBe('ogre');
    expect(followSubject(list, new Set(), ana)).toBe('hero');
    expect(followSubject(list, new Set(), { ...ana, id: 'p2' })).toBeNull();
  });
});

describe('walls, doors and stairs', () => {
  it('lays walls like the editor’s 3D view', () => {
    for (const seg of [[[0, 0], [4, 0]], [[3, 1], [3, 5]], [[1, 1], [4, 5]]] as [[number, number], [number, number]][]) {
      expect(wallPiece(seg, 0.2)).toEqual(wallBox(seg, 0.2));
    }
  });

  it('builds a shut door as a frame and a leaf in the gap', () => {
    const parts = doorPieces({ a: [9, 25], b: [11, 25], style: 'normal' }, 1, 0.2);
    expect(parts.map((p) => p.kind)).toEqual(['frame', 'frame', 'frame', 'leaf']);
    const leaf = parts[3]!;
    expect(leaf.x).toBeCloseTo(10);
    expect(leaf.z).toBe(25);
    expect(leaf.length).toBeCloseTo(1.88);
    expect(leaf.angle).toBeCloseTo(0);
    expect(leaf.height).toBeLessThan(1);
    const lintel = parts[2]!;
    expect(lintel.y - lintel.height / 2).toBeCloseTo(0.82);
  });

  it('swings open doors, splits double doors, bars portcullises and leaves archways empty', () => {
    const open = doorPieces({ a: [0, 0], b: [0, 2], style: 'normal', open: true }, 1, 0.2).at(-1)!;
    // hinged at a, swung toward +normal (here -x), nearly square to the wall
    expect(open.x).toBeLessThan(-0.8);
    expect(open.z).toBeLessThan(0.3);
    const double = doorPieces({ a: [0, 0], b: [2, 0], style: 'double' }, 1, 0.2).filter((p) => p.kind === 'leaf');
    expect(double).toHaveLength(2);
    expect(double[0]!.x).toBeLessThan(1);
    expect(double[1]!.x).toBeGreaterThan(1);
    expect(doorPieces({ a: [0, 0], b: [2, 0], style: 'portcullis' }, 1, 0.2).filter((p) => p.kind === 'iron').length).toBeGreaterThan(5);
    expect(doorPieces({ a: [0, 0], b: [2, 0], style: 'archway' }, 1, 0.2).every((p) => p.kind === 'frame')).toBe(true);
    expect(doorPieces({ a: [0, 0], b: [1, 0], style: 'secret' }, 1, 0.2).at(-1)!.kind).toBe('secret');
    expect(doorPieces({ a: [0, 0], b: [1, 0], style: 'locked' }, 1, 0.2).at(-1)!.kind).toBe('locked');
    expect(doorPieces({ a: [0, 0], b: [2, 0], style: 'normal' }, 0, 0.2)).toEqual([]); // no walls, no doors
  });

  it('steps stairs up toward their direction', () => {
    const north = stairSteps({ box: { x0: 0, y0: 0, x1: 2, y1: 3 }, direction: 'n' }, 0.3);
    expect(north.length).toBe(9);
    expect(north[0]!.z).toBeGreaterThan(north.at(-1)!.z); // the first step is the southern one
    expect(north.at(-1)!.height).toBeCloseTo(0.3);
    expect(north[0]!.length).toBeCloseTo(1.96);
    const east = stairSteps({ box: { x0: 0, y0: 0, x1: 1, y1: 1 }, direction: 'e' });
    expect(east.length).toBe(3);
    expect(east[0]!.x).toBeLessThan(east.at(-1)!.x);
    expect(stairSteps({ box: { x0: 0, y0: 0, x1: 0, y1: 1 }, direction: 's' })).toEqual([]);
  });

  it('draws grid lines on whole cells, thinned out on huge pages', () => {
    const g = gridSegments({ x0: -0.5, y0: 0, x1: 3, y1: 2 });
    expect(g.filter(([x0, , x1]) => x0 === x1).map(([x]) => x)).toEqual([0, 1, 2, 3]);
    expect(g.filter(([, z0, , z1]) => z0 === z1).map(([, z]) => z)).toEqual([0, 1, 2]);
    expect(gridSegments({ x0: 0, y0: 0, x1: 1000, y1: 10 }).length).toBeLessThan(250);
  });
});

describe('light sources (for later)', () => {
  it('keeps the nearest few', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, x: i, y: 0 }));
    expect(pickLights(many.slice(0, 3), 0, 0).map((l) => l.id)).toEqual(['l0', 'l1', 'l2']);
    expect(pickLights(many, 19, 0, 3).map((l) => l.id)).toEqual(['l19', 'l18', 'l17']);
  });
});
