import { join } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { FORMAT, FORMAT_VERSION } from '@delve/core';
import { AccountStore } from './accounts/store.ts';
import { registerApi } from './api.ts';
import { registerAssets } from './assets.ts';
import { Sessions } from './auth.ts';
import { registerChat, type ChatBackends, type ChatConfig } from './chat/route.ts';
import { ChatTokens } from './chat/tokens.ts';
import { PropLibrary, registerPropRoutes } from './custom-props.ts';
import { FeedbackLog, FILE_NAME, SendLimits } from './feedback/log.ts';
import { requestsSection } from './feedback/page.ts';
import { registerFeedback } from './feedback/routes.ts';
import { LiveHub } from './live.ts';
import { isLoggedIn, registerLogin, useAccounts, type EditorAuth } from './login.ts';
import { publicHostOf, registerPublicGate } from './public.ts';
import { registerMcp } from './mcp.ts';
import { registerPreview } from './preview.ts';
import { registerSegments } from './segments.ts';
import { registerTracePage } from './trace-page.ts';
import { registerHandoutPage } from './handout-page.ts';
import { registerHostCheck } from './hosts.ts';
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
  /** DELVE_ALLOWED_HOSTS: host names the server answers to besides IP addresses, home-network names and the public one (hosts.ts). */
  allowedHosts?: string[];
  // ----- the desktop app only (desktop/main.ts); the web server (main.ts) sets none of these -----
  /** One local user: whoever gets past the desktop gate (`extend`) is logged in, with no login page. Its gate checks the Host itself, so the web server's host check is off. */
  singleUser?: boolean;
  /**
   * false: one person's editor with no players (the desktop app). Delve Table
   * (its routes, table.db, table-assets), the players' screen, Discord login and
   * the links to them are left out. Unset: all of them, as on the web server.
   */
  multiplayer?: boolean;
  /** Chat backends besides the bridge (chat/local-chat.ts), made once the app's libraries exist. */
  chatBackends?: (ctx: AppContext) => ChatBackends;
  /** Hooks and routes added before any other (the desktop gate, the model manager). */
  extend?: (app: FastifyInstance, ctx: AppContext) => void;
  /**
   * /mcp without the API token: the requests the desktop gate let in with the
   * Claude Desktop key (desktop/gate.ts). Unset: the API token and chat tokens
   * only, as on the web server.
   */
  mcpGrant?: (req: FastifyRequest) => boolean;
  /** A paragraph added to the MCP server's instructions (the desktop app: links open only inside the app). */
  mcpNote?: string;
}

/** What `extend` and `chatBackends` get to work with. */
export interface AppContext {
  info: AppInfo;
  store: MapStore;
  service: MapService;
  auth: EditorAuth;
  images: ImageLibrary;
  props: PropLibrary;
}

/**
 * Never let a secret in a URL reach the log: the API or player token on a
 * WebSocket and a setup link's token (?token=), a Discord login's code and
 * state, and an invite's token in /play/join/<token>, also where it rides
 * along in ?next= (as it is or URL-encoded).
 */
export const redactUrl = (url: string): string =>
  url
    .replace(/([?&](?:token|code|state)=)[^&]*/g, '$1***')
    .replace(/(\/play\/join\/)[^?&]*/gi, '$1***')
    .replace(/(%2Fplay%2Fjoin%2F)[^&]*/gi, '$1***');

/** The biggest WebSocket message: a map socket's ops may carry as much as a REST write (bodyLimit); the table socket allows 64 KB of its own. */
export const WS_MAX_PAYLOAD = 5 * 1024 * 1024;

