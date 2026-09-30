import { describe, expect, it } from 'vitest';
import { applyIntent, can, TableError, type GameState, type Intent, type Token } from '../src/index.ts';
import { ctx, frozen, run, table } from './fixtures.ts';

const tok = (s: GameState, id: string): Token => s.tokens.find((t) => t.id === id)!;
const refused = (s: GameState, who: string, intent: Intent, message: string | RegExp): void => {
  expect(() => run(s, who, intent)).toThrow(message instanceof RegExp ? message : new TableError(message));
};

describe('permissions: players and tokens', () => {
  it('lets a player move a token they control on their page', () => {
    const s = table();
    const out = run(s, 'p1', { type: 'token.move', id: 'k1', x: 4, y: 5.5 });
    expect(tok(out.state, 'k1')).toMatchObject({ x: 4, y: 5.5 });
    expect(out.state.rev).toBe(s.rev + 1);
    expect(out.events).toEqual([{ type: 'token.upsert', token: tok(out.state, 'k1'), prevLayer: 'tokens' }]);
  });

  it('lets anyone move a token controlled by "all"', () => {
    expect(tok(run(table(), 'p2', { type: 'token.move', id: 'k6', x: 3, y: 3 }).state, 'k6').x).toBe(3);
  });

  it("refuses other players' tokens, gm-layer tokens, other pages and the map layer", () => {
    const s = table();
    refused(s, 'p1', { type: 'token.move', id: 'k2', x: 0, y: 0 }, "You don't control that token");
    refused(s, 'p1', { type: 'token.move', id: 'k3', x: 0, y: 0 }, 'No such token');
    refused(s, 'p1', { type: 'token.move', id: 'k4', x: 0, y: 0 }, "That token isn't on your page");
    refused(s, 'p1', { type: 'token.move', id: 'k5', x: 0, y: 0 }, 'You can only move tokens on the tokens layer');
    refused(s, 'p1', { type: 'token.move', id: 'nope', x: 0, y: 0 }, 'No such token');
  });

  it('lets a player change position, rotation, bars and the name plate of their token', () => {
    const s = table();
    const set = { x: 2, y: 3, rotation: 90, bars: [{ value: 3, max: 10 }, { value: 1 }], name: 'Ann (hurt)', showName: true };
    expect(tok(run(s, 'p1', { type: 'token.update', id: 'k1', set }).state, 'k1')).toMatchObject(set);
  });

  it('refuses the fields only the GM may change', () => {
    const s = table();
    const sets: Record<string, unknown>[] = [{ layer: 'gm' }, { controlledBy: ['p1', 'p2'] }, { gmNotes: 'x' }, { image: '/x.png' }, { w: 2 }, { h: 2 }, { x: 1, layer: 'map' }];
    for (const set of sets) {
      const key = Object.keys(set).find((k) => k !== 'x');
      refused(s, 'p1', { type: 'token.update', id: 'k1', set: set as never }, `Only the GM can change a token's ${key}`);
    }
  });

  it('keeps everything else for the GM', () => {
    const s = table();
    const token = { pageId: 'pg1', layer: 'tokens' as const, x: 0, y: 0, w: 1, h: 1, image: '/a.png', controlledBy: [] };
    refused(s, 'p1', { type: 'token.create', token }, 'Only the GM can create tokens');
    refused(s, 'p1', { type: 'token.delete', ids: ['k1'] }, 'Only the GM can delete tokens');
    refused(s, 'p1', { type: 'page.activate', id: 'pg2' }, 'Only the GM can move the players to a page');
    refused(s, 'p1', { type: 'page.view', id: 'pg2' }, 'Only the GM can switch pages');
    refused(s, 'p1', { type: 'page.update', id: 'pg1', set: { name: 'x' } }, 'Only the GM can change pages');
    refused(s, 'p1', { type: 'turn.sort' }, 'Only the GM can change the turn order');
    refused(s, 'p1', { type: 'turn.visible', visible: false }, 'Only the GM can change the turn order');
    refused(s, 'p1', { type: 'member.remove', id: 'p2' }, 'Only the GM can remove players');
    refused(s, 'p1', { type: 'game.rename', name: 'Mine' }, 'Only the GM can rename the game');
  });

  it('lets players rename only themselves', () => {
    const s = table();
    expect(run(s, 'p1', { type: 'member.rename', id: 'p1', name: 'Annie' }).state.members[1]?.name).toBe('Annie');
    refused(s, 'p1', { type: 'member.rename', id: 'p2', name: 'Bobo' }, 'You can only rename yourself');
  });

  it('refuses strangers and unknown intents', () => {
    const s = table();
    refused(s, 'p9', { type: 'chat.send', text: 'hi' }, "You aren't in this game");
    refused(s, 'gm', { type: 'token.teleport' } as unknown as Intent, 'Unknown intent "token.teleport"');
    refused(s, 'gm', null as unknown as Intent, 'An intent needs a type');
  });

  it('can() answers without throwing, also for odd input', () => {
    const s = table();
    expect(can(s, 'gm', { type: 'token.delete', ids: ['k1'] })).toBe(true);
    expect(can(s, 'p1', { type: 'token.move', id: 'k1', x: 0, y: 0 })).toBe(true);
    expect(can(s, 'p1', { type: 'token.move', id: 'k2', x: 0, y: 0 })).toBe("You don't control that token");
    expect(can(s, 'p1', { type: 'token.update', id: 'k1', set: null } as unknown as Intent)).toBe(true);
    expect(can(s, 'p1', 42 as unknown as Intent)).toBe('That is not something you can do');
    expect(can(s, 'nobody', { type: 'chat.send', text: 'hi' })).toBe("You aren't in this game");
  });
});

