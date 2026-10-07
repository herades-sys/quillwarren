// The built-in model runtime (desktop/runtime.ts) against a fake llama-server
// (fake-llama-server.mjs, run by node): start, health check, the API key, the
// CPU fallback, a crash and its restart, stop, a llama-server left over from
// an earlier launch; and the model download with resume (desktop/download.ts)
// against a local file server.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestJson } from '../src/chat/local-agent.ts';
import { DOWNLOADS, downloadWithResume, totalFromContentRange } from '../src/desktop/download.ts';
import { ModelLibrary, RuntimeSettingsStore } from '../src/desktop/models.ts';
import { ALL_LAYERS, LlamaRuntime, llamaArgs } from '../src/desktop/runtime.ts';

const FAKE = resolve(import.meta.dirname, 'fake-llama-server.mjs');
let dir: string;
const runtimes: LlamaRuntime[] = [];
const env = ['FAKE_LLAMA_LOAD_MS', 'FAKE_LLAMA_GPU_FAIL', 'FAKE_LLAMA_CRASH_ONCE', 'FAKE_LLAMA_ARGS'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delve-runtime-'));
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop();
  for (const k of env) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

function runtime(extra: Partial<ConstructorParameters<typeof LlamaRuntime>[0]> = {}): LlamaRuntime {
  const r = new LlamaRuntime({
    binary: FAKE,
    command: { file: process.execPath, args: [] },
    logFile: join(dir, 'logs', 'llama-server.log'),
    pidFile: join(dir, 'llama-server.pid'),
    keyFile: join(dir, 'llama-server.key'),
    healthTimeoutMs: 10_000,
    pollMs: 50,
    restartDelayMs: 50,
    ...extra,
  });
  runtimes.push(r);
  return r;
}

const req = { model: '/models/qwen3-8b.gguf', alias: 'qwen3-8b', gpu: 'auto' as const, ctxSize: 16384 };

describe('llama-server’s command line', () => {
  it('binds loopback, keeps the key out of the command line, and offloads all layers or none', () => {
    const args = llamaArgs({ model: 'C:\\m\\q.gguf', alias: 'q', port: 5555, keyFile: 'C:\\d\\k', ctxSize: 16384, gpuLayers: ALL_LAYERS });
    expect(args).toEqual(['--model', 'C:\\m\\q.gguf', '--alias', 'q', '--host', '127.0.0.1', '--port', '5555', '--api-key-file', 'C:\\d\\k', '--ctx-size', '16384', '--n-gpu-layers', '999', '--jinja', '--no-webui']);
    expect(llamaArgs({ model: 'm', alias: 'a', port: 1, keyFile: 'k', ctxSize: 4096, gpuLayers: 0, threads: 6 }).slice(-4)).toEqual(['--jinja', '--no-webui', '--threads', '6']);
  });
});

describe('LlamaRuntime', () => {
  it('says it is unavailable without a binary', async () => {
    const r = new LlamaRuntime({});
    expect(r.status()).toEqual({ state: 'unavailable', bundled: false, restarts: 0 });
    await expect(r.start(req)).rejects.toThrow(/no built-in model runtime/);
    const b = r.asBuiltin(new ModelLibrary(dir), new RuntimeSettingsStore(undefined));
    expect(b.status()).toMatchObject({ available: false, note: expect.stringMatching(/no built-in model runtime/) });
  });

  it('starts it, waits for the model to load, and talks to it with the per-launch key only', async () => {
    process.env.FAKE_LLAMA_LOAD_MS = '400';
    process.env.FAKE_LLAMA_ARGS = join(dir, 'args.json');
    const r = runtime();
    const ep = await r.start(req);
    expect(r.status()).toMatchObject({ state: 'ready', bundled: true, model: 'qwen3-8b', device: 'gpu', restarts: 0 });
    expect(ep.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
    expect(args).toContain('--api-key-file');
    expect(args.join(' ')).not.toContain(ep.apiKey);
    expect((await requestJson(`${ep.baseUrl}/models`)).status).toBe(401);
    const models = await requestJson(`${ep.baseUrl}/models`, { headers: { authorization: `Bearer ${ep.apiKey}` } });
    expect(models.json).toMatchObject({ data: [{ id: 'qwen3-8b' }] });
    expect(readFileSync(join(dir, 'llama-server.pid'), 'utf8')).toBe(String(r.status().pid));
    // the same model again: the running one
    expect(await r.start(req)).toEqual(ep);
    await r.stop();
    expect(r.status().state).toBe('stopped');
    expect(existsSync(join(dir, 'llama-server.pid'))).toBe(false);
    expect(existsSync(join(dir, 'llama-server.key'))).toBe(false);
    expect(readFileSync(join(dir, 'logs', 'llama-server.log'), 'utf8')).toMatch(/starting llama-server[\s\S]*model loaded[\s\S]*stopping llama-server/);
  }, 20_000);

  it('falls back to the CPU when the GPU start fails', async () => {
    process.env.FAKE_LLAMA_GPU_FAIL = '1';
    const r = runtime();
    await r.start(req);
    expect(r.status()).toMatchObject({ state: 'ready', device: 'cpu', fellBack: true });
    expect(readFileSync(join(dir, 'logs', 'llama-server.log'), 'utf8')).toContain('no suitable device');
  }, 20_000);

  it('runs on the CPU only when told to', async () => {
    process.env.FAKE_LLAMA_ARGS = join(dir, 'args.json');
    const r = runtime();
    await r.start({ ...req, gpu: 'cpu' });
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('0');
    expect(r.status()).toMatchObject({ device: 'cpu' });
    expect(r.status().fellBack).toBeUndefined();
  }, 20_000);

  it('restarts it after a crash', async () => {
    process.env.FAKE_LLAMA_CRASH_ONCE = join(dir, 'crashed');
    const r = runtime();
    const first = await r.start(req);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(r.status().restarts === 1 && r.status().state === 'ready')) await new Promise((x) => setTimeout(x, 50));
    expect(r.status()).toMatchObject({ state: 'ready', restarts: 1 });
    expect(r.status().lastError).toMatch(/stopped unexpectedly/);
    const now = r.endpoint()!;
    expect(now.baseUrl).not.toBe(first.baseUrl); // a new port and key
    expect((await requestJson(`${now.baseUrl}/models`, { headers: { authorization: `Bearer ${now.apiKey}` } })).status).toBe(200);
  }, 20_000);

  it('gives up with the reason when it never starts', async () => {
    const broken = runtime({ binary: join(dir, 'missing-llama-server.mjs') });
    await expect(broken.start({ ...req, gpu: 'cpu' })).rejects.toThrow(/didn't start/);
    expect(broken.status()).toMatchObject({ state: 'crashed' });
  }, 20_000);

  it('ends a llama-server that an earlier launch left behind', async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const orphan = spawn(process.execPath, [FAKE, '--port', String(port)], { stdio: 'ignore' });
    await new Promise((x) => setTimeout(x, 300));
    writeFileSync(join(dir, 'llama-server.pid'), String(orphan.pid));
    const gone = new Promise((x) => orphan.once('exit', x));
    const r = runtime();
    expect(await r.cleanUpStale()).toBe(true);
    await gone;
    expect(existsSync(join(dir, 'llama-server.pid'))).toBe(false);
    // a pid that now belongs to something else is left alone
    writeFileSync(join(dir, 'llama-server.pid'), String(process.pid));
    expect(await r.cleanUpStale()).toBe(false);
  }, 20_000);

  it('serves the chat as its built-in model: the model chosen on the model page, started on first use', async () => {
    const lib = new ModelLibrary(join(dir, 'models'));
    const settings = new RuntimeSettingsStore(undefined);
    const r = runtime();
    const b = r.asBuiltin(lib, settings);
    expect(b.status()).toMatchObject({ available: false, note: expect.stringMatching(/choose a model/) });
    settings.set({ model: 'qwen3-8b.gguf', gpu: 'auto', ctxSize: 8192 });
    expect(b.status()).toEqual({ available: true, model: 'qwen3-8b.gguf' });
    const ep = await b.endpoint();
    expect(ep).toMatchObject({ model: 'qwen3-8b', baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
    const reply = await requestJson(`${ep.baseUrl}/chat/completions`, { body: { model: ep.model, messages: [] }, headers: { authorization: `Bearer ${ep.apiKey}` } });
    expect(reply.json).toMatchObject({ choices: [{ message: { content: 'Hello from the fake model.' } }] });
  }, 20_000);
});

// ---------- downloads ----------

describe('downloadWithResume', () => {
  const file = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251));
  const sha = createHash('sha256').update(file).digest('hex');
  let server: Server;
  let url = '';
  let mode: 'ranges' | 'no-ranges' | 'cut' = 'ranges';
  const asked: (string | undefined)[] = [];

  beforeEach(async () => {
    asked.length = 0;
    server = createServer((req, res) => {
      asked.push(req.headers.range);
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (m && mode !== 'no-ranges') {
        const from = Number(m[1]);
        if (from >= file.length) {
          res.writeHead(416, { 'content-range': `bytes */${file.length}` });
          return res.end();
        }
        res.writeHead(206, { 'content-range': `bytes ${from}-${file.length - 1}/${file.length}`, 'content-length': String(file.length - from) });
        return res.end(file.subarray(from));
      }
      res.writeHead(200, { 'content-length': String(file.length) });
      if (mode === 'cut') {
        // the connection drops after 60 000 bytes
        res.write(file.subarray(0, 60_000), () => res.destroy());
        return;
      }
      res.end(file);
    });
    await new Promise<void>((x) => server.listen(0, '127.0.0.1', x));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/Qwen3-8B-Q4_K_M.gguf`;
  });
  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('points at the official Qwen GGUF builds on Hugging Face (not used yet)', () => {
    for (const d of DOWNLOADS) {
      expect(d.url).toBe(`https://huggingface.co/${d.repo}/resolve/main/${d.file}`);
      expect(d.repo.startsWith('Qwen/')).toBe(true);
      expect(d.licence).toBe('Apache-2.0');
    }
    expect(totalFromContentRange('bytes 100-199/1000')).toBe(1000);
    expect(totalFromContentRange(null)).toBeUndefined();
  });

  it('resumes a broken download where it stopped, and checks the result', async () => {
    const dest = join(dir, 'model.gguf');
    mode = 'cut';
    await expect(downloadWithResume(url, dest)).rejects.toThrow();
    const kept = readFileSync(`${dest}.part`).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(file.length);
    expect(existsSync(dest)).toBe(false); // a half file never looks like a model
    mode = 'ranges';
    const seen: number[] = [];
    const r = await downloadWithResume(url, dest, { sha256: sha, onProgress: (p) => seen.push(p.done) });
    expect(r).toEqual({ size: file.length, resumed: true });
    expect(asked.at(-1)).toBe(`bytes=${kept}-`);
    expect(seen[0]).toBe(kept);
    expect(seen.at(-1)).toBe(file.length);
    expect(readFileSync(dest)).toEqual(file);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('starts over when the server ignores the range, and finishes a .part that was already whole', async () => {
    const dest = join(dir, 'model.gguf');
    writeFileSync(`${dest}.part`, file.subarray(0, 5000));
    mode = 'no-ranges';
    expect(await downloadWithResume(url, dest)).toEqual({ size: file.length, resumed: false });
    expect(readFileSync(dest)).toEqual(file);
    rmSync(dest);
    writeFileSync(`${dest}.part`, file);
    mode = 'ranges';
    expect(await downloadWithResume(url, dest, { sha256: sha })).toEqual({ size: file.length, resumed: false });
    expect(readFileSync(dest)).toEqual(file);
  });

  it('throws a damaged file away', async () => {
    const dest = join(dir, 'model.gguf');
    await expect(downloadWithResume(url, dest, { sha256: '0'.repeat(64) })).rejects.toThrow(/damaged/);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});
