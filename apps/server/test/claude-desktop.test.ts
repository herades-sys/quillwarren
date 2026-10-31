// Claude Desktop and the Windows app: the gate's Claude Desktop key (only for
// /mcp, only while connected, constant-time, no CORS, never the window's
// secret), the bridge (apps/desktop/claude-extension/server/index.js) spawned
// as Claude Desktop spawns it and spoken to over stdio against a desktop-mode
// server on a free port (initialize, tools/list, add_room changing the map,
// render returning a PNG, the refusals in words, Delve closed or not
// connected, an event-stream answer), and the .mcpb bundle (the MCPB 0.3
// manifest, its tool list against mcp.ts, the zip).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { localChatBackends } from '../src/chat/local-chat.ts';
import { BRIDGE_FILE, buildMcpb, delveTools, extensionManifest, MANIFEST_VERSION, shortDescription, writeExtensionDir } from '../src/desktop/claude-extension.ts';
import { CLAUDE_DESKTOP_CONNECT, CLAUDE_DESKTOP_NOTE, DESKTOP_HEADER, registerClaudeDesktopConnect, registerDesktopGate } from '../src/desktop/gate.ts';
import { MapStore } from '../src/store.ts';
import { unzipEntry } from '../src/zip.ts';

const SECRET = randomBytes(32).toString('base64url');
const KEY = randomBytes(32).toString('base64url');
const testMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as unknown;

/** A desktop-mode app (the gate, one user, no players) with Claude Desktop access as the entry point wires it. */
function desktopApp(o: { port: () => number; key: () => string | null; store?: MapStore }) {
  const store = o.store ?? new MapStore(':memory:');
  if (!o.store) store.create(testMap, 'test');
  const granted = new WeakSet<object>();
  const app = buildApp(
    { version: 'test', started: 'now' },
    {
      store,
      singleUser: true,
      multiplayer: false,
      extend: (a) => registerDesktopGate(a, { secret: SECRET, port: o.port, claudeDesktop: { key: o.key, grant: (req) => granted.add(req.raw) } }),
      mcpGrant: (req) => granted.has(req.raw),
      mcpNote: CLAUDE_DESKTOP_NOTE,
      chatBackends: (ctx) => localChatBackends(ctx),
    },
  );
  app.addHook('onClose', async () => store.close());
  return { app, store };
}

const rpc = (method: string, params: unknown = {}, id: number | null = 1) => JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('the gate and the Claude Desktop key', () => {
  const PORT = 47_321;
  const HOST = `127.0.0.1:${PORT}`;
  let key: string | null = KEY;
  let app: FastifyInstance;
  beforeAll(async () => {
    app = desktopApp({ port: () => PORT, key: () => key }).app;
    await app.ready();
  });
  afterAll(async () => app.close());

  it('lets the key in to /mcp, and Delve’s tools answer without an API token', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, host: HOST, authorization: `Bearer ${KEY}` }, payload: rpc('tools/list') });
    expect(res.statusCode).toBe(200);
    const tools = (JSON.parse(res.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain('add_room');
    expect(tools).toContain('render');
    // no CORS for anyone
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('takes the key on /mcp only: everywhere else it is no window secret', async () => {
    for (const [method, url] of [['GET', '/'], ['GET', '/health'], ['GET', '/api/v1/maps'], ['GET', '/maps/map_test4p'], ['POST', '/api/v1/maps'], ['GET', '/models'], ['GET', '/api/v1/chat/settings'], ['POST', '/mcp/x'], ['GET', '/mcpx']] as const) {
      const res = await app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, payload: method === 'POST' ? '{}' : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.body).not.toContain('Test dungeon');
    }
  });

  it('refuses a wrong key, the window’s secret as a key, and every key while not connected', async () => {
    const send = (auth: string, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, host: HOST, authorization: auth, ...headers }, payload: rpc('tools/list') });
    for (const wrong of [`Bearer ${KEY.slice(1)}`, `Bearer ${KEY}x`, `Bearer ${SECRET}`, `Bearer ${'a'.repeat(43)}`]) {
      const res = await send(wrong);
      expect(res.statusCode, wrong.slice(0, 12)).toBe(401);
      expect(JSON.parse(res.body).error.message).toMatch(/refused this key/);
    }
    key = null;
    try {
      const off = await send(`Bearer ${KEY}`);
      expect(off.statusCode).toBe(401);
      expect(JSON.parse(off.body).error.message).toMatch(/isn’t connected to Claude Desktop/);
    } finally {
      key = KEY;
    }
  });

  it('keeps the Host check, refuses web pages (any Origin), other methods and WebSocket upgrades', async () => {
    const base = { ...MCP_HEADERS, authorization: `Bearer ${KEY}` };
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: `evil.example:${PORT}` }, payload: rpc('tools/list') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: '127.0.0.1:1' }, payload: rpc('tools/list') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: HOST, origin: `http://${HOST}` }, payload: rpc('tools/list') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { ...base, host: HOST, origin: 'https://evil.example' }, payload: rpc('tools/list') })).statusCode).toBe(403);
    for (const method of ['PUT', 'PATCH', 'OPTIONS'] as const) expect((await app.inject({ method, url: '/mcp', headers: { ...base, host: HOST } })).statusCode, method).toBe(405);
    expect((await app.inject({ method: 'GET', url: '/mcp', headers: { ...base, host: HOST, upgrade: 'websocket', connection: 'upgrade' } })).statusCode).toBe(403);
    // the stateless transport's GET and DELETE still answer (405 from the MCP route itself)
    expect((await app.inject({ method: 'GET', url: '/mcp', headers: { ...base, host: HOST } })).statusCode).toBe(405);
  });

  it('keeps /mcp closed to the window: MCP is for Claude Desktop', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, host: HOST, [DESKTOP_HEADER]: SECRET, authorization: `Bearer ${KEY}` }, payload: rpc('tools/list') });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Connect to Claude Desktop');
  });

  it('tells Claude that links open only inside the app', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, host: HOST, authorization: `Bearer ${KEY}` }, payload: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }) });
    expect((JSON.parse(res.body) as { result: { instructions: string } }).result.instructions).toContain('open only inside the Delve app');
  });
});

