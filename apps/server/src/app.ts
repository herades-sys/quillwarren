import { join } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';
import { AccountStore } from './accounts/store.ts';
import { registerApi } from './api.ts';
import { registerAssets } from './assets.ts';
import { Sessions } from './auth.ts';
import { registerChat, type ChatConfig } from './chat/route.ts';
import { ChatTokens } from './chat/tokens.ts';
import { PropLibrary, registerPropRoutes } from './custom-props.ts';
import { LiveHub } from './live.ts';
import { isLoggedIn, registerLogin, useAccounts, type EditorAuth } from './login.ts';
import { publicHostOf, registerPublicGate } from './public.ts';
import { registerMcp } from './mcp.ts';
import { registerPreview } from './preview.ts';
import { registerSegments } from './segments.ts';
import { registerTracePage } from './trace-page.ts';
import { registerHandoutPage } from './handout-page.ts';
import { ImageLibrary, registerImages } from './images.ts';
import { registerStack } from './stack.ts';
import type { DiscordConfig } from './table/discord.ts';
import { registerTable } from './table/routes.ts';
import { registerUi } from './ui.ts';
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
  /** DELVE_DATA: where Delve Table keeps its games and uploads. Without it they live in memory (tests). */
  dataDir?: string;
  /** DELVE_CHAT_URL: the chat bridge that runs Claude Code. Without it, there's no chat panel. */
  chat?: ChatConfig;
  /** DELVE_DISCORD_CLIENT_ID/SECRET (+ DELVE_PUBLIC_URL, DELVE_GM_DISCORD_IDS, DELVE_DISCORD_API): players log in with Discord. */
  discord?: DiscordConfig;
  /** DELVE_PUBLIC_URL: the address the Cloudflare tunnel publishes, e.g. https://delve.example.com. */
  publicUrl?: string;
}

/** Never let the WebSocket token or a Discord login's code and state reach the log. */
const redact = (url: string): string => url.replace(/([?&](?:token|code|state)=)[^&]*/g, '$1***');

export function buildApp(info: AppInfo, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    // cloudflared (the Cloudflare tunnel) connects from loopback: believe its X-Forwarded-* headers
    // (https, the client address), and nobody else's
    trustProxy: ['127.0.0.1', '::1'],
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
  // Uploaded map pictures: <DELVE_DATA>/images (a temp dir without one); PNG exports read them from here too.
  const images = new ImageLibrary(opts.dataDir ? join(opts.dataDir, 'images') : undefined);
  app.addHook('onClose', async () => images.close());
  // This Delve's own props, shared by every GM: <DELVE_DATA>/props (a temp dir without one).
  const props = new PropLibrary(opts.dataDir ? join(opts.dataDir, 'props') : undefined);
  app.addHook('onClose', async () => props.close());
  const auth: EditorAuth = { sessions: new Sessions(opts.token, opts.openEdit ?? false), passwordHash: opts.passwordHash };
  // Admin and GM accounts: <DELVE_DATA>/accounts.db (in memory without one).
  const accounts = new AccountStore(opts.dataDir ? join(opts.dataDir, 'accounts.db') : ':memory:', opts.token);
  app.addHook('onClose', async () => accounts.close());
  useAccounts(auth, accounts);
  // Through the Cloudflare tunnel: no API token, no MCP, and nothing but the table and the login without logging in.
  registerPublicGate(app, { publicHost: publicHostOf(opts.publicUrl), loggedIn: (req) => isLoggedIn(auth, req) });
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
    registerSegments(scoped, { service, token: opts.token, sessions: auth.sessions });
    registerAssets(scoped);
    registerImages(scoped, { images, store, token: opts.token, sessions: auth.sessions });
    registerPropRoutes(scoped, { props, store, token: opts.token, auth });
    registerMcp(scoped, { service, token: opts.token, version: info.version, chatTokens, images, props });
    registerChat(scoped, { service, token: opts.token, sessions: auth.sessions, tokens: chatTokens, config: opts.chat });
    registerLogin(scoped, auth);
    registerViewer(scoped, info, store, auth, opts.chat);
    registerStack(scoped, info, store);
    registerPreview(scoped, info, store, auth);
    registerTracePage(scoped, info, auth);
    registerHandoutPage(scoped, store);
    registerUi(scoped, info);
    registerTable(scoped, {
      maps: store,
      auth,
      token: opts.token,
      version: info.version,
      dataDir: opts.dataDir,
      onMapChange: (cb) => service.onChange(cb),
      ...(opts.discord ? { discord: opts.discord } : {}),
    });
  });
  return app;
}
