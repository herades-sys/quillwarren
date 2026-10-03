// The chat: Claude Code's stream -> chat events, the bridge (with a fake
// `claude` binary), the prompt and context Claude gets, short-lived MCP
// tokens, and the /chat endpoint in front of a fake bridge.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateMap, type DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { claudeArgs, createBridge, parseRun } from '../src/chat/bridge.ts';
import { StreamTranslator, type ChatEvent } from '../src/chat/events.ts';
import { CHAT_SYSTEM_PROMPT, chatContext, chatPrompt } from '../src/chat/prompt.ts';
import { parseChatRequest } from '../src/chat/route.ts';
import { ChatTokens } from '../src/chat/tokens.ts';

const testMap = validateMap(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')));
const SESSION = '11111111-1111-4111-8111-111111111111';
const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o));

describe('StreamTranslator', () => {
  it('turns Claude Code stream-json into chat events', () => {
    const t = new StreamTranslator();
    const out: ChatEvent[] = [];
    for (const l of lines(
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'delve', status: 'connected' }] },
      { type: 'stream_event', session_id: SESSION, event: { type: 'message_start', message: { id: 'm1' } } },
      { type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Adding ' } } },
      { type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'it.' } } },
      {
        type: 'assistant',
        session_id: SESSION,
        message: { id: 'm1', content: [{ type: 'text', text: 'Adding it.' }, { type: 'tool_use', id: 't1', name: 'mcp__delve__add_room', input: { rect: [0, 0, 4, 4] } }] },
      },
      { type: 'user', session_id: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Added room r9.' }] }] } },
      { type: 'stream_event', session_id: SESSION, event: { type: 'message_start', message: { id: 'm2' } } },
      { type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } },
      { type: 'assistant', session_id: SESSION, message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 99, unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.14 } } } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 1234, session_id: SESSION, result: 'Done.' },
      'not json',
    )) {
      out.push(...t.feed(l));
    }
    expect(out).toEqual([
      { type: 'start', session: SESSION, model: 'claude-sonnet-5-5' },
      { type: 'text', text: 'Adding ' },
      { type: 'text', text: 'it.' },
      { type: 'tool', id: 't1', name: 'add_room', input: { rect: [0, 0, 4, 4] } },
      { type: 'tool_done', id: 't1', ok: true, text: 'Added room r9.' },
      { type: 'text', text: '\n\nDone.' },
      { type: 'usage', fiveHour: 0.1, sevenDay: 0.14, status: 'allowed', resetsAt: 99 },
      { type: 'done', session: SESSION, ok: true, turns: 2, ms: 1234 },
    ]);
    expect(t.done).toBe(true);
  });

  it('says so when Delve\'s tools did not connect, or Claude failed', () => {
    const t = new StreamTranslator();
    expect(t.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, mcp_servers: [{ name: 'delve', status: 'failed' }] }))[1]).toMatchObject({
      type: 'error',
      code: 'bridge',
    });
    expect(t.feed(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Please run /login', session_id: SESSION }))[0]).toMatchObject({
      type: 'done',
      ok: false,
      error: 'Please run /login',
    });
  });
});

describe('bridge request checks', () => {
  const good = { prompt: '[Delve context]\nhi', system: 'x', mcp: { url: 'http://127.0.0.1:8790/mcp', token: 'abcdefghijklmnopqrstuvwx' } };
  it('accepts a normal run and refuses odd ones', () => {
    expect(parseRun(good)).toMatchObject({ prompt: good.prompt });
    expect(parseRun({ ...good, mcp: { ...good.mcp, url: 'http://evil.example/mcp' } })).toContain('127.0.0.1');
    expect(parseRun({ ...good, prompt: '/doctor' })).toContain('"/"');
    expect(parseRun({ ...good, resume: 'not-a-uuid' })).toContain('session id');
    expect(parseRun({ ...good, model: 'Opus; rm -rf' })).toContain('model');
    expect(parseRun({ ...good, mcp: { url: good.mcp.url } })).toContain('token');
  });

  it('runs Claude Code with Delve\'s tools only', () => {
    const args = claudeArgs(parseRun({ ...good, resume: SESSION }) as never, { system: '/s.md', mcp: '/m.json' }, 'sonnet');
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('-p');
    expect(args).toContain('--strict-mcp-config');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toBe('mcp__delve');
    expect(after('--setting-sources')).toBe('');
    expect(after('--mcp-config')).toBe('/m.json');
    expect(after('--system-prompt-file')).toBe('/s.md');
    expect(after('--model')).toBe('sonnet');
    expect(after('--resume')).toBe(SESSION);
  });
});

