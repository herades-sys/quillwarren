// "Respect heights": with it on, a player's move over a cliff edge of the page's
// Quillwarren map (no stairs or ladder there) is refused, and so is one through a wall
// or a shut door; the GM is never held back, and it is off by default.
import { describe, expect, it } from 'vitest';
import { crossingAt, moveRefusal, pageForPlayer, viewFor, type GameState, type Page } from '../src/index.ts';
import { run, table } from './fixtures.ts';

/** pg1 with a 10 ft ledge edge along y = 4, cut where stairs cross it (x 5 to 7), and a wall at x = 12. */
function ledge(respect = true): GameState {
  return run(table(), 'gm', {
    type: 'page.update',
    id: 'pg1',
    set: {
      cliffs: [
        { a: [0, 4], b: [5, 4], drop: 10 },
        { a: [7, 4], b: [10, 4], drop: 10 },
      ],
      walls: [[[12, 0], [12, 10]]],
      doors: [{ id: 'd1', a: [12, 10], b: [12, 11], style: 'normal' }],
      ...(respect ? { respectHeights: true } : {}),
    },
  }).state;
}

describe('Respect heights', () => {
  it('refuses a player\'s move over a cliff, and says why', () => {
    // k1 (Ann) stands at 1,2: its centre is 1.5, 2.5
    expect(() => run(ledge(), 'p1', { type: 'token.move', id: 'k1', x: 1, y: 5 })).toThrow('That move goes over a cliff edge (a 10 ft drop): take the stairs or a ladder, or ask the GM');
    // the same through token.update
    expect(() => run(ledge(), 'p1', { type: 'token.update', id: 'k1', set: { y: 6 } })).toThrow(/cliff edge/);
  });

  it('lets them take the stairs', () => {
    let s = run(ledge(), 'p1', { type: 'token.move', id: 'k1', x: 5.5, y: 2 }).state;
    s = run(s, 'p1', { type: 'token.move', id: 'k1', x: 5.5, y: 6 }).state;
    expect(s.tokens.find((t) => t.id === 'k1')).toMatchObject({ x: 5.5, y: 6 });
    // and to move about on either side
    expect(run(s, 'p1', { type: 'token.move', id: 'k1', x: 2, y: 7 }).state.tokens.find((t) => t.id === 'k1')).toMatchObject({ x: 2, y: 7 });
  });

  it('holds them to walls and shut doors too, not open ones', () => {
    let s = run(ledge(), 'p1', { type: 'token.move', id: 'k1', x: 10.5, y: 2 }).state;
    expect(() => run(s, 'p1', { type: 'token.move', id: 'k1', x: 13, y: 2 })).toThrow('That move goes through a wall');
    s = run(s, 'p1', { type: 'token.move', id: 'k1', x: 10.5, y: 5 }).state; // past the ledge's east end (x 10): no edge there
    s = run(s, 'p1', { type: 'token.move', id: 'k1', x: 11, y: 10 }).state;
    expect(() => run(s, 'p1', { type: 'token.move', id: 'k1', x: 12.5, y: 10 })).toThrow('That move goes through a shut door');
    s = run(s, 'gm', { type: 'page.update', id: 'pg1', set: { doorState: { d1: true } } }).state;
    expect(run(s, 'p1', { type: 'token.move', id: 'k1', x: 12.5, y: 10 }).state.tokens.find((t) => t.id === 'k1')?.x).toBe(12.5);
  });

  it('never holds the GM back', () => {
    const s = run(ledge(), 'gm', { type: 'token.move', id: 'k1', x: 1, y: 6 }).state;
    expect(s.tokens.find((t) => t.id === 'k1')).toMatchObject({ x: 1, y: 6 });
  });

  it('is off until the GM turns it on', () => {
    expect(run(ledge(false), 'p1', { type: 'token.move', id: 'k1', x: 1, y: 6 }).state.tokens.find((t) => t.id === 'k1')?.y).toBe(6);
    const page = ledge(false).pages.find((p) => p.id === 'pg1')!;
    expect(moveRefusal(page, { x: 1, y: 2, w: 1, h: 1 }, 1, 6)).toBeNull();
    // and back off
    const off = run(ledge(), 'gm', { type: 'page.update', id: 'pg1', set: { respectHeights: false } }).state;
    expect(run(off, 'p1', { type: 'token.move', id: 'k1', x: 1, y: 6 }).state.tokens.find((t) => t.id === 'k1')?.y).toBe(6);
  });

  it('keeps the cliffs from the players, and checks them', () => {
    const s = ledge();
    const mine = viewFor(s, 'p1').pages.find((p) => p.id === 'pg1')!;
    expect(mine).not.toHaveProperty('cliffs');
    expect(mine.respectHeights).toBe(true);
    expect(pageForPlayer(s.pages.find((p) => p.id === 'pg1')!)).not.toHaveProperty('cliffs');
    for (const cliffs of [[{ a: [0, 0], b: [1, 0] }], [{ a: [0, 0], b: [1, 0], drop: 'deep' }], 'all', [{ a: [0], b: [1, 0], drop: 5 }]]) {
      expect(() => run(table(), 'gm', { type: 'page.update', id: 'pg1', set: { cliffs } as unknown as Partial<Page> })).toThrow(/cliff/);
    }
    expect(() => run(table(), 'p1', { type: 'page.update', id: 'pg1', set: { respectHeights: false } })).toThrow(/Only the GM/);
  });

  it('counts landing on the edge as crossing it, starting on it not', () => {
    expect(crossingAt([0, 0], [0, 2], [-1, 1], [1, 1])).toBeCloseTo(0.5);
    expect(crossingAt([0, 0], [0, 1], [-1, 1], [1, 1])).toBeCloseTo(1);
    expect(crossingAt([0, 1], [0, 3], [-1, 1], [1, 1])).toBeNull();
    expect(crossingAt([0, 0], [2, 0], [-1, 0], [5, 0])).toBeNull(); // along it
  });
});
