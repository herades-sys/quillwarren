// Accounts over HTTP: the bootstrap from the shared password, logging in with
// a code or a recovery code, lockouts, session limits, the admin page and GM
// setup links, and the account page. Date is faked so codes and expiry are
// under the test's control.
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base32Decode, totp } from '../src/accounts/totp.ts';
import { buildApp } from '../src/app.ts';
import { hashPassword, Sessions } from '../src/auth.ts';

const TOKEN = 'accounts-flow-token';
const SHARED = 'the shared editor password';
const ADMIN_PW = 'admin password, long enough';
const GM_PW = 'gm password, long enough';
const HOUR = 3_600_000;

let app: FastifyInstance;
let now: number;
const tick = (ms = 30_000) => {
  now += ms;
  vi.setSystemTime(now);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now = Date.UTC(2026, 8, 30, 12, 0, 0);
  vi.setSystemTime(now);
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, passwordHash: hashPassword(SHARED) });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Extra {
  ip?: string;
  headers?: Record<string, string>;
}

const post = (url: string, fields: Record<string, string>, cookie?: string, extra: Extra = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra.headers },
    payload: new URLSearchParams(fields).toString(),
    ...(extra.ip ? { remoteAddress: extra.ip } : {}),
  });
const get = (url: string, cookie?: string) => app.inject({ url, headers: cookie ? { cookie } : {} });
const setCookie = (res: Res): string => {
  const h = res.headers['set-cookie'];
  return String(Array.isArray(h) ? h[0] : h);
};
const cookieOf = (res: Res): string => setCookie(res).split(';')[0]!;
const secretOf = (html: string): string => /<code class="secret">([A-Z2-7 ]+)<\/code>/.exec(html)![1]!.replace(/ /g, '');
const codesOf = (html: string): string[] => /<pre class="codes" id="codes">([^<]+)<\/pre>/.exec(html)![1]!.split('\n');
const linkOf = (html: string): string => /value="https?:\/\/[^"/]+(\/account\/setup\?token=[\w-]+)"/.exec(html)![1]!;
const code = (secret: string): string => totp(base32Decode(secret), Date.now());
const loggedIn = async (cookie: string): Promise<boolean> => (await get('/api/v1/session', cookie)).json().loggedIn;
const legacyCookie = (): string => `delve_session=${new Sessions(TOKEN).issue()}`;

const login = (name: string, password: string, c: string, o: Extra & { remember?: boolean } = {}) =>
  post('/login', { name, password, code: c, next: '/maps', ...(o.remember ? { remember: '1' } : {}) }, undefined, o);

/** The first admin account, made from a shared-password session. */
async function bootstrap(name = 'Ana') {
  const legacy = legacyCookie();
  const start = await post('/account/setup', { name, password: ADMIN_PW, password2: ADMIN_PW }, legacy);
  expect(start.statusCode).toBe(303);
  const location = String(start.headers.location);
  expect(location).toMatch(/^\/account\/setup\?token=[\w-]{43}$/);
  const page = await get(location);
  expect(page.body).toContain('<svg');
  const secret = secretOf(page.body);
  const done = await post('/account/setup', { token: location.split('=')[1]!, step: 'code', code: code(secret) });
  expect(done.statusCode).toBe(200);
  expect(done.body).toContain('Your recovery codes');
  return { legacy, cookie: cookieOf(done), setCookie: setCookie(done), secret, recovery: codesOf(done.body) };
}

/** A GM (or admin) added by the admin and set up from the link. */
async function addAccount(adminCookie: string, name: string, role: 'gm' | 'admin' = 'gm') {
  const made = await post('/admin', { action: 'create', name, role }, adminCookie);
  expect(made.statusCode).toBe(200);
  const link = linkOf(made.body);
  const token = link.split('=')[1]!;
  expect((await post('/account/setup', { token, step: 'password', password: GM_PW, password2: GM_PW })).statusCode).toBe(303);
  const secret = secretOf((await get(link)).body);
  const done = await post('/account/setup', { token, step: 'code', code: code(secret) });
  expect(done.statusCode).toBe(200);
  return { link, cookie: cookieOf(done), secret, recovery: codesOf(done.body) };
}

