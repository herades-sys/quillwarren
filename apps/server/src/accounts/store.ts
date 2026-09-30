// Accounts for the admin and the GMs, in their own node:sqlite file
// (${DELVE_DATA}/accounts.db): users with a scrypt password and an
// authenticator secret (GM accounts may be password-only, if the admin says
// so), server-side sessions, one-time setup links and login
// lockouts. Session and link tokens are stored only as SHA-256 hashes, and
// authenticator secrets are sealed with AES-256-GCM when there's an API token.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../auth.ts';
import { base32Decode, base32Encode, matchTotp, newTotpSecret } from './totp.ts';

export type Role = 'admin' | 'gm';
export type LinkPurpose = 'bootstrap' | 'new' | 'reset' | 'authenticator';

export interface User {
  id: number;
  name: string;
  role: Role;
  /** Password and authenticator (or just the password) are set up, so the account can log in. */
  active: boolean;
  /** A GM account that logs in with name and password only, no authenticator. */
  passwordOnly: boolean;
  created: number;
  lastLogin: number | null;
  recoveryLeft: number;
  /** When the account's setup link runs out (null: no open link). */
  linkExpires: number | null;
}

export interface Session {
  id: string;
  userId: number;
  userName: string;
  created: number;
  expires: number;
  lastSeen: number;
  remember: boolean;
  userAgent: string;
}

export interface SetupLink {
  userId: number;
  userName: string;
  role: Role;
  purpose: LinkPurpose;
  expires: number;
  /** The authenticator secret this link sets up (base32). */
  secret: string;
  /** A new password was chosen already (it applies once the code confirms). */
  passwordChosen: boolean;
  /** The account logs in without an authenticator (so the password alone finishes a new or reset link). */
  passwordOnly: boolean;
}

