// Entry point. The release bundle (release/main.mjs) is built from this file.
// Env: PORT (default 8790; 0 = any free port), HOST, DELVE_DATA (database dir),
// DELVE_API_TOKEN (needed for any change; without it the API is read-only),
// DELVE_CHAT_URL (the chat bridge, e.g. http://127.0.0.1:8792) and DELVE_CHAT_MODEL.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { parsePort } from './config.ts';
import { MapStore } from './store.ts';

function readVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DELVE_DATA || './data';
mkdirSync(dataDir, { recursive: true });
const store = new MapStore(join(dataDir, 'delve.db'));
const token = process.env.DELVE_API_TOKEN || undefined;
const passwordHash = process.env.DELVE_EDIT_PASSWORD_HASH || undefined;
const openEdit = process.env.DELVE_INSECURE_OPEN_EDIT === '1';
const chatUrl = process.env.DELVE_CHAT_URL || undefined;
const chat = chatUrl ? { bridgeUrl: chatUrl, port: port || 8790, model: process.env.DELVE_CHAT_MODEL || undefined } : undefined;

const app = buildApp(
  { version: readVersion(), started: new Date().toISOString() },
  { logger: true, store, token, passwordHash, openEdit, chat },
);
if (!token) app.log.warn('DELVE_API_TOKEN is not set: the API is read-only');
if (!passwordHash && !openEdit) app.log.info('no editor password set (run delve-passwd): the browser editor is read-only');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host }); // Fastify logs the address it actually bound
