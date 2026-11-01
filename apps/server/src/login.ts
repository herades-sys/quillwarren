// Editor login. Once an admin account exists (see accounts/), /login takes an
// account name, password and authenticator code (or a recovery code) and
// starts a server-side session. Before that, the shared password set with
// `sudo delve-passwd` buys a signed 30-day cookie, as it always has.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readCookie, sameOrigin, SESSION_COOKIE, Sessions, verifyPassword } from './auth.ts';
import { accountCookie, BUSY, isHttps, LOGIN_RATE, RateWindow, requestIp, safeNext, sendPage } from './accounts/http.ts';
import { legacyLoginPage, loginPage, messagePage } from './accounts/pages.ts';
import { registerAccounts } from './accounts/routes.ts';
import { loginKeys, type AccountStore, type LoginKeys } from './accounts/store.ts';

export interface EditorAuth {
  sessions: Sessions;
  /** The shared editor password (DELVE_EDIT_PASSWORD_HASH); it only counts until an admin account exists. */
  passwordHash: string | undefined;
  /** Admin and GM accounts. */
  accounts?: AccountStore;
}

/** Admin, GM, a shared-password session (before the first admin account), or a dev server with open editing. */
export const isLoggedIn = (auth: EditorAuth, req: FastifyRequest): boolean =>
  auth.sessions.valid(readCookie(req.headers.cookie, SESSION_COOKIE));

export function useAccounts(auth: EditorAuth, accounts: AccountStore): void {
  auth.accounts = accounts;
  auth.sessions.useAccounts(accounts);
}

/** Someone can log in on this server: an admin account exists, or the shared password is set. */
export const canLogIn = (auth: EditorAuth): boolean => auth.sessions.legacyOff || Boolean(auth.passwordHash);

const LOCKED = 'Too many failed tries. Wait a while (up to an hour), then try again.';

/**
 * After the slow password check: refuse while the address keys are locked
 * (tries running at the same time may have locked them meanwhile), or the name
 * is, unless this try had the right password and a code from the app or a
 * recovery code (a password alone never gets past a locked name).
 */
const lockedOut = (accounts: AccountStore, keys: LoginKeys, secondFactor: boolean): boolean =>
  accounts.locked(keys.fast) || (!secondFactor && accounts.locked([keys.slow]));

/** `adminSection`: more of /admin, drawn per request (the feature requests). */
export function registerLogin(app: FastifyInstance, auth: EditorAuth, o: { adminSection?: () => string } = {}): void {
  const tries = new RateWindow(LOGIN_RATE.max, LOGIN_RATE.ms);

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as { next?: string }).next);
    if (auth.sessions.legacyOff) return sendPage(reply, 200, loginPage({ next }));
    if (!auth.passwordHash) {
      return sendPage(reply, 200, messagePage('Quillwarren', ['No editor password is set yet. On the container, as root, run: delve-passwd'], [{ href: next, text: 'Back' }]));
    }
    return sendPage(reply, 200, legacyLoginPage({ next }));
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = safeNext(body.next);
    const accounts = auth.accounts;
    const where = requestIp(req);

    if (accounts && auth.sessions.legacyOff) {
      const name = typeof body.name === 'string' ? body.name.slice(0, 64) : '';
      const again = (msg: string, code: number) => sendPage(reply, code, loginPage({ next, error: msg, name }));
      if (!sameOrigin(req.headers.origin, req.headers.host)) return again('Log in from this page.', 403);
      const keys = loginKeys(name, where);
      if (accounts.locked(keys.fast)) return again(LOCKED, 429);
      if (!tries.take()) return again(BUSY, 429);
      const result = await accounts.verifyLogin(name, body.password, body.code);
      const locked = lockedOut(accounts, keys, result !== null && result.factor !== 'password');
      if (!result) accounts.failLogin(keys);
      if (locked) return again(LOCKED, 429);
      if (!result) return again('The name, password or code is not right.', 401);
      // the name's slow count stays: someone failing on purpose doesn't get a fresh 30 because the owner logged in
      accounts.clearFails(keys.fast);
      const remember = body.remember === '1';
      const value = accounts.createSession(result.user.id, { remember, userAgent: String(req.headers['user-agent'] ?? '') });
      return reply
        .header('set-cookie', accountCookie(value, isHttps(req), remember))
        .redirect(result.factor === 'recovery' ? '/account?recovery=1' : next, 303);
    }

    // the shared password, until the first admin account exists (one password for everyone: always the name's slow limit)
    const again = (msg: string, code: number) => sendPage(reply, code, legacyLoginPage({ next, error: msg }));
    if (!auth.passwordHash || !auth.sessions.enabled) return again('Logging in is not set up on this server.', 503);
    const keys: LoginKeys = { fast: [`ip:${where}`, `shared-password|ip:${where}`], slow: 'shared-password' };
    if (accounts?.locked(keys.fast)) return again(LOCKED, 429);
    if (!tries.take()) return again(BUSY, 429);
    const ok = typeof body.password === 'string' && body.password.length <= 256 && (await verifyPassword(body.password, auth.passwordHash));
    const locked = accounts ? lockedOut(accounts, keys, false) : false;
    if (!ok) accounts?.failLogin(keys);
    if (locked) return again(LOCKED, 429);
    if (!ok) return again('That password is not right.', 401);
    accounts?.clearFails(keys.fast);
    return reply.header('set-cookie', auth.sessions.cookie(auth.sessions.issue(), isHttps(req))).redirect(next, 303);
  });

  // Ends the session on the server too, so a copied cookie stops working. From Quillwarren's own pages only, like every cookie write.
  app.post('/logout', async (req, reply) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) return sendPage(reply, 403, messagePage('Not allowed', ['Log out from Quillwarren’s own pages.'], [{ href: '/', text: 'Back' }]));
    auth.accounts?.endSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    return reply.header('set-cookie', Sessions.clearCookie()).redirect('/', 303);
  });

  app.get('/api/v1/session', async (req) => ({
    loggedIn: isLoggedIn(auth, req),
    passwordSet: canLogIn(auth),
  }));

  if (auth.accounts) registerAccounts(app, auth, auth.accounts, { ...o, tries });
}
