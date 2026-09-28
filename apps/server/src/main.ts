// Entry point. The release bundle (release/main.mjs) is built from this file.
// Env: PORT (default 8790; 0 = any free port), HOST, DELVE_DATA, DELVE_API_TOKEN.
import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { parsePort } from './config.ts';

function readVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || '0.0.0.0';
const app = buildApp({ version: readVersion(), started: new Date().toISOString() }, { logger: true });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host }); // Fastify logs the address it actually bound
