// The Delve server inside the Windows desktop app. apps/desktop runs it with
// its own bundled Node.js (node.exe, the same Node 24 the server is tested on)
// as a child process, bundled by apps/desktop/scripts/build.sh into
// server/desktop-main.mjs. The web server's entry is main.ts; this file and
// everything under desktop/ are never part of the web release.
//
// Differences from the web server, all set here (none by env on the web side):
// - listens on 127.0.0.1 only, on the port the app asks for or any free one;
// - every request passes the desktop gate (desktop/gate.ts): the launch secret,
//   the Host check, the Origin check; there is no API token and no MCP;
// - one local user and no login (`singleUser`);
// - no players (`multiplayer: false`): no Delve Table (no table.db), no
//   players' screen, no Discord login, and no links to them;
// - the data lives where the app says (%APPDATA%\Delve\data);
// - the chat answers with a local model or not at all (chat/local-chat.ts),
//   never through the Claude bridge, plus the model manager (/models);
// - no Cloudflare tunnel, no public URL.
// The app talks to it over Node's IPC channel: {type: "ready", port} once it
// listens, and {type: "shutdown"} asks it to stop cleanly. When the app goes
// away (the channel closes) it stops too.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../app.ts';
import { localChatBackends } from '../chat/local-chat.ts';
import { MapStore } from '../store.ts';
import { desktopConfig } from './config.ts';
import { registerDesktopGate } from './gate.ts';
import { registerModelManager } from './models-page.ts';
import { ModelLibrary, RuntimeSettingsStore } from './models.ts';
import { LlamaRuntime } from './runtime.ts';

const cfg = desktopConfig(process.env);
// The secret stays in this process: no child (llama-server) inherits it.
delete process.env.DELVE_DESKTOP_SECRET;

function readVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return cfg.version;
  }
}

for (const d of [cfg.dataDir, cfg.logDir, cfg.modelsDir]) mkdirSync(d, { recursive: true });
const store = new MapStore(join(cfg.dataDir, 'delve.db'));
const models = new ModelLibrary(cfg.modelsDir);
const runtimeSettings = new RuntimeSettingsStore(join(cfg.dataDir, 'runtime.json'));
let log: (msg: string) => void = (msg) => console.log(msg);
const runtime = new LlamaRuntime({
  ...(cfg.llamaServer ? { binary: cfg.llamaServer } : {}),
  logFile: join(cfg.logDir, 'llama-server.log'),
  pidFile: join(cfg.dataDir, 'llama-server.pid'),
  keyFile: join(cfg.dataDir, 'llama-server.key'),
  log: (m) => log(m),
});
let port = 0;

const app = buildApp(
  { version: readVersion(), started: new Date().toISOString() },
  {
    logger: true,
    store,
    dataDir: cfg.dataDir,
    singleUser: true,
    multiplayer: false,
    extend: (a) => {
      registerDesktopGate(a, { secret: cfg.secret, port: () => port });
      registerModelManager(a, { models, settings: runtimeSettings, runtime, ollamaDir: cfg.ollamaModels, log: (m) => log(m) });
    },
    chatBackends: (ctx) =>
      localChatBackends(ctx, {
        settingsFile: join(cfg.dataDir, 'chat-settings.json'),
        links: { models: '/models' },
        builtin: runtime.asBuiltin(models, runtimeSettings),
        log: (m) => log(m),
      }),
  },
);
log = (msg) => app.log.info(msg);

let closing: Promise<void> | null = null;
function shutdown(why: string): Promise<void> {
  closing ??= (async () => {
    app.log.info(`shutting down (${why})`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    await runtime.stop().catch(() => {});
    await app.close().catch(() => {});
    store.close();
    clearTimeout(force);
    process.exit(0);
  })();
  return closing;
}
process.on('message', (m: unknown) => {
  if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'shutdown') void shutdown('the app asked');
});
process.on('disconnect', () => void shutdown('the app went away'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown(signal));

try {
  await app.listen({ port: cfg.port, host: '127.0.0.1' });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || cfg.port === 0) throw e;
  app.log.warn(`port ${cfg.port} is taken: using a free one`);
  await app.listen({ port: 0, host: '127.0.0.1' });
}
const addr = app.server.address();
port = typeof addr === 'object' && addr ? addr.port : 0;
app.log.info({ port, data: cfg.dataDir, models: cfg.modelsDir, runtime: runtime.status().state }, 'Delve desktop server ready');
await runtime.cleanUpStale().catch(() => false);
process.send?.({ type: 'ready', port });
