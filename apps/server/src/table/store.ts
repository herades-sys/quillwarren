// Delve Table storage on node:sqlite (${DELVE_DATA}/table.db). Each game is one
// JSON row, kept in memory and written back at most every 300 ms (and on
// close); chat is an append-only log. "Seats" hold a random nonce per player,
// so a player cookie dies with its member even if a later player gets the same id.
// Accounts are players who logged in with Discord; their sessions are random
// tokens of which only the SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, GameState } from '@delve/table';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  created TEXT NOT NULL,
  rev     INTEGER NOT NULL,
  state   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat (
  game_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  json    TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);
CREATE TABLE IF NOT EXISTS seats (
  game_id   TEXT NOT NULL,
  member_id TEXT NOT NULL,
  nonce     TEXT NOT NULL,
  PRIMARY KEY (game_id, member_id)
);
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  discord_id  TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL,
  name        TEXT NOT NULL,
  avatar      TEXT,
  avatar_file TEXT,
  created     INTEGER NOT NULL,
  seen        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions (account_id);
`;

export interface GameSummary {
  id: string;
  name: string;
  created: string;
  players: number;
}

/** A player who logged in with Discord. Only what the table needs is kept: no tokens, no email. */
export interface Account {
  id: string;
  discordId: string;
  username: string;
  /** Their Discord display name (global_name, else the username). */
  name: string;
  /** Discord's avatar hash, or null. */
  avatar: string | null;
  /** The avatar picture in the table assets ("<sha>.png"), or null. */
  avatarFile: string | null;
  created: number;
  seen: number;
}

export const ACCOUNT_SESSION_DAYS = 30;
/** Older sessions of one account beyond this many are dropped (someone logging in over and over). */
const MAX_SESSIONS_PER_ACCOUNT = 20;
/** `seen` is written at most this often. */
const SEEN_EVERY_MS = 10 * 60_000;

export const ACCOUNT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const accountFrom = (r: Row): Account => ({
  id: String(r.id),
  discordId: String(r.discord_id),
  username: String(r.username),
  name: String(r.name),
  avatar: r.avatar === null || r.avatar === undefined ? null : String(r.avatar),
  avatarFile: r.avatar_file === null || r.avatar_file === undefined ? null : String(r.avatar_file),
  created: Number(r.created),
  seen: Number(r.seen),
});

export function newGameId(): string {
  return `game_${randomBytes(6).toString('hex')}`;
}

export class TableStore {
  private readonly db: DatabaseSync;
  private readonly games = new Map<string, GameState>();
  private readonly created = new Map<string, string>();
  private readonly seqs = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly debounceMs: number;

  constructor(file: string, debounceMs = 300) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.debounceMs = debounceMs;
  }

  list(): GameSummary[] {
    const rows = this.db.prepare('SELECT id FROM games ORDER BY created DESC').all() as Row[];
    return rows.flatMap((r) => {
      const g = this.get(String(r.id));
      return g
        ? [{ id: g.id, name: g.name, created: this.created.get(g.id) ?? '', players: g.members.filter((m) => m.role === 'player').length }]
        : [];
    });
  }

  get(id: string): GameState | undefined {
    const cached = this.games.get(id);
    if (cached) return cached;
    const r = this.db.prepare('SELECT state, created FROM games WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    const state = JSON.parse(String(r.state)) as GameState;
    this.games.set(id, state);
    this.created.set(id, String(r.created));
    return state;
  }

  create(state: GameState, now = Date.now()): void {
    const created = new Date(now).toISOString();
    this.db
      .prepare('INSERT INTO games (id, name, created, rev, state) VALUES (?, ?, ?, ?, ?)')
      .run(state.id, state.name, created, state.rev, JSON.stringify(state));
    this.games.set(state.id, state);
    this.created.set(state.id, created);
  }

  /** Keep the new state now; write it to disk shortly (several quick changes become one write). */
  save(state: GameState): void {
    if (!this.games.has(state.id) && !this.get(state.id)) throw new Error(`no game "${state.id}"`);
    this.games.set(state.id, state);
    this.dirty.add(state.id);
    if (!this.timer && !this.closed) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty.size) return;
    const update = this.db.prepare('UPDATE games SET name = ?, rev = ?, state = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of this.dirty) {
        const g = this.games.get(id);
        if (g) update.run(g.name, g.rev, JSON.stringify(g), id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.dirty.clear();
  }

  delete(id: string): boolean {
    this.games.delete(id);
    this.created.delete(id);
    this.seqs.delete(id);
    this.dirty.delete(id);
    const r = this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM chat WHERE game_id = ?').run(id);
    this.db.prepare('DELETE FROM seats WHERE game_id = ?').run(id);
    return Number(r.changes) > 0;
  }

  // ---------- chat ----------

  /** The next chat sequence number for a game (1, 2, 3…), counting on from what's stored. */
  nextSeq(gameId: string): number {
    let cur = this.seqs.get(gameId);
    if (cur === undefined) {
      const r = this.db.prepare('SELECT MAX(seq) AS s FROM chat WHERE game_id = ?').get(gameId) as Row | undefined;
      cur = Number(r?.s ?? 0) || 0;
    }
    this.seqs.set(gameId, cur + 1);
    return cur + 1;
  }

  appendChat(gameId: string, msg: ChatMessage): void {
    this.db.prepare('INSERT OR REPLACE INTO chat (game_id, seq, at, json) VALUES (?, ?, ?, ?)').run(gameId, msg.seq, msg.at, JSON.stringify(msg));
    if ((this.seqs.get(gameId) ?? 0) < msg.seq) this.seqs.set(gameId, msg.seq);
  }

  /** The last `n` messages, oldest first. */
  lastChat(gameId: string, n = 200): ChatMessage[] {
    const rows = this.db.prepare('SELECT json FROM chat WHERE game_id = ? ORDER BY seq DESC LIMIT ?').all(gameId, n) as Row[];
    return rows.map((r) => JSON.parse(String(r.json)) as ChatMessage).reverse();
  }

  // ---------- player seats ----------

  /** A fresh nonce for a player who just joined. */
  seat(gameId: string, memberId: string): string {
    const nonce = randomBytes(16).toString('base64url');
    this.db.prepare('INSERT OR REPLACE INTO seats (game_id, member_id, nonce) VALUES (?, ?, ?)').run(gameId, memberId, nonce);
    return nonce;
  }

  seatNonce(gameId: string, memberId: string): string | undefined {
    const r = this.db.prepare('SELECT nonce FROM seats WHERE game_id = ? AND member_id = ?').get(gameId, memberId) as Row | undefined;
    return r ? String(r.nonce) : undefined;
  }

  unseat(gameId: string, memberId: string): void {
    this.db.prepare('DELETE FROM seats WHERE game_id = ? AND member_id = ?').run(gameId, memberId);
  }

  // ---------- accounts (Discord login) ----------

  account(id: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? accountFrom(r) : undefined;
  }

  accountByDiscord(discordId: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE discord_id = ?').get(discordId) as Row | undefined;
    return r ? accountFrom(r) : undefined;
  }

  /** Create the account for a Discord user, or refresh its name and avatar hash. */
  upsertAccount(u: { discordId: string; username: string; name: string; avatar: string | null }, now = Date.now()): Account {
    const found = this.db.prepare('SELECT * FROM accounts WHERE discord_id = ?').get(u.discordId) as Row | undefined;
    if (found) {
      this.db.prepare('UPDATE accounts SET username = ?, name = ?, avatar = ?, seen = ? WHERE id = ?').run(u.username, u.name, u.avatar, now, String(found.id));
      return { ...accountFrom(found), username: u.username, name: u.name, avatar: u.avatar, seen: now };
    }
    const id = `acc_${randomBytes(6).toString('hex')}`;
    this.db
      .prepare('INSERT INTO accounts (id, discord_id, username, name, avatar, avatar_file, created, seen) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(id, u.discordId, u.username, u.name, u.avatar, now, now);
    return { id, discordId: u.discordId, username: u.username, name: u.name, avatar: u.avatar, avatarFile: null, created: now, seen: now };
  }

  setAvatarFile(accountId: string, file: string | null): void {
    this.db.prepare('UPDATE accounts SET avatar_file = ? WHERE id = ?').run(file, accountId);
  }

  /** A new session: returns the token for the cookie; only its hash is stored. */
  createAccountSession(accountId: string, now = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM account_sessions WHERE expires <= ?').run(now);
    this.db
      .prepare('INSERT INTO account_sessions (token_hash, account_id, created, expires) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), accountId, now, now + ACCOUNT_SESSION_DAYS * 86_400_000);
    this.db
      .prepare(
        `DELETE FROM account_sessions WHERE account_id = ? AND token_hash NOT IN
           (SELECT token_hash FROM account_sessions WHERE account_id = ? ORDER BY created DESC LIMIT ${MAX_SESSIONS_PER_ACCOUNT})`,
      )
      .run(accountId, accountId);
    return token;
  }

  /** The account behind a session token, if the session exists and hasn't expired. */
  accountForSession(token: string | undefined, now = Date.now()): Account | undefined {
    if (!token || !ACCOUNT_TOKEN.test(token)) return undefined;
    const r = this.db
      .prepare('SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?')
      .get(hashToken(token), now) as Row | undefined;
    if (!r) return undefined;
    const account = accountFrom(r);
    if (now - account.seen > SEEN_EVERY_MS) {
      this.db.prepare('UPDATE accounts SET seen = ? WHERE id = ?').run(now, account.id);
      account.seen = now;
    }
    return account;
  }

  deleteAccountSession(token: string | undefined): void {
    if (token && ACCOUNT_TOKEN.test(token)) this.db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.db.close();
  }
}
