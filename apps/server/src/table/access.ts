// Who is asking, for a game: the GM (Quillwarren's editor login, the API token, or a
// Discord account listed in DELVE_GM_DISCORD_IDS), a player holding the signed
// cookie delve_player_<gameId> = <memberId>.<hmac>, or a player whose Discord
// account (cookie delve_account) is linked to a seat in the game.
// Invite links carry an HMAC-signed token with the game, the invite and the expiry.
// The HMAC key comes from the API token (like the editor sessions), or is random
// per process when there is none (development servers).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { GameState, Member } from '@delve/table';
import { bearer, checkToken, readCookie, sameOrigin } from '../auth.ts';
import { isLoggedIn, type EditorAuth } from '../login.ts';
import type { Account } from './store.ts';

export const PLAYER_COOKIE_DAYS = 30;
export const playerCookieName = (gameId: string): string => `delve_player_${gameId}`;

/** Game ids end up in cookie names and URLs, so keep them plain. */
export const GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface InviteClaim {
  g: string;
  i: string;
  e: number;
}

export const sameMac = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class TableKeys {
  private readonly key: Buffer;

  constructor(secret: string | undefined) {
    this.key = secret ? createHash('sha256').update(`delve-table:${secret}`).digest() : randomBytes(32);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  // ---------- invites ----------

  inviteToken(claim: InviteClaim): string {
    const payload = Buffer.from(JSON.stringify({ g: claim.g, i: claim.i, e: claim.e })).toString('base64url');
    return `${payload}.${this.mac(`invite:${payload}`)}`;
  }

  /** The claim if the signature is right; expiry and revocation are the caller's to check against the game. */
  readInvite(token: string): InviteClaim | null {
    const m = /^([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m || !sameMac(this.mac(`invite:${m[1]!}`), m[2]!)) return null;
    try {
      const c = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as Partial<InviteClaim>;
      if (typeof c.g !== 'string' || typeof c.i !== 'string' || typeof c.e !== 'number') return null;
      return { g: c.g, i: c.i, e: c.e };
    } catch {
      return null;
    }
  }

  // ---------- other signed values (the Discord login's state cookie) ----------

  /** JSON signed for one purpose: "<base64url json>.<hmac>". */
  seal(purpose: string, data: object): string {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${this.mac(`${purpose}:${payload}`)}`;
  }

  /** The JSON of a sealed value if its signature is right for `purpose`, else null. */
  unseal(purpose: string, value: string | undefined): Record<string, unknown> | null {
    const m = /^([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!m || !sameMac(this.mac(`${purpose}:${m[1]!}`), m[2]!)) return null;
    try {
      const v = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as unknown;
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // ---------- player cookies ----------

  playerValue(gameId: string, memberId: string, nonce: string): string {
    return `${memberId}.${this.mac(`player:${gameId}:${memberId}:${nonce}`)}`;
  }

  /** The member id in a player cookie, if its signature matches that member's current seat. */
  readPlayer(gameId: string, value: string | undefined, nonceOf: (memberId: string) => string | undefined): string | null {
    const m = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!m) return null;
    const nonce = nonceOf(m[1]!);
    if (!nonce || !sameMac(this.mac(`player:${gameId}:${m[1]!}:${nonce}`), m[2]!)) return null;
    return m[1]!;
  }
}

export function playerCookie(gameId: string, value: string, secure: boolean): string {
  return `${playerCookieName(gameId)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PLAYER_COOKIE_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

export function clearPlayerCookie(gameId: string): string {
  return `${playerCookieName(gameId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Game ids of every player cookie the browser sent (signatures unchecked). */
export function playerCookieGames(header: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const k = part.trim().split('=')[0] ?? '';
    if (k.startsWith('delve_player_') && GAME_ID.test(k.slice(13))) out.push(k.slice(13));
  }
  return out;
}

export interface AccessDeps {
  auth: EditorAuth;
  token: string | undefined;
  keys: TableKeys;
  seatNonce: (gameId: string, memberId: string) => string | undefined;
  /** The account of the request's delve_account session, if any (only with Discord login set up). */
  accountOf?: (req: FastifyRequest) => Account | null;
  /** Discord user ids who are GM of every game (DELVE_GM_DISCORD_IDS). */
  gmDiscordIds?: ReadonlySet<string>;
}

/** True when the request's Discord account is one of the co-GMs. */
export function isGmAccount(deps: AccessDeps, req: FastifyRequest): boolean {
  if (!deps.gmDiscordIds?.size) return false;
  const account = deps.accountOf?.(req);
  return Boolean(account && deps.gmDiscordIds.has(account.discordId));
}

/** True for the GM: a logged-in editor or co-GM account (writes also need the same origin), or the API token. */
export function isGm(deps: AccessDeps, req: FastifyRequest, opts: { write?: boolean; queryToken?: string } = {}): boolean {
  if (checkToken(deps.token, bearer(req.headers.authorization)) === 'ok') return true;
  if (opts.queryToken !== undefined && checkToken(deps.token, opts.queryToken) === 'ok') return true;
  if (!isLoggedIn(deps.auth, req) && !isGmAccount(deps, req)) return false;
  return !opts.write || sameOrigin(req.headers.origin, req.headers.host);
}

/** The player seat in a game that belongs to an account, if any. */
export const accountSeat = (state: GameState, accountId: string): Member | undefined =>
  state.members.find((m) => m.role === 'player' && m.accountId === accountId);

/**
 * The member this request acts as in a game, or null. First a valid player
 * cookie for the game, then a seat linked to the request's Discord account,
 * then the GM. So the GM can try the game as a player (GET /play/:gameId/leave
 * drops the cookie again), and a player's second device needs no new invite.
 */
export function memberOf(deps: AccessDeps, req: FastifyRequest, state: GameState, opts: { write?: boolean; queryToken?: string } = {}): Member | null {
  const crossSite = opts.write === true && !sameOrigin(req.headers.origin, req.headers.host);
  const playerId = deps.keys.readPlayer(state.id, readCookie(req.headers.cookie, playerCookieName(state.id)), (m) => deps.seatNonce(state.id, m));
  if (playerId) {
    const member = state.members.find((m) => m.id === playerId && m.role === 'player');
    if (member) return crossSite ? null : member;
  }
  const account = deps.accountOf?.(req);
  if (account) {
    const member = accountSeat(state, account.id);
    if (member) return crossSite ? null : member;
  }
  if (isGm(deps, req, opts)) return state.members.find((m) => m.role === 'gm') ?? null;
  return null;
}