describe('bootstrap from the shared password', () => {
  it('offers the admin account to a shared-password editor, then switches the shared password off', async () => {
    const legacy = legacyCookie();
    expect((await get('/', legacy)).body).toContain('Secure your login:');
    expect((await get('/')).body).not.toContain('Secure your login:');
    expect((await get('/account/setup')).headers.location).toBe('/login?next=%2Faccount%2Fsetup');
    expect((await get('/account/setup', legacy)).body).toContain('Create your admin account');
    const short = await post('/account/setup', { name: 'Ana', password: 'short', password2: 'short' }, legacy);
    expect(short.statusCode).toBe(400);
    expect(short.body).toContain('at least 12 characters');
    expect((await post('/account/setup', { name: 'Ana', password: ADMIN_PW, password2: `${ADMIN_PW}!` }, legacy)).body).toContain('different');

    const admin = await bootstrap();
    expect(admin.recovery).toHaveLength(10);
    expect(admin.setCookie).toMatch(/^delve_session=a1\.[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict$/); // not kept: a browser-session cookie
    expect(await loggedIn(admin.cookie)).toBe(true);
    // the shared password and its cookies are done
    expect(await loggedIn(admin.legacy)).toBe(false);
    expect(await loggedIn(legacyCookie())).toBe(false);
    expect((await post('/login', { password: SHARED })).statusCode).toBe(401);
    const loginPage = (await get('/login')).body;
    expect(loginPage).toContain('name="name"');
    expect(loginPage).toContain('name="code"');
    expect((await get('/account/setup', admin.legacy)).body).toContain('An admin account exists already');
    expect((await post('/account/setup', { name: 'Eve', password: ADMIN_PW, password2: ADMIN_PW }, admin.legacy)).statusCode).toBe(403);
    // the start page shows the account instead of the banner
    const start = (await get('/', admin.cookie)).body;
    expect(start).toContain('href="/admin"');
    expect(start).toContain('>Ana</a>');
    expect(start).not.toContain('Secure your login:');
    expect((await get('/api/v1/session')).json()).toEqual({ loggedIn: false, passwordSet: true });
  });

  it('needs the page’s own origin for the bootstrap form', async () => {
    const res = await post('/account/setup', { name: 'Ana', password: ADMIN_PW, password2: ADMIN_PW }, legacyCookie(), { headers: { origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('keeps the setup link after a wrong code', async () => {
    const start = await post('/account/setup', { name: 'Ana', password: ADMIN_PW, password2: ADMIN_PW }, legacyCookie());
    const location = String(start.headers.location);
    const token = location.split('=')[1]!;
    const wrong = await post('/account/setup', { token, step: 'code', code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('That code is not right');
    const secret = secretOf(wrong.body);
    expect((await post('/account/setup', { token, step: 'code', code: code(secret) })).statusCode).toBe(200);
  });
});

describe('logging in', () => {
  it('takes name, password and code, and each code works once', async () => {
    const { secret } = await bootstrap();
    tick();
    const res = await login('ana', ADMIN_PW, code(secret));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/maps');
    expect(await loggedIn(cookieOf(res))).toBe(true);
    const again = await login('Ana', ADMIN_PW, code(secret));
    expect(again.statusCode).toBe(401);
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret))).statusCode).toBe(303);
  });

  it('says the same thing whatever was wrong', async () => {
    const { secret } = await bootstrap();
    tick();
    const msg = (r: Res) => /<p class="error" role="alert">([^<]+)<\/p>/.exec(r.body)![1];
    const wrongName = await login('Nobody', ADMIN_PW, code(secret));
    const wrongPassword = await login('Ana', 'not the right password', code(secret));
    const wrongCode = await login('Ana', ADMIN_PW, '123456');
    for (const r of [wrongName, wrongPassword, wrongCode]) expect(r.statusCode).toBe(401);
    expect(new Set([msg(wrongName), msg(wrongPassword), msg(wrongCode)]).size).toBe(1);
    expect(msg(wrongCode)).toBe('The name, password or code is not right.');
  });

  it('locks out an address and an account for 15 minutes after 5 failures', async () => {
    const { secret } = await bootstrap();
    for (let i = 0; i < 5; i++) expect((await login('Ana', 'not the right password', '123456', { ip: '10.0.0.1' })).statusCode).toBe(401);
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.1' })).statusCode).toBe(429);
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.2' })).statusCode).toBe(429); // the account
    expect((await login('Bo', ADMIN_PW, code(secret), { ip: '10.0.0.1' })).statusCode).toBe(429); // the address
    tick(15 * 60_000);
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.2' })).statusCode).toBe(303);
  });

  it('tells clients behind the Cloudflare tunnel apart', async () => {
    const { secret } = await bootstrap();
    const via = (ip: string): Extra => ({ headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 5; i++) await login('Nobody', 'x'.repeat(12), '123456', via('203.0.113.5'));
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), via('203.0.113.5'))).statusCode).toBe(429);
    expect((await login('Ana', ADMIN_PW, code(secret), via('203.0.113.6'))).statusCode).toBe(303);
  });

  it('takes each recovery code once and says how many are left', async () => {
    const { recovery } = await bootstrap();
    const res = await login('Ana', ADMIN_PW, recovery[0]!);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/account?recovery=1');
    expect((await get('/account?recovery=1', cookieOf(res))).body).toContain('You have 9 left');
    expect((await login('Ana', ADMIN_PW, recovery[0]!)).statusCode).toBe(401);
  });

  it('ends a session after 12 idle hours, or 7 days when kept on the device', async () => {
    const { secret } = await bootstrap();
    tick();
    const plain = cookieOf(await login('Ana', ADMIN_PW, code(secret)));
    tick();
    const keptRes = await login('Ana', ADMIN_PW, code(secret), { remember: true });
    expect(setCookie(keptRes)).toContain('Max-Age=2592000');
    const kept = cookieOf(keptRes);
    tick(12 * HOUR + 60_000);
    expect(await loggedIn(plain)).toBe(false);
    expect(await loggedIn(kept)).toBe(true);
    tick(7 * 24 * HOUR + 60_000);
    expect(await loggedIn(kept)).toBe(false);
  });

  it('logs out on the server, so a copy of the cookie stops working', async () => {
    const { cookie } = await bootstrap();
    const out = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(out.statusCode).toBe(303);
    expect(setCookie(out)).toContain('Max-Age=0');
    expect(await loggedIn(cookie)).toBe(false);
  });

  it('lets an account edit maps, but only from the same origin', async () => {
    const { cookie } = await bootstrap();
    const host = 'delve.test';
    const create = (origin?: string) =>
      app.inject({ method: 'POST', url: '/api/v1/maps', headers: { cookie, host, ...(origin ? { origin } : {}) }, payload: { name: 'Mine' } });
    expect((await create(`https://${host}`)).statusCode).toBe(201);
    expect((await create('https://evil.example')).statusCode).toBe(401);
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    const { secret } = await bootstrap();
    tick();
    const res = await login('Ana', ADMIN_PW, code(secret), { headers: { 'x-forwarded-proto': 'https' } });
    expect(setCookie(res)).toMatch(/; Secure$/);
  });
});

describe('the admin page and GM setup links', () => {
  it('adds a GM, who sets up their own login from the link and can then edit and run games', async () => {
    const admin = await bootstrap();
    expect((await get('/admin', admin.cookie)).body).toContain('Accounts');
    const made = await post('/admin', { action: 'create', name: 'Gm One', role: 'gm' }, admin.cookie);
    expect(made.body).toContain('Setup link for Gm One');
    const link = linkOf(made.body);
    const token = link.split('=')[1]!;
    const first = await get(link);
    expect(first.body).toContain('Welcome to Delve');
    expect(first.headers['referrer-policy']).toBe('same-origin'); // "no-referrer" would make browsers post "Origin: null"
    expect(first.headers['cache-control']).toBe('no-store');
    expect((await post('/account/setup', { token, step: 'password', password: 'short', password2: 'short' })).statusCode).toBe(400);
    expect((await post('/account/setup', { token, step: 'password', password: GM_PW, password2: GM_PW })).headers.location).toBe(link);
    const secret = secretOf((await get(link)).body);
    const done = await post('/account/setup', { token, step: 'code', code: code(secret) });
    const gm = cookieOf(done);
    expect(await loggedIn(gm)).toBe(true);
    // the link is used up
    expect((await get(link)).statusCode).toBe(404);
    // a GM edits maps and runs the table, but isn't an admin
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { cookie: gm }, payload: { name: 'GM map' } })).statusCode).toBe(201);
    const game = await post('/play/new', { name: 'Tuesday game' }, gm);
    expect(game.statusCode).toBe(303);
    expect(String(game.headers.location)).toMatch(/^\/play\/game_/);
    const refused = await get('/admin', gm);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('Only admins');
    expect((await post('/admin', { action: 'create', name: 'Sneaky', role: 'admin' }, gm)).statusCode).toBe(403);
    expect((await get('/', gm)).body).not.toContain('href="/admin"');
    // the admin sees the GM as active
    expect((await get('/admin', admin.cookie)).body).toMatch(/Gm One<\/strong>.*?GM.*?active/s);
    tick();
    expect((await login('gm one', GM_PW, code(secret))).statusCode).toBe(303);
  });

  it('lets setup links run out after 72 hours', async () => {
    const { secret } = await bootstrap();
    tick();
    const admin = cookieOf(await login('Ana', ADMIN_PW, code(secret), { remember: true })); // outlives 12 idle hours
    const link = linkOf((await post('/admin', { action: 'create', name: 'Late', role: 'gm' }, admin)).body);
    tick(72 * HOUR - 60_000);
    expect((await get(link)).statusCode).toBe(200);
    tick(2 * 60_000);
    expect((await get(link)).statusCode).toBe(404);
    const fresh = await post('/admin', { action: 'link', user: '2' }, admin);
    expect(fresh.body).toContain('Setup link for Late');
    expect((await get(linkOf(fresh.body))).statusCode).toBe(200);
  });

  it('resets a GM’s login: they are logged out and need the new link', async () => {
    const admin = await bootstrap();
    const gm = await addAccount(admin.cookie, 'Gm');
    const reset = await post('/admin', { action: 'link', user: '2' }, admin.cookie);
    expect(reset.body).toContain('Their old login no longer works');
    expect(await loggedIn(gm.cookie)).toBe(false);
    tick();
    expect((await login('Gm', GM_PW, code(gm.secret))).statusCode).toBe(401);
    expect((await get(linkOf(reset.body))).body).toContain('Set up your login again');
    // an admin can't reset their own login here
    expect((await post('/admin', { action: 'link', user: '1' }, admin.cookie)).statusCode).toBe(400);
  });

  it('never removes or demotes the admin doing it, and lets another admin demote them', async () => {
    const a = await bootstrap();
    expect((await post('/admin', { action: 'remove', user: '1' }, a.cookie)).body).toContain('can&#39;t remove your own account');
    expect((await post('/admin', { action: 'role', user: '1', role: 'gm' }, a.cookie)).body).toContain('can&#39;t change your own role');
    const b = await addAccount(a.cookie, 'Bo', 'admin');
    expect((await post('/admin', { action: 'role', user: '1', role: 'gm' }, b.cookie)).statusCode).toBe(303);
    expect((await get('/admin', a.cookie)).statusCode).toBe(403);
    expect(await loggedIn(a.cookie)).toBe(true); // still a GM
    expect((await post('/admin', { action: 'remove', user: '1' }, b.cookie)).statusCode).toBe(303);
    expect(await loggedIn(a.cookie)).toBe(false);
  });

  it('ends other people’s sessions', async () => {
    const admin = await bootstrap();
    const gm = await addAccount(admin.cookie, 'Gm');
    expect((await get('/admin', admin.cookie)).body).toContain('this device');
    expect((await post('/admin', { action: 'end-user-sessions', user: '2' }, admin.cookie)).statusCode).toBe(303);
    expect(await loggedIn(gm.cookie)).toBe(false);
    tick();
    const again = cookieOf(await login('Gm', GM_PW, code(gm.secret)));
    expect((await post('/admin', { action: 'end-all' }, admin.cookie)).statusCode).toBe(303);
    expect(await loggedIn(again)).toBe(false);
    expect(await loggedIn(admin.cookie)).toBe(true);
  });

  it('refuses admin posts from another origin', async () => {
    const admin = await bootstrap();
    expect((await post('/admin', { action: 'create', name: 'X', role: 'gm' }, admin.cookie, { headers: { origin: 'http://evil.example' } })).statusCode).toBe(403);
  });
});

