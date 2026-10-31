// The desktop app's gate. Its server listens on 127.0.0.1 only, but every
// program on the computer, and every web page open in any browser, can reach
// 127.0.0.1 too. So each request must also
// - carry the secret the Electron window was given at launch: the header
//   x-delve-desktop (added by the window's session to requests for this exact
//   origin) or the cookie delve_desktop (HttpOnly, SameSite=Strict, set in the
//   window's session) — nothing else ever sees it, and it is new each launch;
// - name this server in its Host header (127.0.0.1:<port> or localhost:<port>),
//   so a web page that points its own domain at 127.0.0.1 (DNS rebinding) is
//   refused even if it guessed the port;
// - when it says where it comes from (Origin), come from this server's own pages.
// Answers carry no CORS headers, so other web pages can't read them.
//
// Desktop only: desktop/main.ts adds it through buildApp's `extend`. The web
// server never loads this file.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { htmlDocument } from '@delve/ui';
import { readCookie } from '../auth.ts';

export const DESKTOP_HEADER = 'x-delve-desktop';
export const DESKTOP_COOKIE = 'delve_desktop';
/** At least 32 characters of base64url (the app makes 43: 32 random bytes). */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time comparison of the launch secret with what a request carries. */
export function secretMatches(secret: string, given: string | undefined): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(secret), digest(given));
}

/** The secret a request carries: the header, else the cookie. */
export function requestSecret(req: Pick<FastifyRequest, 'headers'>): string | undefined {
  const h = req.headers[DESKTOP_HEADER];
  if (typeof h === 'string' && h) return h;
  return readCookie(req.headers.cookie, DESKTOP_COOKIE);
}

/** The Host header names this server on loopback, with its port. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  const h = (host ?? '').toLowerCase();
  return port > 0 && (h === `127.0.0.1:${port}` || h === `localhost:${port}`);
}

/** No Origin (a plain navigation, or Electron's own requests), or this server's own. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === (host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Pages of the web server that mean nothing on one computer with one user: they go back to the library.
 * Delve Table, the players' screen and Discord login (/play, /api/v1/games, /maps/:id/screen,
 * /auth/discord) aren't here: the desktop app never registers them (buildApp's `multiplayer: false`), so they are 404s.
 */
const WEB_ONLY = [/^\/(login|logout)(\?|$)/, /^\/admin(\/|\?|$)/, /^\/account(\/|\?|$)/];

const REFUSED = 'This is the Delve app’s own server. It only answers the Delve window.';

/** Says no. A refused WebSocket upgrade also loses its connection: nothing else would close it, and it would hold the server open. */
function refuse(req: FastifyRequest, reply: FastifyReply, code: 401 | 403): FastifyReply {
  if (req.headers.upgrade !== undefined) reply.raw.once('finish', () => req.raw.socket?.destroy());
  return reply.code(code).header('connection', 'close').type('text/plain; charset=utf-8').send(REFUSED);
}

/** One more page for the desktop app: feature requests have no project page to go to yet. */
function feedbackPage(): string {
  return htmlDocument({
    title: 'Ideas and problems',
    body: `<main class="page narrow" style="padding:48px 20px;max-width:560px;margin:0 auto"><h1>Ideas and problems</h1>
<p>Delve on the desktop has no place to send feature requests yet. Until the project has a public page, write them down and pass them on to whoever gave you Delve.</p>
<p>When something goes wrong, the Help menu’s <b>Copy logs</b> puts what Delve wrote down on the clipboard, ready to paste into a message.</p>
<p><a class="btn btn-secondary" href="/">Back to the library</a></p></main>`,
  });
}

/**
 * The gate, as the first hook of every request (plain HTTP and WebSocket
 * upgrades alike), plus the desktop app's answers for web-only pages.
 * `port` is the port the server listens on (known once it is bound).
 */
export function registerDesktopGate(app: FastifyInstance, o: { secret: string; port: () => number }): void {
  if (!SECRET_PATTERN.test(o.secret)) throw new Error('the desktop secret must be at least 32 base64url characters');
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host;
    if (!hostAllowed(host, o.port())) return refuse(req, reply, 403);
    if (!secretMatches(o.secret, requestSecret(req))) return refuse(req, reply, 401);
    if (!originAllowed(req.headers.origin, host)) return refuse(req, reply, 403);
    const path = req.url;
    if (WEB_ONLY.some((re) => re.test(path))) {
      return req.method === 'GET' || req.method === 'HEAD' ? reply.redirect('/', 303) : reply.code(404).send({ error: 'not in the desktop app' });
    }
    // MCP needs the API token, which the desktop app doesn't have: say so plainly
    if (/^\/mcp(\/|\?|$)/.test(path)) return reply.code(404).send({ error: 'MCP is not available in the desktop app yet' });
    if (/^\/feedback(\?|$)/.test(path)) {
      return req.method === 'GET' ? reply.type('text/html; charset=utf-8').send(feedbackPage()) : reply.code(404).send({ error: 'not in the desktop app' });
    }
  });
  // Nothing from here goes into a frame, or is read by another site or as another type.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
}
