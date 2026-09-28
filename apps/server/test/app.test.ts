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
