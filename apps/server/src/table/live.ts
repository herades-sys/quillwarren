// The table's sync channel (GET /api/v1/games/:id/live). The server is
// authoritative: an intent goes through applyIntent, the new state is saved,
// and every connected member gets the events filtered for them (eventFor /
// chatFor / viewFor), so nothing GM-only ever leaves the server unfiltered.
import { randomInt } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  applyIntent,
  chatFor,
  eventFor,
  pageFor,
  TableError,
  viewFor,
  type ApplyContext,
  type ChatMessage,
  type GameEvent,
  type GameState,
  type Intent,
  type ServerMessage,
} from '@delve/table';
import { GAME_ID, memberOf, type AccessDeps } from './access.ts';
import type { TableStore } from './store.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const HELLO_CHAT = 200;
const PINGS_PER_SECOND = 20;

/** WebSocket close codes: not a member, removed from the game, game deleted. */
export const CLOSE_NOT_MEMBER = 4401;
export const CLOSE_REMOVED = 4403;
export const CLOSE_GONE = 4404;

interface Conn {
  socket: WebSocket;
  gameId: string;
  memberId: string;
}

export interface ChangeResult {
  state: GameState;
  events: GameEvent[];
  chat?: ChatMessage;
}

/** ws hands over a Buffer, a list of fragments, or an ArrayBuffer. */
const bytesOf = (raw: unknown): Buffer =>
  Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw as Buffer[]) : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.from(String(raw));

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

export class TableHub {
  private readonly rooms = new Map<string, Set<Conn>>();
  private readonly pingCounts = new Map<string, { window: number; n: number }>();
  private readonly store: TableStore;
  private readonly log: FastifyBaseLogger;

  constructor(store: TableStore, log: FastifyBaseLogger) {
    this.store = store;
    this.log = log;
  }

  join(conn: Conn): void {
    let room = this.rooms.get(conn.gameId);
    if (!room) this.rooms.set(conn.gameId, (room = new Set()));
    room.add(conn);
    conn.socket.on('close', () => {
      room.delete(conn);
      if (!room.size && this.rooms.get(conn.gameId) === room) this.rooms.delete(conn.gameId);
    });
  }

  /** The member's whole filtered view plus the recent chat they may read. */
  hello(conn: Conn, state = this.store.get(conn.gameId)): void {
    if (!state) return;
    const chat = this.store
      .lastChat(conn.gameId, HELLO_CHAT)
      .map((m) => chatFor(state, conn.memberId, m))
      .filter((m): m is ChatMessage => m !== null);
    send(conn.socket, { type: 'hello', view: viewFor(state, conn.memberId), chat });
  }

  /** Send a fresh hello to the connections that match (e.g. the GM after the invite list changed). */
  refresh(gameId: string, which: (memberId: string) => boolean): void {
    const state = this.store.get(gameId);
    for (const c of this.rooms.get(gameId) ?? []) if (which(c.memberId)) this.hello(c, state);
  }

  /**
   * Run one intent for a member: apply it (throws TableError when it's refused),
   * bump rev, save, store the chat line, and send everyone their share.
   */
  change(gameId: string, memberId: string, intent: Intent): ChangeResult {
    const prev = this.store.get(gameId);
    if (!prev) throw new TableError('this game no longer exists');
    const ctx: ApplyContext = {
      now: Date.now(),
      rng: (sides: number) => randomInt(1, sides + 1),
      nextSeq: () => this.store.nextSeq(gameId),
    };
    const out = applyIntent(prev, memberId, intent, ctx);
    const state = this.commit(prev, out.state, out.events.length > 0);
    if (out.chat) this.store.appendChat(gameId, out.chat);
    this.publish(state, out.events, out.chat);
    return { state, events: out.events, ...(out.chat ? { chat: out.chat } : {}) };
  }

  /** Save a state that changed outside applyIntent (a player joined, an invite came or went). */
  replace(prev: GameState, next: GameState, events: GameEvent[] = []): GameState {
    const state = this.commit(prev, next, true);
    this.publish(state, events);
    return state;
  }

  private commit(prev: GameState, next: GameState, changed: boolean): GameState {
    if (next === prev && !changed) return prev;
    const state = next.rev > prev.rev ? next : { ...next, rev: prev.rev + 1 };
    this.store.save(state);
    // members who are gone lose their seat (and so their cookie) and their sockets
    const left = prev.members.filter((m) => !state.members.some((n) => n.id === m.id));
    for (const m of left) this.store.unseat(state.id, m.id);
    if (left.length) this.kick(state.id, (id) => left.some((m) => m.id === id), 'You were removed from the game.');
    return state;
  }

  /** Fan events (and a chat line) out to every connection, each through the member's filter. */
  publish(state: GameState, events: GameEvent[], chat?: ChatMessage): void {
    for (const c of this.rooms.get(state.id) ?? []) {
      if (!state.members.some((m) => m.id === c.memberId)) continue;
      const mine: GameEvent[] = [];
      let switched = false;
      for (const e of events) {
        const f = eventFor(state, c.memberId, e);
        if (!f) continue;
        if (f.type === 'page.switch') switched = true;
        mine.push(f);
      }
      if (chat) {
        const m = chatFor(state, c.memberId, chat);
        if (m) mine.push({ type: 'chat', message: m });
      }
      if (mine.length) send(c.socket, { type: 'events', rev: state.rev, events: mine });
      if (switched) this.hello(c, state);
    }
  }

