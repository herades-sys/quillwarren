// The chat bridge: a small HTTP service on 127.0.0.1 that runs Claude Code
// (`claude -p`) as the user who is logged in to it (dev on the dev container), so the
// chat panel uses the user's Claude subscription. Each run gets Delve's MCP
// tools and nothing else: no shell or file tools, no other MCP servers, and no
// user or project settings (so no hooks or CLAUDE.md). The Delve server calls
// it; it never sees the live API token, only a short-lived chat token.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StreamTranslator, type ChatEvent } from './events.ts';

export interface BridgeOptions {
  claudeBin: string;
  /** Holds work/ (Claude's empty working directory) and runs/ (per-run temp files). */
  dir: string;
  /** Runs at once; more get 429. Default 2. */
  maxRuns?: number;
  /** Default 5 minutes. */
  timeoutMs?: number;
  defaultModel?: string;
  log?: (msg: string) => void;
}

export interface RunRequest {
  prompt: string;
  system: string;
  /** Claude Code session id to continue. */
  resume?: string;
  model?: string;
  mcp: { url: string; token: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,59}$/;
const MCP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

/** A valid run request, or what's wrong with it. */
export function parseRun(body: unknown): RunRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const mcp = (b.mcp ?? {}) as Record<string, unknown>;
  if (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 200_000) return 'prompt must be a non-empty string';
  if (b.prompt.trimStart().startsWith('/')) return 'prompt must not start with "/" (Claude Code would read it as a command)';
  if (typeof b.system !== 'string' || b.system.length > 200_000) return 'system must be a string';
  if (b.resume !== undefined && (typeof b.resume !== 'string' || !UUID.test(b.resume))) return 'resume must be a session id';
  if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL.test(b.model))) return 'model must be a model name';
  if (typeof mcp.url !== 'string' || !MCP_URL.test(mcp.url)) return 'mcp.url must be http://127.0.0.1:<port>/mcp';
  if (typeof mcp.token !== 'string' || !TOKEN.test(mcp.token)) return 'mcp.token is missing';
  return {
    prompt: b.prompt,
    system: b.system,
    ...(b.resume ? { resume: b.resume as string } : {}),
    ...(b.model ? { model: b.model as string } : {}),
    mcp: { url: mcp.url, token: mcp.token },
  };
}

export function claudeArgs(r: RunRequest, files: { system: string; mcp: string }, defaultModel: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', r.model ?? defaultModel,
    '--system-prompt-file', files.system,
    '--mcp-config', files.mcp,
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__delve',
    '--setting-sources', '',
    ...(r.resume ? ['--resume', r.resume] : []),
  ];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createBridge(o: BridgeOptions): Server {
  const maxRuns = o.maxRuns ?? 2;
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  const defaultModel = o.defaultModel ?? 'sonnet';
  const log = o.log ?? (() => {});
  let running = 0;
  let version: Promise<string> | null = null;
  const claudeVersion = () =>
    (version ??= new Promise((resolve) => {
      execFile(o.claudeBin, ['--version'], { timeout: 15_000 }, (err, out) => resolve(err ? '' : String(out).trim()));
    }));

  async function run(r: RunRequest, res: ServerResponse): Promise<void> {
    const work = join(o.dir, 'work');
    await mkdir(work, { recursive: true, mode: 0o700 });
    await mkdir(join(o.dir, 'runs'), { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(join(o.dir, 'runs', 'run-'));
    const files = { system: join(tmp, 'system.md'), mcp: join(tmp, 'mcp.json') };
    await writeFile(files.system, r.system, { mode: 0o600 });
    const mcp = { mcpServers: { delve: { type: 'http', url: r.mcp.url, headers: { Authorization: `Bearer ${r.mcp.token}` } } } };
    await writeFile(files.mcp, JSON.stringify(mcp), { mode: 0o600 });

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const send = (ev: ChatEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(ev)}\n`);
    };

    const started = Date.now();
    const child = spawn(o.claudeBin, claudeArgs(r, files, defaultModel), { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const t = new StreamTranslator();
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    };
    res.on('close', () => {
      if (!finished) kill(); // the browser went away or pressed Stop
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    child.stdin.on('error', () => {}); // a child that dies early closes stdin under us
    child.stdin.end(r.prompt);
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const ev of t.feed(line)) send(ev);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (e) => {
        spawnError = e;
        resolve(null);
      });
      child.on('close', (c) => resolve(c));
    });
    finished = true;
    clearTimeout(timer);
    await rm(tmp, { recursive: true, force: true }); // the MCP config holds the chat token

    if (!t.done) {
      const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      if (timedOut) send({ type: 'error', code: 'timeout', error: `Claude took longer than ${Math.round(timeoutMs / 60_000)} minutes, so it was stopped. Changes made so far are kept.` });
      else if (/no conversation found/i.test(stderr)) send({ type: 'error', code: 'no_session', error: 'That conversation is gone; start a new chat.' });
      else if (spawnError) send({ type: 'error', code: 'bridge', error: `Couldn't start Claude Code: ${(spawnError as Error).message}` });
      else send({ type: 'error', code: 'bridge', error: `Claude Code stopped (exit ${code ?? 'signal'})${tail ? `: ${tail}` : ''}` });
    }
    res.end();
    log(`run ${t.session || '-'} model=${r.model ?? defaultModel} resume=${r.resume ? 'yes' : 'no'} exit=${code} ${Date.now() - started}ms${timedOut ? ' timeout' : ''}`);
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          const v = await claudeVersion();
          if (!v) version = null; // try again next time
          return sendJson(res, v ? 200 : 503, v ? { ok: true, claude: v, running, maxRuns } : { ok: false, error: `Claude Code not found or not working (${o.claudeBin})` });
        }
        if (req.method === 'POST' && req.url === '/run') {
          const r = parseRun(await readJson(req, 1_000_000));
          if (typeof r === 'string') return sendJson(res, 400, { error: r });
          if (running >= maxRuns) return sendJson(res, 429, { error: 'Claude is busy with another chat message; try again in a moment.' });
          running++;
          try {
            await run(r, res);
          } finally {
            running--;
          }
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (e) {
        if (!res.headersSent) sendJson(res, 400, { error: (e as Error).message });
        else res.end();
      }
    })();
  });
}
