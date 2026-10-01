// Dynamic vision rules: what blocks (walls, shut doors, secret doors, the
// table's own door state), lights and eyes, what the party sees under each
// ambient, the explored fog, and which tokens a player may be sent.
import { describe, expect, it } from 'vitest';
import {
  area,
  blockersOf,
  doorBlocks,
  exploreMore,
  eyesOf,
  givesSight,
  lightsOf,
  mayGetToken,
  nothingExplored,
  partySight,
  pointIn,
  seenTokens,
  SightCache,
  sightFilter,
  tokenSeen,
  visionOf,
  type Page,
  type PageDoor,
  type Seg,
  type Token,
} from '../src/index.ts';

// Room A (0..10 × 0..10) with B east of it through door d1 (x = 10, y 4..6),
// and C south of it behind the secret door s1 (y = 10, x 4..6). The walls are
// the players' walls: the secret door is in them, shut.
const WALLS: Seg[] = [
  [[0, 0], [10, 0]],
  [[10, 0], [20, 0]],
  [[20, 0], [20, 10]],
  [[20, 10], [10, 10]],
  [[0, 0], [0, 20]],
  [[0, 20], [10, 20]],
  [[10, 20], [10, 10]],
  [[10, 0], [10, 4]],
  [[10, 6], [10, 10]],
  [[0, 10], [4, 10]],
  [[6, 10], [10, 10]],
  [[4, 10], [6, 10]],
];
const DOORS: PageDoor[] = [
  { id: 'd1', a: [10, 4], b: [10, 6], style: 'normal' },
  { id: 's1', a: [4, 10], b: [6, 10], style: 'secret' },
];

function page(over: Partial<Page> = {}): Page {
  return {
    id: 'pg1',
    name: 'Crypt',
    width: 20,
    height: 20,
    origin: [0, 0],
    cellPx: 70,
    cellUnit: '5 ft',
    showGrid: true,
    background: { kind: 'delve', mapId: 'm1' },
    walls: WALLS.map(([a, b]) => [[...a], [...b]] as Seg),
    doors: DOORS,
    vision: { mode: 'dynamic', ambient: 'bright' },
    ...over,
  };
}

const tok = (id: string, x: number, y: number, over: Partial<Token> = {}): Token => ({ id, pageId: 'pg1', layer: 'tokens', x, y, w: 1, h: 1, image: '/x.png', controlledBy: [], ...over });
const ann = (over: Partial<Token> = {}) => tok('k1', 2, 4, { controlledBy: ['p1'], ...over }); // eye at (2.5, 4.5) in room A
const lurker = tok('k3', 15, 4.5); // in room B, in line with the door
const corner = tok('k2', 15, 1); // in room B, out of line with the door
const inC = tok('k4', 4.5, 13); // in room C, behind the secret door

describe('what blocks sight', () => {
  it('walls, shut doors and secret doors; the table’s door state wins over the map’s', () => {
    expect(blockersOf(page())).toHaveLength(WALLS.length + 1); // d1 is shut
    expect(blockersOf(page({ doorState: { d1: true } }))).toHaveLength(WALLS.length);
    const mapOpen = page({ doors: [{ ...DOORS[0]!, open: true }, DOORS[1]!] });
    expect(blockersOf(mapOpen)).toHaveLength(WALLS.length);
    expect(blockersOf({ ...mapOpen, doorState: { d1: false } })).toHaveLength(WALLS.length + 1);
    // opening the secret door takes its segment out of the walls
    const secretOpen = blockersOf(page({ doorState: { s1: true } }));
    expect(secretOpen).toHaveLength(WALLS.length); // minus s1, plus the shut d1
    expect(secretOpen.some(([a, b]) => a[0] === 4 && a[1] === 10 && b[0] === 6)).toBe(false);
    // bars and arches don't block
    expect(doorBlocks({}, { id: 'x', a: [0, 0], b: [1, 0], style: 'portcullis' })).toBe(false);
    expect(doorBlocks({}, { id: 'x', a: [0, 0], b: [1, 0], style: 'archway', open: false })).toBe(false);
    expect(doorBlocks({}, { id: 'x', a: [0, 0], b: [1, 0], style: 'locked' })).toBe(true);
  });

  it('defaults to vision off and a dark ambient', () => {
    expect(visionOf(page({ vision: undefined }))).toEqual({ mode: 'off', ambient: 'dark' });
    expect(visionOf(page({ vision: { mode: 'dynamic' } }))).toEqual({ mode: 'dynamic', ambient: 'dark' });
  });
});

