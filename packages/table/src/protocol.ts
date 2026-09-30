// Delve Table: the game state and every message between client and server.
// This file is the contract between packages/table, apps/server/src/table and
// apps/web/src/table (see docs/TABLE.md). Add optional fields freely; rename or
// remove only together with all three.

export type Role = 'gm' | 'player';
export type Layer = 'map' | 'tokens' | 'gm';

export interface Member {
  /** "gm" for the GM, "p1", "p2"… for players. */
  id: string;
  name: string;
  role: Role;
  /** A CSS colour for their pings, chat name and selection. */
  color: string;
  /** Server only: the Discord-linked account ("acc_…") this seat belongs to. viewFor and eventFor never send it. */
  accountId?: string;
  /** The member's picture (their Discord avatar, stored as a game asset URL). */
  avatar?: string;
}

export interface Bar {
  value: number;
  max?: number;
}

export interface Token {
  id: string;
  pageId: string;
  layer: Layer;
  /** Top-left corner in cells, page coordinates (the Delve map's own grid for Delve pages). */
  x: number;
  y: number;
  /** Size in cells. */
  w: number;
  h: number;
  /** Degrees clockwise. */
  rotation?: number;
  name?: string;
  showName?: boolean;
  /** An image URL: an uploaded asset (/api/v1/games/:id/assets/…) or a Delve prop (/assets/props/<id>.svg). */
  image: string;
  /** Member ids, or "all". Empty: only the GM. */
  controlledBy: string[];
  /** Up to three bars, e.g. hit points. */
  bars?: Bar[];
  /** Never sent to players. */
  gmNotes?: string;
}

export type Background = { kind: 'delve'; mapId: string } | { kind: 'image'; url: string; w: number; h: number } | { kind: 'none' };

export interface Page {
  id: string;
  name: string;
  /** Size in cells, and the cell at the top-left of the background (Delve render bounds). */
  width: number;
  height: number;
  origin: [number, number];
  /** Pixels per cell the background is drawn at (Delve renders at 70). */
  cellPx: number;
  /** The label on the grid, e.g. "5 ft". */
  cellUnit: string;
  showGrid: boolean;
  background: Background;
  /** Wall segments in cells, from the Delve map (for phase 3 lighting; not drawn or enforced yet). GM only: never sent to players. */
  walls?: [[number, number], [number, number]][];
}

export interface TurnEntry {
  id: string;
  tokenId?: string;
  name: string;
  initiative: number;
}

export interface TurnOrder {
  entries: TurnEntry[];
  /** Index of the entry whose turn it is. */
  current: number;
  round: number;
  /** Hidden from players while the GM sets it up. */
  visible: boolean;
}

export interface Invite {
  id: string;
  name?: string;
  expires: number;
}

/** Everything about one game. The server keeps it whole; members only ever see viewFor(). */
export interface GameState {
  id: string;
  name: string;
  rev: number;
  members: Member[];
  invites: Invite[];
  pages: Page[];
  /** The page players are on (the "player banner"). */
  playerPageId: string;
  /** The page the GM is looking at. */
  gmPageId: string;
  tokens: Token[];
  turn: TurnOrder;
  /** The number of the next player id ("p<n>"). Kept so a removed player's id is never given out again. */
  nextPlayerNo?: number;
  /** Invites only work with a Discord login (when the server has Discord login set up). */
  requireDiscord?: boolean;
}

// ---------- dice ----------

/** One die as rolled. Only dice without `dropped` count towards the term's value. */
export interface Die {
  value: number;
  /** Not counted: removed by kh/kl/dh/dl, or replaced by a reroll. */
  dropped?: boolean;
  /** This die exploded: the die after it in `dice` is its extra roll. */
  exploded?: boolean;
  /** This roll was rerolled (the next die replaces it); it is also `dropped`. */
  rerolled?: boolean;
  success?: boolean;
  failure?: boolean;
}

