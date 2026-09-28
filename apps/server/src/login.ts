// Editor login: a password (set by the user with `sudo delve-passwd` on the
// container) buys a 30-day session cookie.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginThrottle, readCookie, SESSION_COOKIE, Sessions, verifyPassword } from './auth.ts';

export interface EditorAuth {
  sessions: Sessions;
  passwordHash: string | undefined;
}

export const isLoggedIn = (auth: EditorAuth, req: FastifyRequest): boolean =>
  auth.sessions.valid(readCookie(req.headers.cookie, SESSION_COOKIE));

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeNext = (v: unknown): string => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in · Delve</title>
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root { --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4; --accent: #2C6AA0; --accent-ink: #FFFFFF; --bad: #B3261E; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; --bad: #F2B8B5; color-scheme: dark; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; padding: 20px; box-sizing: border-box; }
  main { width: 100%; max-width: 360px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 28px; display: grid; gap: 14px; }
  h1 { font: 400 2.2rem/1 "IM FELL English", Georgia, serif; margin: 0; }
  p { margin: 0; color: var(--muted); }
  label { display: grid; gap: 6px; font-weight: 500; }
  input { font: inherit; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); }
  button { font: inherit; font-weight: 600; padding: 9px 14px; border-radius: 8px; border: 0; background: var(--accent); color: var(--accent-ink); cursor: pointer; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { color: var(--bad); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; }
  a { color: var(--accent); }
</style></head><body><main>${body}</main></body></html>`;
}

export function registerLogin(app: FastifyInstance, auth: EditorAuth): void {
  const throttle = new LoginThrottle();

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as { next?: string }).next);
    if (!auth.passwordHash) {
      return reply.type('text/html; charset=utf-8').send(
        page(`<h1>Delve</h1><p>No editor password is set yet. On the container, as root, run:</p><p><code>delve-passwd</code></p><p><a href="${esc(next)}">Back</a></p>`),
      );
    }
    return reply.type('text/html; charset=utf-8').send(
      page(`<h1>Delve</h1><p>Log in to edit maps.</p>
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}">
<label>Editor password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<p></p><button type="submit">Log in</button></form>`),
    );
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown; next?: unknown };
    const next = safeNext(body.next);
    const again = (msg: string, code: number) =>
      reply.code(code).type('text/html; charset=utf-8').send(
        page(`<h1>Delve</h1><p class="error">${esc(msg)}</p><p><a href="/login?next=${encodeURIComponent(next)}">Try again</a></p>`),
      );
    if (!auth.passwordHash || !auth.sessions.enabled) return again('Logging in is not set up on this server.', 503);
    if (throttle.blocked(req.ip)) return again('Too many wrong passwords. Wait a minute, then try again.', 429);
    if (typeof body.password !== 'string' || !verifyPassword(body.password, auth.passwordHash)) {
      throttle.fail(req.ip);
      return again('That password is not right.', 401);
    }
    throttle.succeed(req.ip);
    return reply
      .header('set-cookie', auth.sessions.cookie(auth.sessions.issue(), req.protocol === 'https'))
      .redirect(next, 303);
  });

  app.post('/logout', async (_req, reply) => reply.header('set-cookie', Sessions.clearCookie()).redirect('/', 303));

  app.get('/api/v1/session', async (req) => ({
    loggedIn: isLoggedIn(auth, req),
    passwordSet: Boolean(auth.passwordHash),
  }));
}