/** Something the person can fix; the message is shown as it is. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;
const HOUR = 3_600_000;
export const IDLE_MS = 12 * HOUR;
export const REMEMBER_IDLE_MS = 7 * 24 * HOUR;
export const SESSION_MAX_MS = 30 * 24 * HOUR;
export const LINK_MS = 72 * HOUR;
/** Bootstrap and "new authenticator" links are made for the person holding them right now. */
export const SHORT_LINK_MS = HOUR;
export const LOCK_FAILS = 5;
export const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 10;
const TOUCH_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'gm')),
  password_hash   TEXT,
  totp_secret     TEXT,
  -- 1 once the login is set up (for password-only accounts: once the password is chosen)
  totp_confirmed  INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER NOT NULL DEFAULT -1,
  recovery_hashes TEXT NOT NULL DEFAULT '[]',
  created         INTEGER NOT NULL,
  last_login      INTEGER,
  -- 0: a password-only GM account
  two_factor      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  remember   INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS setup_links (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL,
  created       INTEGER NOT NULL,
  expires       INTEGER NOT NULL,
  totp_secret   TEXT NOT NULL,
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  since        INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
`;

type Row = Record<string, unknown>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const SESSION_VALUE = /^a1\.([A-Za-z0-9_-]{43})$/;
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A display name, or null: 1–32 letters, digits, spaces and . _ ' - (starting with a letter or digit). */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,31}$/u.test(name) ? name : null;
}
const nameKey = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** "ABCD-EFGH-JKLM-NPQR": 80 random bits, in the base32 alphabet. */
const newRecoveryCode = (): string => base32Encode(randomBytes(10)).replace(/(.{4})(?=.)/g, '$1-');
/** Uppercase, no separators, and the digits people mistake for letters mapped back. */
function normalRecovery(code: string): string | null {
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  return /^[A-Z2-7]{16}$/.test(c) ? c : null;
}
const recoveryHash = (normal: string): string => sha256(`delve-recovery:${normal}`);

/** Seals authenticator secrets with a key derived from the API token (plain text without one). */
class SecretBox {
  private readonly key: Buffer | null;

  constructor(secret: string | undefined) {
    this.key = secret ? Buffer.from(hkdfSync('sha256', secret, 'delve-accounts', 'totp-secrets', 32)) : null;
  }

  get sealing(): boolean {
    return this.key !== null;
  }

  seal(plain: string, userId: number): string {
    if (!this.key) return `p1:${plain}`;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`totp:${userId}`));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `g1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }

  /** The secret, or null when it can't be read (e.g. the API token changed). */
  open(stored: string | null, userId: number): string | null {
    if (!stored) return null;
    if (stored.startsWith('p1:')) return stored.slice(3);
    const m = /^g1:([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(stored);
    if (!m || !this.key) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(m[1]!, 'base64url'), { authTagLength: 16 });
      d.setAAD(Buffer.from(`totp:${userId}`));
      d.setAuthTag(Buffer.from(m[2]!, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(m[3]!, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

export interface LoginResult {
  user: User;
  factor: 'code' | 'recovery' | 'password';
}

export class AccountStore {
  private readonly db: DatabaseSync;
  private readonly box: SecretBox;
  private dummyHash: string | null = null;

  /** `file` is a path, or ':memory:' (tests and servers without DELVE_DATA). */
  constructor(file: string, apiToken: string | undefined) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // accounts.db files from before password-only accounts
    if (!(this.db.prepare('PRAGMA table_info(users)').all() as Row[]).some((c) => c.name === 'two_factor')) {
      this.db.exec('ALTER TABLE users ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 1');
    }
    this.box = new SecretBox(apiToken);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- the shared-password bootstrap ----------

  /** True once an admin account is set up: the shared editor password and its cookies stop counting. */
  legacyOff(): boolean {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'legacy_login'`).get() as Row | undefined;
    return row?.value === 'off';
  }

  private activeAdmins(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND totp_confirmed = 1`).get() as Row;
    return Number(row.n);
  }

  // ---------- users ----------

  private toUser(r: Row): User {
    const link = this.db.prepare('SELECT MAX(expires) AS e FROM setup_links WHERE user_id = ?').get(r.id as number) as Row;
    return {
      id: Number(r.id),
      name: String(r.name),
      role: r.role as Role,
      active: r.totp_confirmed === 1,
      passwordOnly: r.two_factor === 0,
      created: Number(r.created),
      lastLogin: r.last_login === null ? null : Number(r.last_login),
      recoveryLeft: (JSON.parse(String(r.recovery_hashes)) as string[]).length,
      linkExpires: link.e === null ? null : Number(link.e),
    };
  }

  private row(id: number): Row | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
  }

  user(id: number): User | null {
    const r = this.row(id);
    return r ? this.toUser(r) : null;
  }

  users(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY role, name_key').all() as Row[]).map((r) => this.toUser(r));
  }

  /** A new account that can't log in until its setup link is used. Only GMs can be password-only. */
  createUser(name: unknown, role: Role, now = Date.now(), opts: { passwordOnly?: boolean } = {}): User {
    const clean = cleanName(name);
    if (!clean) throw new AccountError('A name has 1 to 32 letters, digits, spaces or . _ \' - and starts with a letter or digit.');
    if (opts.passwordOnly && role === 'admin') throw new AccountError('Admin accounts always use an authenticator app. Only GM accounts can be password only.');
    if (this.db.prepare('SELECT 1 FROM users WHERE name_key = ?').get(nameKey(clean))) throw new AccountError(`The name "${clean}" is taken.`);
    const r = this.db
      .prepare('INSERT INTO users (name, name_key, role, created, two_factor) VALUES (?, ?, ?, ?, ?)')
      .run(clean, nameKey(clean), role, now, opts.passwordOnly ? 0 : 1);
    return this.user(Number(r.lastInsertRowid))!;
  }

  private guardLastAdmin(id: number, what: string): void {
    const r = this.row(id);
    if (r && r.role === 'admin' && r.totp_confirmed === 1 && this.activeAdmins() <= 1) {
      throw new AccountError(`This is the last admin account, so it can't be ${what}. Make another admin first.`);
    }
  }

  removeUser(id: number): void {
    this.guardLastAdmin(id, 'removed');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  setRole(id: number, role: Role): void {
    if (role !== 'admin') this.guardLastAdmin(id, 'made a GM');
    else if (this.row(id)?.two_factor === 0) throw new AccountError('A password-only account can\'t be an admin. Require the authenticator first.');
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  /**
   * Locks the account (password, authenticator, recovery codes and sessions all
   * go) and returns a new setup link. `passwordOnly` switches the account's
   * mode (GMs only); left out, it stays as it is.
   */
  resetLogin(id: number, now = Date.now(), opts: { passwordOnly?: boolean } = {}): string {
    this.guardLastAdmin(id, 'reset');
    if (opts.passwordOnly && this.row(id)?.role === 'admin') throw new AccountError('Admin accounts always use an authenticator app.');
    return this.tx(() => {
      this.db
        .prepare(`UPDATE users SET password_hash = NULL, totp_secret = NULL, totp_confirmed = 0, totp_last_step = -1, recovery_hashes = '[]' WHERE id = ?`)
        .run(id);
      if (opts.passwordOnly !== undefined) this.db.prepare('UPDATE users SET two_factor = ? WHERE id = ?').run(opts.passwordOnly ? 0 : 1, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return this.createLink(id, 'reset', now);
    });
  }

  // ---------- setup links ----------

  /** A one-time link token (the only copy; only its hash is kept). It replaces the account's earlier link. */
  createLink(userId: number, purpose: LinkPurpose, now = Date.now()): string {
    const token = newToken();
    const ms = purpose === 'new' || purpose === 'reset' ? LINK_MS : SHORT_LINK_MS;
    this.db.prepare('DELETE FROM setup_links WHERE user_id = ?').run(userId);
    this.db
      .prepare('INSERT INTO setup_links (token_hash, user_id, purpose, created, expires, totp_secret) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, purpose, now, now + ms, this.box.seal(newTotpSecret(), userId));
    return token;
  }

  /** Bootstrap: while there's no admin yet, a logged-in editor makes the first admin account. */
  startBootstrap(name: unknown, password: string, now = Date.now()): string {
    if (this.legacyOff()) throw new AccountError('An admin account exists already. Ask the admin for a setup link.');
    return this.tx(() => {
      // earlier attempts that never finished
      this.db.prepare('DELETE FROM users WHERE totp_confirmed = 0').run();
      const user = this.createUser(name, 'admin', now);
      const token = this.createLink(user.id, 'bootstrap', now);
      this.db.prepare('UPDATE setup_links SET password_hash = ? WHERE token_hash = ?').run(hashPassword(password), sha256(token));
      return token;
    });
  }

  private linkRow(token: unknown, now: number): Row | null {
    if (typeof token !== 'string' || !LINK_TOKEN.test(token)) return null;
    const r = this.db
      .prepare('SELECT l.*, u.name, u.role, u.two_factor FROM setup_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?')
      .get(sha256(token)) as Row | undefined;
    if (!r) return null;
    if (Number(r.expires) <= now) {
      this.db.prepare('DELETE FROM setup_links WHERE token_hash = ?').run(r.token_hash as string);
      return null;
    }
    return r;
  }

  link(token: unknown, now = Date.now()): SetupLink | null {
    const r = this.linkRow(token, now);
    if (!r) return null;
    const secret = this.box.open(r.totp_secret as string, Number(r.user_id));
    if (!secret) return null;
    return {
      userId: Number(r.user_id),
      userName: String(r.name),
      role: r.role as Role,
      purpose: r.purpose as LinkPurpose,
      expires: Number(r.expires),
      secret,
      passwordChosen: r.password_hash !== null,
      passwordOnly: r.two_factor === 0,
    };
  }

  /** Step 1 of a setup link: the new password, kept with the link until the code confirms it. */
  chooseLinkPassword(token: string, password: string, now = Date.now()): void {
    const r = this.linkRow(token, now);
    if (!r) throw new AccountError('This setup link is not valid any more.');
    this.db.prepare('UPDATE setup_links SET password_hash = ? WHERE token_hash = ?').run(hashPassword(password), r.token_hash as string);
  }

  /**
   * The only step of a password-only account's new or reset link: the password
   * is set, the link is used up and the account becomes active.
   */
  completePasswordLink(token: string, password: string, now = Date.now()): User {
    const r = this.linkRow(token, now);
    if (!r) throw new AccountError('This setup link is not valid any more.');
    if (r.two_factor !== 0 || r.purpose === 'authenticator' || r.purpose === 'bootstrap') throw new AccountError('This account also needs an authenticator app.');
    const userId = Number(r.user_id);
    return this.tx(() => {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, totp_secret = NULL, totp_confirmed = 1, totp_last_step = -1, recovery_hashes = '[]', last_login = ? WHERE id = ?`)
        .run(hashPassword(password), now, userId);
      this.db.prepare('DELETE FROM setup_links WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return this.user(userId)!;
    });
  }

  /**
   * Step 2: a code from the authenticator proves it's set up. The link is used
   * up, the account becomes active, and new-account links return fresh recovery
   * codes (shown once). So does a password-only account that turns the
   * authenticator on, which then needs codes to log in. Null when the code is wrong.
   */
  completeLink(token: string, code: string, now = Date.now()): { user: User; recoveryCodes: string[] | null } | null {
    const r = this.linkRow(token, now);
    if (!r) throw new AccountError('This setup link is not valid any more.');
    const purpose = r.purpose as LinkPurpose;
    const userId = Number(r.user_id);
    const turningOn = r.two_factor === 0;
    if (turningOn && purpose !== 'authenticator') throw new AccountError('This account logs in with a password only.');
    if (purpose !== 'authenticator' && r.password_hash === null) throw new AccountError('Choose a password first.');
    if (purpose === 'bootstrap' && this.legacyOff()) throw new AccountError('An admin account exists already. Ask the admin for a setup link.');
    const secret = this.box.open(r.totp_secret as string, userId);
    const step = secret ? matchTotp(base32Decode(secret), code.replace(/\s/g, ''), now) : null;
    if (step === null) return null;
    return this.tx(() => {
      const codes = purpose === 'authenticator' && !turningOn ? null : Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
      this.db
        .prepare('UPDATE users SET totp_secret = ?, totp_confirmed = 1, totp_last_step = ?, two_factor = 1 WHERE id = ?')
        .run(this.box.seal(secret!, userId), step, userId);
      // finishing a new or reset account logs it in
      if (purpose !== 'authenticator') this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, userId);
      if (r.password_hash !== null) this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(r.password_hash as string, userId);
      if (codes) this.storeRecovery(userId, codes);
      this.db.prepare('DELETE FROM setup_links WHERE user_id = ?').run(userId);
      if (purpose !== 'authenticator') this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      if (r.role === 'admin') this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_login', 'off')`).run();
      return { user: this.user(userId)!, recoveryCodes: codes };
    });
  }

  // ---------- passwords, codes and recovery codes ----------

  private storeRecovery(userId: number, codes: string[]): void {
    const hashes = codes.map((c) => recoveryHash(normalRecovery(c)!));
    this.db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), userId);
  }

  newRecoveryCodes(userId: number): string[] {
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    this.storeRecovery(userId, codes);
    return codes;
  }

  checkPassword(userId: number, password: string): boolean {
    return verifyPassword(password, (this.row(userId)?.password_hash as string | null) ?? undefined);
  }

  setPassword(userId: number, password: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  }

  /**
   * A 6-digit authenticator code (each works once) or an unused recovery code
   * (used up here). Null when neither matches.
   */
  useSecondFactor(userId: number, code: string, now = Date.now()): 'code' | 'recovery' | null {
    const r = this.row(userId);
    if (!r || r.totp_confirmed !== 1) return null;
    const digits = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(digits)) {
      const secret = this.box.open(r.totp_secret as string | null, userId);
      const step = secret ? matchTotp(base32Decode(secret), digits, now, Number(r.totp_last_step)) : null;
      if (step === null) return null;
      // a secret stored before a token was configured gets sealed now
      const sealed = String(r.totp_secret).startsWith('p1:') && this.box.sealing ? this.box.seal(secret!, userId) : (r.totp_secret as string);
      this.db.prepare('UPDATE users SET totp_last_step = ?, totp_secret = ? WHERE id = ?').run(step, sealed, userId);
      return 'code';
    }
    const normal = normalRecovery(code);
    if (!normal) return null;
    const want = Buffer.from(recoveryHash(normal));
    const hashes = JSON.parse(String(r.recovery_hashes)) as string[];
    let hit = -1;
    hashes.forEach((h, i) => {
      if (timingSafeEqual(Buffer.from(h), want) && hit < 0) hit = i;
    });
    if (hit < 0) return null;
    hashes.splice(hit, 1);
    this.db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), userId);
    return 'recovery';
  }

  /**
   * Name + password + code (password-only accounts ignore the code). The
   * password is always hashed, so a missing account takes as long as a wrong password.
   */
  verifyLogin(name: unknown, password: unknown, code: unknown, now = Date.now()): LoginResult | null {
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
    const r = typeof name === 'string' ? (this.db.prepare('SELECT * FROM users WHERE name_key = ?').get(nameKey(name)) as Row | undefined) : undefined;
    const stored = r?.password_hash as string | null | undefined;
    const passwordOk = verifyPassword(password, stored ?? (this.dummyHash ??= hashPassword(newToken())));
    if (!r || !stored || !passwordOk || r.totp_confirmed !== 1) return null;
    const factor = r.two_factor === 0 ? 'password' : typeof code === 'string' ? this.useSecondFactor(Number(r.id), code, now) : null;
    if (!factor) return null;
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, Number(r.id));
    return { user: this.user(Number(r.id))!, factor };
  }

  // ---------- sessions ----------

  /** A new session; the return value is the cookie value "a1.<token>". */
  createSession(userId: number, opts: { remember?: boolean; userAgent?: string } = {}, now = Date.now()): string {
    this.prune(now);
    const token = newToken();
    this.db
      .prepare('INSERT INTO sessions (token_hash, id, user_id, created, expires, last_seen, remember, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), randomBytes(6).toString('hex'), userId, now, now + SESSION_MAX_MS, now, opts.remember ? 1 : 0, (opts.userAgent ?? '').slice(0, 200));
    return `a1.${token}`;
  }

  private toSession(r: Row): Session {
    return {
      id: String(r.id),
      userId: Number(r.user_id),
      userName: String(r.name),
      created: Number(r.created),
      expires: Number(r.expires),
      lastSeen: Number(r.last_seen),
      remember: r.remember === 1,
      userAgent: String(r.user_agent),
    };
  }

  /** The session and its user for a cookie value, or null (unknown, expired or idle too long). */
  sessionUser(value: string | undefined, now = Date.now()): { session: Session; user: User } | null {
    const m = SESSION_VALUE.exec(value ?? '');
    if (!m) return null;
    const hash = sha256(m[1]!);
    const r = this.db
      .prepare('SELECT s.*, u.name, u.totp_confirmed FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(hash) as Row | undefined;
    if (!r) return null;
    const idle = r.remember === 1 ? REMEMBER_IDLE_MS : IDLE_MS;
    if (Number(r.expires) <= now || now - Number(r.last_seen) > idle || r.totp_confirmed !== 1) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    if (now - Number(r.last_seen) > TOUCH_MS) {
      this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
      r.last_seen = now;
    }
    return { session: this.toSession(r), user: this.user(Number(r.user_id))! };
  }

  /** For Sessions.valid() in auth.ts. */
  sessionValid(value: string, now = Date.now()): boolean {
    return this.sessionUser(value, now) !== null;
  }

  /** Drops sessions past their limits and links past their expiry. */
  private prune(now: number): void {
    this.db
      .prepare('DELETE FROM sessions WHERE expires <= ? OR last_seen < ? - CASE remember WHEN 1 THEN ? ELSE ? END')
      .run(now, now, REMEMBER_IDLE_MS, IDLE_MS);
    this.db.prepare('DELETE FROM setup_links WHERE expires <= ?').run(now);
  }

  sessions(userId?: number, now = Date.now()): Session[] {
    this.prune(now);
    const sql = `SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id${userId === undefined ? '' : ' WHERE s.user_id = ?'} ORDER BY s.last_seen DESC`;
    const rows = (userId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(userId)) as Row[];
    return rows.map((r) => this.toSession(r));
  }

  endSession(value: string | undefined): void {
    const m = SESSION_VALUE.exec(value ?? '');
    if (m) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(m[1]!));
  }

  endSessionById(id: string, userId?: number): void {
    if (userId === undefined) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    else this.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId);
  }

  /** Every session of the account, except (optionally) the one with this id. */
  endUserSessions(userId: number, exceptId?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId ?? '');
  }

  // ---------- lockouts ----------

  /** True while any of the keys (e.g. "ip:1.2.3.4", "name:alice") is locked out. */
  locked(keys: string[], now = Date.now()): boolean {
    return keys.some((k) => {
      const r = this.db.prepare('SELECT locked_until FROM attempts WHERE key = ?').get(k) as Row | undefined;
      return r !== undefined && Number(r.locked_until) > now;
    });
  }

  /** Counts a failure for each key; the fifth within 15 minutes locks that key for 15 minutes. */
  fail(keys: string[], now = Date.now()): void {
    for (const k of keys) {
      const r = this.db.prepare('SELECT fails, since, locked_until FROM attempts WHERE key = ?').get(k) as Row | undefined;
      const fresh = !r || now - Number(r.since) > LOCK_MS;
      const fails = (fresh ? 0 : Number(r.fails)) + 1;
      const since = fresh ? now : Number(r.since);
      const lockedUntil = fails >= LOCK_FAILS ? now + LOCK_MS : Number(r?.locked_until ?? 0);
      this.db
        .prepare('INSERT OR REPLACE INTO attempts (key, fails, since, locked_until) VALUES (?, ?, ?, ?)')
        .run(k, fails >= LOCK_FAILS ? 0 : fails, since, lockedUntil);
    }
    this.db.prepare('DELETE FROM attempts WHERE since < ? AND locked_until < ?').run(now - 24 * HOUR, now);
  }

  clearFails(keys: string[]): void {
    for (const k of keys) this.db.prepare('DELETE FROM attempts WHERE key = ?').run(k);
  }
}

/** The lockout key for an account name (whether or not it exists, so a lockout gives nothing away). */
export const nameLockKey = (name: unknown): string => `name:${typeof name === 'string' ? nameKey(name).slice(0, 64) : ''}`;
