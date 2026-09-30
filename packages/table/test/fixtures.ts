// Shared test helpers: a fixed dice sequence, an ApplyContext and a small game
// with a GM, two players, two pages and tokens on every layer.
import { addMember, applyIntent, newGame, type ApplyContext, type GameState, type Intent, type Outcome } from '../src/index.ts';

/** An RNG that returns the given values in order and fails when they run out. */
export function seq(...values: number[]): (sides: number) => number {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error('the test rng ran out of values');
    return v;
  };
}

export function ctx(...dice: number[]): ApplyContext {
  let n = 0;
  return { now: 1000, rng: seq(...dice), nextSeq: () => ++n };
}

/** Deep-freeze a value, so any mutation throws (ESM code runs in strict mode). */
export function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) frozen(v);
  }
  return value;
}

export function run(state: GameState, who: string, intent: Intent, c: ApplyContext = ctx()): Outcome {
  return applyIntent(state, who, intent, c);
}

/**
 * gm, p1 "Ann", p2 "Bob"; pages pg1 (players are here) and pg2.
 * k1 Ann's token, k2 Bob's, k3 on the gm layer (controlled by Ann, with notes),
 * k4 on pg2 (Ann's), k5 on the map layer (Ann's), k6 anyone's ("all"), with notes.
 */
export function table(): GameState {
  let s = newGame('g1', 'Crypt night', 0);
  s = addMember(s, 'Ann').state;
  s = addMember(s, 'Bob').state;
  s = run(s, 'gm', { type: 'page.create', page: { name: 'Caves', width: 40, height: 30, origin: [2, 3], cellPx: 70, cellUnit: '5 ft', showGrid: false, background: { kind: 'delve', mapId: 'map_abc' } } }).state;
  const token = (pageId: string, layer: 'map' | 'tokens' | 'gm', controlledBy: string[], extra: object = {}): Intent => ({
    type: 'token.create',
    token: { pageId, layer, x: 1, y: 2, w: 1, h: 1, image: '/assets/props/dungeon/barrel.svg', controlledBy, ...extra },
  });
  s = run(s, 'gm', token('pg1', 'tokens', ['p1'], { name: 'Ann the Bold', bars: [{ value: 7, max: 10 }] })).state;
  s = run(s, 'gm', token('pg1', 'tokens', ['p2'], { name: 'Bob' })).state;
  s = run(s, 'gm', token('pg1', 'gm', ['p1'], { name: 'Lurker', gmNotes: 'ambush in round 2' })).state;
  s = run(s, 'gm', token('pg2', 'tokens', ['p1'])).state;
  s = run(s, 'gm', token('pg1', 'map', ['p1'])).state;
  s = run(s, 'gm', token('pg1', 'tokens', ['all'], { name: 'Cart', gmNotes: 'the axle is cursed' })).state;
  return s;
}
