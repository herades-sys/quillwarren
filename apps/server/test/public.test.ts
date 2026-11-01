// Public mode: what a request through the Cloudflare tunnel may do (no API token,
// no MCP, nothing but the table and the login without logging in), the client IP
// behind it, and Quillwarren page pictures served to members of a game.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { addressBucket, clientIp, publicHostOf, viaTunnel } from '../src/public.ts';

const TOKEN = 'public-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };
// what cloudflared adds to every request it passes on
const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delve-public-'));
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, dataDir: dir, publicUrl: 'https://delve.example' });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeReq = (remote: string, headers: Record<string, string>) => ({ socket: { remoteAddress: remote }, headers, ip: remote }) as unknown as FastifyRequest;

describe('requests through the tunnel', () => {
  it('are told apart by the public host or Cloudflare headers', () => {
    expect(publicHostOf('https://Quillwarren.Example/')).toBe('quillwarren.example');
    expect(viaTunnel(fakeReq('127.0.0.1', { host: 'delve.example' }), 'delve.example')).toBe(true);
    expect(viaTunnel(fakeReq('127.0.0.1', { host: '127.0.0.1:8790', 'cf-ray': 'x' }), 'delve.example')).toBe(true);
    expect(viaTunnel(fakeReq('192.168.1.20', { host: '192.168.1.9:8790' }), 'delve.example')).toBe(false);
  });

  it('count an IPv6 client by its /64 and an IPv4 client by its address', () => {
    expect(addressBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(addressBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:0DB8:0001:0002:abcd:ef01:2345:6789')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressBucket('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(addressBucket('not:an:address::x')).toBe('not:an:address::x');
  });

  it("trust Cloudflare's client address only when cloudflared (loopback) passed it on", () => {
    expect(clientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(fakeReq('192.168.1.20', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('192.168.1.20');
  });

  it('refuse MCP and the API token, which stay home-only', async () => {
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { ...tunnel, ...bearer }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/maps', headers: { ...tunnel, ...bearer } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/games/x/live?token=' + TOKEN, headers: tunnel })).statusCode).toBe(403);
    // at home the token works as before
    expect((await app.inject({ url: '/api/v1/maps', headers: bearer })).statusCode).toBe(200);
  });

  it('show nothing of the maps without a login, but keep the table and the login open', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon' } })).json() as { id: string };
    expect((await app.inject({ url: '/api/v1/maps', headers: tunnel })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.png`, headers: tunnel })).statusCode).toBe(401);
    const page = await app.inject({ url: `/maps/${id}`, headers: { ...tunnel, accept: 'text/html' } });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe(`/login?next=${encodeURIComponent(`/maps/${id}`)}`);
    for (const url of ['/health', '/play', '/login', '/favicon.svg']) {
      expect((await app.inject({ url, headers: { ...tunnel, accept: 'text/html' } })).statusCode, url).not.toBe(401);
      expect((await app.inject({ url, headers: { ...tunnel, accept: 'text/html' } })).statusCode, url).not.toBe(303);
    }
    // a GM's one-time setup link carries ?token= too; it isn't the API token
    expect((await app.inject({ url: '/account/setup?token=nope', headers: { ...tunnel, accept: 'text/html' } })).statusCode).not.toBe(403);
    // and from home, reading stays open like before
    expect((await app.inject({ url: `/api/v1/maps/${id}/render.png` })).statusCode).toBe(200);
  });
});

describe('Quillwarren page pictures through the game', () => {
  it('go to members only, and players only get their own page in the players view', async () => {
    const { id: mapId } = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: bearer, payload: { template: 'test-dungeon' } })).json() as { id: string };
    const { id: gameId } = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: 'Crypt' } })).json() as { id: string };
    const { page } = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/pages/from-map`, headers: bearer, payload: { mapId } })).json();
    const url = `/api/v1/games/${gameId}/pages/${page.id}/background.png`;

    const gm = await app.inject({ url: `${url}?view=gm`, headers: bearer });
    expect(gm.statusCode).toBe(200);
    expect(gm.headers['content-type']).toBe('image/png');
    // the page's frame at 70 px per square
    expect(gm.rawPayload.readUInt32BE(16)).toBe(page.width * 70);
    expect(gm.rawPayload.readUInt32BE(20)).toBe(page.height * 70);

    expect((await app.inject({ url })).statusCode).toBe(403); // not a member
    expect((await app.inject({ url, headers: tunnel })).statusCode).toBe(403); // the gate lets it through, the game says no

    const inviteUrl = (await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: bearer, payload: {} })).json().url as string;
    const join = await app.inject({
      method: 'POST',
      url: `/play/join/${inviteUrl.split('/play/join/')[1]}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Alice',
    });
    const cookie = String(join.headers['set-cookie']).split(';')[0]!;
    // the players are still on the first page, so this one isn't theirs yet
    expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/games/${gameId}/pages/nope/background.png`, headers: bearer })).statusCode).toBe(404);
  });
});

describe('behind cloudflared', () => {
  it('builds links and cookies for https, as the tunnel says', async () => {
    const { id: gameId } = (await app.inject({ method: 'POST', url: '/api/v1/games', headers: bearer, payload: { name: 'Crypt' } })).json() as { id: string };
    // inject connects from 127.0.0.1 like cloudflared, so X-Forwarded-Proto counts (another host name, so the token is allowed)
    const res = await app.inject({ method: 'POST', url: `/api/v1/games/${gameId}/invites`, headers: { ...bearer, host: 'table.home.arpa', 'x-forwarded-proto': 'https' }, payload: {} });
    expect(res.json().url).toMatch(/^https:\/\/table\.home\.arpa\/play\/join\//);
  });
});
