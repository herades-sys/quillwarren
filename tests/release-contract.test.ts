// Release contract (see CLAUDE.md): `npm run build` produces ./release with
// entry release/main.mjs, which reads PORT/HOST/DELVE_DATA and answers
// GET /health with HTTP 200 and JSON.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const entry = join(root, 'release', 'main.mjs');

// Ask the OS for a free port up front so the test knows where to connect.
// (PORT=0 also works now, but then the port is only in the log.)
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe('release contract', () => {
  let child: ChildProcess | undefined;
  let dataDir: string;
  let port: number;

  beforeAll(async () => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
    dataDir = mkdtempSync(join(tmpdir(), 'delve-test-'));
    port = await freePort();
    child = spawn(process.execPath, [entry], {
      cwd: join(root, 'release'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DELVE_DATA: dataDir,
        DELVE_API_TOKEN: 'test-token',
      },
      stdio: 'pipe',
    });
  }, 60_000);

  afterAll(() => {
    child?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('builds release/main.mjs', () => {
    expect(existsSync(entry)).toBe(true);
  });

  it('answers GET /health with 200 and JSON', async () => {
    const res = await waitForHealth(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await res.json()) as { ok?: unknown; app?: unknown; version?: unknown };
    expect(body).toMatchObject({ ok: true, app: 'delve' });
    expect(typeof body.version).toBe('string');
  });

  it('renders a PNG from the bundle (native resvg and the font ship in release/)', async () => {
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    const res = await fetch(`http://127.0.0.1:${port}/preview/print.png?ppg=10`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
  });

  it('stores maps (node:sqlite in DELVE_DATA) and renders them through the API', async () => {
    const base = `http://127.0.0.1:${port}/api/v1`;
    const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const created = await fetch(`${base}/maps`, { method: 'POST', headers, body: JSON.stringify({ template: 'test-dungeon' }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(existsSync(join(dataDir, 'delve.db'))).toBe(true);
    const png = await fetch(`${base}/maps/${id}/render.png?ppg=10&view=players`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');

    // the live viewer page and its browser bundle ship in release/web
    const page = await fetch(`http://127.0.0.1:${port}/maps/${id}`);
    expect(page.status).toBe(200);
    const js = await fetch(`http://127.0.0.1:${port}/assets/viewer.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('WebSocket');
  });

  it('answers MCP from the bundle', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('quillwarren');
  });
});
