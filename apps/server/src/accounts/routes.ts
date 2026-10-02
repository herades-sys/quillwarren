// The account pages: /account/setup (the first admin account, and the setup
// links that new or reset accounts get), /account (your own password,
// recovery codes, authenticator and sessions) and /admin (accounts and
// sessions, admins only). Setup links carry their token as ?token=, which the
// server log masks. Forms post urlencoded bodies; cookie-authenticated posts
// must come from Delve's own origin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readCookie, sameOrigin, SESSION_COOKIE } from '../auth.ts';
import type { EditorAuth } from '../login.ts';
import { accountCookie, currentAccount, isHttps, requestIp, sendPage } from './http.ts';
import { accountPage, adminPage, bootstrapPage, messagePage, recoveryCodesPage, setupCodePage, setupPasswordPage, type NewLink } from './pages.ts';
import { qrSvg } from './qr.ts';
import { AccountError, cleanName, MAX_PASSWORD, MIN_PASSWORD, nameLockKey, type AccountStore, type Session, type User } from './store.ts';
import { groupSecret, otpauthUri } from './totp.ts';

type Body = Record<string, unknown>;

const NOTICES = new Map<string, string>([
  ['password', 'Your password is changed. Your other devices are logged out.'],
  ['authenticator-on', 'Your authenticator is set up. From now on you log in with your password and a code from the app.'],
  ['authenticator-required', 'The account now needs an authenticator app. Send them the new setup link.'],
  ['ended-others', 'Your other devices are logged out.'],
  ['ended', 'The session is ended.'],
  ['role', 'The role is changed.'],
  ['removed', 'The account is removed.'],
]);
const LOCKED = 'Too many failed tries. Wait 15 minutes, then try again.';

function passwordProblem(p: unknown, again: unknown): string | null {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) return `Use a password with at least ${MIN_PASSWORD} characters.`;
  if (p.length > MAX_PASSWORD) return `Use a password with at most ${MAX_PASSWORD} characters.`;
  if (p !== again) return 'The two passwords are different.';
  return null;
}

const notice = (q: unknown): string | undefined => {
  const done = (q as { done?: unknown }).done;
  return typeof done === 'string' ? NOTICES.get(done) : undefined;
};

