// Creating games and the changes the server makes outside of intents: members
// joining through an invite, and the invite list. All pure: they return a new state.
import { TableError } from './errors.ts';
import type { GameState, Invite, Member, Page } from './protocol.ts';

/** Member colours, readable on Delve's dark and light themes. The GM gets the first. */
export const PALETTE = [
  '#d4a017',
  '#e05252',
  '#4f8fe0',
  '#4caf50',
  '#b36ae2',
  '#f08c2e',
  '#26b3a6',
  '#e05ca8',
  '#9aa83a',
  '#7a86e8',
  '#c7773a',
  '#5fb0e8',
] as const;

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function defaultPage(id: string, name: string): Page {
  return {
    id,
    name,
    width: 30,
    height: 20,
    origin: [0, 0],
    cellPx: 70,
    cellUnit: '5 ft',
    showGrid: true,
    background: { kind: 'none' },
  };
}

// `now` is part of the API for a later "created" stamp; the state has no time field yet.
export function newGame(id: string, name: string, now: number): GameState {
  return {
    id,
    name: cleanText(name, 'Game name', 80),
    rev: 0,
    members: [{ id: 'gm', name: 'GM', role: 'gm', color: PALETTE[0] }],
    invites: [],
    pages: [defaultPage('pg1', 'Page 1')],
    playerPageId: 'pg1',
    gmPageId: 'pg1',
    tokens: [],
    turn: { entries: [], current: 0, round: 1, visible: true },
    nextPlayerNo: 1,
  };
}

/** Trim, collapse whitespace, drop control characters; 1..max characters or a TableError. */
export function cleanText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new TableError(`${what} must be text`);
  // Control and bidi-override characters could garble or disguise a name in chat.
  const text = value
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim();
  if (text.length < 1 || text.length > max) throw new TableError(`${what} must be 1 to ${max} characters`);
  return text;
}

/** A member name: 1..40 characters and not already taken (case doesn't count). "GM" stays the GM's, for /w gm. */
export function memberName(state: GameState, value: unknown, exceptId?: string): string {
  const name = cleanText(value, 'Name', 40);
  const lower = name.toLowerCase();
  const gmId = state.members.find((m) => m.role === 'gm')?.id;
  if ((lower === 'gm' && exceptId !== gmId) || state.members.some((m) => m.id !== exceptId && m.name.toLowerCase() === lower)) {
    throw new TableError(`The name "${name}" is taken`);
  }
  return name;
}

/** The highest n among ids "<prefix><n>", plus one. */
export function nextNumber(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function addMember(state: GameState, name: string): { state: GameState; member: Member } {
  const clean = memberName(state, name);
  // Never hand out an id twice: a removed player's cookie must not fit a newcomer.
  const n = Math.max(state.nextPlayerNo ?? 1, nextNumber(state.members.map((m) => m.id), 'p'));
  const used = new Set(state.members.map((m) => m.color));
  const players = PALETTE.slice(1);
  const color = players.find((c) => !used.has(c)) ?? players[(n - 1) % players.length] ?? PALETTE[0];
  const member: Member = { id: `p${n}`, name: clean, role: 'player', color };
  return {
    state: { ...state, rev: state.rev + 1, members: [...state.members, member], nextPlayerNo: n + 1 },
    member,
  };
}

export function addInvite(state: GameState, invite: Invite): GameState {
  if (typeof invite?.id !== 'string' || !ID_PATTERN.test(invite.id)) throw new TableError('Invite ids use letters, digits, _ and - (max 32)');
  if (state.invites.some((i) => i.id === invite.id)) throw new TableError(`Invite ${invite.id} already exists`);
  if (!Number.isFinite(invite.expires)) throw new TableError('Invite expiry must be a time');
  const clean: Invite = { id: invite.id, expires: invite.expires };
  if (invite.name !== undefined) clean.name = cleanText(invite.name, 'Invite name', 40);
  return { ...state, rev: state.rev + 1, invites: [...state.invites, clean] };
}

/** Remove an invite; an unknown id leaves the state as it is. */
export function removeInvite(state: GameState, id: string): GameState {
  if (!state.invites.some((i) => i.id === id)) return state;
  return { ...state, rev: state.rev + 1, invites: state.invites.filter((i) => i.id !== id) };
}