describe('lights and eyes', () => {
  it('takes the map’s lights and every token’s, the gm layer’s too', () => {
    const p = page({ lights: [{ id: 'l1', x: 15, y: 5, bright: 4, dim: 4 }, { id: 'l2', x: 1, y: 1, bright: 0, dim: 0 }] });
    const ls = lightsOf(p, [ann({ light: { bright: 2, dim: 2 } }), tok('k9', 5, 5, { layer: 'gm', light: { bright: 1, dim: 0 } }), tok('k8', 5, 5, { pageId: 'pg2', light: { bright: 1, dim: 1 } })]);
    expect(ls).toEqual([
      { x: 15, y: 5, bright: 4, dim: 4 },
      { x: 2.5, y: 4.5, bright: 2, dim: 2 },
      { x: 5.5, y: 5.5, bright: 1, dim: 0 },
    ]);
  });

  it('lets player tokens see by default, others only when switched on, and never the gm layer', () => {
    expect(givesSight(ann())).toBe(true);
    expect(givesSight(tok('k', 0, 0, { controlledBy: ['all'] }))).toBe(true);
    expect(givesSight(tok('k', 0, 0))).toBe(false);
    expect(givesSight(tok('k', 0, 0, { controlledBy: ['gm'] }))).toBe(false);
    expect(givesSight(tok('k', 0, 0, { sight: { enabled: true } }))).toBe(true);
    expect(givesSight(ann({ sight: { enabled: false } }))).toBe(false);
    expect(givesSight(ann({ layer: 'gm', sight: { enabled: true } }))).toBe(false);
    expect(eyesOf(page(), [ann({ sight: { range: 6, darkvision: 3 } })])).toEqual([{ id: 'k1', x: 2.5, y: 4.5, range: 6, darkvision: 3 }]);
  });
});

describe('what the party sees', () => {
  it('in bright light: its own room, and through the door once it opens', () => {
    const shut = partySight(page(), [ann(), lurker, corner]);
    expect(area(shut.raw)).toBeCloseTo(100, 1);
    expect(shut.eyes).toEqual(['k1']);
    expect(tokenSeen(lurker, shut, nothingExplored())).toBe(false);
    const open = partySight(page({ doorState: { d1: true } }), [ann(), lurker, corner]);
    expect(tokenSeen(lurker, open, nothingExplored())).toBe(true);
    expect(tokenSeen(corner, open, nothingExplored())).toBe(false); // round the corner
    // the drawn walls at the edge are part of what clients get, the floor behind them isn't
    expect(pointIn(shut.visible, [10.1, 8])).toBe(true);
    expect(pointIn(shut.visible, [10.5, 8])).toBe(false);
    expect(pointIn(shut.raw, [10.1, 8])).toBe(false);
  });

  it('in the dark: nothing without light or darkvision', () => {
    const p = page({ vision: { mode: 'dynamic', ambient: 'dark' }, doorState: { d1: true } });
    const none = partySight(p, [ann(), lurker]);
    expect(none.raw).toEqual([]);
    expect(none.visible).toEqual([]);
    expect(tokenSeen(lurker, none, nothingExplored())).toBe(false);
    // darkvision 3: a circle around the eye, seen dimly
    const dv = partySight(p, [ann({ x: 4, sight: { darkvision: 3 } }), lurker]); // eye at (4.5, 4.5), clear of the walls
    expect(area(dv.raw)).toBeGreaterThan(Math.PI * 9 * 0.98);
    expect(area(dv.raw)).toBeLessThan(Math.PI * 9);
    expect(dv.bright).toEqual([]);
    // a torch: 4 bright, then 4 dim
    const torch = partySight(p, [ann({ light: { bright: 4, dim: 4 } }), lurker]);
    expect(pointIn(torch.raw, [9, 4.5])).toBe(true);
    expect(pointIn(torch.bright, [5, 4.5])).toBe(true);
    expect(pointIn(torch.bright, [8, 4.5])).toBe(false);
    expect(tokenSeen(lurker, torch, nothingExplored())).toBe(false); // 12.5 cells away: dark
  });

  it('sees a lit room through a door, and not when it shuts', () => {
    const lights = [{ id: 'l1', x: 15, y: 5, bright: 3, dim: 3 }];
    const open = partySight(page({ vision: { mode: 'dynamic', ambient: 'dark' }, doorState: { d1: true }, lights }), [ann(), lurker]);
    expect(tokenSeen(lurker, open, nothingExplored())).toBe(true);
    expect(pointIn(open.raw, [5, 5])).toBe(false); // its own dark room stays dark
    const shut = partySight(page({ vision: { mode: 'dynamic', ambient: 'dark' }, lights }), [ann(), lurker]);
    expect(shut.raw).toEqual([]);
  });

  it('under a dim ambient sees everything in sight, but only lights and darkvision are bright', () => {
    const p = page({ vision: { mode: 'dynamic', ambient: 'dim' }, lights: [{ id: 'l1', x: 2, y: 8, bright: 1, dim: 1 }] });
    const s = partySight(p, [ann()]);
    expect(area(s.raw)).toBeCloseTo(100, 1);
    expect(pointIn(s.bright, [2, 8.5])).toBe(true);
    expect(pointIn(s.bright, [8, 2])).toBe(false);
    const dv = partySight(p, [ann({ sight: { darkvision: 2 } })]);
    expect(pointIn(dv.bright, [3.5, 4.5])).toBe(true);
  });

  it('keeps secret doors shut until the GM opens them, and limits sight to its range', () => {
    const p = page();
    expect(tokenSeen(inC, partySight(p, [ann({ x: 4.5, y: 8 }), inC]), nothingExplored())).toBe(false);
    expect(tokenSeen(inC, partySight(page({ doorState: { s1: true } }), [ann({ x: 4.5, y: 8 }), inC]), nothingExplored())).toBe(true);
    const near = partySight(p, [ann({ sight: { range: 2 } })]);
    expect(area(near.raw)).toBeLessThan(Math.PI * 4);
    expect(pointIn(near.raw, [2.5, 6.4])).toBe(true);
    expect(pointIn(near.raw, [2.5, 6.6])).toBe(false);
  });

  it('shares sight across the party and reuses polygons from its cache', () => {
    const cache = new SightCache();
    const bob = tok('k5', 15, 8, { controlledBy: ['p2'] });
    const s = partySight(page(), [ann(), bob, corner], cache);
    expect(s.eyes.sort()).toEqual(['k1', 'k5']);
    expect(tokenSeen(corner, s, nothingExplored())).toBe(true); // Bob is in room B
    const again = partySight(page(), [ann(), bob, corner], cache);
    expect(again.raw).toEqual(s.raw);
    // moving a door is a new page: the cache starts over and sees the change
    expect(tokenSeen(lurker, partySight(page({ doorState: { d1: true } }), [ann(), lurker], cache), nothingExplored())).toBe(true);
  });
});

