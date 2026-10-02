import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { parsePort } from '../src/config.ts';

describe('parsePort', () => {
  it('defaults to 8790 and keeps 0 as "any free port"', () => {
    expect(parsePort(undefined)).toBe(8790);
    expect(parsePort('')).toBe(8790);
    expect(parsePort('0')).toBe(0);
    expect(parsePort('8791')).toBe(8791);
  });

  it('rejects nonsense instead of guessing', () => {
    expect(() => parsePort('abc')).toThrow(/whole number/);
    expect(() => parsePort('70000')).toThrow(/whole number/);
    expect(() => parsePort('80.5')).toThrow(/whole number/);
  });
});

describe('server', () => {
  it('answers /health with version, start time and format', async () => {
    const app = buildApp({ version: 'test-1', started: '2026-09-28T00:00:00.000Z' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      app: 'delve',
      version: 'test-1',
      started: '2026-09-28T00:00:00.000Z',
      format: 'delve.map v1',
    });
    await app.close();
  });

  it('serves a start page', async () => {
    const app = buildApp({ version: 'test-1', started: 'now' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('Delve');
    await app.close();
  });
});

describe('preview page', () => {
  const app = buildApp({ version: 'test-1', started: 'now' });

  it('shows every style inline, each with its own clip ids', async () => {
    const body = (await app.inject({ url: '/' })).body;
    expect(body.match(/<svg (?!class="icon")/g)).toHaveLength(5); // the five style pictures (icons aside)
    for (const p of ['classic-hatching', 'clean', 'old-school-blue', 'print', 'parchment']) {
      expect(body).toContain(`id="${p}-clip-floor"`);
      expect(body).toContain(`href="/preview/${p}.png?view=gm"`);
    }
    expect(body).toContain('href="/play"'); // the Play button, for everyone
    expect(body).toContain('>S</text>'); // GM sees the secret door
    expect(body).toContain('1 Entrance hall [r1]'); // describeMap text
  });

  it('hides GM-only marks in the players’ view', async () => {
    const body = (await app.inject({ url: '/?view=players' })).body;
    expect(body).not.toContain('>S</text>');
    expect(body).toContain('aria-current="page">Players’ view');
  });

  it('serves SVG and Roll20-sized PNG downloads with the size in the filename', async () => {
    const svg = await app.inject({ url: '/preview/clean.svg?view=players' });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-disposition']).toMatch(/filename="test-dungeon-4-players_clean_players_\d+x\d+\.svg"/);
    const png = await app.inject({ url: '/preview/print.png?ppg=20' });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    const [, w, h] = /_(\d+)x(\d+)\.png/.exec(String(png.headers['content-disposition']))!;
    expect(png.rawPayload.readUInt32BE(16)).toBe(Number(w) * 20);
    expect(png.rawPayload.readUInt32BE(20)).toBe(Number(h) * 20);
  });

  it('rejects unknown styles and silly sizes', async () => {
    expect((await app.inject({ url: '/preview/neon.png' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/preview/clean.png?ppg=5' })).statusCode).toBe(400);
  });

  it('serves a live viewer page for a saved map', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: 'Bearer t' }, payload: {} });
    // this app has no token, so creation is refused: use a token-enabled app instead
    expect(created.statusCode).toBe(503);
    const withToken = buildApp({ version: 'v1', started: 'now' }, { token: 't' });
    const res = await withToken.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: 'Bearer t' }, payload: { template: 'test-dungeon', name: 'Viewer test' } });
    const { id } = res.json();
    const page = await withToken.inject({ url: `/maps/${id}?view=players` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<script id="delve-initial" type="application/json">');
    expect(page.body).toContain('<script type="module" src="/assets/viewer.js?v=v1">');
    expect(page.body).toContain('<input type="radio" name="view" value="players" checked>'); // the GM / Players switch starts on Players
    expect(page.body).not.toMatch(/id="players-banner"[^>]* hidden/);
    expect(page.body).toMatch(/<svg [^>]*viewBox=/); // first picture is server-rendered
    expect((await withToken.inject({ url: '/' })).body).toContain(`href="/maps/${id}"`);
    expect((await withToken.inject({ url: '/maps/map_nope' })).statusCode).toBe(404);
    await withToken.close();
  });

  it('serves the room-number font', async () => {
    const res = await app.inject({ url: '/fonts/marcellus-sc.ttf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/ttf');
  });

  it('serves the label font', async () => {
    const res = await app.inject({ url: '/fonts/im-fell-english.ttf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/ttf');
    expect(res.rawPayload.length).toBeGreaterThan(50_000);
  });
});
