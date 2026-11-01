// The built-in model runtime: Quillwarren starts llama.cpp's llama-server (MIT) with
// a GGUF model and talks to its OpenAI-compatible API (/v1/chat/completions),
// so the desktop app's chat needs no Ollama. This is the code only: the
// binary isn't bundled yet. When it is, apps/desktop puts it at
// resources/llama/llama-server.exe and passes DELVE_LLAMA_SERVER; until then
// `binary` is undefined and the model manager says so.
//
// What it does: pick a free port on 127.0.0.1, start llama-server with a fresh
// API key (in a key file, never on the command line), wait until /health says
// the model is loaded, restart it when it crashes (a few times, with a growing
// pause), log its output to logs/llama-server.log, and stop it with the app.
// GPU offload is "all layers" with a CPU fallback: when the GPU start fails
// (old driver, too little video memory) it starts again with no layers on the
// GPU. A pid file lets the next launch end a llama-server the last one left
// behind (when Quillwarren was killed).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { requestJson } from '../chat/local-agent.ts';
import type { BuiltinModel } from '../chat/local-chat.ts';
import type { ModelLibrary, RuntimeSettingsStore } from './models.ts';

/** All layers on the GPU (llama-server caps it at the model's count). */
export const ALL_LAYERS = 999;

export interface RuntimeOptions {
  /** llama-server(.exe); undefined: this build has none. */
  binary?: string;
  /** Run `binary` through another program (tests: node and a fake server script). */
  command?: { file: string; args: string[] };
  logFile?: string;
  pidFile?: string;
  /** Holds the API key while llama-server runs (llama-server --api-key-file). */
  keyFile?: string;
  /** Loading a 5 GB model from a slow disk takes a while. Default 3 minutes. */
  healthTimeoutMs?: number;
  pollMs?: number;
  /** Crash restarts within restartWindowMs (default 3 in 10 minutes). */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** The pause before the first restart (doubles each time; default 1 s). */
  restartDelayMs?: number;
  /** The log file is moved to .1 past this size (default 5 MB). */
  maxLogBytes?: number;
  log?: (msg: string) => void;
}

export interface StartRequest {
  /** The GGUF file. */
  model: string;
  /** The model's name in the API (what /v1/models lists and requests name). */
  alias: string;
  gpu: 'auto' | 'cpu';
  ctxSize: number;
  threads?: number;
}

export type RuntimeState = 'unavailable' | 'stopped' | 'starting' | 'ready' | 'crashed';

export interface RuntimeStatus {
  state: RuntimeState;
  /** This build has the llama-server binary. */
  bundled: boolean;
  model?: string;
  port?: number;
  /** Where the layers run: gpu, or cpu (asked for, or after the GPU start failed). */
  device?: 'gpu' | 'cpu';
  /** The GPU start failed and it runs on the CPU instead. */
  fellBack?: boolean;
  restarts: number;
  lastError?: string;
  pid?: number;
}

/** llama-server's command line (the key comes from keyFile, so it never shows in a process list). */
export function llamaArgs(o: { model: string; alias: string; port: number; keyFile: string; ctxSize: number; gpuLayers: number; threads?: number }): string[] {
  return [
    '--model', o.model,
    '--alias', o.alias,
    '--host', '127.0.0.1',
    '--port', String(o.port),
    '--api-key-file', o.keyFile,
    '--ctx-size', String(o.ctxSize),
    '--n-gpu-layers', String(o.gpuLayers),
    '--jinja',
    '--no-webui',
    ...(o.threads ? ['--threads', String(o.threads)] : []),
  ];
}

