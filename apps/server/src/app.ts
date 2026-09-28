import Fastify, { type FastifyInstance } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';

export interface AppInfo {
  version: string;
  started: string;
}

export function buildApp(info: AppInfo, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/health', async () => ({
    ok: true,
    app: 'delve',
    version: info.version,
    started: info.started,
    format: `${FORMAT} v${FORMAT_VERSION}`,
  }));

  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Delve</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Delve</h1><p>The server is running. The map editor arrives in phase 4.</p>
<p style="color:#667">Release ${info.version} · started ${info.started} · ${FORMAT} v${FORMAT_VERSION}</p></body>`),
  );

  return app;
}
