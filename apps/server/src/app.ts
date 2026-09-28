import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';
import { registerApi } from './api.ts';
import { Sessions } from './auth.ts';
import { LiveHub } from './live.ts';
import { registerLogin, type EditorAuth } from './login.ts';
import { registerMcp } from './mcp.ts';
import { registerPreview } from './preview.ts';
import { MapService } from './service.ts';
import { MapStore } from './store.ts';
import { registerViewer } from './viewer.ts';

export interface AppInfo {
  version: string;
  started: string;
}

export interface AppOptions {
  logger?: boolean;
  /** Defaults to an in-memory store that closes with the app. */
  store?: MapStore;
  /** DELVE_API_TOKEN. Without it, every write is refused and nobody can log in. */
  token?: string;
  /** DELVE_EDIT_PASSWORD_HASH, set by `delve-passwd`. Without it, the browser editor can't log in. */
  passwordHash?: string;
  /** DELVE_INSECURE_OPEN_EDIT=1: every browser counts as logged in. Development servers only. */
  openEdit?: boolean;
}

/** Never let the WebSocket token reach the log. */
const redact = (url: string): string => url.replace(/([?&]token=)[^&]*/g, '$1***');

export function buildApp(info: AppInfo, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    logger: opts.logger
      ? {
          serializers: {
            req: (req) => ({ method: req.method, url: redact(req.url), remoteAddress: req.ip }),
          },
        }
      : false,
  });
  const store = opts.store ?? new MapStore(':memory:');
  if (!opts.store) app.addHook('onClose', async () => store.close());
  const service = new MapService(store, new LiveHub());
  const auth: EditorAuth = { sessions: new Sessions(opts.token, opts.openEdit ?? false), passwordHash: opts.passwordHash };
  if (opts.openEdit) app.log.warn('DELVE_INSECURE_OPEN_EDIT is on: every browser can edit. Never use this on the live server.');

  // HTML forms (the login page) post urlencoded bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/health', async () => ({
    ok: true,
    app: 'delve',
    version: info.version,
    started: info.started,
    format: `${FORMAT} v${FORMAT_VERSION}`,
  }));

  void app.register(websocket);
  void app.register(async (scoped) => {
    registerApi(scoped, { service, token: opts.token, sessions: auth.sessions });
    registerMcp(scoped, { service, token: opts.token, version: info.version });
    registerLogin(scoped, auth);
    registerViewer(scoped, info, store, auth);
    registerPreview(scoped, info, store, auth);
  });
  return app;
}