/** A port nothing listens on right now (127.0.0.1). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** The program a pid runs, as far as this system tells ("" when it can't, or the process is gone). */
export function processCommand(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve('');
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? '' : String(out)));
    });
  }
  try {
    return Promise.resolve(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
  } catch {
    return Promise.resolve('');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlamaRuntime {
  private child: ChildProcess | null = null;
  private state: RuntimeState;
  private current: (StartRequest & { port: number; apiKey: string; gpuLayers: number }) | null = null;
  private fellBack = false;
  private lastError: string | undefined;
  private crashes: number[] = [];
  private restarts = 0;
  /** stop() was asked for: an exit now is no crash. */
  private stopping = false;
  private starting: Promise<{ baseUrl: string; apiKey: string }> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  private readonly o: RuntimeOptions;

  constructor(o: RuntimeOptions) {
    this.o = o;
    this.state = o.binary ? 'stopped' : 'unavailable';
  }

  private log(msg: string): void {
    this.o.log?.(msg);
    this.writeLog(`[quillwarren] ${msg}\n`);
  }

  private writeLog(text: string): void {
    const f = this.o.logFile;
    if (!f) return;
    try {
      mkdirSync(dirname(f), { recursive: true });
      try {
        if (statSync(f).size > (this.o.maxLogBytes ?? 5_000_000)) renameSync(f, `${f}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(f, text);
    } catch {
      // logging must never stop the runtime
    }
  }

  status(): RuntimeStatus {
    return {
      state: this.state,
      bundled: Boolean(this.o.binary),
      restarts: this.restarts,
      ...(this.current ? { model: this.current.alias, port: this.current.port, device: this.current.gpuLayers > 0 ? ('gpu' as const) : ('cpu' as const) } : {}),
      ...(this.fellBack ? { fellBack: true } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
    };
  }

  /** The address while it runs. */
  endpoint(): { baseUrl: string; apiKey: string } | null {
    return this.state === 'ready' && this.current ? { baseUrl: `http://127.0.0.1:${this.current.port}/v1`, apiKey: this.current.apiKey } : null;
  }

  /** Ends a llama-server an earlier launch left running (its pid file says which). */
  async cleanUpStale(): Promise<boolean> {
    const f = this.o.pidFile;
    if (!f) return false;
    let pid = 0;
    try {
      pid = Number(readFileSync(f, 'utf8').trim());
    } catch {
      return false;
    }
    rmSync(f, { force: true });
    const cmd = await processCommand(pid);
    if (!/llama-server/i.test(cmd)) return false; // gone, or the pid belongs to something else now
    try {
      process.kill(pid);
      this.log(`ended llama-server ${pid}, left over from an earlier launch`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts llama-server with this model (stopping another one first), or
   * returns the running one when it already runs this model the same way.
   */
  async start(req: StartRequest): Promise<{ baseUrl: string; apiKey: string }> {
    if (!this.o.binary) throw new Error('this build of Quillwarren has no built-in model runtime (llama-server) yet');
    const same = this.current && this.current.model === req.model && this.current.gpu === req.gpu && this.current.ctxSize === req.ctxSize;
    if (same && this.state === 'ready') return this.endpoint()!;
    if (same && this.starting) return this.starting;
    await this.stop();
    this.restarts = 0;
    this.crashes = [];
    this.fellBack = false;
    this.lastError = undefined;
    this.starting = this.launch(req).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(req: StartRequest): Promise<{ baseUrl: string; apiKey: string }> {
    await this.cleanUpStale();
    const tries: number[] = req.gpu === 'auto' ? [ALL_LAYERS, 0] : [0];
    let last = '';
    for (const [i, gpuLayers] of tries.entries()) {
      const result = await this.spawnOnce(req, gpuLayers);
      if (result.ok) {
        if (i > 0) {
          this.fellBack = true;
          this.log(`running on the CPU: the GPU start failed (${last})`);
        }
        return this.endpoint()!;
      }
      last = result.error;
      this.log(`llama-server did not start with ${gpuLayers ? 'the GPU' : 'the CPU only'}: ${result.error}`);
    }
    this.state = 'crashed';
    this.lastError = last;
    throw new Error(`the built-in model didn't start: ${last}`);
  }

  private async spawnOnce(req: StartRequest, gpuLayers: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const port = await freePort();
    const apiKey = randomBytes(24).toString('base64url');
    const keyFile = this.o.keyFile ?? `${this.o.pidFile ?? 'llama-server'}.key`;
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
    const args = llamaArgs({ model: req.model, alias: req.alias, port, keyFile, ctxSize: req.ctxSize, gpuLayers, ...(req.threads ? { threads: req.threads } : {}) });
    const file = this.o.command?.file ?? this.o.binary!;
    const fullArgs = [...(this.o.command?.args ?? []), ...(this.o.command ? [this.o.binary!] : []), ...args];
    this.state = 'starting';
    this.current = { ...req, port, apiKey, gpuLayers };
    this.stopping = false;
    this.writeLog(`\n[quillwarren] ${new Date().toISOString()} starting llama-server on port ${port}: ${req.alias}, ${gpuLayers ? 'GPU' : 'CPU'}, context ${req.ctxSize}\n`);
    // the child gets no Quillwarren secrets: only what it needs from the environment
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('DELVE_')) delete env[k];
    const child = spawn(file, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    this.child = child;
    let tail = '';
    const take = (d: Buffer) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-2000);
      this.writeLog(s);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let exited: number | string | null = null;
    let spawnError: Error | null = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('exit', (code, signal) => {
      exited = code ?? signal ?? 'exit';
      if (this.child === child) this.onExit(child, code, signal);
    });
    if (child.pid && this.o.pidFile) {
      mkdirSync(dirname(this.o.pidFile), { recursive: true });
      writeFileSync(this.o.pidFile, String(child.pid));
    }

    const deadline = Date.now() + (this.o.healthTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (spawnError) return { ok: false, error: `couldn't run ${file}: ${(spawnError as Error).message}` };
      if (exited !== null) return { ok: false, error: `it stopped (${exited}) while loading: ${lastLines(tail)}` };
      try {
        const r = await requestJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 2000 });
        if (r.status === 200) {
          this.state = 'ready';
          this.log(`llama-server ready on port ${port} (${req.alias}, ${gpuLayers ? 'GPU' : 'CPU'})`);
          void this.checkKey(port);
          return { ok: true };
        }
        // 503 while the model loads
      } catch {
        // not listening yet
      }
      await sleep(this.o.pollMs ?? 500);
    }
    await this.kill(child);
    return { ok: false, error: `no answer from /health within ${Math.round((this.o.healthTimeoutMs ?? 180_000) / 1000)} s: ${lastLines(tail)}` };
  }

  /** The API must refuse requests without the key; if this llama-server ignores the key file, say so in the log. */
  private async checkKey(port: number): Promise<void> {
    try {
      const r = await requestJson(`http://127.0.0.1:${port}/v1/models`, { timeoutMs: 3000 });
      if (r.status === 200) this.log('warning: llama-server answers without the API key (check --api-key-file in this llama.cpp version)');
    } catch {
      // fine: it will show up in the chat
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    if (this.o.pidFile) rmSync(this.o.pidFile, { force: true });
    if (this.stopping || this.state !== 'ready') return; // stop(), or a failed start (launch() handles that)
    this.lastError = `llama-server stopped unexpectedly (${code ?? signal})`;
    this.log(this.lastError);
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < (this.o.restartWindowMs ?? 600_000));
    this.crashes.push(now);
    if (this.crashes.length > (this.o.maxRestarts ?? 3)) {
      this.state = 'crashed';
      this.log('not restarting: it crashed too often; start it again from the model page');
      return;
    }
    const req = this.current;
    if (!req) return;
    this.state = 'starting';
    const delay = (this.o.restartDelayMs ?? 1000) * 2 ** (this.crashes.length - 1);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restarts++;
      this.starting = this.spawnOnce(req, req.gpuLayers)
        .then((r) => {
          if (!r.ok) {
            this.state = 'crashed';
            this.lastError = r.error;
            throw new Error(r.error);
          }
          return this.endpoint()!;
        })
        .finally(() => {
          this.starting = null;
        });
      this.starting.catch(() => {});
    }, delay);
    this.restartTimer.unref?.();
  }

  private async kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    await done;
    clearTimeout(t);
  }

  /** Stops it (the app quits, another model is chosen, or the model page says so). */
  async stop(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = true;
    const child = this.child;
    if (child) {
      this.log('stopping llama-server');
      await this.kill(child);
    }
    this.child = null;
    if (this.o.pidFile) rmSync(this.o.pidFile, { force: true });
    if (this.o.keyFile) rmSync(this.o.keyFile, { force: true });
    this.state = this.o.binary ? 'stopped' : 'unavailable';
    this.current = null;
  }

  /** The chat's view of it: the model chosen on the model page, started on first use. */
  asBuiltin(models: ModelLibrary, settings: RuntimeSettingsStore): BuiltinModel {
    return {
      status: () => {
        const s = settings.get();
        if (!this.o.binary) return { available: false, note: 'this build of Quillwarren has no built-in model runtime yet: use a model server (Ollama, llama-server) in the chat settings' };
        if (!s.model) return { available: false, note: 'choose a model on the model page first' };
        return { available: this.state !== 'crashed', model: s.model, ...(this.lastError ? { note: this.lastError } : {}) };
      },
      endpoint: async () => {
        const s = settings.get();
        if (!s.model) throw new Error('choose a model on the model page first');
        const ep = await this.start({ model: models.path(s.model), alias: s.model.replace(/\.gguf$/i, ''), gpu: s.gpu, ctxSize: s.ctxSize });
        return { ...ep, model: s.model.replace(/\.gguf$/i, '') };
      },
    };
  }
}

/** The last few lines of llama-server's output, for an error message. */
function lastLines(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  return lines.slice(-400) || 'no output';
}
