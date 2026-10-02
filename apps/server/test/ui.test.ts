// The shared stylesheet, the style guide, and the account pages on top of them.
import { afterAll, describe, expect, it } from 'vitest';
import { UI_CSS, UI_CSS_VERSION } from '@delve/ui';
import { buildApp } from '../src/app.ts';
import { loginPage } from '../src/accounts/pages.ts';

const app = buildApp({ version: 'test-ui', started: 'now' });
afterAll(() => app.close());

describe('the shared look', () => {
  it('serves the stylesheet, cached for good only at its own version', async () => {
    const res = await app.inject({ method: 'GET', url: `/assets/delve-ui.css?v=${UI_CSS_VERSION}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.body).toBe(UI_CSS);
    const stale = await app.inject({ method: 'GET', url: '/assets/delve-ui.css?v=old' });
    expect(stale.headers['cache-control']).toBe('public, max-age=300');
  });

  it('serves the fonts the stylesheet names', async () => {
    for (const f of ['im-fell-english.ttf', 'im-fell-english-italic.ttf', 'marcellus-sc.ttf']) {
      const res = await app.inject({ method: 'GET', url: `/fonts/${f}` });
      expect(res.statusCode, f).toBe(200);
      expect(res.headers['content-type']).toBe('font/ttf');
      expect(res.rawPayload.length).toBeGreaterThan(10_000);
    }
  });

  it('lets the stylesheet through the tunnel without a login, but not the style guide', async () => {
    const tunnel = { host: 'delve.example', 'cf-connecting-ip': '203.0.113.9', accept: 'text/html' };
    const pub = buildApp({ version: 'test-ui', started: 'now' }, { publicUrl: 'https://delve.example' });
    expect((await pub.inject({ method: 'GET', url: `/assets/delve-ui.css?v=${UI_CSS_VERSION}`, headers: tunnel })).statusCode).toBe(200);
    const guide = await pub.inject({ method: 'GET', url: '/ui', headers: tunnel });
    expect(guide.statusCode).toBe(303);
    expect(guide.headers.location).toBe('/login?next=%2Fui');
    await pub.close();
  });

  it('shows every component on /ui in both themes', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain(`/assets/delve-ui.css?v=${UI_CSS_VERSION}`);
    for (const s of ['Colour tokens', 'Type', 'Space, radius, elevation', 'Icons', 'Buttons', 'Segmented controls and tabs', 'Tool rail, tooltip and context bar', 'Inspector fields', 'Cards, tables, tags', 'Toasts, dialogs, the marker note', 'Chat lines and roll cards', 'Token settings and the bottom sheet', 'Empty, loading, live and offline']) {
      expect(html, s).toContain(s);
    }
    expect(html.match(/data-theme="dark"/g)!.length).toBeGreaterThanOrEqual(10);
    expect(html.match(/data-theme="light"/g)!.length).toBeGreaterThanOrEqual(10);
    expect(html).toMatch(/\d+\.\d : 1 AA/); // contrast ratios are computed from the tokens
    expect(html).not.toContain(': 1 fail');
    expect(html).not.toMatch(/undefined|NaN|\[object /);
  });

  it('builds the login page on the shared layer', () => {
    const html = loginPage({ next: '/maps', error: 'Nope <b>' });
    expect(html).toContain(`/assets/delve-ui.css?v=${UI_CSS_VERSION}`);
    expect(html).toContain('data-theme-set');
    expect(html).toContain('<p class="error" role="alert">Nope &lt;b&gt;</p>');
    expect(html).toContain('class="btn btn-primary btn-lg" type="submit">Log in</button>');
    // every input has a label that points at it
    const ids = [...html.matchAll(/<input id="(f\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['f1', 'f2', 'f3']);
    for (const id of ids) expect(html).toContain(`<label for="${id}">`);
    expect(html).not.toMatch(/googleapis|TOKENS_CSS/);
  });
});
