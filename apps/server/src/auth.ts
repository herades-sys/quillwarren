// Access control.
// - Scripts and MCP: the API token (Authorization: Bearer <token>, or ?token= on the WebSocket).
// - The browser editor: admin and GM accounts (accounts/, name + password + authenticator code)
//   with server-side sessions. Until the first admin account exists, the shared password the
//   user sets with `delve-passwd` (stored only as a scrypt hash) gets a signed session cookie.
//   Cookie writes must come from the page's own origin.
import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export type TokenCheck = 'ok' | 'missing' | 'wrong' | 'unconfigured';

/** Compare in constant time; hashing first makes the lengths equal. */
export function checkToken(expected: string | undefined, given: string | undefined): TokenCheck {
  if (!expected) return 'unconfigured';
  if (!given) return 'missing';
  return timingSafeEqual(digest(expected), digest(given)) ? 'ok' : 'wrong';
}

/** Token from "Authorization: Bearer <token>". */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1];
}

// ---------- editor password ----------

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** "scrypt:N:r:p:salt:hash" (base64url; no "$", so it's safe in a systemd EnvironmentFile). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

/** crypto.scrypt as a promise: it runs on libuv's thread pool, so checking a password never holds up the event loop. */
const scryptAsync = (password: string, salt: Buffer, keylen: number, o: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, keylen, o, (err, key) => (err ? reject(err) : resolve(key))));

/** A password against its stored hash, compared in constant time; the hashing runs off the event loop (about 25 ms each). */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(stored ?? '');
  if (!m) return false;
  const [, N, r, p, salt, hash] = m;
  const expected = Buffer.from(hash!, 'base64url');
  const got = await scryptAsync(password, Buffer.from(salt!, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------- sessions ----------

export const SESSION_COOKIE = 'delve_session';
const SESSION_DAYS = 30;

/** The account store's side of session checks (see accounts/store.ts). */
export interface AccountSessions {
  /** An account session cookie value ("a1.<token>") that is still live. */
  sessionValid(value: string, now?: number): boolean;
  /** True once an admin account exists: the shared-password cookies stop counting. */
  legacyOff(): boolean;
}

/**
 * Checks the delve_session cookie. Account sessions ("a1.<token>") live in the
 * account store. Shared-password sessions are signed "v1.<expires ms>.<hmac>"
 * values (the key comes from the API token, so rotating it logs them out), and
 * count only until the first admin account is set up.
 */
export class Sessions {
  private readonly key: Buffer | null;
  /** Development only: treat every browser as logged in (DELVE_INSECURE_OPEN_EDIT=1). */
  readonly open: boolean;
  private accounts: AccountSessions | undefined;

  constructor(secret: string | undefined, open = false) {
    this.key = secret ? digest(`delve-session:${secret}`) : null;
    this.open = open;
  }

  useAccounts(accounts: AccountSessions): void {
    this.accounts = accounts;
  }

  /** The shared-password login is switched off (an admin account exists). */
  get legacyOff(): boolean {
    return this.accounts?.legacyOff() ?? false;
  }

  get enabled(): boolean {
    return this.key !== null || this.open;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key!).update(payload).digest('base64url');
  }

  issue(now = Date.now()): string {
    if (!this.key) throw new Error('sessions need DELVE_API_TOKEN');
    const payload = `v1.${now + SESSION_DAYS * 86_400_000}`;
    return `${payload}.${this.sign(payload)}`;
  }

  valid(value: string | undefined, now = Date.now()): boolean {
    if (this.open) return true;
    if (!value) return false;
    if (value.startsWith('a1.')) return this.accounts?.sessionValid(value, now) ?? false;
    if (!this.key || this.legacyOff) return false;
    const m = /^(v1\.(\d+))\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!m || Number(m[2]) < now) return false;
    const want = Buffer.from(this.sign(m[1]!));
    const got = Buffer.from(m[3]!);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  cookie(value: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
  }

  static clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** True unless the request says it comes from another site. Browsers send Origin on POST and on WebSocket upgrades. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
