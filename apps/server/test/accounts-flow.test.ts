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
  expect(page.body).toContain('<div class="qr"><svg');
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

  it('locks out an address, and an account from that address, for 15 minutes after 5 failures', async () => {
    const { secret } = await bootstrap();
    for (let i = 0; i < 5; i++) expect((await login('Ana', 'not the right password', '123456', { ip: '10.0.0.1' })).statusCode).toBe(401);
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.1' })).statusCode).toBe(429);
    expect((await login('Bo', ADMIN_PW, code(secret), { ip: '10.0.0.1' })).statusCode).toBe(429); // the address
    // somewhere else, the right login still works: failing on purpose can't lock the owner out
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.2' })).statusCode).toBe(303);
    tick(15 * 60_000);
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.0.1' })).statusCode).toBe(303);
  });

  it('failures from other addresses never lock out the right login with a code', async () => {
    const { secret } = await bootstrap();
    // 5 addresses fail 5 times each: each of them is locked, the name isn't yet (25 of 30)
    for (let a = 1; a <= 5; a++) {
      for (let i = 0; i < 5; i++) expect((await login('Ana', 'not the right password', '123456', { ip: `10.0.1.${a}` })).statusCode).toBe(401);
      tick(1000);
    }
    tick(); // a fresh code: the one that confirmed the setup was used
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.1.3' })).statusCode).toBe(429);
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.1.6' })).statusCode).toBe(303);
    // past 30 failures the name is locked for an hour: tries without the right password and code all get 429 now
    for (let a = 7; a <= 8; a++) {
      for (let i = 0; i < 5; i++) await login('Ana', 'not the right password', '123456', { ip: `10.0.1.${a}` });
      tick(1000);
    }
    tick();
    const wrong = await login('Ana', 'not the right password', '123456', { ip: '10.0.1.9' });
    expect(wrong.statusCode).toBe(429);
    expect(wrong.body).toContain('Too many failed tries. Wait a while (up to an hour), then try again.');
    expect((await login('Ana', ADMIN_PW, '000000', { ip: '10.0.1.9' })).statusCode).toBe(429); // the password alone gets no further
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '10.0.1.10' })).statusCode).toBe(303);
  });

  it('keys IPv6 clients by their /64', async () => {
    const { secret } = await bootstrap();
    for (let i = 1; i <= 5; i++) expect((await login('Nobody', 'x'.repeat(12), '123456', { ip: `2001:db8:1:2::${i}` })).statusCode).toBe(401);
    tick();
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '2001:db8:1:2:abcd:ef01:2345:6789' })).statusCode).toBe(429);
    // through the tunnel too
    expect((await login('Ana', ADMIN_PW, code(secret), { headers: { 'cf-connecting-ip': '2001:0db8:0001:0002::77' } })).statusCode).toBe(429);
    expect((await login('Ana', ADMIN_PW, code(secret), { ip: '2001:db8:1:3::1' })).statusCode).toBe(303);
  });

  it('allows 20 password checks a second across all clients', async () => {
    await bootstrap();
    // the clock stands still here: every try lands in the same second
    const tries = await Promise.all(Array.from({ length: 24 }, (_, i) => login(`Name${i}`, 'x'.repeat(12), '123456', { ip: `10.0.2.${i + 1}` })));
    const busy = tries.filter((r) => r.statusCode === 429);
    expect(busy).toHaveLength(4);
    for (const r of busy) expect(r.body).toContain('Too many logins at once. Try again in a few seconds.');
    expect(tries.filter((r) => r.statusCode === 401)).toHaveLength(20);
    tick(1000);
    expect((await login('Name0', 'x'.repeat(12), '123456', { ip: '10.0.2.99' })).statusCode).toBe(401);
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
    const host = 'delve.lan';
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
    expect(first.body).toContain('Welcome to Quillwarren');
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

describe('password-only GM accounts', () => {
  const HIVE_PW = 'hive password, long enough';

  /** "Hive", added as password only and set up from its link. */
  async function addHive(adminCookie: string) {
    const made = await post('/admin', { action: 'create', name: 'Hive', role: 'gm', password_only: '1' }, adminCookie);
    expect(made.statusCode).toBe(200);
    expect(made.body).toContain('With it they choose their own password.');
    const link = linkOf(made.body);
    const page = await get(link);
    expect(page.body).toContain('Save password and log in');
    expect(page.body).not.toContain('class="qr"');
    const done = await post('/account/setup', { token: link.split('=')[1]!, step: 'password', password: HIVE_PW, password2: HIVE_PW });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/');
    expect((await get(link)).statusCode).toBe(404);
    return { link, cookie: cookieOf(done) };
  }

  it('are added by the admin, set up with a password alone, and log in without a code, also through the tunnel', async () => {
    const admin = await bootstrap();
    const hive = await addHive(admin.cookie);
    expect(await loggedIn(hive.cookie)).toBe(true);
    expect((await get('/admin', admin.cookie)).body).toMatch(/Hive<\/strong>.*?>GM<\/span> <span class="tag tag-neutral">.*?Password only<\/span>.*?Active/s);
    expect((await login('hive', HIVE_PW, '')).statusCode).toBe(303);
    expect((await login('hive', 'not the password', '')).statusCode).toBe(401);
    const tunnel = { headers: { host: 'delve.example', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https', origin: 'https://delve.example' } };
    const remote = await login('Hive', HIVE_PW, '', tunnel);
    expect(remote.statusCode).toBe(303);
    expect(setCookie(remote)).toContain('Secure');
    expect((await app.inject({ url: '/api/v1/maps', headers: { cookie: cookieOf(remote), ...tunnel.headers } })).statusCode).toBe(200);
    // the admin still needs the code
    expect((await login('Ana', ADMIN_PW, '')).statusCode).toBe(401);
  });

  it('are GMs only', async () => {
    const admin = await bootstrap();
    const refused = await post('/admin', { action: 'create', name: 'Boss', role: 'admin', password_only: '1' }, admin.cookie);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('always use an authenticator');
    await addHive(admin.cookie);
    expect((await post('/admin', { action: 'role', user: '2', role: 'admin' }, admin.cookie)).statusCode).toBe(400);
  });

  it('change the password with the current one alone, and have no recovery codes', async () => {
    const admin = await bootstrap();
    const hive = await addHive(admin.cookie);
    const page = (await get('/account', hive.cookie)).body;
    expect(page).toContain('password only, no authenticator');
    expect(page).not.toContain('name="code"');
    expect(page).toContain('Set up an authenticator');
    const NEW = 'a brand new hive password';
    expect((await post('/account', { action: 'password', current: 'wrong password here', password: NEW, password2: NEW }, hive.cookie)).statusCode).toBe(401);
    expect((await post('/account', { action: 'password', current: HIVE_PW, password: NEW, password2: NEW }, hive.cookie)).headers.location).toBe('/account?done=password');
    expect((await login('Hive', NEW, '')).statusCode).toBe(303);
    expect((await post('/account', { action: 'recovery' }, hive.cookie)).statusCode).toBe(400);
  });

  it('still wait out the slower lock on their name: 30 failures from anywhere within an hour', async () => {
    const admin = await bootstrap();
    await addHive(admin.cookie);
    for (let a = 1; a <= 6; a++) {
      for (let i = 0; i < 5; i++) expect((await login('Hive', 'not the hive password', '', { ip: `10.0.3.${a}` })).statusCode).toBe(401);
      tick(1000);
    }
    // a password is all such an account has, so the right one waits too, from any address
    expect((await login('Hive', HIVE_PW, '', { ip: '10.0.3.7' })).statusCode).toBe(429);
    // the admin's name is a different name
    tick();
    expect((await login('Ana', ADMIN_PW, code(admin.secret), { ip: '10.0.3.7' })).statusCode).toBe(303);
    tick(60 * 60_000);
    expect((await login('Hive', HIVE_PW, '', { ip: '10.0.3.7' })).statusCode).toBe(303);
  });

  it('can turn the authenticator on themselves, which then gives recovery codes and needs the code', async () => {
    const admin = await bootstrap();
    const hive = await addHive(admin.cookie);
    const start = await post('/account', { action: 'authenticator', current: HIVE_PW }, hive.cookie);
    const location = String(start.headers.location);
    expect(location).toMatch(/^\/account\/setup\?token=/);
    const page = await get(location);
    expect(page.body).toContain('Once it is confirmed');
    const secret = secretOf(page.body);
    const done = await post('/account/setup', { token: location.split('=')[1]!, step: 'code', code: code(secret) });
    expect(done.statusCode).toBe(200);
    expect(codesOf(done.body)).toHaveLength(10);
    expect(done.body).not.toContain('old recovery codes');
    expect(await loggedIn(hive.cookie)).toBe(true);
    tick();
    expect((await login('Hive', HIVE_PW, '')).statusCode).toBe(401);
    expect((await login('Hive', HIVE_PW, code(secret))).statusCode).toBe(303);
  });

  it('can be made from an existing GM on the admin page, who keeps their password and stays logged in', async () => {
    const admin = await bootstrap();
    const gm = await addAccount(admin.cookie, 'Gm');
    const before = (await get('/admin', admin.cookie)).body;
    expect(before).toContain('value="make-password-only"');
    expect(before.match(/value="make-password-only"/g)).toHaveLength(1); // the GM's row only, never an admin's
    const res = await post('/admin', { action: 'make-password-only', user: '2' }, admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Gm now logs in with name and password only');
    expect(res.body).toMatch(/Gm<\/strong>.*?Password only/s);
    expect(res.body).not.toContain('value="make-password-only"');
    expect(await loggedIn(gm.cookie)).toBe(true);
    tick();
    expect((await login('Gm', GM_PW, '')).statusCode).toBe(303);
    expect((await login('Gm', 'not the password', '')).statusCode).toBe(401);
    // twice, an admin, or not from the admin: refused
    expect((await post('/admin', { action: 'make-password-only', user: '2' }, admin.cookie)).statusCode).toBe(400);
    expect((await post('/admin', { action: 'make-password-only', user: '1' }, admin.cookie)).statusCode).toBe(400);
    expect((await post('/admin', { action: 'make-password-only', user: '2' }, gm.cookie)).statusCode).toBe(403);
  });

  it('keep their mode on a reset, and the admin can require the authenticator', async () => {
    const admin = await bootstrap();
    const hive = await addHive(admin.cookie);
    const reset = await post('/admin', { action: 'link', user: '2' }, admin.cookie);
    expect(await loggedIn(hive.cookie)).toBe(false);
    expect((await get(linkOf(reset.body))).body).toContain('Save password and log in');
    const again = await post('/account/setup', { token: linkOf(reset.body).split('=')[1]!, step: 'password', password: HIVE_PW, password2: HIVE_PW });
    expect(again.headers.location).toBe('/');

    const required = await post('/admin', { action: 'require-authenticator', user: '2' }, admin.cookie);
    expect(required.statusCode).toBe(200);
    expect(required.body).toContain('now needs an authenticator app');
    expect(await loggedIn(cookieOf(again))).toBe(false);
    expect((await login('Hive', HIVE_PW, '')).statusCode).toBe(401);
    const link = linkOf(required.body);
    expect((await get(link)).body).toContain('Next: authenticator app');
    // an account with the app already can't be "required" again
    expect((await post('/admin', { action: 'require-authenticator', user: '2' }, admin.cookie)).statusCode).toBe(400);
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

describe('the Snip button (export an area as a PNG)', () => {
  const hasSnip = (html: string) => html.includes('id="snip-btn"') && html.includes('data-act="snip"') && html.includes('"snip":true');

  it('is there for admin and GM accounts only', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name: 'Crypt' } });
    expect(made.statusCode).toBe(201);
    const page = async (cookie?: string) => (await get(`/maps/${made.json().id as string}`, cookie)).body;
    // the shared password edits, but has no account: no snip
    expect(hasSnip(await page(legacyCookie()))).toBe(false);
    const admin = await bootstrap();
    const gm = await addAccount(admin.cookie, 'Bo');
    expect(hasSnip(await page())).toBe(false);
    expect(hasSnip(await page(admin.cookie))).toBe(true);
    expect(hasSnip(await page(gm.cookie))).toBe(true);
  });

  it('is there on development open-edit servers', async () => {
    const open = buildApp({ version: 't', started: 'now' }, { openEdit: true, token: TOKEN });
    const made = await open.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name: 'Crypt' } });
    expect(hasSnip((await open.inject({ url: `/maps/${made.json().id as string}` })).body)).toBe(true);
    await open.close();
  });
});
