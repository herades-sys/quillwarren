// The web app's fingerprint: the routes, pages and chat answers of the server
// as the CT runs it (no desktop mode), so a change meant for the desktop app
// can't slip into the web app unnoticed. web-baseline.test.ts compares this
// with fixtures/web-baseline.json, which was written from 3a8997d, before the
// desktop work.
//   node apps/server/test/web-baseline.ts            print the fingerprint
//   node apps/server/test/web-baseline.ts --write    rewrite the fixture (only when the web app changes on purpose)
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/app.ts';
import { MapStore } from '../src/store.ts';

export const BASELINE_FILE = resolve(import.meta.dirname, '../../../fixtures/web-baseline.json');

const INFO = { version: 'baseline', started: '2026-10-07T00:00:00.000Z' };
const TOKEN = 'baseline-token-0123456789abcdef';

interface Probe {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const MAP = 'map_test4p';
const PAGES: Probe[] = [
  { method: 'GET', url: '/health' },
  { method: 'GET', url: '/' },
  { method: 'GET', url: '/login' },
  { method: 'GET', url: '/admin' },
  { method: 'GET', url: '/account' },
  { method: 'GET', url: '/feedback' },
  { method: 'GET', url: '/ui' },
  { method: 'GET', url: '/play' },
  { method: 'GET', url: `/maps/${MAP}` },
  { method: 'GET', url: `/maps/${MAP}?view=players` },
  { method: 'GET', url: `/maps/${MAP}/3d` },
  { method: 'GET', url: `/maps/${MAP}/handout` },
  { method: 'GET', url: `/maps/${MAP}/screen` },
  { method: 'GET', url: '/import/image' },
  { method: 'GET', url: '/models' },
  { method: 'GET', url: '/api/v1/session' },
  { method: 'GET', url: '/api/v1/chat' },
  { method: 'GET', url: '/api/v1/chat/settings' },
  { method: 'GET', url: '/api/v1/maps' },
  { method: 'GET', url: `/api/v1/maps/${MAP}` },
  { method: 'POST', url: `/api/v1/maps/${MAP}/chat`, body: { message: 'Add a room' } },
  { method: 'POST', url: '/api/v1/maps', body: { name: 'x' } },
  { method: 'POST', url: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  { method: 'GET', url: '/mcp' },
  // through the Cloudflare tunnel (public mode)
  { method: 'GET', url: '/', headers: { 'cf-connecting-ip': '203.0.113.9', accept: 'text/html' } },
  { method: 'GET', url: `/maps/${MAP}`, headers: { 'cf-connecting-ip': '203.0.113.9', accept: 'text/html' } },
  { method: 'GET', url: '/api/v1/maps', headers: { 'cf-connecting-ip': '203.0.113.9' } },
  { method: 'POST', url: '/mcp', headers: { 'cf-connecting-ip': '203.0.113.9' }, body: {} },
  // the desktop app's header means nothing to the web server
  { method: 'GET', url: '/', headers: { 'x-delve-desktop': 'anything' } },
  { method: 'POST', url: '/api/v1/maps', headers: { 'x-delve-desktop': 'anything', cookie: 'delve_desktop=anything' }, body: { name: 'x' } },
];

/** The configurations the web app runs in: the live server, a bare test server, and an open-edit dev server with the chat bridge. */
function configs(dataDir: string): Record<string, AppOptions> {
  const chat = { bridgeUrl: 'http://127.0.0.1:9', port: 8790 };
  return {
    live: {
      token: TOKEN,
      chat,
      dataDir: join(dataDir, 'live'),
      publicUrl: 'https://delve.example.test',
      discord: { clientId: '123456789012345678', clientSecret: 'secret', publicUrl: 'https://delve.example.test' },
    },
    bare: {},
    openEditChat: { openEdit: true, chat, dataDir: join(dataDir, 'dev') },
  };
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** What the web app answers in each configuration: the route table, and status, type and a hash of the body for each probe. */
export async function webFingerprint(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'delve-baseline-'));
  const testMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as unknown;
  const out: Record<string, unknown> = {};
  try {
    for (const [name, opts] of Object.entries(configs(dir))) {
      if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
      const store = new MapStore(':memory:');
      store.create(testMap, 'baseline');
      const app = buildApp(INFO, { ...opts, store });
      await app.ready();
      const answers: Record<string, string> = {};
      for (const p of PAGES) {
        const res = await app.inject({
          method: p.method,
          url: p.url,
          headers: { ...(p.body !== undefined ? { 'content-type': 'application/json' } : {}), ...p.headers },
          ...(p.body !== undefined ? { payload: JSON.stringify(p.body) } : {}),
        });
        const type = String(res.headers['content-type'] ?? '').split(';')[0];
        const where = res.headers.location ? ` -> ${String(res.headers.location)}` : '';
        // small JSON answers verbatim, everything else hashed; times, new map ids and seeds blanked
        const text = res.body
          .replace(/"(created|updated)":"[^"]*"/g, '"$1":"*"')
          .replace(/map_[0-9a-f]{12}/g, 'map_*')
          .replace(/"seed":\d+/g, '"seed":0');
        const body = type === 'application/json' && text.length < 400 ? text : sha(text);
        answers[`${p.method} ${p.url}${p.headers ? ` ${JSON.stringify(p.headers)}` : ''}`] = `${res.statusCode} ${type}${where} ${body}`;
      }
      out[name] = { routes: app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean), answers };
      await app.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const fp = await webFingerprint();
  const text = `${JSON.stringify(fp, null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE_FILE, text);
    console.log(`wrote ${BASELINE_FILE}`);
  } else process.stdout.write(text);
}
