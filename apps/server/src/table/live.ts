// The table's sync channel (GET /api/v1/games/:id/live). The server is
// authoritative: an intent goes through applyIntent, the new state is saved,
// and every connected member gets the events filtered for them (eventFor /
// chatFor / viewFor), so nothing GM-only ever leaves the server unfiltered.
//
// Dynamic vision (vision.ts): on such a page, players get only their own tokens
// and the ones the party sees. Each player connection remembers which tokens
// of its page it holds, so a token that comes into view arrives as an upsert,
// one that leaves goes as a removal, and moves of tokens it can't see send it
// nothing at all. After each recompute it gets what the party sees as a
// `vision` message (the explored fog only when it grew).
import { randomInt } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  applyIntent,
  chatFor,
  eventFor,
  isDynamic,
  mayGetToken,
  pageFor,
  sightFilter,
  TableError,
  tokenForPlayer,
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
import { VisionPictures } from './vision-render.ts';
import { TableVision, type PageSight } from './vision.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const HELLO_CHAT = 200;
const PINGS_PER_SECOND = 20;
/** A player's chat lines (and rolls) per connection: this many within CHAT_WINDOW_MS, the rest refused. */
export const CHAT_PER_WINDOW = 10;
export const CHAT_WINDOW_MS = 10_000;

/** WebSocket close codes: not a member, removed from the game, game deleted. */
export const CLOSE_NOT_MEMBER = 4401;
export const CLOSE_REMOVED = 4403;
export const CLOSE_GONE = 4404;

interface Conn {
  socket: WebSocket;
  gameId: string;
  memberId: string;
  /** Players on a dynamic page: the ids of that page's tokens this connection holds. */
  known?: Set<string>;
  knownPage?: string;
  /** The explored version it has, and what the last vision message showed. */
  exploredSent?: number;
  visionSig?: string;
  /** When its last chat lines came (players only), for CHAT_PER_WINDOW. */
  chatTimes?: number[];
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
  /** Dynamic vision: what the party sees per page, and the explored fog. */
  readonly vision: TableVision;
  /** Page pictures in dynamic vision, cached per explored version. */
  readonly pictures = new VisionPictures();

