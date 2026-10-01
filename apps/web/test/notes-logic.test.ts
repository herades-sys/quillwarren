// The GM notes' pure helpers: the notebook list (search, order, merging what the
// server says), snippets and time stamps, tokens with notes, and the note pins.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DelveMap } from '@delve/core';
import type { NotebookEntry, Token } from '@delve/table';
import { filterEntries, insertStamp, mergeEntry, notedTokens, pinItems, removeEntry, snippet, stamp, whenText } from '../src/table/notes-logic.ts';

const entry = (id: string, title: string, text: string, updated: number): NotebookEntry => ({ id, title, text, created: 1, updated });
const tok = (id: string, over: Partial<Token> = {}): Token => ({ id, pageId: 'pg1', layer: 'tokens', x: 0, y: 0, w: 1, h: 1, image: '/x.svg', controlledBy: [], ...over });

describe('the notebook list', () => {
  const list = [entry('a', 'Session 1', 'Met Duke Varo at the inn', 10), entry('b', 'NPCs', 'Varo: wants the key\nMira: owes us', 30), entry('c', 'To do', 'Prep the crypt', 20)];

  it('searches titles and text for every word, newest change first', () => {
    expect(filterEntries(list, '').map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(filterEntries(list, 'varo').map((e) => e.id)).toEqual(['b', 'a']);
    expect(filterEntries(list, 'VARO key').map((e) => e.id)).toEqual(['b']);
    expect(filterEntries(list, 'crypt to').map((e) => e.id)).toEqual(['c']);
    expect(filterEntries(list, 'dragon')).toEqual([]);
  });

  it('takes newer copies, keeps newer ones, and drops deleted ones', () => {
    const newer = entry('a', 'Session 1', 'more', 40);
    expect(mergeEntry(list, newer).map((e) => [e.id, e.updated])).toEqual([['a', 40], ['b', 30], ['c', 20]]);
    expect(mergeEntry(mergeEntry(list, newer), entry('a', 'old', 'old', 15)).find((e) => e.id === 'a')?.text).toBe('more');
    expect(mergeEntry(list, entry('d', 'New', '', 5)).map((e) => e.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(removeEntry(list, 'b').map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('shows the first line with words, and when it changed', () => {
    expect(snippet('\n  \n  First real line  \nsecond')).toBe('First real line');
    expect(snippet('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    const now = new Date(2026, 9, 1, 21, 30).getTime();
    expect(whenText(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('09:05');
    expect(whenText(new Date(2026, 8, 28, 9, 5).getTime(), now)).toBe('28 Sep');
    expect(whenText(new Date(2025, 8, 28, 9, 5).getTime(), now)).toBe('28 Sep 2025');
  });

  it('puts a time stamp on a line of its own at the cursor', () => {
    expect(stamp(new Date(2026, 9, 1, 21, 4))).toBe('[Thu 1 Oct 21:04]');
    expect(insertStamp('', 0, 0, '[T]')).toEqual({ text: '[T] ', caret: 4 });
    expect(insertStamp('Rolled init', 11, 11, '[T]')).toEqual({ text: 'Rolled init\n[T] ', caret: 16 });
    expect(insertStamp('a\nb', 2, 2, '[T]')).toEqual({ text: 'a\n[T] b', caret: 6 });
    expect(insertStamp('abcdef', 2, 4, '[T]')).toEqual({ text: 'ab\n[T] ef', caret: 7 });
  });
});

describe('notes on characters', () => {
  it('lists tokens with notes (not blanks) by name', () => {
    const tokens = [tok('k1', { name: 'Zed', gmNotes: 'traitor' }), tok('k2', { name: 'Ann', gmNotes: '  ' }), tok('k3', { name: 'Bob', gmNotes: 'owes 5 gp', layer: 'gm' }), tok('k4')];
    expect(notedTokens(tokens).map((t) => t.id)).toEqual(['k3', 'k1']);
  });
});

describe('note pins', () => {
  const map = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as DelveMap;

  it('pins every room, corridor and terrain that has notes, rooms beside their number', () => {
    const c1 = map.objects.find((o) => o.id === 'c1')!;
    const noted = { ...map, objects: [...map.objects.filter((o) => o.id !== 'c1'), { ...c1, notes: 'oily' }] } as DelveMap;
    expect(pinItems(noted)).toEqual([
      { id: 'r5', at: [10, 6], title: '5 Boss chamber', beside: true },
      { id: 'c1', at: [10, 23], title: 'Corridor 1–2', beside: false },
    ]);
    expect(pinItems(null)).toEqual([]);
  });
});
