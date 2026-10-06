// "Request a feature" (/feedback): who may send (accounts, the shared editor login,
// table players; not anonymous or public visitors), the same-origin check, the
// honeypot, text limits and cleaning, the rate limits, the text file and its
// numbering, and the admin-only view of it.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.ts';
import { base32Decode, totp } from '../src/accounts/totp.ts';
import { buildApp } from '../src/app.ts';
import { hashPassword, Sessions } from '../src/auth.ts';
import { cleanLine, cleanText, FeedbackLog, formatBlock, parseRequests, SendLimits } from '../src/feedback/log.ts';
import { senderLabel } from '../src/feedback/routes.ts';

const TOKEN = 'feedback-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
const HOST = 'delve.test';
const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };
const HEADER = /^==== #(\d+) · \d{4}-\d\d-\d\d \d\d:\d\d · /;

let dir: string;
let app: FastifyInstance;
let file: string;
/** Session cookies of the seeded accounts. */
let admin: string;
let gm: string;

/** An admin (Ana, with an authenticator) and a password-only GM (Gil), seeded straight into accounts.db. */
function seedAccounts(): { admin: string; gm: string } {
  const store = new AccountStore(join(dir, 'accounts.db'), TOKEN);
  try {
    const boot = store.startBootstrap('Ana', 'admin password, long enough');
    const done = store.completeLink(boot, totp(base32Decode(store.link(boot)!.secret), Date.now()));
    const gil = store.createUser('Gil', 'gm', Date.now(), { passwordOnly: true });
    store.completePasswordLink(store.createLink(gil.id, 'new'), 'gm password, long enough');
    return { admin: `delve_session=${store.createSession(done!.user.id)}`, gm: `delve_session=${store.createSession(gil.id)}` };
  } finally {
    store.close();
  }
}

async function build(o: { accounts?: boolean; passwordHash?: string } = {}): Promise<FastifyInstance> {
  if (o.accounts !== false) ({ admin, gm } = seedAccounts());
  const built = buildApp(
    { version: 'test', started: 'now' },
    { token: TOKEN, dataDir: dir, publicUrl: 'https://delve.example', ...(o.passwordHash ? { passwordHash: o.passwordHash } : {}) },
  );
  await built.ready();
  return built;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delve-feedback-'));
  file = join(dir, 'feature-requests.txt');
  app = await build();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const form = (fields: Record<string, string> = {}) => ({
  kind: 'idea',
  title: 'Legend on the 3D view',
  description: 'A small legend in the corner\nthat names the storeys.',
  about: '/maps/map_x',
  name: '',
  website: '',
  from: '/maps/map_x',
  ...fields,
});
const send = (cookie: string | undefined, fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/feedback',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
    payload: new URLSearchParams(form(fields)).toString(),
  });
