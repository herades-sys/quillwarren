import { describe, expect, it } from 'vitest';
import { addInvite, eventFor, pageFor, viewFor, type GameEvent, type GameState, type Intent } from '../src/index.ts';
import { run, table } from './fixtures.ts';

const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id);

/** Run a GM intent and deliver its events to `member`. */
function deliver(s: GameState, intent: Intent, member: string, who = 'gm'): { state: GameState; got: (GameEvent | null)[] } {
  const out = run(s, who, intent);
  return { state: out.state, got: out.events.map((e) => eventFor(out.state, member, e)) };
}

describe('viewFor', () => {
  it('shows a player their page, the tokens they may see and no GM notes', () => {
    const s = addInvite(table(), { id: 'i1', expires: 99 });
    const v = viewFor(s, 'p1');
    expect(v.you).toMatchObject({ id: 'p1', name: 'Ann', role: 'player' });
    expect(v).toMatchObject({ id: 'g1', name: 'Crypt night', rev: s.rev, pageId: 'pg1', playerPageId: 'pg1' });
    expect(ids(v.pages)).toEqual(['pg1']);
    expect(ids(v.tokens)).toEqual(['k1', 'k2', 'k5', 'k6']);
    expect(v.tokens.some((t) => 'gmNotes' in t)).toBe(false);
    expect(v.invites).toBeUndefined();
    expect(v.members).toHaveLength(3);
    expect(JSON.stringify(v)).not.toMatch(/Lurker|ambush|cursed|i1/);
  });

  it('shows the GM everything on the page they look at, plus pages and invites', () => {
    let s = addInvite(table(), { id: 'i1', name: 'for Cleo', expires: 99 });
    let v = viewFor(s, 'gm');
    expect(ids(v.pages)).toEqual(['pg1', 'pg2']);
    expect(ids(v.tokens)).toEqual(['k1', 'k2', 'k3', 'k5', 'k6']);
    expect(v.tokens.find((t) => t.id === 'k3')?.gmNotes).toBe('ambush in round 2');
    expect(v.invites).toEqual([{ id: 'i1', name: 'for Cleo', expires: 99 }]);
    s = run(s, 'gm', { type: 'page.view', id: 'pg2' }).state;
    v = viewFor(s, 'gm');
    expect(v.pageId).toBe('pg2');
    expect(ids(v.tokens)).toEqual(['k4']);
    expect(pageFor(s, 'gm')).toBe('pg2');
    expect(pageFor(s, 'p1')).toBe('pg1');
  });

  it('hides the turn order while it is hidden, and gm-layer entries always', () => {
    let s = table();
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k3', name: 'Lurker', initiative: 20 } }).state;
    s = run(s, 'gm', { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 10 } }).state;
    expect(viewFor(s, 'p1').turn?.entries).toEqual([
      { id: 't1', name: 'Hidden', initiative: 20 },
      { id: 't2', tokenId: 'k1', name: 'Ann', initiative: 10 },
    ]);
    expect(viewFor(s, 'gm').turn?.entries[0]?.name).toBe('Lurker');
    s = run(s, 'gm', { type: 'turn.visible', visible: false }).state;
    expect(viewFor(s, 'p1').turn).toBeNull();
    expect(viewFor(s, 'gm').turn?.visible).toBe(false);
  });

  it('keeps page walls for the GM', () => {
    const walls: [[number, number], [number, number]][] = [[[0, 0], [5, 0]], [[5, 0], [5, 5]]];
    const out = run(table(), 'gm', { type: 'page.update', id: 'pg1', set: { walls } });
    expect(viewFor(out.state, 'gm').pages[0]?.walls).toEqual(walls);
    expect(viewFor(out.state, 'p1').pages[0]).not.toHaveProperty('walls');
    expect(viewFor(out.state, 'p1').pages[0]?.name).toBe('Page 1');
    const [e] = out.events;
    expect(eventFor(out.state, 'gm', e!)).toMatchObject({ type: 'page.upsert', page: { walls } });
    const mine = eventFor(out.state, 'p1', e!);
    expect(mine).toMatchObject({ type: 'page.upsert', page: { id: 'pg1' } });
    expect(mine && mine.type === 'page.upsert' && 'walls' in mine.page).toBe(false);
  });

  it('refuses strangers', () => {
    expect(() => viewFor(table(), 'p9')).toThrow("You aren't in this game");
  });
});

