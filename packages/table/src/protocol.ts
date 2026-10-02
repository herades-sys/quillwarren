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
  /** Light it gives off (a torch, a glowing sword), centred on the token. GM only to change. */
  light?: TokenLight;
  /** What it sees in dynamic vision. Player-controlled tokens see by default. GM only to change; players get it for their own tokens only. */
  sight?: Sight;
}

/** Light in cells: bright out to `bright`, then dim for `dim` cells more (a torch: 4 and 4). */
export interface TokenLight {
  bright: number;
  dim: number;
}

export interface Sight {
  /** Unset: tokens a player controls see, others don't. */
  enabled?: boolean;
  /** How far it sees in cells; unset: as far as walls (and light) allow. */
  range?: number;
  /** Sees without light out to this many cells. */
  darkvision?: number;
}

// ---------- vision (docs/TABLE.md, "Vision and light") ----------

export type VisionMode = 'off' | 'dynamic';
/** bright: everything is lit; dim: lit but dimmed; dark: only lights and darkvision show anything. */
export type Ambient = 'dark' | 'dim' | 'bright';

/** off (the default): the Delve map's own room fog, as before. dynamic: line of sight decides. */
export interface PageVision {
  mode: VisionMode;
  /** Default: dark. */
  ambient?: Ambient;
}

/** One door of the Delve map behind a page, as a sight blocker. GM only: never sent to players. */
export interface PageDoor {
  id: string;
  a: [number, number];
  b: [number, number];
  /** The map's door style (normal, double, locked, secret, portcullis, archway). */
  style: string;
  /** Open on the map; the table's own state (page.doorState) wins. */
  open?: boolean;
}

/** A light from the Delve map (a torch sconce, a brazier…), in cells. GM only: never sent to players. */
export interface PageLight {
  /** The prop's id on the map. */
  id: string;
  x: number;
  y: number;
  bright: number;
  dim: number;
  /** The prop's asset, for the GM's overlay. */
  asset?: string;
}

/** A polygon in cells with holes, the shape of @delve/core's Polygon. */
export interface VisionPolygon {
  outer: [number, number][];
  holes: [number, number][][];
}

/** What a member gets about dynamic vision on the page they look at. */
export interface VisionView {
  pageId: string;
  /** What the party sees right now, walls at its edge included. */
  visible: VisionPolygon[];
  /** The part of `visible` in bright light (the rest is dim: dim light or darkvision). */
  bright: VisionPolygon[];
  /** Everything the party has seen on this page so far, or "all" (the GM revealed it). Left out when it hasn't changed since the last vision message. */
  explored?: VisionPolygon[] | 'all';
  /** Grows by one whenever `explored` changes; the page picture follows it. */
  exploredVersion: number;
  ambient: Ambient;
  /** GM only: the tokens the party sees right now (for "see as players"). */
  seen?: string[];
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
  /** Wall segments in cells, from the Delve map, secret doors shut (they block sight in dynamic vision). GM only: never sent to players. */
  walls?: [[number, number], [number, number]][];
  /** Dynamic vision (line of sight, light, explored fog). Unset: off. */
  vision?: PageVision;
  /** The Delve map's doors (they follow the map). GM only. */
  doors?: PageDoor[];
  /** The table's door state, by door id: true open, false shut. Wins over the map's. GM only. */
  doorState?: Record<string, boolean>;
  /** Lights from the Delve map's props (they follow the map). GM only. */
  lights?: PageLight[];
  /** The Delve map's cliff edges that no stairs or ladder cross (core blockingEdges; they follow the map). GM only. */
  cliffs?: PageCliff[];
  /** Respect heights: a player's move can't cross a cliff edge without stairs or a ladder, nor a wall or a shut door (movement.ts). Unset: off. */
  respectHeights?: boolean;
}

/** A cliff edge of a page's Delve map, in cells; `drop` is the height difference in the map's units (10 for a 10 ft ledge). GM only. */
export interface PageCliff {
  a: [number, number];
  b: [number, number];
  drop: number;
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

// ---------- the GM's notes (docs/TABLE.md, "GM notes") ----------

/**
 * One page of the GM's session notebook (a session log, NPCs, to-dos), per game.
 * GM only: kept in table.db apart from the game state, read and written over
 * REST by the GM; players never get one, not in a hello or any event.
 */
export interface NotebookEntry {
  id: string;
  title: string;
  /** Plain text with line breaks. */
  text: string;
  /** Milliseconds since 1970. */
  created: number;
  updated: number;
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
  | { type: 'game.rename'; name: string }
  /** GM: open or shut a door of a page's Delve map, for this table only (the map stays as it is). */
  | { type: 'door.set'; pageId: string; id: string; open: boolean }
  /** GM: the explored fog of a dynamic-vision page. reset: forget it (what the party sees now stays); reveal: all of the page; hide: nothing, until the party next looks. */
  | { type: 'vision.explored'; pageId: string; action: 'reset' | 'reveal' | 'hide' };

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
  /** routing: prevLayer is the token's layer before the change; applyIntent leaves it out only for a new token. gmOnly: only the GM's notes (gmNotes) changed, so players get nothing at all. */
  | { type: 'token.upsert'; token: Token; prevLayer?: Layer; gmOnly?: boolean }
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
  /** Dynamic vision of the page you look at, after a hello and whenever it changes; null: the page has no dynamic vision. */
  | { type: 'vision'; pageId: string; vision: VisionView | null }
  /** GM only: the notes on this Delve map changed and nothing else did (no picture changed, so pages aren't sent again): fetch the map for its notes. */
  | { type: 'map.notes'; mapId: string }
  /** GM only: a notebook entry was saved (`entry`) or deleted (`removed`), in any of the GM's tabs. */
  | { type: 'notebook'; entry?: NotebookEntry; removed?: string }
  /** You were removed from the game, or it was deleted. */
  | { type: 'bye'; reason: string };
