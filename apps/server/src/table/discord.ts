// "Log in with Discord" for Quillwarren Table players (docs/TABLE.md, "Discord login").
// OAuth2 authorization code flow with the `identify` scope only:
//   GET /auth/discord?next=/path   → a signed 10-minute state cookie, then off to Discord
//   GET /auth/discord/callback     → check the state, swap the code for a token, read
//                                    /users/@me, forget the token, start an account session
//   POST /auth/logout              → end the session (GET shows a button for it)
// The account session is a random token in the cookie delve_account; the
// database keeps only its SHA-256. Codes, tokens, the client secret and
// cookies are never logged (app.ts masks code= and state= in logged URLs).
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readCookie, sameOrigin } from '../auth.ts';
import { sameMac, type TableKeys } from './access.ts';
import { sniffImage, type TableAssets } from './assets.ts';
import { esc, messagePage, shell } from './html.ts';
import { ACCOUNT_SESSION_DAYS, type Account, type TableStore } from './store.ts';

export interface DiscordConfig {
  /** DELVE_DISCORD_CLIENT_ID and DELVE_DISCORD_CLIENT_SECRET, from the Discord developer portal. */
  clientId: string;
  clientSecret: string;
  /** DELVE_PUBLIC_URL (e.g. https://table.example): the base of the redirect URI. Without it, the address the browser used. */
  publicUrl?: string;
  /** DELVE_GM_DISCORD_IDS: Discord user ids who are GM of every game. */
  gmIds?: string[];
  /** DELVE_DISCORD_API, default https://discord.com/api. Tests point it at a fake. */
  api?: string;
  /** DELVE_DISCORD_CDN, default https://cdn.discordapp.com (where avatars are fetched from once per change). */
  cdn?: string;
}

export const ACCOUNT_COOKIE = 'delve_account';
const STATE_COOKIE = 'delve_discord_state';
const STATE_PURPOSE = 'discord-state';
const STATE_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 1024 * 1024;
const DEFAULT_API = 'https://discord.com/api';
const DEFAULT_CDN = 'https://cdn.discordapp.com';
const USER_AGENT = 'QuillwarrenTable (self-hosted, 1)';

const trimSlash = (s: string): string => s.replace(/\/+$/, '');
const apiBase = (c: DiscordConfig): string => trimSlash(c.api || DEFAULT_API);
// The consent page lives on discord.com itself; a fake API (tests) serves it too.
const authorizeBase = (c: DiscordConfig): string => (apiBase(c) === DEFAULT_API ? 'https://discord.com/oauth2/authorize' : `${apiBase(c)}/oauth2/authorize`);

/** DELVE_PUBLIC_URL as an origin ("https://table.example"), or undefined when it's unset or not an http(s) URL. */
export function parsePublicUrl(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Discord user ids from DELVE_GM_DISCORD_IDS ("123, 456"); anything that isn't a snowflake is dropped. */
export function parseDiscordIds(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,25}$/.test(s));
}

/**
 * A path on this site to go back to after logging in: starts with one "/",
 * no "//" or "\" (browsers read "/\evil" as "//evil"), printable ASCII only.
 */
export function localPath(v: unknown, fallback = '/play'): string {
  if (typeof v !== 'string' || v.length > 1024) return fallback;
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(v) || v.includes('\\')) return fallback;
  return v;
}

export const discordLoginUrl = (next: string): string => `/auth/discord?next=${encodeURIComponent(localPath(next))}`;

/** A member's picture for an account in one game: the stored avatar, served as that game's asset. */
export const avatarUrl = (gameId: string, account: Pick<Account, 'avatarFile'>): string | undefined =>
  account.avatarFile ? `/api/v1/games/${encodeURIComponent(gameId)}/assets/${account.avatarFile}` : undefined;

/** A Discord display name as a member name: single spaces, no control or bidi characters, at most 40. */
export function displayName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim() : '';
  // 40 UTF-16 units like the member-name check, without cutting an emoji in half
  const chars = [...s];
  while (chars.join('').length > 40) chars.pop();
  return chars.join('').trim();
}