export function buildApp(info: AppInfo, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    // cloudflared (the Cloudflare tunnel) connects from loopback: believe its X-Forwarded-* headers
    // (https, the client address), and nobody else's
    trustProxy: ['127.0.0.1', '::1'],
    logger: opts.logger
      ? {
          serializers: {
            req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
          },
        }
      : false,
  });
  // Only our own host names, before anything else (DNS rebinding); the desktop app's gate checks the Host itself.
  if (!opts.singleUser) {
    const publicHosts = [publicHostOf(opts.publicUrl), publicHostOf(opts.discord?.publicUrl)].filter((h): h is string => Boolean(h));
    registerHostCheck(app, { allowed: [...publicHosts, ...(opts.allowedHosts ?? [])] });
  }
  const store = opts.store ?? new MapStore(':memory:');
  if (!opts.store) app.addHook('onClose', async () => store.close());
  const service = new MapService(store, new LiveHub());
  // Uploaded map pictures: <DELVE_DATA>/images (a temp dir without one); PNG exports read them from here too.
  const images = new ImageLibrary(opts.dataDir ? join(opts.dataDir, 'images') : undefined);
  app.addHook('onClose', async () => images.close());
  // This Delve's own props, shared by every GM: <DELVE_DATA>/props (a temp dir without one).
  const props = new PropLibrary(opts.dataDir ? join(opts.dataDir, 'props') : undefined);
  app.addHook('onClose', async () => props.close());
  const auth: EditorAuth = { sessions: new Sessions(opts.token, Boolean(opts.openEdit || opts.singleUser)), passwordHash: opts.passwordHash };
  // Admin and GM accounts: <DELVE_DATA>/accounts.db (in memory without one).
  const accounts = new AccountStore(opts.dataDir ? join(opts.dataDir, 'accounts.db') : ':memory:', opts.token);
  app.addHook('onClose', async () => accounts.close());
  useAccounts(auth, accounts);
  // Feature requests from /feedback: <DELVE_DATA>/feature-requests.txt (a temp file without one).
  const feedback = new FeedbackLog(opts.dataDir ? join(opts.dataDir, FILE_NAME) : undefined);
  app.addHook('onClose', async () => feedback.close());
  // Through the Cloudflare tunnel: no API token, no MCP, and nothing but the table and the login without logging in.
  const ctx: AppContext = { info, store, service, auth, images, props };
  opts.extend?.(app, ctx);
  const backends = opts.chatBackends?.(ctx);
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

  void app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  const chatTokens = new ChatTokens();
  // Delve Table, the players' screen and Discord: everywhere but the desktop app
  const multiplayer = opts.multiplayer !== false;
  void app.register(async (scoped) => {
    registerApi(scoped, { service, token: opts.token, sessions: auth.sessions, screen: multiplayer });
    registerSegments(scoped, { service, token: opts.token, sessions: auth.sessions });
    registerAssets(scoped);
    registerImages(scoped, { images, store, token: opts.token, sessions: auth.sessions });
    registerPropRoutes(scoped, { props, store, token: opts.token, auth });
    registerMcp(scoped, { service, token: opts.token, version: info.version, chatTokens, images, props, ...(opts.mcpGrant ? { grant: opts.mcpGrant } : {}), ...(opts.mcpNote ? { note: opts.mcpNote } : {}) });
    registerChat(scoped, { service, token: opts.token, sessions: auth.sessions, tokens: chatTokens, config: opts.chat, backends });
    registerLogin(scoped, auth, { adminSection: () => requestsSection(feedback.summary()) });
    registerViewer(scoped, info, store, auth, opts.chat, backends, multiplayer);
    registerStack(scoped, info, store);
    registerPreview(scoped, info, store, auth, { multiplayer, singleUser: Boolean(opts.singleUser) });
    registerTracePage(scoped, info, auth);
    registerHandoutPage(scoped, store, auth, info.version);
    registerUi(scoped, info);
    const table = multiplayer
      ? registerTable(scoped, {
          maps: store,
          auth,
          token: opts.token,
          version: info.version,
          dataDir: opts.dataDir,
          onMapChange: (cb) => service.onChange(cb),
          ...(opts.discord ? { discord: opts.discord } : {}),
        })
      : undefined;
    registerFeedback(scoped, { auth, log: feedback, limits: new SendLimits(), ...(table ? { table } : {}) });
  });
  return app;
}
