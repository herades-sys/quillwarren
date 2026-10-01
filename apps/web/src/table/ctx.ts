// What the table's panels get from the app: the current view, sending intents,
// the selection and the board. One interface so the panels don't import app.ts.
import type { Intent, Layer, Member, Page, ServerMessage, Token } from '@delve/table';
import type { Board } from './board.ts';
import type { TableState } from './logic.ts';

/** What changed, so a panel redraws only when it has to. "all" follows a hello. */
export type Change = 'all' | 'tokens' | 'pages' | 'chat' | 'turn' | 'members' | 'game' | 'selection' | 'layer';

export interface TableCtx {
  gameId: string;
  me(): Member;
  state(): TableState | null;
  /** The page this member is looking at. */
  page(): Page | null;
  /** Tokens on that page, optimistic moves included. */
  tokens(): Token[];
  selected(): string[];
  select(ids: string[]): void;
  /** The layer the GM is working on (players: always tokens). */
  layer(): Layer;
  /** Send an intent; rejects with the server's error. */
  send(intent: Intent): Promise<number>;
  /** Send an intent and show its error as a toast; true when it went through. */
  act(intent: Intent): Promise<boolean>;
  board(): Board | null;
  openToken(id: string): void;
  /** Listen for changes; returns a function that stops listening. */
  on(fn: (c: Change) => void): () => void;
  /** Every message from the server, after the app has handled it (the GM's notes listen for theirs). */
  onMessage(fn: (m: ServerMessage) => void): () => void;
  /** Which picture of a Delve page the member looks at: the GM's own, or as the players see it. */
  seeAs(): 'gm' | 'players';
}
