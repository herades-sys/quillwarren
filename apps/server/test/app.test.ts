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

  it('shows all four styles inline, each with its own clip ids', async () => {
    const body = (await app.inject({ url: '/' })).body;
    expect(body.match(/<svg /g)).toHaveLength(4);
    for (const p of ['classic-hatching', 'clean', 'old-school-blue', 'print']) {
      expect(body).toContain(`id="${p}-clip-floor"`);
      expect(body).toContain(`href="/preview/${p}.png?view=gm"`);
    }
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

  it('serves the label font', async () => {
    const res = await app.inject({ url: '/fonts/im-fell-english.ttf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/ttf');
    expect(res.rawPayload.length).toBeGreaterThan(50_000);
  });
});
