// "Request a feature": GET/POST /feedback for anyone logged in (admin and GM
// accounts, the shared editor login while it still counts, Delve Table players
// with their player cookie or Discord seat, co-GMs), and the whole file for
// admins at /admin/feature-requests.txt. Who sent a request comes from the
// login, never from the name typed into the form alone. Posts must come from
// Delve's own origin, carry an empty honeypot field, and stay within the limits
// in log.ts (SendLimits: 5 per person an hour, 50 a day from everyone).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sameOrigin } from '../auth.ts';
import { currentAccount, safeNext, sendPage } from '../accounts/http.ts';
import { messagePage } from '../accounts/pages.ts';
import { canLogIn, isLoggedIn, type EditorAuth } from '../login.ts';
import { clientIp } from '../public.ts';
import { discordLoginUrl } from '../table/discord.ts';
import type { TableIdentity } from '../table/routes.ts';
import { cleanLine, cleanText, FILE_NAME, isKind, MAX, type FeedbackLog, type SendLimits } from './log.ts';
import { feedbackPage, loginNotePage, type FormValues, type Who } from './page.ts';

export interface FeedbackDeps {
  auth: EditorAuth;
  log: FeedbackLog;
  limits: SendLimits;
  table: TableIdentity;
}

/** Who is sending, as the server knows it. `key` is what the per-person limit counts. */
export type Sender =
  | { kind: 'account'; key: string; name: string; role: 'admin' | 'gm' }
  | { kind: 'table-gm'; key: string; name: string }
  | { kind: 'player'; key: string; name: string; game: string; via: 'invite' | 'discord' }
  | { kind: 'editor'; key: string; open: boolean };

const quote = (s: string): string => `"${s.replace(/"/g, "'")}"`;

/** The "from" part of a request's header: the checked identity, plus the typed name when it differs. */
export function senderLabel(s: Sender, typed: string): string {
  const as = (name: string) => (typed && typed !== name ? ` as ${quote(typed)}` : '');
  switch (s.kind) {
    case 'account':
      return `${s.name} (${s.role === 'admin' ? 'admin' : 'GM'})${as(s.name)}`;
    case 'table-gm':
      return `${quote(s.name)} (GM at the table, Discord)${as(s.name)}`;
    case 'player':
      return `${quote(s.name)} (player in ${quote(s.game)}, ${s.via === 'discord' ? 'Discord' : 'invite link'})${as(s.name)}`;
    case 'editor':
      return `${typed ? `${quote(typed)} ` : ''}(${s.open ? 'open dev server' : 'shared editor login'})`;
  }
}

function who(s: Sender): Who {
  switch (s.kind) {
    case 'account':
      return { name: s.name, label: `${s.name} · ${s.role === 'admin' ? 'Admin' : 'GM'}`, player: false };
    case 'table-gm':
      return { name: s.name, label: `${s.name} · GM at the table`, player: true };
    case 'player':
      return { name: s.name, label: `${s.name} · player in ${s.game}`, player: true };
    case 'editor':
      return { name: '', label: s.open ? 'Open dev server' : 'Shared editor login', player: false };
  }
}

/** The page someone came from, if it is a path on this site. */
const fromPath = (v: unknown): string => {
  const p = safeNext(v);
  return p !== '/' && p.length <= MAX.about ? p : '';
};

