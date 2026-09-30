import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';
import { registerApi } from './api.ts';
import { registerAssets } from './assets.ts';
import { Sessions } from './auth.ts';
import { registerChat, type ChatConfig } from './chat/route.ts';
import { ChatTokens } from './chat/tokens.ts';
import { LiveHub } from './live.ts';
import { registerLogin, type EditorAuth } from './login.ts';
import { registerMcp } from './mcp.ts';
import { registerPreview } from './preview.ts';
import { registerTracePage } from './trace-page.ts';
import { registerStack } from './stack.ts';
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
  /** DELVE_CHAT_URL: the chat bridge that runs Claude Code. Without it, there's no chat panel. */
  chat?: ChatConfig;
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

  // HTML forms (the login page) post urlencoded bodies; file imports post raw bytes.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/health', async () => ({
    ok: true,
    app: 'delve',
    version: info.version,
    started: info.started,
    format: `${FORMAT} v${FORMAT_VERSION}`,
  }));

  void app.register(websocket);
  const chatTokens = new ChatTokens();
  void app.register(async (scoped) => {
    registerApi(scoped, { service, token: opts.token, sessions: auth.sessions });
    registerAssets(scoped);
    registerMcp(scoped, { service, token: opts.token, version: info.version, chatTokens });
    registerChat(scoped, { service, token: opts.token, sessions: auth.sessions, tokens: chatTokens, config: opts.chat });
    registerLogin(scoped, auth);
    registerViewer(scoped, info, store, auth, opts.chat);
    registerStack(scoped, info, store);
    registerPreview(scoped, info, store, auth);
    registerTracePage(scoped, info, auth);
  });
  return app;
}
