// The one filter: what each member may see. viewFor builds a member's whole view,
// eventFor and chatFor decide per member whether (and how) a change reaches them.
// Players never get gm-layer tokens, gmNotes, other pages, page walls, doors or
// lights, whispers not meant for them, GM roll results, a hidden turn order or
// the invite list. Nobody gets a member's accountId: it stays on the server.
// On a page with dynamic vision the server passes a TokenFilter (sight.ts):
// players then get only their own tokens and those the party sees.
import { TableError } from './errors.ts';
import type { ChatMessage, GameEvent, GameState, GameView, Member, Page, Token, TurnOrder } from './protocol.ts';
import { controlsToken, mayGetToken, type TokenFilter } from './sight.ts';

const member = (state: GameState, id: string): Member | undefined => state.members.find((m) => m.id === id);
const isGm = (m: Member | undefined): boolean => m?.role === 'gm';

/** The page a member looks at: the GM's own, or the players' page. */
export function pageFor(state: GameState, memberId: string): string {
  const page = isGm(member(state, memberId)) ? state.gmPageId : state.playerPageId;
  return state.pages.some((p) => p.id === page) ? page : (state.pages[0]?.id ?? page);
}

// Walls, doors and lights outline the whole map, unseen parts included, so players don't get them.
const GM_PAGE_FIELDS = ['walls', 'doors', 'doorState', 'lights'] as const;

export function pageForPlayer(p: Page): Page {
  // nor the Delve map's id: players draw the page through the game's members-only routes, and from
  // the home network the map's own API would hand them the whole map
  const mapId = p.background.kind === 'delve' && p.background.mapId !== '';
  if (!mapId && !GM_PAGE_FIELDS.some((k) => p[k] !== undefined)) return p;
  const rest = { ...p };
  for (const k of GM_PAGE_FIELDS) delete rest[k];
  if (mapId) rest.background = { kind: 'delve', mapId: '' };
  return rest;
}

/** A member as anyone may see them: without the account link. */
export function publicMember(m: Member): Member {
  if (m.accountId === undefined) return m;
  const { accountId: _, ...rest } = m;
  return rest;
}

/** A token as a player gets it: no GM notes, and the sight and light of their own tokens only. */
export function tokenForPlayer(t: Token, memberId: string): Token {
  const own = controlsToken(t, memberId);
  if (t.gmNotes === undefined && (own || (t.sight === undefined && t.light === undefined))) return t;
  const { gmNotes: _, ...rest } = t;
  if (!own) {
    delete rest.sight;
    delete rest.light;
  }
  return rest;
}

/** Turn order as a player sees it: tokens they may not see (gm layer, or unseen in dynamic vision) show as "Hidden", so indices still line up. */
function turnForPlayer(state: GameState, me: Member, filter?: TokenFilter | null): TurnOrder | null {
  const { turn } = state;
  if (!turn.visible) return null;
  const hidden = new Set(state.tokens.filter((t) => !mayGetToken(me, t, filter)).map((t) => t.id));
  if (!turn.entries.some((e) => e.tokenId !== undefined && hidden.has(e.tokenId))) return turn;
  return {
    ...turn,
    entries: turn.entries.map((e) => (e.tokenId !== undefined && hidden.has(e.tokenId) ? { id: e.id, name: 'Hidden', initiative: e.initiative } : e)),
  };
}

/** The member's whole view. `filter`: dynamic vision on their page (players get only the tokens it lets through). */
export function viewFor(state: GameState, memberId: string, filter?: TokenFilter | null): GameView {
  const me = member(state, memberId);
  if (!me) throw new TableError("You aren't in this game");
  const gm = isGm(me);
  const pageId = pageFor(state, memberId);
  const tokens = state.tokens.filter((t) => t.pageId === pageId && mayGetToken(me, t, filter));
  const view: GameView = {
    id: state.id,
    name: state.name,
    rev: state.rev,
    you: publicMember(me),
    members: state.members.map(publicMember),
    pages: gm ? state.pages : state.pages.filter((p) => p.id === pageId).map(pageForPlayer),
    playerPageId: state.playerPageId,
    pageId,
    tokens: gm ? tokens : tokens.map((t) => tokenForPlayer(t, memberId)),
    turn: gm ? state.turn : turnForPlayer(state, me, filter),
  };
  if (gm) view.invites = state.invites;
  if (gm && state.requireDiscord) view.requireDiscord = true;
  return view;
}

/**
 * One event as `memberId` should get it, or null. `state` is the state after the change.
 * Routing fields (prevLayer, pageId, hidden, wasPlayerPage, audience) never leave here.
 * With a `filter` (dynamic vision), an upsert of a token the player may not see
 * is dropped like a gm-layer one; whether they need a removal instead depends on
 * what their connection was sent before, which only the server's hub knows.
 */
export function eventFor(state: GameState, memberId: string, event: GameEvent, filter?: TokenFilter | null): GameEvent | null {
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
      if (!mayGetToken(me, token, filter)) return null;
      return { type: 'token.upsert', token: tokenForPlayer(token, memberId) };
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
      return { type: 'turn', turn: gm ? state.turn : turnForPlayer(state, me, filter) };
    case 'members':
      return { type: 'members', members: state.members.map(publicMember) };
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
