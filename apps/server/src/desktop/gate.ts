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
// One more caller, only while the user has connected Claude Desktop (Help →
// Connect to Claude Desktop…): the Quillwarren extension's bridge in Claude Desktop
// (apps/desktop/claude-extension) reaches /mcp, and nothing else, with its own
// per-install key as "Authorization: Bearer <key>" — never the window's secret.
// The same Host check applies, it must send no Origin (browsers always do on
// these requests), and only the methods MCP's Streamable HTTP transport uses.
//
// Desktop only: desktop/main.ts adds it through buildApp's `extend`. The web
// server never loads this file.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { htmlDocument } from '@delve/ui';
import { bearer, readCookie } from '../auth.ts';

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
 * Quillwarren Table, the players' screen and Discord login (/play, /api/v1/games, /maps/:id/screen,
 * /auth/discord) aren't here: the desktop app never registers them (buildApp's `multiplayer: false`), so they are 404s.
 */
const WEB_ONLY = [/^\/(login|logout)(\?|$)/, /^\/admin(\/|\?|$)/, /^\/account(\/|\?|$)/];

const REFUSED = 'This is the Quillwarren app’s own server. It only answers the Quillwarren window.';

/** Says no. A refused WebSocket upgrade also loses its connection: nothing else would close it, and it would hold the server open. */
function refuse(req: FastifyRequest, reply: FastifyReply, code: 401 | 403): FastifyReply {
  if (req.headers.upgrade !== undefined) reply.raw.once('finish', () => req.raw.socket?.destroy());
  return reply.code(code).header('connection', 'close').type('text/plain; charset=utf-8').send(REFUSED);
}

/** Where ideas and problems go. */
export const FEEDBACK_ISSUES_URL = 'https://github.com/herades-sys/quillwarren/issues';

/** One more page for the desktop app: feature requests go to the project's public issue tracker (the app opens other sites in the user's browser). */
function feedbackPage(): string {
  return htmlDocument({
    title: 'Ideas and problems',
    body: `<main class="page narrow" style="padding:48px 20px;max-width:560px;margin:0 auto"><h1>Ideas and problems</h1>
<p>Ideas, feature requests and problems go on the project’s public page: <a href="${FEEDBACK_ISSUES_URL}">github.com/herades-sys/quillwarren/issues</a>. The link opens in your browser.</p>
<p>When something goes wrong, the Help menu’s <b>Copy logs</b> puts what Quillwarren wrote down on the clipboard, ready to paste into a message.</p>
<p><a class="btn btn-secondary" href="/">Back to the library</a></p></main>`,
  });
}

/** The MCP endpoint, exactly (no sub-paths). */
export const MCP_PATH = /^\/mcp(\?|$)/;
/** What MCP's Streamable HTTP transport sends: POST for messages, GET for a stream, DELETE to end a session. */
export const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);

/** Claude Desktop's access to /mcp (Help → Connect to Claude Desktop…). */
export interface ClaudeDesktopAccess {
  /** The per-install key while connected, null while not. */
  key(): string | null;
  /** Called for each request let in with the key, so /mcp can tell it from the rest (buildApp's `mcpGrant`). */
  grant(req: FastifyRequest): void;
}

/** Added to the MCP instructions in the desktop app (buildApp's `mcpNote`): links open only inside the app. */
export const CLAUDE_DESKTOP_NOTE =
  "This Quillwarren is the desktop app on the user's own computer: the user watches the open map change in the Quillwarren window. Links in tool results (viewer pages, exports) open only inside the Quillwarren app, so don't offer them as links; use focus to show the user what you changed, and point them to Quillwarren's Export menu for files.";

/** Where the chat settings ask the app for its "Connect to Claude Desktop…" dialog. */
export const CLAUDE_DESKTOP_CONNECT = '/api/v1/desktop/claude-desktop/connect';

/**
 * The chat settings' Claude Desktop box: whether it is connected (for the
 * settings view, local-chat's `extra`) and POST CLAUDE_DESKTOP_CONNECT, which
 * asks the app over IPC to show the same dialog as Help → Connect to Claude
 * Desktop…, so nothing connects without the user's click there. Behind the
 * gate like every route, so only the window reaches it.
 */
