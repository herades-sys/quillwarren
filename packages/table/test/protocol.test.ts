import { describe, expect, it } from 'vitest';
import { addInvite, addMember, applyIntent, newGame, PALETTE, removeInvite, TableError } from '../src/index.ts';
import { ctx, frozen } from './fixtures.ts';

describe('newGame', () => {
  it('starts with one page, the GM and an empty turn order', () => {
    expect(newGame('g1', ' Crypt night ', 123)).toEqual({
      id: 'g1',
      name: 'Crypt night',
      rev: 0,
      members: [{ id: 'gm', name: 'GM', role: 'gm', color: PALETTE[0] }],
      invites: [],
      pages: [
        {
          id: 'pg1',
          name: 'Page 1',
          width: 30,
          height: 20,
          origin: [0, 0],
          cellPx: 70,
          cellUnit: '5 ft',
          showGrid: true,
          background: { kind: 'none' },
        },
      ],
      playerPageId: 'pg1',
      gmPageId: 'pg1',
      tokens: [],
      turn: { entries: [], current: 0, round: 1, visible: true },
      nextPlayerNo: 1,
    });
  });
});

describe('addMember', () => {
  it('numbers players p1, p2… and never reuses an id', () => {
    let s = newGame('g1', 'x', 0);
    const a = addMember(s, 'Ann');
    expect(a.member).toEqual({ id: 'p1', name: 'Ann', role: 'player', color: PALETTE[1] });
    expect(a.state.rev).toBe(1);
    s = addMember(a.state, 'Bob').state;
    expect(s.members.map((m) => m.id)).toEqual(['gm', 'p1', 'p2']);
    s = applyIntent(s, 'gm', { type: 'member.remove', id: 'p2' }, ctx()).state;
    const c = addMember(s, 'Cleo');
    expect(c.member.id).toBe('p3');
    expect(c.member.color).toBe(PALETTE[2]); // the colour Bob left is free again
  });

  it('gives different colours until the palette runs out, then cycles', () => {
    let s = newGame('g1', 'x', 0);
    for (let i = 1; i <= PALETTE.length + 1; i++) s = addMember(s, `Player ${i}`).state;
    const colours = s.members.map((m) => m.color);
    expect(new Set(colours.slice(0, PALETTE.length)).size).toBe(PALETTE.length);
    expect(colours.every((c) => (PALETTE as readonly string[]).includes(c))).toBe(true);
  });

  it('cleans names and refuses empty, long, taken and "GM"', () => {
    const s = addMember(newGame('g1', 'x', 0), 'Ann').state;
    expect(addMember(s, '  Old \n Tom ').member.name).toBe('Old Tom');
    expect(addMember(s, 'Ev‮il\u0007').member.name).toBe('Evil');
    expect(() => addMember(s, '   ')).toThrow(new TableError('Name must be 1 to 40 characters'));
    expect(() => addMember(s, 'x'.repeat(41))).toThrow('Name must be 1 to 40 characters');
    expect(addMember(s, 'x'.repeat(40)).member.name).toHaveLength(40);
    expect(() => addMember(s, 'ANN')).toThrow('The name "ANN" is taken');
    expect(() => addMember(s, 'gm')).toThrow('The name "gm" is taken');
  });

  it('does not change its input', () => {
    const s = frozen(newGame('g1', 'x', 0));
    addMember(s, 'Ann');
    expect(s.members).toHaveLength(1);
  });
});

describe('invites', () => {
  it('adds and removes invites', () => {
    let s = newGame('g1', 'x', 0);
    s = addInvite(s, { id: 'inv1', name: 'for Ann', expires: 5000 });
    s = addInvite(s, { id: 'inv2', expires: 6000 });
    expect(s.invites).toEqual([
      { id: 'inv1', name: 'for Ann', expires: 5000 },
      { id: 'inv2', expires: 6000 },
    ]);
    expect(() => addInvite(s, { id: 'inv1', expires: 1 })).toThrow('Invite inv1 already exists');
    expect(() => addInvite(s, { id: 'bad id', expires: 1 })).toThrow(TableError);
    const rev = s.rev;
    s = removeInvite(s, 'inv1');
    expect(s.invites.map((i) => i.id)).toEqual(['inv2']);
    expect(s.rev).toBe(rev + 1);
    expect(removeInvite(s, 'nope')).toBe(s);
  });
});
