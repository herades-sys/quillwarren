// Who is asking, for a game: the GM (Delve's editor login, or the API token),
// or a player holding the signed cookie delve_player_<gameId> = <memberId>.<hmac>.
// Invite links carry an HMAC-signed token with the game, the invite and the expiry.
// The HMAC key comes from the API token (like the editor sessions), or is random
// per process when there is none (development servers).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { GameState, Member } from '@delve/table';
import { bearer, checkToken, readCookie, sameOrigin } from '../auth.ts';
import { isLoggedIn, type EditorAuth } from '../login.ts';

export const PLAYER_COOKIE_DAYS = 30;
export const playerCookieName = (gameId: string): string => `delve_player_${gameId}`;

/** Game ids end up in cookie names and URLs, so keep them plain. */
export const GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface InviteClaim {
  g: string;
  i: string;
  e: number;
}

const sameMac = (a: string, b: string): boolean => {
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
}

/** True for the GM: a logged-in editor (writes also need the same origin) or the API token. */
export function isGm(deps: AccessDeps, req: FastifyRequest, opts: { write?: boolean; queryToken?: string } = {}): boolean {
  if (checkToken(deps.token, bearer(req.headers.authorization)) === 'ok') return true;
  if (opts.queryToken !== undefined && checkToken(deps.token, opts.queryToken) === 'ok') return true;
  if (!isLoggedIn(deps.auth, req)) return false;
  return !opts.write || sameOrigin(req.headers.origin, req.headers.host);
}

/**
 * The member this request acts as in a game, or null. A valid player cookie for
 * the game wins over the GM login, so the GM can try the game as a player
 * (GET /play/:gameId/leave drops it again).
 */
export function memberOf(deps: AccessDeps, req: FastifyRequest, state: GameState, opts: { write?: boolean; queryToken?: string } = {}): Member | null {
  const playerId = deps.keys.readPlayer(state.id, readCookie(req.headers.cookie, playerCookieName(state.id)), (m) => deps.seatNonce(state.id, m));
  if (playerId) {
    const member = state.members.find((m) => m.id === playerId && m.role === 'player');
    if (member) return opts.write && !sameOrigin(req.headers.origin, req.headers.host) ? null : member;
  }
  if (isGm(deps, req, opts)) return state.members.find((m) => m.role === 'gm') ?? null;
  return null;
}