describe('validation', () => {
  const base = { pageId: 'pg1', layer: 'tokens' as const, x: 1, y: 1, w: 1, h: 1, image: '/api/v1/games/g1/assets/ab.png', controlledBy: [] as string[] };
  const create = (extra: Record<string, unknown>): Intent => ({ type: 'token.create', token: { ...base, ...extra } as never });

  it('accepts a good token and fills in defaults', () => {
    const out = run(table(), 'gm', { type: 'token.create', token: { pageId: 'pg2', x: 0, y: 0, image: '/a.png' } as never });
    expect(tok(out.state, 'k7')).toEqual({ id: 'k7', pageId: 'pg2', layer: 'tokens', x: 0, y: 0, w: 1, h: 1, image: '/a.png', controlledBy: [] });
  });

  const bad: [string, Record<string, unknown>, string][] = [
    ['a tiny token', { w: 0.1 }, 'Token w must be a number from 0.25 to 50'],
    ['a huge token', { h: 51 }, 'Token h must be a number from 0.25 to 50'],
    ['NaN', { x: Number.NaN }, 'Token x must be a number from -1000 to 10000'],
    ['Infinity', { y: Number.POSITIVE_INFINITY }, 'Token y must be a number from -1000 to 10000'],
    ['far away', { x: 10001 }, 'Token x must be a number from -1000 to 10000'],
    ['a string number', { x: '3' }, 'Token x must be a number from -1000 to 10000'],
    ['another origin', { image: 'https://evil.example/x.png' }, 'Token image must be a path on this server, starting with /'],
    ['protocol-relative', { image: '//evil.example/x.png' }, 'Token image must be a path on this server, starting with /'],
    ['a backslash', { image: '/\\evil.example/x.png' }, 'Token image must be a path on this server, starting with /'],
    ['javascript:', { image: 'javascript:alert(1)' }, 'Token image must be a path on this server, starting with /'],
    ['javascript: in a path', { image: '/x/javascript:alert(1)' }, 'Token image must be a path on this server, starting with /'],
    ['a quote', { image: '/x".png' }, 'Token image must be a path on this server, starting with /'],
    ['a long name', { name: 'n'.repeat(81) }, 'Token name is too long (max 80 characters)'],
    ['long notes', { gmNotes: 'n'.repeat(5001) }, 'GM notes is too long (max 5000 characters)'],
    ['a strange layer', { layer: 'sky' }, 'Layer must be map, tokens or gm'],
    ['an unknown controller', { controlledBy: ['p9'] }, 'No member "p9"'],
    ['four bars', { bars: [{ value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }] }, 'A token has at most 3 bars'],
    ['a bad bar', { bars: [{ value: 'x' }] }, 'Bar 1 value must be a number from -1000000000 to 1000000000'],
    ['an unknown field', { speed: 30 }, 'Tokens have no field "speed"'],
    ['an unknown page', { pageId: 'pg9' }, 'No page "pg9"'],
    ['a bad id', { id: '9lives' }, 'Token ids start with a letter and use only letters, digits, _ or - (max 32)'],
    ['a taken id', { id: 'k1' }, 'Token id k1 is already in use'],
    ['no image', { image: undefined }, 'A new token needs x, y and an image'],
  ];
  for (const [what, extra, message] of bad) {
    it(`refuses ${what}`, () => refused(table(), 'gm', create(extra), message));
  }

  it('checks updates, moves and pages too', () => {
    const s = table();
    refused(s, 'gm', { type: 'token.update', id: 'k1', set: { pageId: 'pg2' } as never }, "A token's pageId can't be changed");
    refused(s, 'gm', { type: 'token.update', id: 'k9', set: {} }, 'No token "k9"');
    refused(s, 'gm', { type: 'token.move', id: 'k1', x: 1, y: -1001 }, 'Token y must be a number from -1000 to 10000');
    refused(s, 'gm', { type: 'token.delete', ids: [] }, 'ids must be a list of 1 to 1000 ids');
    refused(s, 'gm', { type: 'token.delete', ids: ['k1', 'k9'] }, 'No token "k9"');
    refused(s, 'gm', { type: 'page.update', id: 'pg1', set: { name: 'n'.repeat(81) } }, 'Page name must be 1 to 80 characters');
    refused(s, 'gm', { type: 'page.update', id: 'pg1', set: { background: { kind: 'image', url: 'http://x/y.png', w: 10, h: 10 } } }, 'Background image must be a path on this server, starting with /');
    refused(s, 'gm', { type: 'page.update', id: 'pg1', set: { background: { kind: 'video' } as never } }, 'Background kind must be none, delve or image');
    refused(s, 'gm', { type: 'page.delete', id: 'pg7' }, 'No page "pg7"');
    refused(s, 'gm', { type: 'game.rename', name: '   ' }, 'Game name must be 1 to 80 characters');
    refused(s, 'gm', { type: 'member.remove', id: 'gm' }, "The GM can't be removed");
    refused(s, 'gm', { type: 'member.rename', id: 'p1', name: 'bob' }, 'The name "bob" is taken');
  });

  it('caps the number of tokens, pages and turn entries', () => {
    const s = table();
    const full = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
    const many = { ...s, tokens: full(5000, (i) => ({ ...s.tokens[0]!, id: `x${i}` })) };
    refused(many, 'gm', create({}), 'A game holds at most 5000 tokens');
    const pages = { ...s, pages: full(200, (i) => ({ ...s.pages[0]!, id: `x${i}` })) };
    refused(pages, 'gm', { type: 'page.create', page: {} as never }, 'A game holds at most 200 pages');
    const turns = { ...s, turn: { ...s.turn, entries: full(500, (i) => ({ id: `x${i}`, name: 'x', initiative: 0 })) } };
    refused(turns, 'p1', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 1 } }, 'The turn order holds at most 500 entries');
  });

  it('removes optional token fields set to undefined (in-process callers)', () => {
    const out = run(table(), 'gm', { type: 'token.update', id: 'k6', set: { gmNotes: undefined, name: undefined } });
    expect(tok(out.state, 'k6')).not.toHaveProperty('gmNotes');
    expect(tok(out.state, 'k6')).not.toHaveProperty('name');
  });

  it('copies values instead of keeping the intent\'s objects', () => {
    const bars = [{ value: 1, max: 2 }];
    const out = run(table(), 'gm', { type: 'token.update', id: 'k1', set: { bars } });
    bars[0]!.value = 99;
    expect(tok(out.state, 'k1').bars).toEqual([{ value: 1, max: 2 }]);
  });
});

