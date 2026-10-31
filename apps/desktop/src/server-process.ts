// The Delve server as a child process of the desktop app, run by the bundled
// Node.js (resources\node\node.exe, Node 24 like the server's tests) rather
// than by Electron's own Node: see docs/DESKTOP.md, "Why a separate Node". It
// talks over Node's IPC channel: the server sends {type: "ready", port} once
// it listens, the app sends {type: "shutdown"} to stop it cleanly, and when the
// app dies the channel closes and the server stops by itself. Its output goes
// to logs\server.log. No Electron here, so it is tested on its own.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DesktopPaths } from './paths.ts';

export interface ServerLaunch {
  node: string;
  entry: string;
  secret: string;
  paths: DesktopPaths;
  /** The port to try first (the last launch's, so the window's origin stays the same); 0 = any. */
  port: number;
  version: string;
  /** llama-server, when the build has it. */
  llama?: string;
  /** The Claude Desktop key while the user has connected Claude Desktop (claude-desktop.ts). */
  claudeKey?: string;
}

/**
 * The server's environment: the user's own (PATH, SystemRoot, TEMP, USERPROFILE…)
 * without anything that could change how Node runs it or leak into it, plus Delve's settings.
 */
export function serverEnv(base: NodeJS.ProcessEnv, o: Omit<ServerLaunch, 'node' | 'entry'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if (key.startsWith('ELECTRON_') || key.startsWith('DELVE_') || key.startsWith('NODE_') || key === 'PORT' || key === 'HOST') continue;
    env[k] = v;
  }
  return {
    ...env,
    NODE_ENV: 'production',
    DELVE_DESKTOP_SECRET: o.secret,
    DELVE_DATA: o.paths.data,
    DELVE_LOG_DIR: o.paths.logs,
    DELVE_MODELS_DIR: o.paths.models,
    DELVE_VERSION: o.version,
    PORT: String(o.port),
    ...(o.llama ? { DELVE_LLAMA_SERVER: o.llama } : {}),
    ...(o.claudeKey ? { DELVE_CLAUDE_DESKTOP_KEY: o.claudeKey } : {}),
  };
}

export interface ServerEvents {
  output(text: string): void;
  /** It stopped without being asked to. */
  crashed(code: number | null, signal: string | null): void;
  /** Any other message from it (the key vault's requests: vault.ts). */
  message?(msg: unknown): void;
}

export class ServerProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  port = 0;

  private readonly launch: ServerLaunch;
  private readonly events: ServerEvents;

  constructor(launch: ServerLaunch, events: ServerEvents) {
    this.launch = launch;
    this.events = events;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Starts it and resolves with the port once it listens (rejects with its last output when it doesn't). */
  start(timeoutMs = 45_000): Promise<number> {
    const l = this.launch;
    if (!existsSync(l.node)) return Promise.reject(new Error(`the bundled Node.js is missing: ${l.node}`));
    if (!existsSync(l.entry)) return Promise.reject(new Error(`the Delve server is missing: ${l.entry}`));
    this.stopping = false;
    const child = spawn(l.node, [l.entry], {
      env: serverEnv(process.env, l),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      cwd: l.paths.userData,
    });
    this.child = child;
    let recent = '';
    const take = (d: Buffer) => {
      const s = d.toString('utf8');
      recent = (recent + s).slice(-3000);
      this.events.output(s);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    return new Promise<number>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        reject(new Error(`the Delve server didn't start within ${Math.round(timeoutMs / 1000)} s:\n${recent.trim().slice(-1500)}`));
        child.kill();
      }, timeoutMs);
      child.on('message', (m: unknown) => {
        const msg = m as { type?: string; port?: number };
        if (msg?.type === 'ready' && typeof msg.port === 'number' && !ready) {
          ready = true;
          clearTimeout(timer);
          this.port = msg.port;
          resolve(msg.port);
        } else if (msg?.type !== 'ready') this.events.message?.(m);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`couldn't start the Delve server: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!ready) reject(new Error(`the Delve server stopped while starting (${code ?? signal}):\n${recent.trim().slice(-1500)}`));
        else if (!this.stopping) this.events.crashed(code, signal);
      });
    });
  }

  /** A message to the server over IPC; false when it isn't running. */
  send(msg: unknown): boolean {
    const child = this.child;
    if (!child || !child.connected) return false;
    try {
      return child.send(msg as object);
    } catch {
      return false;
    }
  }

  /** Sends a message and waits for the first answer of `type` (or gives up after `timeoutMs`). */
  request(msg: unknown, type: string, timeoutMs = 3000): Promise<unknown> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new Error('the server isn’t running'));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        child.off('message', on);
      };
      const on = (m: unknown) => {
        if ((m as { type?: unknown })?.type !== type) return;
        done();
        resolve(m);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('the server didn’t answer'));
      }, timeoutMs);
      child.on('message', on);
      if (!this.send(msg)) {
        done();
        reject(new Error('the server isn’t running'));
      }
    });
  }

  /** Asks it to stop (it closes the database and the model runtime), and makes sure it does. */
  async stop(graceMs = 6000): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill();
    } catch {
      child.kill();
    }
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs));
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
    this.child = null;
  }
}