export type RollTerm =
  | { kind: 'dice'; text: string; count: number; sides: number | 'F'; dice: Die[]; value: number }
  | { kind: 'number'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' };

export interface RollResult {
  expr: string;
  total: number;
  terms: RollTerm[];
}

// ---------- chat ----------

export type ChatKind = 'chat' | 'emote' | 'ooc' | 'desc' | 'roll' | 'whisper' | 'gmroll' | 'system';

export interface ChatMessage {
  id: string;
  seq: number;
  at: number;
  /** Member id of the sender ("system" for server notes). */
  from: string;
  /** The name shown: the member's, or who the GM speaks as (/as). */
  speaker: string;
  kind: ChatKind;
  /** The text, with inline rolls replaced by {{roll:N}} markers that point into `rolls`. */
  text: string;
  rolls?: RollResult[];
  /** Whisper recipients (member ids). GM rolls go to the GM and the roller. */
  to?: string[];
  /** Set when a filtered copy hides a GM roll's result from its roller. */
  hiddenResult?: boolean;
}

// ---------- client → server ----------

export type Intent =
  | { type: 'token.create'; token: Omit<Token, 'id'> & { id?: string } }
  | { type: 'token.update'; id: string; set: Partial<Omit<Token, 'id' | 'pageId'>> }
  | { type: 'token.move'; id: string; x: number; y: number }
  | { type: 'token.delete'; ids: string[] }
  | { type: 'page.create'; page: Omit<Page, 'id'> & { id?: string } }
  | { type: 'page.update'; id: string; set: Partial<Omit<Page, 'id'>> }
  | { type: 'page.delete'; id: string }
  /** GM: look at a page yourself. */
  | { type: 'page.view'; id: string }
  /** GM: move the players to a page. */
  | { type: 'page.activate'; id: string }
  | { type: 'chat.send'; text: string }
  | { type: 'turn.add'; entry: Omit<TurnEntry, 'id'> & { id?: string } }
  | { type: 'turn.update'; id: string; set: Partial<Omit<TurnEntry, 'id'>> }
  | { type: 'turn.remove'; id: string }
  | { type: 'turn.sort' }
  | { type: 'turn.next' }
  | { type: 'turn.clear' }
  | { type: 'turn.visible'; visible: boolean }
  | { type: 'member.remove'; id: string }
  | { type: 'member.rename'; id: string; name: string }
  | { type: 'game.rename'; name: string };

export type ClientMessage =
  | { type: 'intent'; ref: number; intent: Intent }
  | { type: 'ping'; pageId: string; x: number; y: number }
  | { type: 'keepalive' };

// ---------- server → client ----------

/** What one member is allowed to know right now (see viewFor). */
export interface GameView {
  id: string;
  name: string;
  rev: number;
  you: Member;
  members: Member[];
  /** Players: only their current page. The GM: all pages. */
  pages: Page[];
  playerPageId: string;
  /** The page this member is looking at. */
  pageId: string;
  /** Tokens on `pageId` that this member may see. */
  tokens: Token[];
  /** Players get null while the GM keeps it hidden. */
  turn: TurnOrder | null;
  /** GM only. */
  invites?: Invite[];
  /** GM only: invites need a Discord login. */
  requireDiscord?: boolean;
}

/** A state change, already filtered for its recipient. */
// The fields marked "routing" are set by applyIntent so that eventFor can
// filter events whose subject is already gone; eventFor strips them, so a
// client never sees them.
export type GameEvent =
  /** routing: prevLayer is the token's layer before the change; applyIntent leaves it out only for a new token. */
  | { type: 'token.upsert'; token: Token; prevLayer?: Layer }
  /** routing: pageId is the page the tokens were on; hidden means they were on the gm layer. */
  | { type: 'token.remove'; ids: string[]; pageId?: string; hidden?: boolean }
  | { type: 'page.upsert'; page: Page }
  /** routing: wasPlayerPage means the players were on this page. */
  | { type: 'page.remove'; id: string; wasPlayerPage?: boolean }
  /** This member now looks at another page: a fresh view follows as `hello`. routing: audience says whose page changed. */
  | { type: 'page.switch'; pageId: string; audience?: 'players' | 'gm' }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'turn'; turn: TurnOrder | null }
  | { type: 'members'; members: Member[] }
  /** playerPageId: the page the players are on, so the GM's "player banner" follows page.activate. */
  | { type: 'game'; name: string; playerPageId?: string };

export type ServerMessage =
  | { type: 'hello'; view: GameView; chat: ChatMessage[] }
  | { type: 'events'; rev: number; events: GameEvent[] }
  | { type: 'ack'; ref: number; rev: number }
  | { type: 'error'; ref?: number; error: string }
  | { type: 'ping'; from: string; color: string; pageId: string; x: number; y: number }
  /** You were removed from the game, or it was deleted. */
  | { type: 'bye'; reason: string };