describe('eventFor: tokens', () => {
  it('never sends gm-layer tokens to players', () => {
    const s = table();
    const move = { type: 'token.move', id: 'k3', x: 5, y: 5 } as const;
    expect(deliver(s, move, 'p1').got).toEqual([null]);
    const gm = deliver(s, move, 'gm').got[0];
    expect(gm).toMatchObject({ type: 'token.upsert', token: { id: 'k3', gmNotes: 'ambush in round 2' } });
    expect(gm).not.toHaveProperty('prevLayer');
    const create: Intent = { type: 'token.create', token: { pageId: 'pg1', layer: 'gm', x: 0, y: 0, w: 1, h: 1, image: '/trap.png', controlledBy: [] } };
    expect(deliver(s, create, 'p1').got).toEqual([null]);
    expect(deliver(s, create, 'gm').got[0]).toMatchObject({ type: 'token.upsert', token: { image: '/trap.png' } });
  });

  it('turns a token moved to the gm layer into token.remove for players', () => {
    const s = table();
    const hide = { type: 'token.update', id: 'k1', set: { layer: 'gm' } } as const;
    expect(deliver(s, hide, 'p1').got).toEqual([{ type: 'token.remove', ids: ['k1'] }]);
    expect(deliver(s, hide, 'p2').got).toEqual([{ type: 'token.remove', ids: ['k1'] }]);
    expect(deliver(s, hide, 'gm').got[0]).toMatchObject({ type: 'token.upsert', token: { id: 'k1', layer: 'gm' } });
  });

  it('brings a token back from the gm layer without its notes', () => {
    const s = table();
    const [got] = deliver(s, { type: 'token.update', id: 'k3', set: { layer: 'tokens' } }, 'p2').got;
    expect(got).toEqual({ type: 'token.upsert', token: expect.objectContaining({ id: 'k3', layer: 'tokens' }) });
    expect(got && got.type === 'token.upsert' && 'gmNotes' in got.token).toBe(false);
  });

  it('strips gmNotes from visible tokens', () => {
    const s = table();
    const [got] = deliver(s, { type: 'token.update', id: 'k6', set: { gmNotes: 'the axle is very cursed' } }, 'p1').got;
    expect(got).toMatchObject({ type: 'token.upsert', token: { id: 'k6' } });
    expect(JSON.stringify(got)).not.toContain('cursed');
  });

  it('only sends tokens on the page the member looks at', () => {
    const s = table();
    const move = { type: 'token.move', id: 'k4', x: 1, y: 1 } as const;
    expect(deliver(s, move, 'p1').got).toEqual([null]);
    expect(deliver(s, move, 'gm').got).toEqual([null]); // the GM looks at pg1
    const onPg2 = run(s, 'gm', { type: 'page.view', id: 'pg2' }).state;
    expect(deliver(onPg2, move, 'gm').got[0]).toMatchObject({ type: 'token.upsert' });
  });

  it('routes token.remove by page and layer', () => {
    const s = table();
    const del: Intent = { type: 'token.delete', ids: ['k1', 'k3', 'k4'] };
    expect(deliver(s, del, 'p1').got).toEqual([{ type: 'token.remove', ids: ['k1'] }, null, null]);
    expect(deliver(s, del, 'gm').got).toEqual([{ type: 'token.remove', ids: ['k1'] }, { type: 'token.remove', ids: ['k3'] }, null]);
  });
});