export function registerClaudeDesktopConnect(app: FastifyInstance, o: { connected: () => boolean; askApp: () => boolean }): () => Record<string, unknown> {
  app.post(CLAUDE_DESKTOP_CONNECT, async (_req, reply) => {
    if (!o.askApp()) return reply.code(503).send({ error: 'Quillwarren couldn’t reach its window: choose Help → Connect to Claude Desktop… instead' });
    return reply.code(202).send({ ok: true });
  });
  return () => ({ claudeDesktop: { connected: o.connected(), connect: CLAUDE_DESKTOP_CONNECT } });
}

/** A JSON-RPC error body, so an MCP client shows the reason rather than a bare status. */
const rpcRefusal = (message: string) => ({ jsonrpc: '2.0', id: null, error: { code: -32001, message } });

/**
 * A request for /mcp that carries a bearer key and not the window's secret:
 * Claude Desktop's bridge, let in only with the right key while connected.
 * Returns undefined when it passes (and grants it), else the refusal sent.
 */
function claudeDesktopRequest(req: FastifyRequest, reply: FastifyReply, access: ClaudeDesktopAccess | undefined, given: string): FastifyReply | undefined {
  const refuseMcp = (code: 401 | 403 | 405, message: string) => {
    if (req.headers.upgrade !== undefined) reply.raw.once('finish', () => req.raw.socket?.destroy());
    return reply.code(code).header('connection', 'close').send(rpcRefusal(message));
  };
  if (req.headers.upgrade !== undefined) return refuseMcp(403, 'not a WebSocket endpoint');
  if (req.headers.origin !== undefined) return refuseMcp(403, 'Quillwarren’s MCP endpoint takes no requests from web pages');
  if (!MCP_METHODS.has(req.method)) return refuseMcp(405, 'MCP uses POST, GET and DELETE');
  const key = access?.key() ?? null;
  if (!key) return refuseMcp(401, 'Quillwarren isn’t connected to Claude Desktop: in Quillwarren, choose Help → Connect to Claude Desktop…');
  if (!secretMatches(key, given)) return refuseMcp(401, 'Quillwarren refused this key: in Quillwarren, choose Help → Connect to Claude Desktop… again');
  access!.grant(req);
  return undefined;
}

/**
 * The gate, as the first hook of every request (plain HTTP and WebSocket
 * upgrades alike), plus the desktop app's answers for web-only pages.
 * `port` is the port the server listens on (known once it is bound).
 * `claudeDesktop`: the Claude Desktop key for /mcp (see the top of this file).
 */
export function registerDesktopGate(app: FastifyInstance, o: { secret: string; port: () => number; claudeDesktop?: ClaudeDesktopAccess }): void {
  if (!SECRET_PATTERN.test(o.secret)) throw new Error('the desktop secret must be at least 32 base64url characters');
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host;
    if (!hostAllowed(host, o.port())) return refuse(req, reply, 403);
    const windowSecret = requestSecret(req);
    // Claude Desktop's bridge: /mcp only, its own key only (a key anywhere else meets the secret check below and fails)
    const key = bearer(req.headers.authorization);
    if (MCP_PATH.test(req.url) && key !== undefined && windowSecret === undefined) {
      const refused = claudeDesktopRequest(req, reply, o.claudeDesktop, key);
      if (refused) return refused;
      return;
    }
    if (!secretMatches(o.secret, windowSecret)) return refuse(req, reply, 401);
    if (!originAllowed(req.headers.origin, host)) return refuse(req, reply, 403);
    const path = req.url;
    if (WEB_ONLY.some((re) => re.test(path))) {
      return req.method === 'GET' || req.method === 'HEAD' ? reply.redirect('/', 303) : reply.code(404).send({ error: 'not in the desktop app' });
    }
    // MCP is for Claude Desktop's bridge with its own key (above), never for the window
    if (/^\/mcp(\/|\?|$)/.test(path)) return reply.code(404).send({ error: 'MCP is for Claude Desktop: in Quillwarren, choose Help → Connect to Claude Desktop…' });
    if (/^\/feedback(\?|$)/.test(path)) {
      return req.method === 'GET' ? reply.type('text/html; charset=utf-8').send(feedbackPage()) : reply.code(404).send({ error: 'not in the desktop app' });
    }
  });
  // Nothing from here goes into a frame, or is read by another site or as another type.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cross-origin-resource-policy', 'same-origin');
    // Not "no-referrer": with it, browsers send "Origin: null" on form posts (the library's New map), and the check above refuses them.
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });
}
