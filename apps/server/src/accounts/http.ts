// Small request/response helpers shared by the login and the account pages.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie, SESSION_COOKIE } from '../auth.ts';
import { clientIp } from '../public.ts';
import type { EditorAuth } from '../login.ts';
import { SESSION_MAX_MS, type Session, type User } from './store.ts';

/**
 * The client's address for lockouts. Behind the Cloudflare tunnel every request
 * arrives from cloudflared on loopback, whose CF-Connecting-IP header names the
 * real client; from anywhere else that header is ignored, so it can't dodge a lockout.
 */
export const requestIp = (req: FastifyRequest): string => clientIp(req);

/** https directly, or through a proxy that says so (a wrong claim only makes the cookie Secure). */
export function isHttps(req: FastifyRequest): boolean {
  const fwd = req.headers['x-forwarded-proto'];
  return req.protocol === 'https' || (typeof fwd === 'string' && fwd.split(',')[0]!.trim().toLowerCase() === 'https');
}

/** The account behind the request's session cookie, if it is an account session. */
export function currentAccount(auth: EditorAuth, req: FastifyRequest): { user: User; session: Session } | null {
  return auth.accounts?.sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE)) ?? null;
}

/** Account sessions: a browser-session cookie, or 30 days with "keep me logged in". */
export function accountCookie(value: string, secure: boolean, remember: boolean): string {
  const age = remember ? `; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}` : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${age}${secure ? '; Secure' : ''}`;
}

/**
 * Account pages are never cached, framed or leaked to other sites through
 * Referer (setup links carry a token). Not "no-referrer": with it, browsers
 * send "Origin: null" on form posts, and the same-origin check refuses them.
 */
export function sendPage(reply: FastifyReply, code: number, html: string): FastifyReply {
  return reply
    .code(code)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'same-origin')
    .header('x-frame-options', 'DENY')
    .header('content-security-policy', "frame-ancestors 'none'")
    .send(html);
}

/** A path on this site to go back to: one leading slash, then printable ASCII without backslashes (browsers read "/\x" and "/<tab>/x" as another site). */
export const safeNext = (v: unknown): string => (typeof v === 'string' && /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/.test(v) ? v : '/');