export function accountCookie(token: string, secure: boolean): string {
  return `${ACCOUNT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACCOUNT_SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

export function clearAccountCookie(): string {
  return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Lax: the cookie has to come along when Discord sends the browser back (a top-level GET).
const stateCookie = (value: string, secure: boolean): string =>
  `${STATE_COOKIE}=${value}; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=${STATE_MS / 1000}${secure ? '; Secure' : ''}`;
const clearStateCookie = (): string => `${STATE_COOKIE}=; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=0`;

export interface DiscordUser {
  discordId: string;
  username: string;
  name: string;
  avatar: string | null;
}

/** A failed call to Discord: which step and the HTTP status (0 for a network error or timeout). Nothing else, so it can be logged. */
export class DiscordError extends Error {
  readonly step: string;
  readonly status: number;
  constructor(step: string, status: number) {
    super(`Discord ${step} failed (${status || 'no answer'})`);
    this.step = step;
    this.status = status;
  }
}

async function call(step: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new DiscordError(step, 0);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new DiscordError(step, res.status);
  }
  return res;
}

async function json(step: string, res: Response): Promise<Record<string, unknown>> {
  try {
    const v = (await res.json()) as unknown;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* falls through */
  }
  throw new DiscordError(step, res.status);
}

/** Swap an authorization code for the user's id, names and avatar hash. The access token is used once and dropped. */
export async function fetchDiscordUser(c: DiscordConfig, code: string, redirectUri: string): Promise<DiscordUser> {
  const tokenRes = await call('token', `${apiBase(c)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  const tok = await json('token', tokenRes);
  if (typeof tok.access_token !== 'string' || !tok.access_token) throw new DiscordError('token', tokenRes.status);
  const meRes = await call('user', `${apiBase(c)}/users/@me`, {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json', 'user-agent': USER_AGENT },
  });
  const me = await json('user', meRes);
  const id = typeof me.id === 'string' && /^\d{5,25}$/.test(me.id) ? me.id : null;
  const username = displayName(me.username);
  if (!id || !username) throw new DiscordError('user', meRes.status);
  const avatar = typeof me.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(me.avatar) ? me.avatar : null;
  return { discordId: id, username, name: displayName(me.global_name) || username, avatar };
}

/** The avatar picture (128 px PNG), or null if Discord doesn't hand it over. */
async function fetchAvatar(c: DiscordConfig, discordId: string, hash: string): Promise<Buffer | null> {
  try {
    const res = await call('avatar', `${trimSlash(c.cdn || DEFAULT_CDN)}/avatars/${discordId}/${hash}.png?size=128`, { headers: { 'user-agent': USER_AGENT } });
    if (Number(res.headers.get('content-length') ?? 0) > MAX_AVATAR_BYTES) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= MAX_AVATAR_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export interface DiscordDeps {
  config: DiscordConfig;
  store: TableStore;
  keys: TableKeys;
  assets: TableAssets;
  log: FastifyBaseLogger;
  /** After a login, with the fresh account: the routes update that account's member pictures. */
  onLogin: (account: Account) => void;
}

const page = (reply: FastifyReply, code: number, body: string) =>
  reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

export function registerDiscord(app: FastifyInstance, deps: DiscordDeps): void {
  const { config, store, keys, assets } = deps;
  const pub = parsePublicUrl(config.publicUrl);
  const pubUrl = pub ? new URL(pub) : undefined;
  const secure = (req: FastifyRequest): boolean =>
    req.protocol === 'https' || (pubUrl?.protocol === 'https:' && pubUrl.host === req.headers.host);

  const failed = (reply: FastifyReply, code: number, title: string, text: string, next: string) =>
    page(reply, code, messagePage(title, [text], [{ href: discordLoginUrl(next), text: 'Try again' }, { href: next, text: 'Back' }]));

  // Each state works once, even if its cookie were replayed (state → its expiry).
  // A flood only pushes out the oldest entries; replaying those still needs their cookie.
  const used = new Map<string, number>();
  const useState = (state: string, expires: number): boolean => {
    const now = Date.now();
    for (const [s, e] of used) if (e < now) used.delete(s);
    if (used.has(state)) return false;
    while (used.size >= 10_000) used.delete(used.keys().next().value!);
    used.set(state, expires);
    return true;
  };

  app.get('/auth/discord', async (req, reply) => {
    const next = localPath((req.query as { next?: unknown }).next);
    // the state cookie has to be set on the host Discord sends the browser back to
    if (pubUrl && pubUrl.host !== req.headers.host) return reply.redirect(`${pub}/auth/discord?next=${encodeURIComponent(next)}`, 302);
    const redirectUri = `${pub ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`}/auth/discord/callback`;
    const state = randomBytes(18).toString('base64url');
    const sealed = keys.seal(STATE_PURPOSE, { s: state, e: Date.now() + STATE_MS, n: next, r: redirectUri });
    const q = new URLSearchParams({ client_id: config.clientId, response_type: 'code', scope: 'identify', redirect_uri: redirectUri, state, prompt: 'none' });
    return reply
      .header('set-cookie', stateCookie(sealed, secure(req)))
      .header('cache-control', 'no-store')
      .redirect(`${authorizeBase(config)}?${q.toString()}`, 302);
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const st = keys.unseal(STATE_PURPOSE, readCookie(req.headers.cookie, STATE_COOKIE));
    const valid = st && typeof st.s === 'string' && typeof st.e === 'number' && typeof st.n === 'string' && typeof st.r === 'string' ? { s: st.s, e: st.e, n: st.n, r: st.r } : null;
    const next = valid ? localPath(valid.n) : '/play';
    void reply.header('set-cookie', clearStateCookie()); // one try per state

    if (q.error === 'access_denied') {
      return failed(reply, 403, 'Not logged in', "You didn't allow Quillwarren Table to see your Discord name, so you're not logged in. You can try again, or go back.", next);
    }
    if (q.error !== undefined) return failed(reply, 502, 'Discord login did not work', 'Discord did not log you in. Try again in a moment.', next);
    if (!valid || valid.e < Date.now() || typeof q.state !== 'string' || !sameMac(q.state, valid.s) || !useState(valid.s, valid.e)) {
      return failed(reply, 400, 'Login expired', 'This login took too long, or it was started in another tab or browser. Try again.', next);
    }
    if (typeof q.code !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(q.code)) {
      return failed(reply, 400, 'Discord login did not work', 'Discord sent the browser back without a login code. Try again.', next);
    }

    let user: DiscordUser;
    try {
      user = await fetchDiscordUser(config, q.code, valid.r);
    } catch (e) {
      const d = e instanceof DiscordError ? { step: e.step, status: e.status } : { step: 'unknown', status: 0 };
      deps.log.warn(d, 'Discord login failed');
      return failed(reply, 502, 'Discord login did not work', "Discord didn't confirm who you are. Try again in a moment.", next);
    }

    // The picture is fetched once per avatar change and kept as a table asset, so the
    // pages never point at Discord's CDN (its URLs carry the Discord user id). The
    // hash is stored only with its picture, so a failed download is tried again next time.
    const before = store.accountByDiscord(user.discordId);
    let avatar = { hash: before?.avatar ?? null, file: before?.avatarFile ?? null };
    if (!user.avatar) avatar = { hash: null, file: null };
    else if (avatar.hash !== user.avatar || !avatar.file || !assets.get(avatar.file)) {
      const bytes = await fetchAvatar(config, user.discordId, user.avatar);
      const ext = bytes ? sniffImage(bytes) : null;
      if (bytes && ext) avatar = { hash: user.avatar, file: assets.put(bytes, ext) };
    }
    const account = { ...store.upsertAccount({ ...user, avatar: avatar.hash }), avatarFile: avatar.file };
    if (avatar.file !== (before?.avatarFile ?? null)) store.setAvatarFile(account.id, avatar.file);
    deps.onLogin(account);
    const token = store.createAccountSession(account.id);
    return reply.header('set-cookie', [clearStateCookie(), accountCookie(token, secure(req))]).redirect(next, 303);
  });

  app.get('/auth/logout', async (req, reply) => {
    const next = localPath((req.query as { next?: unknown }).next);
    return page(
      reply,
      200,
      shell(
        'Log out · Quillwarren Table',
        `<main class="page narrow"><h1>Log out</h1><form class="card" method="post" action="/auth/logout">
  <p>Log out of your Discord login on this device? Games you joined with it stay yours; log in again to get back to them.</p>
  <input type="hidden" name="next" value="${esc(next)}">
  <p class="links"><button class="button primary" type="submit">Log out</button> <a class="button" href="${esc(next)}">Cancel</a></p>
</form></main>`,
      ),
    );
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) return page(reply, 403, messagePage('Not allowed', ['Log out from Quillwarren Table itself.']));
    store.deleteAccountSession(readCookie(req.headers.cookie, ACCOUNT_COOKIE));
    const next = localPath((req.body as { next?: unknown } | undefined)?.next);
    return reply.header('set-cookie', clearAccountCookie()).redirect(next, 303);
  });
}