describe('eventFor: pages', () => {
  it('page.activate switches the players, and tells the GM where they went', () => {
    const s = table();
    const act = { type: 'page.activate', id: 'pg2' } as const;
    expect(deliver(s, act, 'p1').got).toEqual([
      { type: 'page.switch', pageId: 'pg2' },
      { type: 'game', name: 'Crypt night', playerPageId: 'pg2' },
    ]);
    expect(deliver(s, act, 'gm').got).toEqual([null, { type: 'game', name: 'Crypt night', playerPageId: 'pg2' }]);
  });

  it('page.view switches only the GM', () => {
    const s = table();
    const view = { type: 'page.view', id: 'pg2' } as const;
    expect(deliver(s, view, 'gm').got).toEqual([{ type: 'page.switch', pageId: 'pg2' }]);
    expect(deliver(s, view, 'p1').got).toEqual([null]);
    // even when the GM goes to the players' page, the players stay put
    const away = run(s, 'gm', { type: 'page.view', id: 'pg2' }).state;
    expect(deliver(away, { type: 'page.view', id: 'pg1' }, 'p1').got).toEqual([null]);
  });

  it('page changes reach players only for their page', () => {
    const s = table();
    const other = { type: 'page.update', id: 'pg2', set: { name: 'Deep caves' } } as const;
    expect(deliver(s, other, 'p1').got).toEqual([null]);
    expect(deliver(s, other, 'gm').got[0]).toMatchObject({ type: 'page.upsert', page: { id: 'pg2', name: 'Deep caves' } });
    const mine = { type: 'page.update', id: 'pg1', set: { showGrid: false } } as const;
    expect(deliver(s, mine, 'p1').got[0]).toMatchObject({ type: 'page.upsert', page: { id: 'pg1', showGrid: false } });
    expect(deliver(s, { type: 'page.create', page: { name: 'Secret lair' } as never }, 'p1').got).toEqual([null]);
    expect(deliver(s, { type: 'page.delete', id: 'pg2' }, 'p1').got).toEqual([null]);
  });

  it('deleting the players page removes it for them and moves them', () => {
    const s = table();
    expect(deliver(s, { type: 'page.delete', id: 'pg1' }, 'p1').got).toEqual([
      { type: 'page.remove', id: 'pg1' },
      { type: 'page.switch', pageId: 'pg2' },
      { type: 'game', name: 'Crypt night', playerPageId: 'pg2' },
      null,
    ]);
    expect(deliver(s, { type: 'page.delete', id: 'pg1' }, 'gm').got).toEqual([
      { type: 'page.remove', id: 'pg1' },
      null,
      { type: 'game', name: 'Crypt night', playerPageId: 'pg2' },
      { type: 'page.switch', pageId: 'pg2' },
    ]);
  });
});

describe('eventFor: turn, members, game', () => {
  it('players get a null turn while it is hidden', () => {
    let s = table();
    s = run(s, 'gm', { type: 'turn.add', entry: { name: 'Orc', initiative: 3 } }).state;
    const hide = deliver(s, { type: 'turn.visible', visible: false }, 'p1');
    expect(hide.got).toEqual([{ type: 'turn', turn: null }]);
    expect(deliver(hide.state, { type: 'turn.next' }, 'p1').got).toEqual([{ type: 'turn', turn: null }]);
    expect(deliver(hide.state, { type: 'turn.next' }, 'gm').got[0]).toMatchObject({ type: 'turn', turn: { visible: false, current: 0, round: 2 } });
    const show = deliver(hide.state, { type: 'turn.visible', visible: true }, 'p1');
    expect(show.got[0]).toMatchObject({ type: 'turn', turn: { entries: [{ name: 'Orc' }] } });
  });

  it('members and game events reach everyone', () => {
    const s = table();
    const rm = deliver(s, { type: 'member.remove', id: 'p2' }, 'p1');
    expect(rm.got[0]).toEqual({ type: 'members', members: rm.state.members });
    expect(deliver(s, { type: 'game.rename', name: 'Tomb' }, 'p2').got).toEqual([{ type: 'game', name: 'Tomb', playerPageId: 'pg1' }]);
    // the removed member gets nothing more
    expect(eventFor(rm.state, 'p2', { type: 'members', members: rm.state.members })).toBeNull();
  });
});

describe('no leaks', () => {
  it('nothing a player receives mentions gm-layer tokens or GM notes', () => {
    let s = table();
    const secret = /Lurker|ambush|cursed|dragon|k3|k9/;
    const gmIntents: Intent[] = [
      { type: 'token.move', id: 'k3', x: 3, y: 3 },
      { type: 'token.update', id: 'k3', set: { name: 'Lurker king', gmNotes: 'ambush now' } },
      { type: 'token.create', token: { id: 'k9', pageId: 'pg1', layer: 'gm', x: 1, y: 1, w: 3, h: 3, image: '/dragon.png', controlledBy: [], name: 'dragon' } },
      { type: 'token.update', id: 'k6', set: { gmNotes: 'still cursed' } },
      { type: 'token.update', id: 'k1', set: { gmNotes: 'cursed too', name: 'Ann' } },
      { type: 'turn.add', entry: { tokenId: 'k9', name: 'dragon', initiative: 25 } },
      { type: 'turn.add', entry: { tokenId: 'k1', name: 'Ann', initiative: 12 } },
      { type: 'turn.sort' },
      { type: 'turn.next' },
      { type: 'token.delete', ids: ['k3'] },
      { type: 'page.update', id: 'pg1', set: { name: 'Crypt' } },
    ];
    for (const intent of gmIntents) {
      const out = run(s, 'gm', intent);
      s = out.state;
      for (const p of ['p1', 'p2']) {
        for (const e of out.events) expect(JSON.stringify(eventFor(s, p, e) ?? null)).not.toMatch(secret);
        expect(JSON.stringify(viewFor(s, p))).not.toMatch(secret);
      }
    }
  });
});
