// Entry point. The release bundle (release/main.mjs) is built from this file.
// Env: PORT (default 8790; 0 = any free port), HOST, DELVE_DATA (database dir),
// DELVE_API_TOKEN (needed for any change; without it the API is read-only).
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

const app = buildApp({ version: readVersion(), started: new Date().toISOString() }, { logger: true, store, token });
if (!token) app.log.warn('DELVE_API_TOKEN is not set: the API is read-only');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host }); // Fastify logs the address it actually bound