describe('ids', () => {
  it('numbers new tokens, pages and turn entries after the highest in use', () => {
    let s = table();
    expect(s.tokens.map((t) => t.id)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    expect(s.pages.map((p) => p.id)).toEqual(['pg1', 'pg2']);
    s = run(s, 'gm', { type: 'token.create', token: { pageId: 'pg1', x: 0, y: 0, image: '/a.png', id: 'k40' } as never }).state;
    s = run(s, 'gm', { type: 'token.create', token: { pageId: 'pg1', x: 0, y: 0, image: '/a.png' } as never }).state;
    expect(s.tokens.at(-1)?.id).toBe('k41');
    s = run(s, 'gm', { type: 'token.create', token: { pageId: 'pg1', x: 0, y: 0, image: '/a.png', id: 'boss' } as never }).state;
    expect(s.tokens.at(-1)?.id).toBe('boss');
    s = run(s, 'gm', { type: 'page.create', page: { name: 'Tower' } as never }).state;
    expect(s.pages.at(-1)).toMatchObject({ id: 'pg3', name: 'Tower', width: 30, height: 20, cellPx: 70, background: { kind: 'none' } });
    s = run(s, 'gm', { type: 'turn.add', entry: { name: 'Goblin', initiative: 3 } }).state;
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k1', initiative: 9 } as never }).state;
    expect(s.turn.entries).toEqual([
      { id: 't1', name: 'Goblin', initiative: 3 },
      { id: 't2', tokenId: 'k1', name: 'Ann the Bold', initiative: 9 },
    ]);
  });
});

describe('pages', () => {
  it('page.activate moves the players and page.view the GM', () => {
    const s = table();
    const a = run(s, 'gm', { type: 'page.activate', id: 'pg2' });
    expect(a.state).toMatchObject({ playerPageId: 'pg2', gmPageId: 'pg1' });
    expect(a.events).toEqual([
      { type: 'page.switch', pageId: 'pg2', audience: 'players' },
      { type: 'game', name: 'Crypt night', playerPageId: 'pg2' },
    ]);
    const v = run(s, 'gm', { type: 'page.view', id: 'pg2' });
    expect(v.state).toMatchObject({ playerPageId: 'pg1', gmPageId: 'pg2' });
    expect(v.events).toEqual([{ type: 'page.switch', pageId: 'pg2', audience: 'gm' }]);
  });

  it('deleting a page takes its tokens and moves whoever was on it', () => {
    let s = table();
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 5 } }).state;
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k4', name: 'Ann elsewhere', initiative: 4 } }).state;
    const out = run(s, 'gm', { type: 'page.delete', id: 'pg1' });
    expect(out.state.pages.map((p) => p.id)).toEqual(['pg2']);
    expect(out.state.tokens.map((t) => t.id)).toEqual(['k4']);
    expect(out.state.turn.entries.map((e) => e.id)).toEqual(['t2']);
    expect(out.state).toMatchObject({ playerPageId: 'pg2', gmPageId: 'pg2' });
    expect(out.events.map((e) => e.type)).toEqual(['page.remove', 'turn', 'page.switch', 'game', 'page.switch']);
    refused(out.state, 'gm', { type: 'page.delete', id: 'pg2' }, 'A game needs at least one page');
  });
});