const get = (url: string, cookie?: string, headers: Record<string, string> = {}) => app.inject({ url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...headers } });
const text = (): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** A table player: a game, an invite, and the cookie from joining it. */
async function player(name = 'Alice', game = 'Crypt night'): Promise<{ cookie: string; gameId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: game } })).json() as { id: string };
  const url = String((await app.inject({ method: 'POST', url: `/api/v1/games/${id}/invites`, headers: bearer, payload: {} })).json().url);
  const joined = await app.inject({
    method: 'POST',
    url: `/play/join/${url.split('/play/join/')[1]!}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ name }).toString(),
  });
  expect(joined.statusCode).toBe(303);
  return { cookie: String(joined.headers['set-cookie']).split(';')[0]!, gameId: id };
}

describe('the text', () => {
  it('cleans typed text: controls and bidi marks go, one-line fields stay on one line', () => {
    expect(cleanLine('  Legend\non the\t3D\u0007 view\u202E ')).toBe('Legend on the 3D view');
    expect(cleanText('Line one\r\n\r\n\r\n\r\nLine\u0000 two  \r\n\ttab\u2028three\n\n')).toBe('Line one\n\nLine two\n  tab\nthree');
    expect(cleanLine(42)).toBe('');
  });

  it('writes one readable block per request, and no description line passes for a header', () => {
    const block = formatBlock(12, { kind: 'idea', title: 'Legend', description: 'Please.\n==== #13 · forged', about: '/maps/map_x', from: 'Robin (GM)', at: Date.now() });
    expect(block).toMatch(/^==== #12 · \d{4}-\d\d-\d\d \d\d:\d\d · Feature idea · from Robin \(GM\) · about \/maps\/map_x\nTitle: Legend\nPlease\.\n ==== #13 · forged\n\n$/);
    const parsed = parseRequests(block);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ n: 12, kind: 'Feature idea', title: 'Legend', description: 'Please.\n ==== #13 · forged' });
  });

  it('records the checked sender, and a typed name only next to it', () => {
    expect(senderLabel({ kind: 'account', key: 'k', name: 'Robin', role: 'gm' }, 'Robin')).toBe('Robin (GM)');
    expect(senderLabel({ kind: 'account', key: 'k', name: 'Robin', role: 'admin' }, 'Ana "the admin"')).toBe(`Robin (admin) as "Ana 'the admin'"`);
    expect(senderLabel({ kind: 'player', key: 'k', name: 'Bob', game: 'Crypt', via: 'invite' }, '')).toBe('"Bob" (player in "Crypt", invite link)');
    expect(senderLabel({ kind: 'editor', key: 'k', open: false }, 'Tim')).toBe('"Tim" (shared editor login)');
    expect(senderLabel({ kind: 'editor', key: 'k', open: true }, '')).toBe('(open dev server)');
  });

  it('numbers in order across restarts, makes the file, and keeps hand edits apart', () => {
    const path = join(dir, 'log.txt');
    const r = { kind: 'bug' as const, title: 'T', description: 'D', about: '', from: 'Gil (GM)', at: Date.now() };
    const one = new FeedbackLog(path);
    expect(one.read()).toBe('');
    expect(one.append(r)).toBe(1);
    expect(one.append(r)).toBe(2);
    // edited by hand, without a final line break
    appendFileSync(path, 'a note from the admin');
    expect(one.append(r)).toBe(3);
    expect(new FeedbackLog(path).append(r)).toBe(4);
    const all = readFileSync(path, 'utf8');
    expect(all).toContain('a note from the admin\n==== #3 · ');
    expect(parseRequests(all).map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(one.summary(2)).toMatchObject({ count: 4, latest: [{ n: 4 }, { n: 3 }] });
    writeFileSync(path, '==== #41 · old\nTitle: x\n\n');
    expect(one.append(r)).toBe(42);
  });

  it('limits each person to 5 an hour and everyone to 50 a day', () => {
    const limits = new SendLimits();
    const t0 = Date.UTC(2026, 9, 3, 12);
    for (let i = 0; i < 5; i++) {
      expect(limits.check('a', t0 + i)).toBeNull();
      limits.note('a', t0 + i);
    }
    expect(limits.check('a', t0 + 10)).toBe('person');
    expect(limits.check('b', t0 + 10)).toBeNull();
    expect(limits.check('a', t0 + 3_600_001 + 4)).toBeNull();
    for (let p = 0; p < 9; p++) for (let i = 0; i < 5; i++) limits.note(`p${p}`, t0 + 100);
    expect(limits.check('new', t0 + 200)).toBe('day');
    expect(limits.check('new', t0 + 24 * 3_600_000 + 101)).toBeNull();
  });
});

describe('sending', () => {
  it('takes a request from a logged-in GM and appends it with the right header', async () => {
    const page = await get('/feedback?from=%2Fmaps%2Fmap_x', gm);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('<form class="panel req-form" method="post" action="/feedback">');
    // no fb- class names: ad blockers (Opera GX) hide .fb-page and friends as Facebook widgets
    expect(page.body).not.toMatch(/class="[^"]*\bfb-/);
    expect(page.body).toContain('name="about" value="/maps/map_x"');
    expect(page.body).toContain('name="name" value="Gil"');
    expect(page.body).toContain('Sent as <strong>Gil · GM</strong>');
    expect(text()).toBe('');

    const res = await send(gm);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/feedback?sent=1&from=%2Fmaps%2Fmap_x');
    expect((await get(String(res.headers.location), gm)).body).toContain('Thank you! Your request is in.');
    const lines = text().split('\n');
    expect(lines[0]).toMatch(HEADER);
    expect(lines[0]).toMatch(/ · Feature idea · from Gil \(GM\) · about \/maps\/map_x$/);
    expect(lines.slice(1)).toEqual(['Title: Legend on the 3D view', 'A small legend in the corner', 'that names the storeys.', '', '']);

    // a typed name never stands alone; the next one is #2
    expect((await send(gm, { kind: 'bug', title: 'Second', name: 'Ana', about: '' })).statusCode).toBe(303);
    expect(text()).toMatch(/\n==== #2 · [^\n]+ · Problem \/ bug · from Gil \(GM\) as "Ana"\nTitle: Second\n/);
  });

  it('takes requests from table players (invite cookie) with their game', async () => {
    const { cookie, gameId } = await player('Alice', 'Crypt night');
    const page = await get(`/feedback?from=${encodeURIComponent(`/play/${gameId}`)}`, cookie);
    expect(page.body).toContain('Sent as <strong>Alice · player in Crypt night</strong>');
    expect(page.body).toContain('href="/play">Delve Table</a>');
    expect((await send(cookie, { about: '', from: `/play/${gameId}` })).statusCode).toBe(303);
    expect(text()).toMatch(/^==== #1 · [^\n]+ · Feature idea · from "Alice" \(player in "Crypt night", invite link\)\n/);
    // the same through the tunnel
    expect((await get('/feedback', cookie, tunnel)).body).toContain('action="/feedback"');
    expect((await send(cookie, { about: '' }, { ...tunnel, origin: 'https://delve.example' })).statusCode).toBe(303);
    expect(parseRequests(text())).toHaveLength(2);
    // a forged player cookie is nobody
    const forged = `delve_player_${gameId}=p1.${'A'.repeat(43)}`;
    expect((await send(forged)).statusCode).toBe(401);
  });

  it('takes requests from the shared editor login, recorded as such', async () => {
    // a Delve without accounts yet
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'delve-feedback-'));
    file = join(dir, 'feature-requests.txt');
    app = await build({ accounts: false, passwordHash: hashPassword('the shared editor password') });
    const legacy = `delve_session=${new Sessions(TOKEN).issue()}`;
    expect((await get('/feedback', legacy)).body).toContain('Sent as <strong>Shared editor login</strong>');
    expect((await send(legacy, { name: 'Tim' })).statusCode).toBe(303);
    expect(text()).toMatch(/ · from "Tim" \(shared editor login\) · about /);
    // there is no admin yet, so nobody reads the file through the web
    expect((await get('/admin/feature-requests.txt', legacy)).statusCode).toBe(403);
  });

  it('shows anonymous and public visitors a login note instead of the form, and refuses their posts', async () => {
    for (const headers of [{}, { ...tunnel, accept: 'text/html' }]) {
      const page = await get('/feedback', undefined, headers);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Log in to send a request');
      expect(page.body).toContain('href="/login?next=%2Ffeedback"');
      expect(page.body).not.toContain('action="/feedback"');
    }
    expect((await send(undefined)).statusCode).toBe(401);
    expect((await send(undefined, {}, { ...tunnel, origin: 'https://delve.example' })).statusCode).toBe(401);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses posts from other sites', async () => {
    const res = await send(gm, {}, { origin: 'http://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(existsSync(file)).toBe(false);
  });

  it('thanks bots that fill in the honeypot, and keeps nothing', async () => {
    const res = await send(gm, { website: 'http://spam.example' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/feedback?sent=1&from=%2Fmaps%2Fmap_x');
    expect(existsSync(file)).toBe(false);
  });

  it('keeps to the length limits and wants a title and a description', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ title: 'x'.repeat(121) }, 'Keep the title to 120 characters (it has 121).'],
      [{ description: 'x'.repeat(4001) }, 'Keep the description to 4000 characters (it has 4001).'],
      [{ about: 'x'.repeat(201) }, 'Keep the map or page to 200 characters'],
      [{ name: 'x'.repeat(61) }, 'Keep the name to 60 characters'],
      [{ title: ' \u0007 ' }, 'Give your request a short title.'],
      [{ description: '\r\n \u202E\r\n' }, 'Describe what you would like'],
      [{ kind: 'spam' }, 'Choose what kind of request it is.'],
    ];
    for (const [fields, error] of cases) {
      const res = await send(gm, fields);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(error);
    }
    // the form keeps what was typed
    expect((await send(gm, { title: 'x'.repeat(121), description: 'Keep <this>' })).body).toContain('Keep &lt;this&gt;</textarea>');
    expect(existsSync(file)).toBe(false);
    // exactly at the limits, CR LF counting as one character
    const long = `${'y'.repeat(3000)}\r\n${'z'.repeat(999)}`;
    expect((await send(gm, { title: 't'.repeat(120), description: long })).statusCode).toBe(303);
    expect(parseRequests(text())[0]!.description).toHaveLength(4000);
  });

  it('takes at most 5 requests per person an hour', async () => {
    for (let i = 1; i <= 5; i++) expect((await send(gm, { title: `Idea ${i}` })).statusCode).toBe(303);
    const sixth = await send(gm, { title: 'Idea 6' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.body).toContain('You sent 5 requests within the last hour');
    expect(sixth.body).toContain('value="Idea 6"');
    // someone else still may
    expect((await send(admin, { title: 'From Ana' })).statusCode).toBe(303);
    expect(parseRequests(text()).map((e) => e.title)).toEqual(['Idea 1', 'Idea 2', 'Idea 3', 'Idea 4', 'Idea 5', 'From Ana']);
  });
});

describe('reading them', () => {
  it('shows admins the count, the newest and the whole file; GMs and others get 403 or the login', async () => {
    const { cookie: alice } = await player();
    expect((await get('/admin', admin)).body).toContain('No requests yet.');
    await send(gm, { title: 'First <idea>' });
    await send(alice, { kind: 'bug', title: 'Dice roll twice', description: 'They do.' });

    const page = await get('/admin', admin);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<h2 class="panel-title">Feature requests</h2>');
    expect(page.body).toContain('2 requests in <code>feature-requests.txt</code>');
    expect(page.body.indexOf('Dice roll twice')).toBeLessThan(page.body.indexOf('First &lt;idea&gt;'));
    expect(page.body).toContain('href="/admin/feature-requests.txt"');
    expect(page.body).toContain('href="/admin/feature-requests.txt?download=1"');

    const view = await get('/admin/feature-requests.txt', admin);
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['x-content-type-options']).toBe('nosniff');
    expect(view.headers['content-disposition']).toBe('inline; filename="feature-requests.txt"');
    expect(view.body).toBe(text());
    expect((await get('/admin/feature-requests.txt?download=1', admin)).headers['content-disposition']).toBe('attachment; filename="feature-requests.txt"');

    // GMs only send
    expect((await get('/admin/feature-requests.txt', gm)).statusCode).toBe(403);
    expect((await get('/admin', gm)).body).not.toContain('Dice roll twice');
    // players and strangers are sent to the login, at home and through the tunnel
    for (const cookie of [alice, undefined]) {
      const res = await get('/admin/feature-requests.txt', cookie);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/login?next=%2Fadmin%2Ffeature-requests.txt');
    }
    expect((await get('/admin/feature-requests.txt', undefined, { ...tunnel, accept: 'text/html' })).statusCode).toBe(303);
    expect((await get('/admin/feature-requests.txt', undefined, tunnel)).statusCode).toBe(401);
  });

  it('links to the form from the library, the editor and the table', async () => {
    expect((await get('/', gm)).body).toContain('href="/feedback"');
    const { id } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { name: 'Crypt' } })).json() as { id: string };
    expect((await get(`/maps/${id}`, gm)).body).toContain(`href="/feedback?from=%2Fmaps%2F${id}"`);
    const { cookie, gameId } = await player();
    expect((await get('/play', cookie)).body).toContain('href="/feedback?from=%2Fplay"');
    expect((await get(`/play/${gameId}`, cookie)).body).toContain(`href="/feedback?from=%2Fplay%2F${gameId}"`);
  });
});