describe('the web server is untouched: no Claude Desktop key there', () => {
  it('answers /mcp with the API token only, as before', async () => {
    const app = buildApp({ version: 't', started: 'now' }, { token: 'web-token-0123456789abcdef' });
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY}` }, payload: rpc('tools/list') });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ---------- the bridge, as Claude Desktop runs it ----------

/** The bridge on stdio: send JSON-RPC lines, wait for answers by id, collect notifications. */
class Bridge {
  readonly child: ChildProcess;
  private buf = '';
  private readonly waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  readonly notes: Record<string, unknown>[] = [];
  readonly stray: Record<string, unknown>[] = [];
  stderr = '';
  private id = 100;

  constructor(entry: string, appData: string) {
    this.child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? '', APPDATA: appData }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as Record<string, unknown>;
        const w = this.waiting.get(m.id);
        if (w && m.id !== undefined) {
          this.waiting.delete(m.id);
          w(m);
        } else if (m.method) this.notes.push(m);
        else this.stray.push(m);
      }
    });
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr += d.toString()));
  }

  call(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((done, fail) => {
      const t = setTimeout(() => fail(new Error(`no answer to ${method}; stderr: ${this.stderr}`)), timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(t);
        done(m);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<number | null> {
    const exited = new Promise<number | null>((r) => this.child.once('exit', (code) => r(code)));
    this.child.stdin!.end();
    return exited;
  }
}

const toolText = (m: Record<string, unknown>) => ((m.result as { content: { text?: string }[] }).content[0]?.text ?? '') as string;
const isError = (m: Record<string, unknown>) => (m.result as { isError?: boolean }).isError === true;

describe('Connect to Claude Desktop from the chat settings', () => {
  const PORT = 47_322;
  const HOST = `127.0.0.1:${PORT}`;
  const ok = { host: HOST, [DESKTOP_HEADER]: SECRET };
  let connected = false;
  let reachable = true;
  let asked = 0;
  let app: FastifyInstance;
  beforeAll(async () => {
    const store = new MapStore(':memory:');
    store.create(testMap, 'test');
    let view: () => Record<string, unknown> = () => ({});
    app = buildApp(
      { version: 'test', started: 'now' },
      {
        store,
        singleUser: true,
        multiplayer: false,
        extend: (a) => {
          registerDesktopGate(a, { secret: SECRET, port: () => PORT, claudeDesktop: { key: () => (connected ? KEY : null), grant: () => undefined } });
          view = registerClaudeDesktopConnect(a, { connected: () => connected, askApp: () => (asked++, reachable) });
        },
        chatBackends: (ctx) => localChatBackends(ctx, { extra: () => view() }),
      },
    );
    app.addHook('onClose', async () => store.close());
    await app.ready();
  });
  afterAll(async () => app.close());

  it('tells the settings whether Claude Desktop is connected, and where to ask for the dialog', async () => {
    const off = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/chat/settings', headers: ok })).body) as Record<string, unknown>;
    expect(off.claudeDesktop).toEqual({ connected: false, connect: CLAUDE_DESKTOP_CONNECT });
    connected = true;
    const on = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/chat/settings', headers: ok })).body) as Record<string, unknown>;
    expect(on.claudeDesktop).toEqual({ connected: true, connect: CLAUDE_DESKTOP_CONNECT });
    connected = false;
  });

  it('asks the app for its own Connect dialog: it connects nothing by itself', async () => {
    asked = 0;
    const res = await app.inject({ method: 'POST', url: CLAUDE_DESKTOP_CONNECT, headers: ok });
    expect(res.statusCode).toBe(202);
    expect(asked).toBe(1);
    expect(connected).toBe(false); // the app's dialog decides
    reachable = false;
    const gone = await app.inject({ method: 'POST', url: CLAUDE_DESKTOP_CONNECT, headers: ok });
    expect(gone.statusCode).toBe(503);
    expect(gone.body).toContain('Help → Connect to Claude Desktop');
    reachable = true;
  });

  it('answers only the window: not without the secret, not other pages, not the Claude Desktop key', async () => {
    asked = 0;
    connected = true;
    const tries = [
      { host: HOST },
      { ...ok, origin: 'http://evil.example' },
      { host: HOST, authorization: `Bearer ${KEY}` },
      { host: 'delve.example:80', [DESKTOP_HEADER]: SECRET },
    ];
    for (const headers of tries) expect((await app.inject({ method: 'POST', url: CLAUDE_DESKTOP_CONNECT, headers })).statusCode, JSON.stringify(headers)).toBeGreaterThanOrEqual(400);
    expect(asked).toBe(0);
    connected = false;
  });
});

describe('the bridge between Claude Desktop and the Delve app', () => {
  let app: FastifyInstance;
  let store: MapStore;
  let port = 0;
  let key: string | null = KEY;
  let root: string;
  let appData: string;
  let ext: string;
  let bridge: Bridge;
  const connFile = () => join(appData, 'Delve', 'claude-desktop.json');
  const writeConn = (c: Record<string, unknown>) => writeFileSync(connFile(), JSON.stringify({ app: 'Delve', version: 1, ...c }));

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'delve-claude-desktop-'));
    appData = join(root, 'Roaming');
    mkdirSync(join(appData, 'Delve'), { recursive: true });
    ext = join(root, 'extension');
    await writeExtensionDir(ext, { version: '0.1.0' });
    const made = desktopApp({ port: () => port, key: () => key });
    app = made.app;
    store = made.store;
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    writeConn({ port, key: KEY });
    bridge = new Bridge(join(ext, 'server', 'index.js'), appData);
  }, 60_000);
  afterAll(async () => {
    await bridge?.close();
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('initializes through Delve and lists Delve’s tools', async () => {
    const init = await bridge.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1.0.0' } });
    const result = init.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: { tools?: unknown } };
    expect(result.serverInfo.name).toBe('delve');
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain('open only inside the Delve app');
    bridge.notify('notifications/initialized');
    const list = await bridge.call('tools/list');
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual((await delveTools()).tools.map((t) => t.name));
    expect((await bridge.call('ping')).result).toEqual({});
  });

  it('changes the map with add_room, as one revision the open editor sees', async () => {
    const before = store.get('map_test4p');
    const res = await bridge.call('tools/call', { name: 'add_room', arguments: { map: 'map_test4p', rect: [40, 2, 6, 4], name: 'From Claude Desktop' } });
    expect(isError(res)).toBe(false);
    expect(toolText(res)).toMatch(/rev \d+/);
    const after = store.get('map_test4p');
    expect(after.rev).toBe(before.rev + 1);
    expect(after.map.objects.some((o) => o.type === 'room' && (o as { name?: string }).name === 'From Claude Desktop')).toBe(true);
  });

  it('passes render’s picture through as an image (a PNG)', async () => {
    const res = await bridge.call('tools/call', { name: 'render', arguments: { map: 'map_test4p', ppg: 10 } });
    const content = (res.result as { content: { type: string; data?: string; mimeType?: string }[] }).content;
    const img = content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data!, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('says so plainly when Delve refuses: wrong key, access turned off', async () => {
    writeConn({ port, key: 'b'.repeat(43) });
    const wrong = await bridge.call('tools/call', { name: 'list_maps', arguments: {} });
    expect(isError(wrong)).toBe(true);
    expect(toolText(wrong)).toBe('Delve refused the connection. In Delve, choose Help → Connect to Claude Desktop… again, then try again.');
    writeConn({ port, key: KEY });
    key = null; // Help → Disconnect Claude Desktop (the server's side)
    const off = await bridge.call('tools/call', { name: 'list_maps', arguments: {} });
    expect(toolText(off)).toMatch(/^Delve isn’t connected to Claude Desktop/);
    key = KEY;
    expect(isError(await bridge.call('tools/call', { name: 'list_maps', arguments: {} }))).toBe(false);
  });

  it('answers by itself when the connection file is missing or Delve is closed, never crashing', async () => {
    rmSync(connFile());
    const missing = await bridge.call('tools/call', { name: 'list_maps', arguments: {} });
    expect(isError(missing)).toBe(true);
    expect(toolText(missing)).toBe('Delve isn’t connected to Claude Desktop. Open Delve and choose Help → Connect to Claude Desktop…, then try again.');
    // closed: the app writes port null when it quits
    writeConn({ port: null, key: KEY });
    expect(toolText(await bridge.call('tools/call', { name: 'list_maps', arguments: {} }))).toBe('Delve isn’t running. Open Delve, then try again.');
    // crashed: the old port has nobody behind it
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
    const deadPort = (gone.address() as AddressInfo).port;
    await new Promise<void>((r) => gone.close(() => r()));
    writeConn({ port: deadPort, key: KEY });
    expect(toolText(await bridge.call('tools/call', { name: 'list_maps', arguments: {} }))).toBe('Delve isn’t running. Open Delve, then try again.');
    // the tools are still listed (from the bundle), so Claude knows them before Delve opens
    const list = await bridge.call('tools/list');
    expect((list.result as { tools: { name: string; inputSchema?: unknown }[] }).tools.length).toBe((await delveTools()).tools.length);
    expect((list.result as { tools: { inputSchema?: unknown }[] }).tools[0]!.inputSchema).toBeDefined();
    expect(bridge.child.exitCode).toBe(null);
    // Delve is back: the tool list may have changed, and calls work again
    writeConn({ port, key: KEY });
    expect(isError(await bridge.call('tools/call', { name: 'list_maps', arguments: {} }))).toBe(false);
    expect(bridge.notes.some((n) => n.method === 'notifications/tools/list_changed')).toBe(true);
  });

  it('starts with Delve closed: initialize and tools/list from the bundle', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'delve-no-appdata-'));
    const lone = new Bridge(join(ext, 'server', 'index.js'), empty);
    try {
      const init = await lone.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
      const result = init.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
      expect(result.protocolVersion).toBe('2025-11-25');
      expect(result.serverInfo.name).toBe('delve');
      expect(result.instructions).toContain('Help → Connect to Claude Desktop');
      expect(((await lone.call('tools/list')).result as { tools: unknown[] }).tools.length).toBeGreaterThan(40);
      const other = await lone.call('resources/list');
      expect((other.error as { message: string }).message).toMatch(/isn’t connected/);
    } finally {
      await lone.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('never writes the key to its log (stderr)', () => {
    expect(bridge.stderr).not.toContain(KEY);
    expect(bridge.stderr).toContain('claude-desktop.json');
  });
});

describe('the bridge with an event-stream answer', () => {
  let server: Server;
  let root: string;
  const seen: { auth?: string; version?: string; accept?: string }[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'delve-bridge-sse-'));
    mkdirSync(join(root, 'Delve'), { recursive: true });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        seen.push({ auth: req.headers.authorization, version: req.headers['mcp-protocol-version'] as string | undefined, accept: req.headers.accept });
        if (msg.id === undefined) return res.writeHead(202).end();
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }));
        }
        // a progress notification, then the answer split mid-character (é is two bytes)
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 0.5 } })}\n\n`);
        const answer = Buffer.from(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'café ready' }] } })}\r\n\r\n`);
        const cut = answer.indexOf(Buffer.from('é')) + 1;
        res.write(answer.subarray(0, cut));
        setTimeout(() => res.end(answer.subarray(cut)), 30);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'Delve', 'claude-desktop.json'), JSON.stringify({ app: 'Delve', version: 1, port: (server.address() as AddressInfo).port, key: KEY }));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it('passes the stream’s messages on in order, characters whole, with the key and the protocol version', async () => {
    const b = new Bridge(BRIDGE_FILE, root);
    try {
      await b.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      const res = await b.call('tools/call', { name: 'anything', arguments: {} });
      expect(toolText(res)).toBe('café ready');
      expect(b.notes.map((n) => n.method)).toContain('notifications/progress');
      expect(seen[0]).toMatchObject({ auth: `Bearer ${KEY}`, accept: 'application/json, text/event-stream' });
      expect(seen[1]!.version).toBe('2025-06-18');
    } finally {
      expect(await b.close()).toBe(0);
    }
  });
});

describe('the Delve.mcpb bundle', () => {
  it('lists exactly mcp.ts’s tools, with a sentence each', async () => {
    const { tools, instructions } = await delveTools('0.1.0');
    expect(tools.length).toBeGreaterThan(40);
    const m = extensionManifest({ version: '0.1.0', tools }) as { tools: { name: string; description: string }[] };
    expect(m.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    for (const t of m.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(5);
      expect(t.description.length, t.name).toBeLessThanOrEqual(241);
    }
    expect(instructions).toContain(CLAUDE_DESKTOP_NOTE);
    expect(shortDescription('Mark an open area (e.g. a cave mouth). More here.')).toBe('Mark an open area (e.g. a cave mouth).');
  });

  it('follows the MCPB 0.3 manifest: only its fields, a node server started by Claude Desktop’s Node, Windows only', async () => {
    const m = extensionManifest({ version: '0.1.0', tools: [{ name: 'add_room', description: 'Add a room. More.' }] }) as Record<string, unknown>;
    const allowed = ['manifest_version', 'dxt_version', 'name', 'display_name', 'version', 'description', 'long_description', 'author', 'repository', 'homepage', 'documentation', 'support', 'icon', 'icons', 'screenshots', 'server', 'tools', 'tools_generated', 'prompts', 'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config', 'localization', '_meta'];
    for (const k of Object.keys(m)) expect(allowed, k).toContain(k);
    expect(m.manifest_version).toBe(MANIFEST_VERSION);
    expect(m).toMatchObject({
      name: 'delve',
      display_name: 'Delve',
      version: '0.1.0',
      author: { name: 'herades-sys' },
      license: 'Apache-2.0',
      icon: 'icon.png',
      icons: [{ src: 'icon.png', size: '512x512' }],
      server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: {} } },
      tools: [{ name: 'add_room', description: 'Add a room.' }],
      compatibility: { platforms: ['win32'], runtimes: { node: '>=18.0.0' } },
    });
    expect(Object.keys(m.author as object)).toEqual(['name']); // no email until there is one
  });

  it('is a zip with the manifest, the bridge, the tool list and the icon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-mcpb-'));
    try {
      const out = join(dir, 'Delve.mcpb');
      const got = await buildMcpb(out, { version: '0.1.0' });
      const zip = readFileSync(out);
      expect(got.bytes).toBe(zip.length);
      const manifest = JSON.parse(unzipEntry(zip, 'manifest.json').toString('utf8')) as { tools: unknown[] };
      expect(manifest.tools.length).toBe(got.tools);
      expect(unzipEntry(zip, 'server/index.js').equals(readFileSync(BRIDGE_FILE))).toBe(true);
      const tools = JSON.parse(unzipEntry(zip, 'server/tools.json').toString('utf8')) as { tools: { inputSchema: unknown }[]; instructions: string };
      expect(tools.tools.length).toBe(got.tools);
      expect(tools.tools.every((t) => t.inputSchema)).toBe(true);
      expect(unzipEntry(zip, 'icon.png').subarray(1, 4).toString()).toBe('PNG');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the bridge to Node’s built-ins', () => {
    const src = readFileSync(BRIDGE_FILE, 'utf8');
    const required = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(3);
    for (const r of required) expect(r, r).toMatch(/^node:/);
    expect(src).not.toMatch(/\bimport\s/);
  });
});
