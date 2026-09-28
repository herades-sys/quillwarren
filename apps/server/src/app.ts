import Fastify, { type FastifyInstance } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';
import { registerPreview } from './preview.ts';

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

  registerPreview(app, info);
  return app;
}
