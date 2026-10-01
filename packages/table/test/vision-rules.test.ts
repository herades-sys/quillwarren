// The rules and views around dynamic vision: token light and sight (GM only),
// page vision settings, doors, lights and door state (validated, GM only, never
// sent to players), the explored tools, and views with a token filter.
import { describe, expect, it } from 'vitest';
import { eventFor, sightFilter, viewFor, type GameState, type Intent, type Page } from '../src/index.ts';
import { run, table } from './fixtures.ts';

const refused = (s: GameState, who: string, intent: Intent) => expect(() => run(s, who, intent)).toThrow();

function withDoors(): GameState {
  return run(table(), 'gm', {
    type: 'page.update',
    id: 'pg1',
    set: {
      vision: { mode: 'dynamic', ambient: 'dim' },
      walls: [[[0, 0], [10, 0]]],
      doors: [{ id: 'd1', a: [10, 4], b: [10, 6], style: 'normal' }],
      lights: [{ id: 'torch1', x: 3, y: 4, bright: 4, dim: 4, asset: 'sconce' }],
    },
  }).state;
}

describe('token light and sight', () => {
  it('lets the GM set and clear them, checked', () => {
    let s = run(table(), 'gm', { type: 'token.update', id: 'k1', set: { light: { bright: 4, dim: 4 }, sight: { enabled: true, range: 12, darkvision: 12 } } }).state;
    expect(s.tokens.find((t) => t.id === 'k1')).toMatchObject({ light: { bright: 4, dim: 4 }, sight: { enabled: true, range: 12, darkvision: 12 } });
    s = run(s, 'gm', { type: 'token.update', id: 'k1', set: { light: null, sight: null } as never }).state;
    expect(s.tokens.find((t) => t.id === 'k1')).not.toHaveProperty('light');
    expect(s.tokens.find((t) => t.id === 'k1')).not.toHaveProperty('sight');
    for (const set of [{ light: { bright: -1, dim: 0 } }, { light: { bright: 1, dim: 1, colour: 'red' } }, { light: 'bright' }, { sight: { range: 'far' } }, { sight: { xray: true } }, { sight: { enabled: 'yes' } }]) {
      refused(s, 'gm', { type: 'token.update', id: 'k1', set } as Intent);
    }
  });

  it('never lets a player change them, not even on their own token', () => {
    const s = table();
    for (const set of [{ light: { bright: 9, dim: 9 } }, { sight: { darkvision: 60 } }, { sight: { enabled: false } }]) {
      expect(() => run(s, 'p1', { type: 'token.update', id: 'k1', set } as Intent)).toThrow(/Only the GM/);
    }
  });
});

describe('page vision, doors and lights', () => {
  it('checks the settings, doors and lights a page may carry', () => {
    const s = withDoors();
    const p = s.pages.find((x) => x.id === 'pg1')!;
    expect(p.vision).toEqual({ mode: 'dynamic', ambient: 'dim' });
    for (const set of [
      { vision: { mode: 'on' } },
      { vision: { mode: 'dynamic', ambient: 'pitch' } },
      { vision: { mode: 'dynamic', fog: true } },
      { doors: [{ id: '1bad', a: [0, 0], b: [1, 0], style: 'normal' }] },
      { doors: [{ id: 'd1', a: [0, 0], style: 'normal' }] },
      { lights: [{ id: 'l1', x: 0, y: 0, bright: 500, dim: 0 }] },
      { doorState: { d1: 'open' } },
      { doorState: { __proto__x: true } },
    ]) {
      refused(s, 'gm', { type: 'page.update', id: 'pg1', set } as Intent);
    }
    refused(s, 'p1', { type: 'page.update', id: 'pg1', set: { vision: { mode: 'off' } } });
  });

  it('opens and shuts the map’s doors for the table only, GM only', () => {
    const s = withDoors();
    const out = run(s, 'gm', { type: 'door.set', pageId: 'pg1', id: 'd1', open: true });
    expect(out.state.pages.find((p) => p.id === 'pg1')!.doorState).toEqual({ d1: true });
    expect(out.events).toEqual([{ type: 'page.upsert', page: out.state.pages.find((p) => p.id === 'pg1') }]);
    expect(run(out.state, 'gm', { type: 'door.set', pageId: 'pg1', id: 'd1', open: false }).state.pages.find((p) => p.id === 'pg1')!.doorState).toEqual({ d1: false });
    expect(() => run(s, 'gm', { type: 'door.set', pageId: 'pg1', id: 'nope', open: true })).toThrow(/No door/);
    expect(() => run(s, 'gm', { type: 'door.set', pageId: 'pg1', id: 'd1', open: 'yes' } as never)).toThrow();
    expect(() => run(s, 'p1', { type: 'door.set', pageId: 'pg1', id: 'd1', open: true })).toThrow('Only the GM can open and shut doors');
  });

  it('hands the explored tools to the server, GM only', () => {
    const s = withDoors();
    const out = run(s, 'gm', { type: 'vision.explored', pageId: 'pg1', action: 'reveal' });
    expect(out.explored).toEqual({ pageId: 'pg1', action: 'reveal' });
    expect(out.events).toEqual([]);
    expect(() => run(s, 'gm', { type: 'vision.explored', pageId: 'pg1', action: 'burn' } as never)).toThrow();
    expect(() => run(s, 'p1', { type: 'vision.explored', pageId: 'pg1', action: 'reset' })).toThrow();
  });

  it('never sends players the walls, doors, lights or door state', () => {
    const s = run(withDoors(), 'gm', { type: 'door.set', pageId: 'pg1', id: 'd1', open: true });
    const page = viewFor(s.state, 'p1').pages[0] as Page;
    for (const k of ['walls', 'doors', 'lights', 'doorState']) expect(page).not.toHaveProperty(k);
    expect(page.vision).toEqual({ mode: 'dynamic', ambient: 'dim' });
    const ev = eventFor(s.state, 'p1', s.events[0]!);
    expect(JSON.stringify(ev)).not.toMatch(/d1|torch1|doorState|walls/);
    expect(viewFor(s.state, 'gm').pages.find((p) => p.id === 'pg1')!.doorState).toEqual({ d1: true });
  });
});