export function registerAccounts(app: FastifyInstance, auth: EditorAuth, accounts: AccountStore): void {
  const loggedIn = (req: FastifyRequest): boolean => auth.sessions.valid(readCookie(req.headers.cookie, SESSION_COOKIE));
  const userAgent = (req: FastifyRequest): string => String(req.headers['user-agent'] ?? '');
  const bootstrapping = (req: FastifyRequest): boolean => !auth.sessions.legacyOff && loggedIn(req);

  // ---------- setup: the first admin account, and setup links ----------

  /** The step a setup link is at: choose a password, or scan the QR code and confirm a code. */
  const showLink = (reply: FastifyReply, token: string, error?: string): FastifyReply => {
    const link = accounts.link(token);
    if (!link) {
      return sendPage(reply, 404, messagePage('Setup link not valid', ['This setup link was used already, or it ran out. Ask your admin for a new one.']));
    }
    const code = error ? 400 : 200;
    if (link.purpose !== 'authenticator' && (!link.passwordChosen || link.passwordOnly)) {
      return sendPage(reply, code, setupPasswordPage({ token, name: link.userName, reset: link.purpose === 'reset', passwordOnly: link.passwordOnly, error }));
    }
    const qr = qrSvg(otpauthUri(link.userName, link.secret), { title: 'QR code for your authenticator app' });
    return sendPage(
      reply,
      code,
      setupCodePage({ token, name: link.userName, qr, secret: groupSecret(link.secret), error, authenticatorOnly: link.purpose === 'authenticator', turningOn: link.passwordOnly }),
    );
  };

  app.get('/account/setup', async (req, reply) => {
    const token = (req.query as { token?: unknown }).token;
    if (typeof token === 'string') return showLink(reply, token);
    if (auth.sessions.legacyOff) {
      return sendPage(reply, 200, messagePage('Delve has an admin', ['An admin account exists already. Log in, or ask your admin for a setup link.'], [{ href: '/login', text: 'Log in' }]));
    }
    if (!loggedIn(req)) return reply.redirect('/login?next=%2Faccount%2Fsetup', 303);
    return sendPage(reply, 200, bootstrapPage({}));
  });

  app.post('/account/setup', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    try {
      if (typeof body.token === 'string') return await setupStep(req, reply, body.token, body);
      // the first admin account, made by an editor logged in with the shared password
      if (!bootstrapping(req) || !sameOrigin(req.headers.origin, req.headers.host)) {
        return sendPage(reply, 403, messagePage('Not allowed', ['Log in with the editor password first.'], [{ href: '/login?next=%2Faccount%2Fsetup', text: 'Log in' }]));
      }
      const name = typeof body.name === 'string' ? body.name.slice(0, 64) : '';
      if (!cleanName(name)) return sendPage(reply, 400, bootstrapPage({ name, error: "A name has 1 to 32 letters, digits, spaces or . _ ' - and starts with a letter or digit." }));
      const problem = passwordProblem(body.password, body.password2);
      if (problem) return sendPage(reply, 400, bootstrapPage({ name, error: problem }));
      const token = accounts.startBootstrap(name, body.password as string);
      return reply.redirect(`/account/setup?token=${encodeURIComponent(token)}`, 303);
    } catch (e) {
      if (e instanceof AccountError) return sendPage(reply, 400, messagePage('That did not work', [e.message]));
      throw e;
    }
  });

  async function setupStep(req: FastifyRequest, reply: FastifyReply, token: string, body: Body): Promise<FastifyReply> {
    const link = accounts.link(token);
    if (!link) return showLink(reply, token);
    const remember = body.remember === '1';
    const logIn = (userId: number) => reply.header('set-cookie', accountCookie(accounts.createSession(userId, { remember, userAgent: userAgent(req) }), isHttps(req), remember));
    if (body.step === 'password') {
      const problem = passwordProblem(body.password, body.password2);
      if (problem) return showLink(reply, token, problem);
      if (link.passwordOnly && link.purpose !== 'authenticator') {
        // no authenticator: the password finishes the setup
        const user = accounts.completePasswordLink(token, body.password as string);
        return logIn(user.id).redirect('/', 303);
      }
      accounts.chooseLinkPassword(token, body.password as string);
      return reply.redirect(`/account/setup?token=${encodeURIComponent(token)}`, 303);
    }
    const done = accounts.completeLink(token, typeof body.code === 'string' ? body.code : '');
    if (!done) return showLink(reply, token, 'That code is not right. Check that the time on your phone is right, then try the newest code.');
    if (link.purpose === 'authenticator') {
      // a password-only account that turned the authenticator on gets its first recovery codes
      if (done.recoveryCodes) return sendPage(reply, 200, recoveryCodesPage({ codes: done.recoveryCodes, next: '/account?done=authenticator-on', first: false, replaced: false }));
      return reply.redirect('/account?done=authenticator', 303);
    }
    logIn(done.user.id);
    return sendPage(reply, 200, recoveryCodesPage({ codes: done.recoveryCodes ?? [], next: '/', first: true }));
  }

  // ---------- your account ----------

  app.get('/account', async (req, reply) => {
    const cur = currentAccount(auth, req);
    if (!cur) return reply.redirect(bootstrapping(req) ? '/account/setup' : '/login?next=%2Faccount', 303);
    const q = req.query as { recovery?: unknown; done?: unknown };
    const text =
      q.recovery === '1'
        ? `You logged in with a recovery code. You have ${cur.user.recoveryLeft} left. If you lost your phone, set up a new authenticator below.`
        : q.done === 'authenticator'
          ? 'Your new authenticator is set up. Codes from the old one no longer work.'
          : notice(q);
    return sendPage(reply, 200, accountPage({ user: cur.user, session: cur.session, sessions: accounts.sessions(cur.user.id), notice: text }));
  });

  app.post('/account', async (req, reply) => {
    const cur = currentAccount(auth, req);
    if (!cur || !sameOrigin(req.headers.origin, req.headers.host)) {
      return sendPage(reply, 403, messagePage('Not allowed', ['Log in first.'], [{ href: '/login?next=%2Faccount', text: 'Log in' }]));
    }
    const { user, session } = cur;
    const body = (req.body ?? {}) as Body;
    const show = (o: { error?: string; notice?: string }, code = 200) =>
      sendPage(reply, code, accountPage({ user: accounts.user(user.id)!, session, sessions: accounts.sessions(user.id), ...o }));
    // someone holding a stolen cookie mustn't get to guess the password or codes freely
    const keys = [`ip:${requestIp(req)}`, nameLockKey(user.name)];
    const verify = (needPassword: boolean): FastifyReply | null => {
      if (accounts.locked(keys)) return show({ error: LOCKED }, 429);
      const current = body.current;
      const passwordOk = !needPassword || (typeof current === 'string' && current.length <= MAX_PASSWORD && accounts.checkPassword(user.id, current));
      // a password-only account has nothing but the password to check
      const secondOk = user.passwordOnly ? needPassword : accounts.useSecondFactor(user.id, typeof body.code === 'string' ? body.code : '') !== null;
      if (passwordOk && secondOk) {
        accounts.clearFails(keys);
        return null;
      }
      accounts.fail(keys);
      if (user.passwordOnly) return show({ error: 'The current password is not right.' }, 401);
      return show({ error: needPassword ? 'The current password or the code is not right.' : 'That code is not right.' }, 401);
    };

    switch (body.action) {
      case 'password': {
        const problem = passwordProblem(body.password, body.password2);
        if (problem) return show({ error: problem }, 400);
        const refused = verify(true);
        if (refused) return refused;
        accounts.setPassword(user.id, body.password as string);
        accounts.endUserSessions(user.id, session.id);
        return reply.redirect('/account?done=password', 303);
      }
      case 'recovery': {
        if (user.passwordOnly) return show({ error: 'Your account has no recovery codes. Set up an authenticator first.' }, 400);
        const refused = verify(false);
        if (refused) return refused;
        return sendPage(reply, 200, recoveryCodesPage({ codes: accounts.newRecoveryCodes(user.id), next: '/account', first: false }));
      }
      case 'authenticator': {
        const refused = verify(true);
        if (refused) return refused;
        const token = accounts.createLink(user.id, 'authenticator');
        return reply.redirect(`/account/setup?token=${encodeURIComponent(token)}`, 303);
      }
      case 'end-others':
        accounts.endUserSessions(user.id, session.id);
        return reply.redirect('/account?done=ended-others', 303);
      case 'end-session':
        accounts.endSessionById(String(body.session ?? ''), user.id);
        return reply.redirect('/account?done=ended', 303);
      default:
        return show({ error: 'Unknown action.' }, 400);
    }
  });

  // ---------- admin ----------

  const adminView = (reply: FastifyReply, me: { user: User; session: Session }, o: { newLink?: NewLink; notice?: string; error?: string }, code = 200) =>
    sendPage(reply, code, adminPage({ me: me.user, session: me.session, users: accounts.users(), sessions: accounts.sessions(), now: Date.now(), ...o }));
  const refuseNonAdmin = (reply: FastifyReply) =>
    sendPage(reply, 403, messagePage('Admins only', ['Only admins can open this page.'], [{ href: '/', text: 'Back to Delve' }, { href: '/account', text: 'Your account' }]));

  app.get('/admin', async (req, reply) => {
    const cur = currentAccount(auth, req);
    if (!cur) return reply.redirect(bootstrapping(req) ? '/account/setup' : '/login?next=%2Fadmin', 303);
    if (cur.user.role !== 'admin') return refuseNonAdmin(reply);
    return adminView(reply, cur, { notice: notice(req.query) });
  });

  app.post('/admin', async (req, reply) => {
    const cur = currentAccount(auth, req);
    if (!cur || cur.user.role !== 'admin' || !sameOrigin(req.headers.origin, req.headers.host)) return refuseNonAdmin(reply);
    const body = (req.body ?? {}) as Body;
    const me = cur.user;
    const id = Number(body.user);
    const target = Number.isInteger(id) ? accounts.user(id) : null;
    const linkFor = (u: User, token: string, reset: boolean): NewLink => {
      const fresh = accounts.user(u.id);
      return {
        name: u.name,
        url: `${isHttps(req) ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}/account/setup?token=${encodeURIComponent(token)}`,
        expires: fresh?.linkExpires ?? Date.now(),
        reset,
        passwordOnly: fresh?.passwordOnly ?? false,
      };
    };
    try {
      switch (body.action) {
        case 'create': {
          const created = accounts.createUser(body.name, body.role === 'admin' ? 'admin' : 'gm', Date.now(), { passwordOnly: body.password_only === '1' });
          const token = accounts.createLink(created.id, 'new');
          return adminView(reply, cur, { newLink: linkFor(created, token, false), notice: `${created.name} is added. Send them the setup link below.` });
        }
        case 'require-authenticator': {
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          if (!target.passwordOnly) return adminView(reply, cur, { error: `${target.name} uses an authenticator already.` }, 400);
          const token = accounts.resetLogin(target.id, Date.now(), { passwordOnly: false });
          return adminView(reply, cur, { newLink: linkFor(target, token, target.active), notice: NOTICES.get('authenticator-required') });
        }
        case 'make-password-only': {
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          const user = accounts.makePasswordOnly(target.id);
          return adminView(reply, cur, {
            notice: user.active
              ? `${user.name} now logs in with name and password only. Their password and sessions stay; their authenticator and recovery codes no longer work.`
              : `${user.name}'s setup link now asks for a password only.`,
          });
        }
        case 'link': {
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          if (target.id === me.id) return adminView(reply, cur, { error: 'Change your own password or authenticator on your account page.' }, 400);
          const reset = target.active;
          const token = reset ? accounts.resetLogin(target.id) : accounts.createLink(target.id, 'new');
          return adminView(reply, cur, { newLink: linkFor(target, token, reset), notice: reset ? `${target.name}'s login is reset and they are logged out.` : undefined });
        }
        case 'role':
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          if (target.id === me.id) return adminView(reply, cur, { error: "You can't change your own role. Ask another admin." }, 400);
          accounts.setRole(target.id, body.role === 'admin' ? 'admin' : 'gm');
          return reply.redirect('/admin?done=role', 303);
        case 'remove':
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          if (target.id === me.id) return adminView(reply, cur, { error: "You can't remove your own account. Ask another admin." }, 400);
          accounts.removeUser(target.id);
          return reply.redirect('/admin?done=removed', 303);
        case 'end-session':
          accounts.endSessionById(String(body.session ?? ''));
          return reply.redirect('/admin?done=ended', 303);
        case 'end-user-sessions':
          if (!target) return adminView(reply, cur, { error: 'There is no such account.' }, 404);
          accounts.endUserSessions(target.id, target.id === me.id ? cur.session.id : undefined);
          return reply.redirect('/admin?done=ended', 303);
        case 'end-all':
          for (const u of accounts.users()) accounts.endUserSessions(u.id, u.id === me.id ? cur.session.id : undefined);
          return reply.redirect('/admin?done=ended', 303);
        default:
          return adminView(reply, cur, { error: 'Unknown action.' }, 400);
      }
    } catch (e) {
      if (e instanceof AccountError) return adminView(reply, cur, { error: e.message }, 400);
      throw e;
    }
  });
}