// ---------- the bridge with a fake claude ----------

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const arg = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const mode = stdin.includes('MODE=hang') ? 'hang' : stdin.includes('MODE=nosession') ? 'nosession' : 'ok';
  if (mode === 'nosession') { process.stderr.write('No conversation found with session ID: x\\n'); process.exit(1); }
  const session = arg('--resume') ?? '${SESSION}';
  out({ type: 'system', subtype: 'init', session_id: session, model: arg('--model'), mcp_servers: [{ name: 'delve', status: 'connected' }] });
  if (mode === 'hang') {
    out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pid:' + process.pid } } });
    setInterval(() => {}, 1000);
    return;
  }
  const seen = { stdin, cwd: process.cwd(), mcp: JSON.parse(readFileSync(arg('--mcp-config'), 'utf8')), system: readFileSync(arg('--system-prompt-file'), 'utf8') };
  out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(seen) } } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, session_id: session, result: 'ok' });
});
`;

describe('chat bridge', () => {
  let dir: string;
  let bridge: Server;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'delve-bridge-'));
    const bin = join(dir, 'fake-claude.mjs');
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    bridge = createBridge({ claudeBin: bin, dir: join(dir, 'home'), timeoutMs: 1500 });
    await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
  });
  afterAll(() => {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const body = (prompt: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ prompt, system: 'SYSTEM PROMPT', mcp: { url: 'http://127.0.0.1:8790/mcp', token: 'chat-token-abcdefghijkl' }, ...extra });
  const events = async (res: Response) =>
    (await res.text())
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatEvent);

  it('reports the Claude Code version', async () => {
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: true, claude: '9.9.9 (Claude Code)' });
  });

  it('runs claude with the prompt on stdin, its own MCP config, and cleans up', async () => {
    const res = await fetch(`${url}/run`, { method: 'POST', body: body('[ctx] add a room', { model: 'opus' }) });
    expect(res.headers.get('content-type')).toContain('ndjson');
    const evs = await events(res);
    expect(evs[0]).toMatchObject({ type: 'start', session: SESSION, model: 'opus' });
    const seen = JSON.parse((evs.find((e) => e.type === 'text') as { text: string }).text);
    expect(seen.stdin).toBe('[ctx] add a room');
    expect(seen.system).toBe('SYSTEM PROMPT');
    expect(seen.cwd).toBe(join(dir, 'home', 'work'));
    expect(seen.mcp.mcpServers.delve).toEqual({ type: 'http', url: 'http://127.0.0.1:8790/mcp', headers: { Authorization: 'Bearer chat-token-abcdefghijkl' } });
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true });
    expect(readdirSync(join(dir, 'home', 'runs'))).toEqual([]); // the token file is gone
  });

  it('tells the panel when the conversation to resume is gone', async () => {
    const evs = await events(await fetch(`${url}/run`, { method: 'POST', body: body('[ctx] MODE=nosession', { resume: SESSION }) }));
    expect(evs).toEqual([{ type: 'error', code: 'no_session', error: expect.stringContaining('start a new chat') }]);
  });

  it('stops Claude when the browser goes away, and after the timeout', async () => {
    const abort = new AbortController();
    const res = await fetch(`${url}/run`, { method: 'POST', body: body('[ctx] MODE=hang'), signal: abort.signal });
    // the fake claude says its pid, then hangs; once we hang up, it must be gone shortly
    const reader = res.body!.getReader();
    let got = '';
    while (!/pid:\d+/.test(got)) got += new TextDecoder().decode((await reader.read()).value);
    const pid = Number(/pid:(\d+)/.exec(got)![1]);
    abort.abort();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 5000 }).toBe(false);

    const timedOut = await events(await fetch(`${url}/run`, { method: 'POST', body: body('[ctx] MODE=hang') }));
    expect(timedOut.at(-1)).toMatchObject({ type: 'error', code: 'timeout' });
  });

  it('refuses bad requests', async () => {
    const res = await fetch(`${url}/run`, { method: 'POST', body: body('/login') });
    expect(res.status).toBe(400);
  });
});

// ---------- prompt and context ----------

describe('what Claude is told', () => {
  it('explains coordinates, walls, doors and the tools', () => {
    for (const s of ['y grows downward', 'Rooms that touch or overlap merge', 'north wall: at [x+k, y]', 'apply_ops', 'render', 'focus', 'classic-hatching', '70 px per square']) {
      expect(CHAT_SYSTEM_PROMPT).toContain(s);
    }
  });

  it('gives the map, the selection, the view and exact objects', () => {
    const ctx = chatContext({ map: testMap, rev: 7, selection: ['r3', 'nope'], view: { x0: 0, y0: 0, x1: 20, y1: 30 } });
    expect(ctx).toContain(`id ${testMap.id}, rev 7`);
    expect(ctx).toMatch(/Selected in the editor:\n {2}r3 room/);
    expect(ctx).not.toContain('nope');
    expect(ctx).toContain('Visible area: x 0 to 20, y 0 to 30 (centre 10, 15)');
    expect(ctx).toContain('Objects (exact, in squares):');
    expect(ctx).toMatch(/d\d+ door at \[/);
    // the plan reminder comes last, right before the user's words (the system prompt alone was ignored)
    expect(ctx).toMatch(/Plan: if this request takes 3 or more steps, call plan first[^\n]*\n\[End of Delve context\]$/);
    expect(chatPrompt({ map: testMap, rev: 7 }, '  make it bigger ')).toMatch(/\[End of Delve context\]\n\nmake it bigger$/);
  });

  it('lists only a summary for huge maps', () => {
    const big: DelveMap = {
      ...testMap,
      objects: Array.from({ length: 400 }, (_, i) => ({ id: `l${i + 1}`, type: 'label' as const, text: `Label number ${i + 1} with some text`, at: [i, 0] as [number, number] })),
    };
    const ctx = chatContext({ map: big, rev: 1 });
    expect(ctx).toContain('call get_map');
    expect(ctx.length).toBeLessThan(20_000);
  });
});

describe('ChatTokens', () => {
  it('works until revoked or expired', () => {
    const t = new ChatTokens(1000);
    const a = t.mint('http://delve.test', 0);
    expect(t.lookup(a, 10)).toEqual({ base: 'http://delve.test', expires: 1000 });
    expect(t.lookup(a, 1000)).toBeNull();
    const b = t.mint('http://x', 0);
    t.revoke(b);
    expect(t.lookup(b, 1)).toBeNull();
    expect(t.lookup(undefined)).toBeNull();
  });
});

describe('chat request checks', () => {
  it('needs a message and accepts selection, view and model', () => {
    expect(() => parseChatRequest({ message: '  ' })).toThrow(/write something/);
    expect(() => parseChatRequest({ message: 'hi', model: 'gpt' })).toThrow(/model/);
    expect(() => parseChatRequest({ message: 'hi', session: 'x' })).toThrow(/session/);
    expect(parseChatRequest({ message: ' hi ', selection: ['r1', 3], view: { x0: 0, y0: 0, x1: 5, y1: 5 }, model: 'opus' })).toEqual({
      message: 'hi',
      selection: ['r1'],
      view: { x0: 0, y0: 0, x1: 5, y1: 5 },
      model: 'opus',
    });
  });
});

// ---------- the /chat endpoint ----------

describe('chat endpoint', () => {
  const TOKEN = 'test-token';
  const auth = { authorization: `Bearer ${TOKEN}` };
  let app: FastifyInstance;
  let fake: Server;
  let fakeUrl: string;
  let lastRun: { prompt: string; system: string; model: string; resume?: string; mcp: { url: string; token: string } } | null = null;
  let mcpDuringRun: { status: number; text: string } | null = null;

  beforeAll(async () => {
    fake = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, claude: '9.9.9 (Claude Code)' }));
        return;
      }
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', async () => {
        lastRun = JSON.parse(raw);
        // While the run is open, its chat token works on /mcp, and links use the browser's address.
        const r = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { authorization: `Bearer ${lastRun!.mcp.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export', arguments: { map: /id (map_[0-9a-f]+)/.exec(lastRun!.prompt)![1] } } },
        });
        mcpDuringRun = { status: r.statusCode, text: r.body };
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ type: 'start', session: SESSION })}\n`);
        res.end(`${JSON.stringify({ type: 'done', session: SESSION, ok: true, turns: 1, ms: 1 })}\n`);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, chat: { bridgeUrl: fakeUrl, port: 8790 } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    fake.close();
  });
  afterEach(() => {
    lastRun = null;
    mcpDuringRun = null;
  });

  const newMapId = async () =>
    (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Chat crypt' } })).json().id as string;

  it('streams the answer and gives Claude the context and a working, short-lived token', async () => {
    const id = await newMapId();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${id}/chat`,
      headers: { ...auth, host: 'delve.test:8790' },
      payload: { message: 'add a shrine', selection: ['r2'], model: 'opus', session: SESSION },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.body.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(['start', 'done']);
    expect(lastRun!.prompt).toContain(`id ${id}, rev 1`);
    expect(lastRun!.prompt).toMatch(/Selected in the editor:\n {2}r2 room/);
    expect(lastRun!.prompt.endsWith('add a shrine')).toBe(true);
    expect(lastRun!.system).toBe(CHAT_SYSTEM_PROMPT);
    expect(lastRun!.model).toBe('opus');
    expect(lastRun!.resume).toBe(SESSION);
    expect(lastRun!.mcp.url).toBe('http://127.0.0.1:8790/mcp');
    expect(lastRun!.mcp.token).not.toBe(TOKEN);
    expect(mcpDuringRun!.status).toBe(200);
    expect(mcpDuringRun!.text).toContain(`http://delve.test:8790/api/v1/maps/${id}/render.png`);
    // once the answer is done, the token is dead
    const after = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${lastRun!.mcp.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(after.statusCode).toBe(401);
  });

  it('is for editors only, and explains problems', async () => {
    const id = await newMapId();
    expect((await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, payload: { message: 'hi' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, headers: auth, payload: { message: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/maps/map_000000000000/chat', headers: auth, payload: { message: 'hi' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/chat', headers: auth })).json()).toMatchObject({ enabled: true, ok: true, models: ['sonnet', 'opus', 'haiku'] });
  });

  it('says when the bridge is down or the chat is not set up', async () => {
    const down = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, chat: { bridgeUrl: 'http://127.0.0.1:9', port: 8790 } });
    const off = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    try {
      const id = (await down.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: {} })).json().id;
      const r = await down.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, headers: auth, payload: { message: 'hi' } });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toContain('delve-chat.service');
      expect((await down.inject({ url: '/api/v1/chat', headers: auth })).json()).toMatchObject({ enabled: true, ok: false });
      expect((await off.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, headers: auth, payload: { message: 'hi' } })).statusCode).toBe(503);
      expect((await off.inject({ url: '/api/v1/chat', headers: auth })).json()).toEqual({ enabled: false });
    } finally {
      await down.close();
      await off.close();
    }
  });

  it('shows the chat panel only to logged-in editors when the chat is set up', async () => {
    const open = buildApp({ version: 'test', started: 'now' }, { openEdit: true, chat: { bridgeUrl: fakeUrl, port: 8790, model: 'opus' } });
    try {
      const id = (await open.inject({ method: 'POST', url: '/api/v1/maps', payload: {} })).json().id;
      const page = (await open.inject({ url: `/maps/${id}` })).body;
      expect(page).toContain('id="chat-toggle"');
      expect(page).toContain('"chat":{"enabled":true,"model":"opus"}');
      const id2 = await newMapId();
      const anon = (await app.inject({ url: `/maps/${id2}` })).body;
      expect(anon).not.toContain('chat-toggle');
      expect(anon).not.toContain('"chat"');
    } finally {
      await open.close();
    }
  });
});