describe('explored fog', () => {
  it('grows with what is seen, ignores slivers, and stays whole once revealed', () => {
    const first = partySight(page(), [ann()]);
    const e1 = exploreMore(nothingExplored(), first.visible)!;
    expect(e1.version).toBe(1);
    expect(e1.area).toBeGreaterThan(100);
    // the same again, or a step inside the same room: no change
    expect(exploreMore(e1, first.visible)).toBeNull();
    expect(exploreMore(e1, partySight(page(), [ann({ x: 3 })]).visible)).toBeNull();
    const e2 = exploreMore(e1, partySight(page({ doorState: { d1: true } }), [ann()]).visible)!;
    expect(e2.version).toBe(2);
    expect(e2.area!).toBeGreaterThan(e1.area! + 1);
    expect(exploreMore({ version: 5, all: true, polys: [] }, first.visible)).toBeNull();
  });
});

describe('which tokens a player gets', () => {
  it('their own, the party’s eyes and what the party sees; map-layer scenery once explored', () => {
    const p = page();
    const crate = tok('k6', 15, 8, { layer: 'map' });
    const rug = tok('k7', 3, 3, { layer: 'map' });
    const hidden = tok('k8', 3, 3, { layer: 'gm' });
    const own = tok('k9', 15, 1, { controlledBy: ['p2'], sight: { enabled: false } }); // Bob's, blind, in room B
    const tokens = [ann(), lurker, crate, rug, hidden, own];
    const sight = partySight(p, tokens);
    const explored = exploreMore(nothingExplored(), sight.visible)!;
    const seen = seenTokens(p, tokens, sight, explored);
    expect([...seen].sort()).toEqual(['k1', 'k7']);
    const filter = sightFilter('pg1', sight, explored);
    const p1 = { id: 'p1', role: 'player' as const };
    const p2 = { id: 'p2', role: 'player' as const };
    const gm = { id: 'gm', role: 'gm' as const };
    expect(tokens.filter((t) => mayGetToken(p1, t, filter)).map((t) => t.id)).toEqual(['k1', 'k7']);
    expect(tokens.filter((t) => mayGetToken(p2, t, filter)).map((t) => t.id)).toEqual(['k1', 'k7', 'k9']);
    expect(tokens.filter((t) => mayGetToken(gm, t, filter))).toHaveLength(tokens.length);
    // other pages, and pages without dynamic vision, are as before
    expect(mayGetToken(p1, { ...lurker, pageId: 'pg2' }, filter)).toBe(true);
    expect(mayGetToken(p1, lurker, null)).toBe(true);
    expect(mayGetToken(p1, hidden, null)).toBe(false);
    expect(mayGetToken(undefined, ann(), null)).toBe(false);
    // revealing all explores the crate, but the lurker still needs to be in sight
    const all = seenTokens(p, tokens, sight, { version: 2, all: true, polys: [] });
    expect([...all].sort()).toEqual(['k1', 'k6', 'k7']);
  });
});
