// The one filter: what each member may see. viewFor builds a member's whole view,
// eventFor and chatFor decide per member whether (and how) a change reaches them.
// Players never get gm-layer tokens, gmNotes, other pages, page walls, whispers
// not meant for them, GM roll results, a hidden turn order or the invite list.
import { TableError } from './errors.ts';
import type { ChatMessage, GameEvent, GameState, GameView, Member, Page, Token, TurnOrder } from './protocol.ts';

const member = (state: GameState, id: string): Member | undefined => state.members.find((m) => m.id === id);
const isGm = (m: Member | undefined): boolean => m?.role === 'gm';

/** The page a member looks at: the GM's own, or the players' page. */
export function pageFor(state: GameState, memberId: string): string {
  const page = isGm(member(state, memberId)) ? state.gmPageId : state.playerPageId;
  return state.pages.some((p) => p.id === page) ? page : (state.pages[0]?.id ?? page);
}

// Walls outline the whole map, fogged parts included; phase 1 doesn't draw them, so players don't get them.
function pageForPlayer(p: Page): Page {
  if (p.walls === undefined) return p;
  const { walls: _, ...rest } = p;
  return rest;
}

function tokenForPlayer(t: Token): Token {
  if (t.gmNotes === undefined) return t;
  const { gmNotes: _, ...rest } = t;
  return rest;
}

/** Turn order as a player sees it: gm-layer tokens show as "Hidden", so indices still line up. */
function turnForPlayer(state: GameState): TurnOrder | null {
  const { turn } = state;
  if (!turn.visible) return null;
  const hidden = new Set(state.tokens.filter((t) => t.layer === 'gm').map((t) => t.id));
  if (!turn.entries.some((e) => e.tokenId !== undefined && hidden.has(e.tokenId))) return turn;
  return {
    ...turn,
    entries: turn.entries.map((e) => (e.tokenId !== undefined && hidden.has(e.tokenId) ? { id: e.id, name: 'Hidden', initiative: e.initiative } : e)),
  };
}

export function viewFor(state: GameState, memberId: string): GameView {
  const me = member(state, memberId);
  if (!me) throw new TableError("You aren't in this game");
  const gm = isGm(me);
  const pageId = pageFor(state, memberId);
  const tokens = state.tokens.filter((t) => t.pageId === pageId && (gm || t.layer !== 'gm'));
  const view: GameView = {
    id: state.id,
    name: state.name,
    rev: state.rev,
    you: me,
    members: state.members,
    pages: gm ? state.pages : state.pages.filter((p) => p.id === pageId).map(pageForPlayer),
    playerPageId: state.playerPageId,
    pageId,
    tokens: gm ? tokens : tokens.map(tokenForPlayer),
    turn: gm ? state.turn : turnForPlayer(state),
  };
  if (gm) view.invites = state.invites;
  return view;
}

/**
 * One event as `memberId` should get it, or null. `state` is the state after the change.
 * Routing fields (prevLayer, pageId, hidden, wasPlayerPage, audience) never leave here.
 */
export function eventFor(state: GameState, memberId: string, event: GameEvent): GameEvent | null {
  const me = member(state, memberId);
  if (!me) return null;
  const gm = isGm(me);
  const pageId = pageFor(state, memberId);
  switch (event.type) {
    case 'token.upsert': {
      const { token } = event;
      if (token.pageId !== pageId) return null;
      if (gm) return { type: 'token.upsert', token };
      if (token.layer === 'gm') {
        // Moved to the gm layer: players drop it. Already there, or new: they never had it.
        return event.prevLayer === undefined || event.prevLayer === 'gm' ? null : { type: 'token.remove', ids: [token.id] };
      }
      return { type: 'token.upsert', token: tokenForPlayer(token) };
    }
    case 'token.remove': {
      if (event.pageId !== undefined && event.pageId !== pageId) return null;
      if (event.hidden && !gm) return null;
      return { type: 'token.remove', ids: event.ids };
    }
    case 'page.upsert':
      if (gm) return event;
      return event.page.id === pageId ? { type: 'page.upsert', page: pageForPlayer(event.page) } : null;
    case 'page.remove':
      return gm || event.wasPlayerPage || event.id === pageId ? { type: 'page.remove', id: event.id } : null;
    case 'page.switch': {
      const audience = event.audience ?? (event.pageId === pageId ? (gm ? 'gm' : 'players') : undefined);
      if (audience !== (gm ? 'gm' : 'players')) return null;
      return { type: 'page.switch', pageId: event.pageId };
    }
    case 'chat': {
      const message = chatFor(state, memberId, event.message);
      return message ? { type: 'chat', message } : null;
    }
    case 'turn':
      return { type: 'turn', turn: gm ? state.turn : turnForPlayer(state) };
    case 'members':
      return { type: 'members', members: state.members };
    case 'game':
      return { type: 'game', name: state.name, playerPageId: state.playerPageId };
  }
}

/** A chat message as `memberId` should get it, or null. */
export function chatFor(state: GameState, memberId: string, message: ChatMessage): ChatMessage | null {
  const me = member(state, memberId);
  if (!me) return null;
  const gm = isGm(me);
  const to = message.to ?? [];
  switch (message.kind) {
    case 'whisper':
      return gm || message.from === memberId || to.includes(memberId) ? message : null;
    case 'gmroll': {
      if (gm) return message;
      if (message.from !== memberId) return null;
      const { rolls: _, ...rest } = message;
      return { ...rest, text: `rolled ${message.text} secretly`, hiddenResult: true };
    }
    case 'system':
      return message.to === undefined || to.includes(memberId) ? message : null;
    default:
      return message;
  }
}