describe('turn order', () => {
  function withTurns(): GameState {
    let s = table();
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 12 } }).state;
    s = run(s, 'gm', { type: 'turn.add', entry: { name: 'Goblin', initiative: 15 } }).state;
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k2', name: 'Bob', initiative: 8 } }).state;
    return s;
  }
  const names = (s: GameState): string[] => s.turn.entries.map((e) => e.name);

  it('sorts by initiative (descending, stable) and the current turn follows its entry', () => {
    let s = withTurns();
    s = run(s, 'gm', { type: 'turn.next' }).state; // Goblin's turn
    s = run(s, 'gm', { type: 'turn.add', entry: { name: 'Rat', initiative: 12 } }).state;
    const out = run(s, 'gm', { type: 'turn.sort' });
    expect(names(out.state)).toEqual(['Goblin', 'Ann', 'Rat', 'Bob']);
    expect(out.state.turn.current).toBe(0);
    expect(out.events).toEqual([{ type: 'turn', turn: out.state.turn }]);
  });

  it('next counts rounds up past the end', () => {
    let s = withTurns();
    expect(s.turn).toMatchObject({ current: 0, round: 1 });
    s = run(s, 'gm', { type: 'turn.next' }).state;
    s = run(s, 'gm', { type: 'turn.next' }).state;
    expect(s.turn).toMatchObject({ current: 2, round: 1 });
    s = run(s, 'gm', { type: 'turn.next' }).state;
    expect(s.turn).toMatchObject({ current: 0, round: 2 });
    refused(table(), 'gm', { type: 'turn.next' }, 'The turn order is empty');
  });

  it("lets a player end their own turn, not someone else's", () => {
    let s = withTurns(); // Ann (k1) is first
    refused(s, 'p2', { type: 'turn.next' }, "It isn't your turn");
    s = run(s, 'p1', { type: 'turn.next' }).state;
    refused(s, 'p1', { type: 'turn.next' }, "It isn't your turn"); // the Goblin's
    s = run(s, 'gm', { type: 'turn.visible', visible: false }).state;
    refused(s, 'p1', { type: 'turn.next' }, 'The turn order is hidden');
  });

  it('lets a player add a token they control', () => {
    const s = table();
    const out = run(s, 'p1', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 14 } });
    expect(out.state.turn.entries).toEqual([{ id: 't1', tokenId: 'k1', name: 'Ann', initiative: 14 }]);
    refused(s, 'p1', { type: 'turn.add', entry: { tokenId: 'k2', name: 'Bob', initiative: 1 } }, 'You can only add tokens you control');
    refused(s, 'p1', { type: 'turn.add', entry: { name: 'Dragon', initiative: 30 } }, 'Only the GM can add names to the turn order');
    refused(s, 'p1', { type: 'turn.add', entry: { tokenId: 'k3', name: 'x', initiative: 1 } }, 'No such token');
  });

  it('update, remove and clear', () => {
    let s = withTurns();
    s = run(s, 'gm', { type: 'turn.next' }).state;
    s = run(s, 'gm', { type: 'turn.next' }).state; // Bob's turn (index 2)
    s = run(s, 'gm', { type: 'turn.update', id: 't2', set: { name: 'Goblin boss', initiative: 16 } }).state;
    expect(s.turn.entries[1]).toEqual({ id: 't2', name: 'Goblin boss', initiative: 16 });
    s = run(s, 'gm', { type: 'turn.remove', id: 't1' }).state;
    expect(names(s)).toEqual(['Goblin boss', 'Bob']);
    expect(s.turn.current).toBe(1); // still Bob
    s = run(s, 'gm', { type: 'turn.remove', id: 't3' }).state;
    expect(s.turn.current).toBe(0); // Bob was last: back to the top
    refused(s, 'gm', { type: 'turn.remove', id: 't3' }, 'No turn entry "t3"');
    s = run(s, 'gm', { type: 'turn.next' }).state;
    s = run(s, 'gm', { type: 'turn.clear' }).state;
    expect(s.turn).toEqual({ entries: [], current: 0, round: 1, visible: true });
  });

  it('deleting a token drops its turn entry', () => {
    const s = withTurns();
    const out = run(s, 'gm', { type: 'token.delete', ids: ['k1'] });
    expect(names(out.state)).toEqual(['Goblin', 'Bob']);
    expect(out.events).toEqual([
      { type: 'token.remove', ids: ['k1'], pageId: 'pg1' },
      { type: 'turn', turn: out.state.turn },
    ]);
  });
});