describe('the account page', () => {
  it('changes the password with the current one and a code, and logs out other devices', async () => {
    const first = await bootstrap();
    tick();
    const second = cookieOf(await login('Ana', ADMIN_PW, code(first.secret)));
    const NEW = 'a brand new password here';
    tick();
    const wrong = await post('/account', { action: 'password', current: 'not the password', password: NEW, password2: NEW, code: code(first.secret) }, second);
    expect(wrong.statusCode).toBe(401);
    tick();
    const ok = await post('/account', { action: 'password', current: ADMIN_PW, password: NEW, password2: NEW, code: code(first.secret) }, second);
    expect(ok.headers.location).toBe('/account?done=password');
    expect(await loggedIn(first.cookie)).toBe(false);
    expect(await loggedIn(second)).toBe(true);
    tick();
    expect((await login('Ana', ADMIN_PW, code(first.secret))).statusCode).toBe(401);
    tick();
    expect((await login('Ana', NEW, code(first.secret))).statusCode).toBe(303);
  });

  it('makes new recovery codes, and the old ones stop working', async () => {
    const admin = await bootstrap();
    tick();
    const res = await post('/account', { action: 'recovery', code: code(admin.secret) }, admin.cookie);
    expect(res.statusCode).toBe(200);
    const fresh = codesOf(res.body);
    expect((await login('Ana', ADMIN_PW, admin.recovery[1]!)).statusCode).toBe(401);
    expect((await login('Ana', ADMIN_PW, fresh[1]!)).statusCode).toBe(303);
  });

  it('sets up a new authenticator; the old one works until the new one is confirmed', async () => {
    const admin = await bootstrap();
    tick();
    const start = await post('/account', { action: 'authenticator', current: ADMIN_PW, code: code(admin.secret) }, admin.cookie);
    expect(String(start.headers.location)).toMatch(/^\/account\/setup\?token=/);
    const page = await get(String(start.headers.location));
    expect(page.body).toContain('old authenticator keeps working');
    const secret2 = secretOf(page.body);
    tick();
    const done = await post('/account/setup', { token: String(start.headers.location).split('=')[1]!, step: 'code', code: code(secret2) });
    expect(done.headers.location).toBe('/account?done=authenticator');
    expect(await loggedIn(admin.cookie)).toBe(true);
    tick();
    expect((await login('Ana', ADMIN_PW, code(admin.secret))).statusCode).toBe(401);
    expect((await login('Ana', ADMIN_PW, code(secret2))).statusCode).toBe(303);
  });

  it('ends the other sessions of the account', async () => {
    const first = await bootstrap();
    tick();
    const second = cookieOf(await login('Ana', ADMIN_PW, code(first.secret)));
    expect((await post('/account', { action: 'end-others' }, second)).statusCode).toBe(303);
    expect(await loggedIn(first.cookie)).toBe(false);
    expect(await loggedIn(second)).toBe(true);
  });

  it('needs an account session', async () => {
    expect((await get('/account', legacyCookie())).headers.location).toBe('/account/setup');
    expect((await get('/account')).headers.location).toBe('/login?next=%2Faccount');
    expect((await post('/account', { action: 'end-others' }, legacyCookie())).statusCode).toBe(403);
    expect((await get('/admin')).headers.location).toBe('/login?next=%2Fadmin');
  });
});

describe('development open-edit servers', () => {
  it('keep every browser an editor, with no admin page', async () => {
    const open = buildApp({ version: 't', started: 'now' }, { openEdit: true });
    expect((await open.inject({ url: '/api/v1/session' })).json().loggedIn).toBe(true);
    expect((await open.inject({ url: '/admin' })).statusCode).toBe(303);
    expect((await open.inject({ url: '/' })).body).not.toContain('Secure your login:');
    await open.close();
  });
});