describe('views with a token filter', () => {
  it('drops tokens the party doesn’t see, keeps the player’s own, and hides them in the turn order', () => {
    let s = table();
    s = run(s, 'gm', { type: 'token.update', id: 'k2', set: { sight: { enabled: false }, light: { bright: 1, dim: 1 } } }).state; // Bob's, blind
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k6', name: 'Cart', initiative: 3 } }).state;
    // a filter that sees only k1 (Ann's)
    const filter = { pageId: 'pg1', sees: (t: { id: string }) => t.id === 'k1' };
    const ann = viewFor(s, 'p1', filter);
    // k6 is controlled by "all", so every player has it; k5 is Ann's own on the map layer
    expect(ann.tokens.map((t) => t.id)).toEqual(['k1', 'k5', 'k6']);
    const bob = viewFor(s, 'p2', filter);
    expect(bob.tokens.map((t) => t.id)).toEqual(['k1', 'k2', 'k6']);
    // Bob's own token keeps its sight and light; others' are stripped
    expect(bob.tokens.find((t) => t.id === 'k2')).toMatchObject({ sight: { enabled: false }, light: { bright: 1, dim: 1 } });
    const s2 = run(s, 'gm', { type: 'token.update', id: 'k1', set: { sight: { darkvision: 6 } } }).state;
    expect(viewFor(s2, 'p2', filter).tokens.find((t) => t.id === 'k1')).not.toHaveProperty('sight');
    expect(viewFor(s2, 'p1', filter).tokens.find((t) => t.id === 'k1')).toHaveProperty('sight');
    // an unseen token in the turn order: hidden, without its token
    const hidden = { pageId: 'pg1', sees: () => false };
    const carl = viewFor(s, 'p1', hidden);
    expect(carl.turn?.entries).toEqual([{ id: 't1', tokenId: 'k6', name: 'Cart', initiative: 3 }]); // Ann controls k6 ("all")
    const s3 = run(s, 'gm', { type: 'token.update', id: 'k6', set: { controlledBy: [] } }).state;
    expect(viewFor(s3, 'p1', hidden).turn?.entries).toEqual([{ id: 't1', name: 'Hidden', initiative: 3 }]);
    expect(viewFor(s3, 'gm', hidden).tokens.map((t) => t.id)).toEqual(['k1', 'k2', 'k3', 'k5', 'k6']);
  });

  it('drops upserts of unseen tokens in events, for players only', () => {
    const s = table();
    const out = run(s, 'gm', { type: 'token.move', id: 'k6', x: 5, y: 5 });
    const ev = out.events[0]!;
    const none = { pageId: 'pg1', sees: () => false };
    expect(eventFor(out.state, 'p1', ev, none)).toMatchObject({ type: 'token.upsert' }); // Ann controls it ("all")
    const s2 = run(s, 'gm', { type: 'token.update', id: 'k6', set: { controlledBy: [] } }).state;
    const moved = run(s2, 'gm', { type: 'token.move', id: 'k6', x: 6, y: 6 });
    expect(eventFor(moved.state, 'p1', moved.events[0]!, none)).toBeNull();
    expect(eventFor(moved.state, 'gm', moved.events[0]!, none)).toMatchObject({ type: 'token.upsert' });
    // a filter for another page changes nothing here
    expect(eventFor(moved.state, 'p1', moved.events[0]!, { pageId: 'pg2', sees: () => false })).toMatchObject({ type: 'token.upsert' });
    // sightFilter never lets a gm-layer token through
    expect(sightFilter('pg1', { raw: [{ outer: [[0, 0], [99, 0], [99, 99], [0, 99]], holes: [] }], visible: [], bright: [], eyes: ['k3'] }, { version: 0, polys: [] }).sees(s.tokens.find((t) => t.id === 'k3')!)).toBe(false);
  });
});