describe('members', () => {
  it('removing a player strips them from every token', () => {
    const s = table();
    const out = run(s, 'gm', { type: 'member.remove', id: 'p1' });
    expect(out.state.members.map((m) => m.id)).toEqual(['gm', 'p2']);
    expect(out.state.tokens.filter((t) => t.controlledBy.includes('p1'))).toEqual([]);
    expect(out.events[0]).toEqual({ type: 'members', members: out.state.members });
    expect(out.events.slice(1).map((e) => (e.type === 'token.upsert' ? e.token.id : e.type))).toEqual(['k1', 'k3', 'k4', 'k5']);
    expect(tok(out.state, 'k6').controlledBy).toEqual(['all']);
  });

  it('renames and game renames emit members and game events', () => {
    const s = table();
    expect(run(s, 'gm', { type: 'member.rename', id: 'p2', name: ' Robert ' }).events).toEqual([
      { type: 'members', members: [s.members[0], s.members[1], { ...s.members[2], name: 'Robert' }] },
    ]);
    expect(run(s, 'gm', { type: 'game.rename', name: 'Crypt, part 2' }).events).toEqual([{ type: 'game', name: 'Crypt, part 2', playerPageId: 'pg1' }]);
  });
});

describe('applyIntent is pure', () => {
  const intents: [string, Intent][] = [
    ['gm', { type: 'token.create', token: { pageId: 'pg1', layer: 'gm', x: 1, y: 1, w: 2, h: 2, image: '/a.png', controlledBy: ['p1'], bars: [{ value: 1 }] } }],
    ['gm', { type: 'token.update', id: 'k1', set: { layer: 'gm', bars: [{ value: 2, max: 3 }], gmNotes: 'x' } }],
    ['p1', { type: 'token.move', id: 'k1', x: 9, y: 9 }],
    ['gm', { type: 'token.delete', ids: ['k1', 'k3'] }],
    ['gm', { type: 'page.create', page: { name: 'New', width: 10, height: 10, origin: [0, 0], cellPx: 70, cellUnit: '5 ft', showGrid: true, background: { kind: 'none' } } }],
    ['gm', { type: 'page.update', id: 'pg1', set: { walls: [[[0, 0], [1, 0]]], origin: [1, 1] } }],
    ['gm', { type: 'page.delete', id: 'pg1' }],
    ['gm', { type: 'page.view', id: 'pg2' }],
    ['gm', { type: 'page.activate', id: 'pg2' }],
    ['p2', { type: 'chat.send', text: '/r 4d6kh3' }],
    ['gm', { type: 'turn.add', entry: { tokenId: 'k2', name: 'Bob', initiative: 3 } }],
    ['gm', { type: 'turn.sort' }],
    ['gm', { type: 'turn.clear' }],
    ['gm', { type: 'turn.visible', visible: false }],
    ['gm', { type: 'member.remove', id: 'p1' }],
    ['p1', { type: 'member.rename', id: 'p1', name: 'Annie' }],
    ['gm', { type: 'game.rename', name: 'Renamed' }],
  ];
  for (const [who, intent] of intents) {
    it(`${intent.type} leaves the input alone and bumps rev`, () => {
      let s = table();
      s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 5 } }).state;
      s = run(s, 'gm', { type: 'turn.add', entry: { name: 'Orc', initiative: 7 } }).state;
      const snapshot = JSON.parse(JSON.stringify(s)) as GameState;
      frozen(s);
      const out = applyIntent(s, who, frozen(intent), ctx(1, 2, 3, 4));
      expect(s).toEqual(snapshot);
      expect(out.state).not.toBe(s);
      expect(out.state.rev).toBe(s.rev + 1);
    });
  }
});
