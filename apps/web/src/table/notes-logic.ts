// Pure helpers for the GM's notes (no DOM): the notebook list (search, order,
// merging what the server says), snippets and time stamps, and which tokens have
// notes. Used by notes-panel.ts on the 2D and 3D tables.
import { areaTitle, hasNotes, noteAnchor, notedAreas, type DelveMap, type Point } from '@delve/core';
import type { NotebookEntry, Token } from '@delve/table';

/** Newest change first; ties by title. */
export const byUpdated = (a: NotebookEntry, b: NotebookEntry): number => b.updated - a.updated || a.title.localeCompare(b.title);

/** Entries whose title or text has every word of the query (any case), newest change first. */
export function filterEntries(entries: readonly NotebookEntry[], query: string): NotebookEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (e: NotebookEntry) => {
    const hay = `${e.title}\n${e.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return entries.filter(hit).sort(byUpdated);
}

/** Put a saved entry into the list (replacing an older copy; an older copy never replaces a newer one). */
export function mergeEntry(entries: readonly NotebookEntry[], entry: NotebookEntry): NotebookEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i < 0) return [...entries, entry].sort(byUpdated);
  if (entries[i]!.updated > entry.updated) return [...entries];
  const next = [...entries];
  next[i] = entry;
  return next.sort(byUpdated);
}

export const removeEntry = (entries: readonly NotebookEntry[], id: string): NotebookEntry[] => entries.filter((e) => e.id !== id);

/** The first line with something on it, cut to `max` characters. */
export function snippet(text: string, max = 90): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A session log's time stamp, in local time: "[Thu 1 Oct 21:04]". */
export const stamp = (d: Date): string => `[${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}]`;

/** When an entry last changed: the time today, else the date (and the year when it isn't this one). */
export function whenText(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

/**
 * Insert `add` in place of text[start, end), on a line of its own start (a line
 * break first unless the caret already starts a line). Returns the text and where
 * the caret goes (after the insert).
 */
export function insertStamp(text: string, start: number, end: number, add: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const piece = `${lead}${add} `;
  return { text: before + piece + text.slice(end), caret: start + piece.length };
}

/** Tokens with GM notes (not just blanks), by name. */
export const notedTokens = (tokens: readonly Token[]): Token[] =>
  tokens.filter((t) => t.gmNotes?.trim()).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));

/** A token's name for lists. */
export const tokenName = (t: Token): string => t.name?.trim() || 'Unnamed';

/** A note pin: an area with notes, where it is, and its name. */
export interface PinItem {
  id: string;
  at: Point;
  title: string;
  /** Sits beside the room number (rooms) rather than on the spot itself. */
  beside: boolean;
}

/** The pins for a map: every room, corridor and terrain area with notes. */
export function pinItems(map: DelveMap | null): PinItem[] {
  if (!map) return [];
  return notedAreas(map).flatMap((o) => {
    const at = noteAnchor(map, o);
    return at && hasNotes(o) ? [{ id: o.id, at, title: areaTitle(map, o), beside: o.type === 'room' && Boolean(o.label) }] : [];
  });
}