export function registerFeedback(app: FastifyInstance, deps: FeedbackDeps): void {
  const { auth, log, limits, table } = deps;

  /** Accounts first, then a co-GM's Discord login, a player seat (the game of `from` if there is one), and last the shared editor login. */
  const senderOf = (req: FastifyRequest, from: string): Sender | null => {
    const cur = currentAccount(auth, req);
    if (cur) return { kind: 'account', key: `account:${cur.user.id}`, name: cur.user.name, role: cur.user.role };
    const discord = table.account(req);
    if (discord && table.coGm(req)) return { kind: 'table-gm', key: `discord:${discord.id}`, name: discord.name };
    const seats = table.seats(req);
    const game = /^\/play\/([^/?#]+)/.exec(from)?.[1];
    const seat = seats.find((s) => s.gameId === game) ?? seats[0];
    if (seat) {
      return {
        kind: 'player',
        key: seat.accountId ? `discord:${seat.accountId}` : `seat:${seat.gameId}:${seat.memberId}`,
        name: seat.name,
        game: seat.game,
        via: seat.via,
      };
    }
    if (isLoggedIn(auth, req)) return { kind: 'editor', key: `editor:${clientIp(req)}`, open: auth.sessions.open };
    return null;
  };

  const loginNote = (req: FastifyRequest) => {
    const discord = table.account(req);
    return loginNotePage({
      loginHref: canLogIn(auth) ? '/login?next=%2Ffeedback' : null,
      discordHref: table.discord && !discord ? discordLoginUrl('/feedback') : null,
      discordName: discord?.name ?? null,
    });
  };

  const sentUrl = (from: string): string => `/feedback?sent=1${from ? `&from=${encodeURIComponent(from)}` : ''}`;

  app.get('/feedback', async (req, reply) => {
    const q = req.query as { from?: unknown; sent?: unknown };
    const from = fromPath(q.from);
    const sender = senderOf(req, from);
    if (!sender) return sendPage(reply, 200, loginNote(req));
    const values: FormValues = { kind: 'idea', title: '', description: '', about: from, name: sender.kind === 'editor' ? '' : sender.name };
    return sendPage(reply, 200, feedbackPage({ who: who(sender), values, from, sent: q.sent === '1' }));
  });

  app.post('/feedback', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = fromPath(body.from);
    const sender = senderOf(req, from);
    if (!sender) return sendPage(reply, 401, loginNote(req));
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      return sendPage(reply, 403, messagePage('Not allowed', ['Send requests from the form on this site.'], [{ href: '/feedback', text: 'Open the form' }]));
    }
    // a hidden field only bots fill in: thank them and keep nothing
    if (typeof body.website === 'string' && body.website !== '') {
      req.log.info('feature request dropped: the honeypot field was filled in');
      return reply.redirect(sentUrl(from), 303);
    }
    const values: FormValues = {
      kind: isKind(body.kind) ? body.kind : 'idea',
      title: cleanLine(body.title),
      description: cleanText(body.description),
      about: cleanLine(body.about),
      name: cleanLine(body.name),
    };
    const again = (error: string, code: number) => sendPage(reply, code, feedbackPage({ who: who(sender), values, from, error }));
    const tooLong = (what: string, max: number, n: number) => again(`Keep the ${what} to ${max} characters (it has ${n}).`, 400);
    if (!isKind(body.kind)) return again('Choose what kind of request it is.', 400);
    if (!values.title) return again('Give your request a short title.', 400);
    if (values.title.length > MAX.title) return tooLong('title', MAX.title, values.title.length);
    if (!values.description) return again('Describe what you would like, in a few words or more.', 400);
    if (values.description.length > MAX.description) return tooLong('description', MAX.description, values.description.length);
    if (values.about.length > MAX.about) return tooLong('map or page', MAX.about, values.about.length);
    if (values.name.length > MAX.name) return tooLong('name', MAX.name, values.name.length);

    const refused = limits.check(sender.key);
    if (refused === 'person') return again(`You sent ${limits.perPerson} requests within the last hour. Please wait a while, then send this one.`, 429);
    if (refused === 'day') return again('Delve has taken all the requests it takes in one day. Please send this one tomorrow.', 429);
    const n = log.append({ kind: values.kind, title: values.title, description: values.description, about: values.about, from: senderLabel(sender, values.name), at: Date.now() });
    limits.note(sender.key);
    req.log.info({ request: n }, 'feature request saved');
    return reply.redirect(sentUrl(from), 303);
  });

  // The whole file, for admins only (GMs and players only send).
  app.get(`/admin/${FILE_NAME}`, async (req, reply) => {
    const cur = currentAccount(auth, req);
    if (!cur) {
      if (isLoggedIn(auth, req)) return sendPage(reply, 403, messagePage('Admins only', ['Only admins can read the feature requests. Create your admin account first.'], [{ href: '/', text: 'Back to Delve' }]));
      return reply.redirect(`/login?next=${encodeURIComponent(`/admin/${FILE_NAME}`)}`, 303);
    }
    if (cur.user.role !== 'admin') {
      return sendPage(reply, 403, messagePage('Admins only', ['Only admins can read the feature requests.'], [{ href: '/feedback', text: 'Request a feature' }, { href: '/', text: 'Back to Delve' }]));
    }
    const download = (req.query as { download?: unknown }).download === '1';
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${FILE_NAME}"`)
      .send(log.read());
  });
}