  kick(gameId: string, which: (memberId: string) => boolean, reason: string): void {
    for (const c of [...(this.rooms.get(gameId) ?? [])]) {
      if (!which(c.memberId)) continue;
      send(c.socket, { type: 'bye', reason });
      c.socket.close(CLOSE_REMOVED, 'removed from the game');
    }
  }

  /** The game was deleted: say goodbye to everyone. */
  end(gameId: string): void {
    for (const c of [...(this.rooms.get(gameId) ?? [])]) {
      send(c.socket, { type: 'bye', reason: 'The game was deleted.' });
      c.socket.close(CLOSE_GONE, 'game deleted');
    }
    this.rooms.delete(gameId);
  }

  /** Relay a ping to the members looking at that page. Never stored; beyond 20 a second per member they're dropped. */
  ping(conn: Conn, msg: { pageId?: unknown; x?: unknown; y?: unknown }): void {
    const { pageId, x, y } = msg;
    if (typeof pageId !== 'string' || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return send(conn.socket, { type: 'error', error: 'a ping needs pageId, x and y' });
    }
    const now = Date.now();
    const key = `${conn.gameId}\n${conn.memberId}`;
    const count = this.pingCounts.get(key);
    const window = Math.floor(now / 1000);
    if (count && count.window === window) {
      if (++count.n > PINGS_PER_SECOND) return;
    } else this.pingCounts.set(key, { window, n: 1 });
    const state = this.store.get(conn.gameId);
    const from = state?.members.find((m) => m.id === conn.memberId);
    if (!state || !from || pageFor(state, from.id) !== pageId) return;
    const out: ServerMessage = { type: 'ping', from: from.id, color: from.color, pageId, x, y };
    for (const c of this.rooms.get(conn.gameId) ?? []) {
      const m = state.members.find((n) => n.id === c.memberId);
      if (m && pageFor(state, m.id) === pageId) send(c.socket, out);
    }
  }

  /** One message from a client. Bad input gets an error back; nothing here may throw. */
  receive(conn: Conn, raw: unknown): void {
    const bytes = bytesOf(raw);
    if (bytes.length > MAX_MESSAGE_BYTES) return send(conn.socket, { type: 'error', error: 'message too large (64 KB at most)' });
    let msg: { type?: unknown; ref?: unknown; intent?: unknown; pageId?: unknown; x?: unknown; y?: unknown };
    try {
      msg = JSON.parse(bytes.toString('utf8'));
    } catch {
      return send(conn.socket, { type: 'error', error: 'messages must be JSON' });
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return send(conn.socket, { type: 'error', error: 'messages must be JSON objects' });
    if (msg.type === 'keepalive') return;
    if (msg.type === 'ping') return this.ping(conn, msg);
    if (msg.type !== 'intent') return send(conn.socket, { type: 'error', error: `unknown message type ${JSON.stringify(msg.type) ?? 'undefined'}` });
    const ref = typeof msg.ref === 'number' && Number.isFinite(msg.ref) ? msg.ref : undefined;
    const intent = msg.intent as { type?: unknown } | null | undefined;
    if (ref === undefined) return send(conn.socket, { type: 'error', error: 'an intent needs a numeric ref' });
    if (typeof intent !== 'object' || intent === null || typeof intent.type !== 'string') {
      return send(conn.socket, { type: 'error', ref, error: 'intent must be an object with a type' });
    }
    try {
      const { state } = this.change(conn.gameId, conn.memberId, intent as Intent);
      send(conn.socket, { type: 'ack', ref, rev: state.rev });
    } catch (e) {
      if (e instanceof TableError) return send(conn.socket, { type: 'error', ref, error: e.message });
      this.log.error({ err: e, game: conn.gameId, intent: intent.type }, 'table intent failed');
      send(conn.socket, { type: 'error', ref, error: 'that did not work (internal error; see the server log)' });
    }
  }
}

export function registerLive(app: FastifyInstance, hub: TableHub, store: TableStore, access: AccessDeps): void {
  app.get('/api/v1/games/:id/live', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const state = GAME_ID.test(id) ? store.get(id) : undefined;
    const token = (req.query as { token?: unknown }).token;
    // write: a cookie only counts from the page's own origin (no cross-site sockets)
    const member = state ? memberOf(access, req, state, { write: true, ...(typeof token === 'string' ? { queryToken: token } : {}) }) : null;
    if (!state || !member) {
      send(socket, { type: 'error', error: 'not a member of this game' });
      socket.close(CLOSE_NOT_MEMBER, 'not a member of this game');
      return;
    }
    const conn: Conn = { socket, gameId: id, memberId: member.id };
    hub.join(conn);
    socket.on('message', (raw) => hub.receive(conn, raw));
    hub.hello(conn, state);
  });
}