  constructor(store: TableStore, log: FastifyBaseLogger, visionThrottleMs?: number) {
    this.store = store;
    this.log = log;
    this.vision = new TableVision(store, (state, now) => this.visionChanged(state, now), visionThrottleMs, (err) => this.log.error({ err }, 'table vision failed'));
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

  /** The member's whole filtered view plus the recent chat they may read; then, on a dynamic page, what the party sees. */
  hello(conn: Conn, state = this.store.get(conn.gameId)): void {
    if (!state) return;
    const chat = this.store
      .lastChat(conn.gameId, HELLO_CHAT)
      .map((m) => chatFor(state, conn.memberId, m))
      .filter((m): m is ChatMessage => m !== null);
    const filter = this.vision.filterFor(state, conn.memberId);
    const view = viewFor(state, conn.memberId, filter);
    if (filter) {
      conn.known = new Set(view.tokens.map((t) => t.id));
      conn.knownPage = view.pageId;
    } else {
      delete conn.known;
      delete conn.knownPage;
    }
    delete conn.exploredSent;
    delete conn.visionSig;
    send(conn.socket, { type: 'hello', view, chat });
    this.sendVision(conn, state);
  }

  /** The vision message for the page the member looks at, unless it would show what they already have. */
  private sendVision(conn: Conn, state: GameState, now?: PageSight): void {
    const me = state.members.find((m) => m.id === conn.memberId);
    if (!me) return;
    const pageId = pageFor(state, conn.memberId);
    const cur = now?.pageId === pageId ? now : this.vision.current(state, pageId);
    if (!cur) return; // no dynamic vision there: a hello already told the client everything
    const sig = me.role === 'gm' ? `${cur.sig}|${[...cur.seen].sort().join(',')}` : cur.sig;
    if (conn.visionSig === sig) return;
    const withExplored = conn.exploredSent !== cur.explored.version;
    send(conn.socket, { type: 'vision', pageId, vision: this.vision.viewFor(state, me, cur, withExplored) });
    conn.exploredSent = cur.explored.version;
    conn.visionSig = sig;
  }

  /** After a recompute: tokens that came into or went out of the party's sight, then what it sees. */
  private visionChanged(state: GameState, now: PageSight): void {
    const filter = sightFilter(now.pageId, now.sight, now.explored);
    const inTurn = new Set(state.turn.entries.flatMap((e) => (e.tokenId === undefined ? [] : [e.tokenId])));
    for (const c of this.rooms.get(state.id) ?? []) {
      const me = state.members.find((m) => m.id === c.memberId);
      if (!me || pageFor(state, c.memberId) !== now.pageId) continue;
      const known = me.role !== 'gm' && c.knownPage === now.pageId ? c.known : undefined;
      if (known) {
        const events: GameEvent[] = [];
        let turn = false;
        for (const t of state.tokens) {
          if (t.pageId !== now.pageId) continue;
          const may = mayGetToken(me, t, filter);
          if (may === known.has(t.id)) continue;
          if (may) {
            known.add(t.id);
            events.push({ type: 'token.upsert', token: tokenForPlayer(t, me.id) });
          } else {
            known.delete(t.id);
            events.push({ type: 'token.remove', ids: [t.id] });
          }
          if (inTurn.has(t.id)) turn = true;
        }
        if (turn) {
          const ev = eventFor(state, me.id, { type: 'turn', turn: state.turn }, filter);
          if (ev) events.push(ev);
        }
        if (events.length) send(c.socket, { type: 'events', rev: state.rev, events });
      }
      this.sendVision(c, state, now);
    }
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
    this.afterChange(prev, state, out.events);
    if (out.explored) this.vision.setExplored(state, out.explored.pageId, out.explored.action);
    return { state, events: out.events, ...(out.chat ? { chat: out.chat } : {}) };
  }

  /** Save a state that changed outside applyIntent (a player joined, an invite came or went). */
  replace(prev: GameState, next: GameState, events: GameEvent[] = []): GameState {
    const state = this.commit(prev, next, true);
    this.publish(state, events);
    this.afterChange(prev, state, events);
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

  /**
   * Dynamic vision after a change: pages whose tokens, walls, doors, lights or
   * settings changed are recomputed (throttled); a page that switched vision on
   * or off gives its players a fresh view; a deleted page's fog goes.
   */
  private afterChange(prev: GameState, state: GameState, events: GameEvent[]): void {
    const touched = new Set<string>();
    const switched = new Set<string>();
    for (const e of events) {
      if (e.type === 'token.upsert') {
        if (!e.gmOnly) touched.add(e.token.pageId); // notes don't move anyone's sight
      }
      else if (e.type === 'token.remove' && e.pageId !== undefined) touched.add(e.pageId);
      else if (e.type === 'page.upsert') {
        touched.add(e.page.id);
        if (isDynamic(prev.pages.find((p) => p.id === e.page.id)) !== isDynamic(e.page)) switched.add(e.page.id);
      } else if (e.type === 'page.remove') this.vision.forget(state.id, e.id, true);
    }
    for (const pageId of switched) {
      this.vision.forget(state.id, pageId, false);
      const players = (id: string) => state.members.some((m) => m.id === id && m.role !== 'gm') && pageFor(state, id) === pageId;
      // the GM's board needs the vision messages too (or to drop them)
      this.refresh(state.id, (id) => pageFor(state, id) === pageId && (players(id) || state.members.some((m) => m.id === id && m.role === 'gm')));
    }
    for (const pageId of touched) {
      const page = state.pages.find((p) => p.id === pageId);
      if (page && isDynamic(page) && !switched.has(pageId)) this.vision.touch(state.id, pageId, () => this.store.get(state.id));
    }
  }

  /** Fan events (and a chat line) out to every connection, each through the member's filter. */
  publish(state: GameState, events: GameEvent[], chat?: ChatMessage): void {
    for (const c of this.rooms.get(state.id) ?? []) {
      const me = state.members.find((m) => m.id === c.memberId);
      if (!me) continue;
      const filter = me.role === 'gm' ? null : this.vision.filterFor(state, c.memberId);
      const known = filter && c.knownPage === filter.pageId ? c.known : undefined;
      const mine: GameEvent[] = [];
      let switched = false;
      let turnShows = false; // a token in the turn order came into sight or left it: its entry changes
      for (const e of events) {
        // the GM's notes on a token changed and nothing else: not even a removal for players
        if (e.type === 'token.upsert' && e.gmOnly && me.role !== 'gm') continue;
        const f = eventFor(state, c.memberId, e, filter);
        if (known && e.type === 'token.upsert') {
          // in sight: send it; out of sight: a removal if they hold it, else nothing at all
          const id = e.token.id;
          if (f?.type === 'token.upsert') {
            if (!known.has(id)) turnShows ||= state.turn.entries.some((t) => t.tokenId === id);
            known.add(id);
            mine.push(f);
          } else if (known.has(id)) {
            known.delete(id);
            turnShows ||= state.turn.entries.some((t) => t.tokenId === id);
            mine.push({ type: 'token.remove', ids: [id] });
          }
          continue;
        }
        if (known && e.type === 'token.remove') {
          const ids = f?.type === 'token.remove' ? f.ids.filter((id) => known.has(id)) : [];
          for (const id of ids) known.delete(id);
          if (ids.length) mine.push({ type: 'token.remove', ids });
          continue;
        }
        if (!f) continue;
        if (f.type === 'page.switch') switched = true;
        mine.push(f);
      }
      if (turnShows && !mine.some((e) => e.type === 'turn')) {
        const t = eventFor(state, c.memberId, { type: 'turn', turn: state.turn }, filter);
        if (t) mine.push(t);
      }
      if (chat) {
        const m = chatFor(state, c.memberId, chat);
        if (m) mine.push({ type: 'chat', message: m });
      }
      if (mine.length) send(c.socket, { type: 'events', rev: state.rev, events: mine });
      if (switched) this.hello(c, state);
    }
  }

  /**
   * A GM-only message (the notebook, notes on a page's map) to the game's GM
   * connections. Players never get these; a GM testing as a player (player
   * cookie) is a player here too. Returns how many got it.
   */
  toGms(gameId: string, msg: Extract<ServerMessage, { type: 'notebook' | 'map.notes' }>): number {
    const state = this.store.get(gameId);
    if (!state) return 0;
    let n = 0;
    for (const c of this.rooms.get(gameId) ?? []) {
      if (state.members.find((m) => m.id === c.memberId)?.role !== 'gm') continue;
      send(c.socket, msg);
      n++;
    }
    return n;
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
    this.vision.forgetGame(gameId);
  }

  /** Stop the vision timers (the server is closing). */
  close(): void {
    this.vision.close();
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

  /** Counts a chat line on a player's connection: false beyond CHAT_PER_WINDOW in CHAT_WINDOW_MS. The GM isn't counted. */
  private chatFits(conn: Conn, now = Date.now()): boolean {
    if (this.store.get(conn.gameId)?.members.find((m) => m.id === conn.memberId)?.role === 'gm') return true;
    const times = (conn.chatTimes ??= []);
    while (times.length && times[0]! <= now - CHAT_WINDOW_MS) times.shift();
    if (times.length >= CHAT_PER_WINDOW) return false;
    times.push(now);
    return true;
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
    if (intent.type === 'chat.send' && !this.chatFits(conn)) {
      return send(conn.socket, { type: 'error', ref, error: `Slow down: at most ${CHAT_PER_WINDOW} messages in ${CHAT_WINDOW_MS / 1000} seconds.` });
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
    socket.on('message', (raw) => {
      // the login behind the socket may have ended since it opened (logout, "log out everywhere")
      const now = store.get(id);
      const still = now ? memberOf(access, req, now, { write: true, ...(typeof token === 'string' ? { queryToken: token } : {}) }) : null;
      if (!still || still.id !== conn.memberId) {
        send(socket, { type: 'bye', reason: 'Your login has ended. Reload the page to join again.' });
        socket.close(CLOSE_NOT_MEMBER, 'login ended');
        return;
      }
      hub.receive(conn, raw);
    });
    hub.hello(conn, state);
  });
}
