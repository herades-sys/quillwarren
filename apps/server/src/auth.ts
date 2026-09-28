// Access control.
// - Scripts and MCP: the API token (Authorization: Bearer <token>, or ?token= on the WebSocket).
// - The browser editor: a password the user sets with `delve-passwd` (stored only as a scrypt hash),
//   which gets a signed session cookie. Cookie writes must come from the page's own origin.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(stored ?? '');
  if (!m) return false;
  const [, N, r, p, salt, hash] = m;
  const expected = Buffer.from(hash!, 'base64url');
  const got = scryptSync(password, Buffer.from(salt!, 'base64url'), expected.length, {
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

/** Signed "v1.<expires ms>.<hmac>" values. The key comes from the API token, so rotating it logs everyone out. */
export class Sessions {
  private readonly key: Buffer | null;
  /** Development only: treat every browser as logged in (DELVE_INSECURE_OPEN_EDIT=1). */
  readonly open: boolean;

  constructor(secret: string | undefined, open = false) {
    this.key = secret ? digest(`delve-session:${secret}`) : null;
    this.open = open;
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
    if (!this.key || !value) return false;
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

// ---------- login throttling ----------

/** After 5 wrong passwords from one address, refuse further tries for a minute. */
export class LoginThrottle {
  private readonly fails = new Map<string, { n: number; last: number }>();

  blocked(ip: string, now = Date.now()): boolean {
    const f = this.fails.get(ip);
    if (!f) return false;
    if (now - f.last > 60_000) {
      this.fails.delete(ip);
      return false;
    }
    return f.n >= 5;
  }

  fail(ip: string, now = Date.now()): void {
    const f = this.fails.get(ip);
    this.fails.set(ip, { n: (f && now - f.last <= 60_000 ? f.n : 0) + 1, last: now });
  }

  succeed(ip: string): void {
    this.fails.delete(ip);
  }
}
