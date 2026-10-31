// The desktop app's chat on the user's own API key ("Claude (your Anthropic
// API key)", "OpenAI (your API key)"), against fake Anthropic and OpenAI
// servers on 127.0.0.1: never the real network, never a real key. A reply that
// calls add_room and render and then answers (tool_use → tool_result → text),
// with prompt caching, adaptive thinking passed back, refusal fallbacks, the
// picture going back as a picture, and the tokens; a bad key (401), a rate
// limit (429, retried), no credit, Stop in the middle of a reply; and the key
// itself: checked against the models endpoint, sealed on disk, never sent back
// to the page.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.ts';
import { claudeFeatures, finishReply, offeredClaude } from '../src/chat/anthropic.ts';
import { apiSchema, anthropicTools, openAiTools } from '../src/chat/api-tools.ts';
import { checkKey, KeyStore, plainBox, type SecretBox } from '../src/chat/api-keys.ts';
import { noUsage } from '../src/chat/api-model.ts';
import type { ChatEvent } from '../src/chat/events.ts';
import { localChatBackends } from '../src/chat/local-chat.ts';
import { openAiChatModel, sortOpenAiModels } from '../src/chat/openai.ts';
import type { ChatBackends } from '../src/chat/route.ts';
import { ipcSecretBox } from '../src/desktop/vault.ts';
import { MapStore } from '../src/store.ts';
import { vaultReply } from '../../desktop/src/vault.ts';

const ANTHROPIC_KEY = 'sk-ant-api03-FAKE-TEST-KEY-not-real-0000000000000000';
const OPENAI_KEY = 'sk-proj-FAKE-TEST-KEY-not-real-00000000000000';
const MAP = 'map_test4p';
const testMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as unknown;

// No test here may reach the real network: anything but 127.0.0.1 throws.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`a test tried to reach ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A box that really changes the key (as safeStorage would), so the file can be checked for it. */
const fakeBox: SecretBox = {
  kind: 'safeStorage',
  available: async () => true,
  seal: async (s) => `sealed:${Buffer.from(s).reverse().toString('base64')}`,
  open: async (s) => Buffer.from(s.slice(7), 'base64').reverse().toString(),
};

type Json = Record<string, unknown>;

/** A scripted fake API: each POST takes the next step; every request is kept. */
class FakeApi {
  server!: Server;
  base = '';
  readonly requests: { method: string; url: string; headers: IncomingMessage['headers']; body: Json }[] = [];
  steps: ((body: Json, res: ServerResponse, req: IncomingMessage) => void)[] = [];
  models: (res: ServerResponse, req: IncomingMessage) => void = (res) => res.writeHead(404).end();
  closedEarly = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Json) : {};
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.on('close', () => {
          if (!res.writableFinished) this.closedEarly++;
        });
        if (req.method === 'GET' && req.url?.startsWith('/v1/models')) return this.models(res, req);
        const step = this.steps.shift();
        if (!step) return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"no more steps"}}');
        step(body, res, req);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  posts(): Json[] {
    return this.requests.filter((r) => r.method === 'POST').map((r) => r.body);
  }
}

function sse(res: ServerResponse, events: [string, Json][], hold = false): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!hold) res.end();
}

function openAiStream(res: ServerResponse, chunks: Json[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const jsonError = (res: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const anthropicOops = (type: string, message: string) => ({ type: 'error', error: { type, message } });

/** Anthropic's stream for one reply: optional text, optional tool calls (input sent in two pieces), a stop reason. */
function claudeReply(o: { id: string; text?: string; tools?: { id: string; name: string; input: Json }[]; stop: string; usage?: Json; thinking?: boolean }): [string, Json][] {
  const ev: [string, Json][] = [['message_start', { type: 'message_start', message: { id: o.id, model: 'claude-opus-5-5', usage: o.usage ?? { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }]];
  let i = 0;
  if (o.thinking) {
    ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
    ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: `sig-${o.id}` } }]);
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }]);
  }
  if (o.text) {
    ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]);
    const half = Math.ceil(o.text.length / 2);
    for (const part of [o.text.slice(0, half), o.text.slice(half)]) ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: part } }]);
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }]);
  }
  for (const t of o.tools ?? []) {
    ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } }]);
    const json = JSON.stringify(t.input);
    for (const part of [json.slice(0, 10), json.slice(10)]) ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: part } }]);
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }]);
  }
  ev.push(['ping', { type: 'ping' }]);
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: o.stop }, usage: { output_tokens: 42 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev;
}

/** The ndjson chat events of one POST /chat. */
const eventsOf = (body: string): ChatEvent[] =>
  body
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChatEvent);

interface Setup {
  app: FastifyInstance;
  store: MapStore;
  backends: ChatBackends;
  ctx: AppContext;
  dir: string;
}

async function setUp(anthropic: FakeApi, openai: FakeApi, box: SecretBox = fakeBox): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'delve-api-chat-'));
  const store = new MapStore(':memory:');
  store.create(testMap, 'test');
  let backends!: ChatBackends;
  let ctx!: AppContext;
  const app = buildApp(
    { version: 'test', started: 'now' },
    {
      store,
      openEdit: true,
      singleUser: true,
      multiplayer: false,
      chatBackends: (c) => {
        ctx = c;
        backends = localChatBackends(c, {
          settingsFile: join(dir, 'chat-settings.json'),
          api: { box, keysFile: join(dir, 'chat-keys.json'), providers: { anthropic: { base: anthropic.base, retries: 2, pauseMs: 5 }, openai: { base: openai.base, retries: 2, pauseMs: 5 } } },
        });
        return backends;
      },
    },
  );
  await app.ready();
  return { app, store, backends, ctx, dir };
}

const put = (app: FastifyInstance, body: Json) => app.inject({ method: 'PUT', url: '/api/v1/chat/settings', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const chat = (app: FastifyInstance, body: Json) => app.inject({ method: 'POST', url: `/api/v1/maps/${MAP}/chat`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const CLAUDE_MODELS = (res: ServerResponse) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      data: [
        { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01', max_tokens: 64000 },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01', max_tokens: 128000 },
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01', max_tokens: 128000 },
        { id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', created_at: '2024-03-07', max_tokens: 4096 },
        { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01', max_tokens: 128000 },
      ],
      has_more: false,
    }),
  );

describe('Claude on the user’s own Anthropic API key', () => {
  const anthropic = new FakeApi();
  const openai = new FakeApi();
  let s: Setup;
  beforeAll(async () => {
    await anthropic.start();
    await openai.start();
    anthropic.models = (res, req) => (req.headers['x-api-key'] === ANTHROPIC_KEY ? CLAUDE_MODELS(res) : jsonError(res, 401, anthropicOops('authentication_error', 'invalid x-api-key')));
    s = await setUp(anthropic, openai);
  });
  afterAll(async () => {
    await s.app.close();
    await anthropic.stop();
    await openai.stop();
    rmSync(s.dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    anthropic.requests.length = 0;
    anthropic.steps = [];
  });

  it('offers both API-key backends next to none and local, with Claude Opus 5.5 by default and no key', async () => {
    const view = JSON.parse((await s.app.inject({ method: 'GET', url: '/api/v1/chat/settings' })).body) as Json;
    expect(view.offered).toEqual(['none', 'local', 'anthropic', 'openai']);
    expect(view.labels).toMatchObject({ anthropic: ['Claude (your Anthropic API key)', expect.any(String)], openai: ['OpenAI (your API key)', expect.any(String)] });
    const keys = view.keys as Record<string, Json>;
    expect(keys.anthropic).toMatchObject({ set: false, model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] });
    expect(keys.anthropic!.note).toMatch(/go to Anthropic.*billed to your Anthropic account/);
    expect(keys.openai).toMatchObject({ set: false, model: '', models: [] });
    expect(keys.openai!.note).toMatch(/go to OpenAI.*billed to your OpenAI account/);
    expect(anthropic.requests).toEqual([]); // nothing is sent before the user asks
  });

  it('checks a key against the models endpoint: the models it may use, or what is wrong in words', async () => {
    const test = (body: Json) => s.app.inject({ method: 'POST', url: '/api/v1/chat/settings/test', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const bad = JSON.parse((await test({ backend: 'anthropic', key: 'sk-ant-api03-WRONG-0000000000000000000000' })).body) as Json;
    expect(bad).toEqual({ ok: false, error: 'Anthropic refused the API key: it may be wrong, revoked or deleted. Check it in the chat settings.' });
    expect(JSON.parse((await test({ backend: 'anthropic', key: 'hello' })).body)).toMatchObject({ ok: false, error: expect.stringMatching(/doesn’t look like an API key/) });
    expect(JSON.parse((await test({ backend: 'anthropic' })).body)).toEqual({ ok: false, error: 'enter your API key first' });
    const good = JSON.parse((await test({ backend: 'anthropic', key: ANTHROPIC_KEY })).body) as { ok: boolean; models: { id: string }[] };
    expect(good.ok).toBe(true);
    // the three current ones first, older Claude after them, nothing older than 4.5
    expect(good.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8']);
    expect(anthropic.requests.at(-1)!.headers['anthropic-version']).toBe('2026-10-21');
    const view = JSON.parse((await s.app.inject({ method: 'GET', url: '/api/v1/chat/settings' })).body) as { keys: Record<string, { models: unknown[] }> };
    expect(view.keys.anthropic!.models).toHaveLength(4);
  });

  it('keeps the key sealed on disk and never sends it back to the page', async () => {
    expect((await put(s.app, { backend: 'anthropic' })).statusCode).toBe(400); // no key yet
    const badKey = await put(s.app, { backend: 'anthropic', anthropic: { key: 'sk-openai-looking-0000000000000000' } });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.body).not.toContain('sk-openai-looking');
    const saved = await put(s.app, { backend: 'anthropic', anthropic: { key: ANTHROPIC_KEY, model: 'claude-opus-5-5' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(ANTHROPIC_KEY);
    expect(JSON.parse(saved.body)).toMatchObject({ backend: 'anthropic', keys: { anthropic: { set: true, hint: '…0000', storage: 'encrypted' } } });
    const onDisk = readFileSync(join(s.dir, 'chat-keys.json'), 'utf8');
    expect(onDisk).not.toContain(ANTHROPIC_KEY);
    expect(onDisk).toContain('sealed:');
    expect(readFileSync(join(s.dir, 'chat-settings.json'), 'utf8')).not.toContain(ANTHROPIC_KEY);
    for (const url of ['/api/v1/chat/settings', '/api/v1/chat', `/maps/${MAP}`]) expect((await s.app.inject({ method: 'GET', url })).body, url).not.toContain(ANTHROPIC_KEY);
    expect(JSON.parse((await s.app.inject({ method: 'GET', url: '/api/v1/chat' })).body)).toMatchObject({ enabled: true, backend: 'anthropic', ok: true, model: 'claude-opus-5-5' });
    // a fresh start opens it again through the box
    const again = new KeyStore(join(s.dir, 'chat-keys.json'), fakeBox);
    expect(await again.get('anthropic')).toBe(ANTHROPIC_KEY);
  });

  it('answers with tool_use → tool_result → text: the map changes, render’s picture goes back, the plan and tokens reach the panel', async () => {
    anthropic.steps = [
      (_b, res) => sse(res, claudeReply({ id: 'msg_1', thinking: true, text: 'Adding a vault.', tools: [{ id: 'toolu_1', name: 'add_room', input: { map: MAP, rect: [40, 2, 6, 4], name: 'Vault' } }], stop: 'tool_use', usage: { input_tokens: 900, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0, output_tokens: 1 } })),
      (_b, res) => sse(res, claudeReply({ id: 'msg_2', thinking: true, tools: [{ id: 'toolu_2', name: 'render', input: { map: MAP, ppg: 10 } }], stop: 'tool_use' })),
      (_b, res) => sse(res, claudeReply({ id: 'msg_3', text: 'Added room Vault east of the rest.', stop: 'end_turn', usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 12000, output_tokens: 1 } })),
    ];
    const before = s.store.get(MAP).rev;
    const res = await chat(s.app, { message: 'Add a vault east of everything' });
    const evs = eventsOf(res.body);
    const posts = anthropic.posts();
    expect(posts).toHaveLength(3);

    // the request: model, streaming, caching on tools + system + the newest message, adaptive thinking, effort, fallbacks
    const first = posts[0]!;
    const req = anthropic.requests.find((r) => r.method === 'POST')!;
    expect(req.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(req.headers['anthropic-version']).toBe('2026-10-21');
    expect(req.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(first).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, fallbacks: 'default', max_tokens: 64000 });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(first, k).not.toHaveProperty(k);
    const system = first.system as Json[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(String(system[0]!.text)).toMatch(/^You are Claude, working inside Delve/);
    const tools = first.tools as Json[];
    expect(tools.map((t) => t.name)).toContain('add_room');
    expect(tools.map((t) => t.name)).toContain('TaskCreate');
    expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
    expect(tools.every((t) => t.eager_input_streaming === true)).toBe(true);
    const addRoom = tools.find((t) => t.name === 'add_room')!.input_schema as { properties: Record<string, Json> };
    expect(addRoom.properties.rect).toMatchObject({ type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 });
    const userMsg = (first.messages as { role: string; content: Json[] }[])[0]!;
    expect(String(userMsg.content[0]!.text)).toContain('[Delve context');
    expect(userMsg.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });

    // the second request: the reply came back whole (thinking with its signature, the tool call), then its result
    const second = posts[1]!.messages as { role: string; content: Json[] }[];
    expect(second).toHaveLength(3);
    expect(second[0]!.content[0]!.cache_control).toBeUndefined(); // only the newest message carries the breakpoint
    expect(second[1]!.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(second[1]!.content[0]).toMatchObject({ type: 'thinking', signature: 'sig-msg_1' });
    expect(second[1]!.content[2]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'add_room', input: { map: MAP, rect: [40, 2, 6, 4], name: 'Vault' } });
    expect(second[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', cache_control: { type: 'ephemeral' } });
    // render's PNG went back as an image block
    const third = posts[2]!.messages as { role: string; content: { type: string; content?: Json[] }[] }[];
    const result = third.at(-1)!.content[0]!;
    expect(result.content!.some((c) => c.type === 'image' && (c.source as Json).media_type === 'image/png')).toBe(true);

    // the map changed, as one revision for add_room
    expect(s.store.get(MAP).rev).toBe(before + 1);
    expect(s.store.get(MAP).map.objects.some((o) => (o as { name?: string }).name === 'Vault')).toBe(true);

    // what the panel got: the text streamed once, the tools with their results, done with the tokens
    expect(evs[0]).toMatchObject({ type: 'start', model: 'claude-opus-5-5' });
    const text = evs.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Adding a vault.\n\nAdded room Vault east of the rest.');
    expect(evs.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name)).toEqual(['add_room', 'render']);
    expect(evs.filter((e) => e.type === 'tool_done').every((e) => (e as { ok: boolean }).ok)).toBe(true);
    const done = evs.at(-1) as Extract<ChatEvent, { type: 'done' }>;
    expect(done).toMatchObject({ type: 'done', ok: true, turns: 3 });
    expect(done.tokens).toEqual({ input: 900 + 12000 + 10 + 300 + 12000, output: 126, cacheRead: 12000, cacheWrite: 12000 });
    expect(res.body).not.toContain(ANTHROPIC_KEY);

    // a follow-up carries the conversation as plain text (no thinking blocks from the earlier reply)
    anthropic.steps = [(_b, r) => sse(r, claudeReply({ id: 'msg_4', text: 'It is 6 by 4 squares.', stop: 'end_turn' }))];
    const follow = await chat(s.app, { message: 'How big is it?', session: done.session });
    expect(eventsOf(follow.body).at(-1)).toMatchObject({ type: 'done', ok: true });
    const msgs = anthropic.posts().at(-1)!.messages as { role: string; content: unknown }[];
    expect(msgs[0]).toEqual({ role: 'user', content: 'Add a vault east of everything' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Added room Vault east of the rest.' });
    expect(JSON.stringify(msgs[2])).toContain('How big is it?');
  });

  it('turns the task list into the plan card', async () => {
    anthropic.steps = [
      (_b, res) => sse(res, claudeReply({ id: 'm1', tools: [{ id: 't1', name: 'TaskCreate', input: { subject: 'Build the room' } }, { id: 't2', name: 'TaskCreate', input: { subject: 'Check it' } }], stop: 'tool_use' })),
      (_b, res) => sse(res, claudeReply({ id: 'm2', tools: [{ id: 't3', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }, { id: 't4', name: 'describe_map', input: { map: MAP } }], stop: 'tool_use' })),
      (_b, res) => sse(res, claudeReply({ id: 'm3', text: 'Done.', stop: 'end_turn' })),
    ];
    const evs = eventsOf((await chat(s.app, { message: 'Plan it' })).body);
    const plans = evs.filter((e) => e.type === 'plan') as Extract<ChatEvent, { type: 'plan' }>[];
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.at(-1)!.steps).toEqual([
      { title: 'Build the room', status: 'done' },
      { title: 'Check it', status: 'done' },
    ]);
    expect(evs.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name)).toEqual(['describe_map']);
  });

  it('says what went wrong: a refused key, a rate limit (retried first), no credit', async () => {
    // 429 then success: retried after retry-after
    anthropic.steps = [(_b, res) => jsonError(res, 429, anthropicOops('rate_limit_error', 'slow down'), { 'retry-after': '0' }), (_b, res) => sse(res, claudeReply({ id: 'r1', text: 'Fine.', stop: 'end_turn' }))];
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ type: 'done', ok: true });
    expect(anthropic.posts()).toHaveLength(2);
    // 429 every time: the limit in words
    anthropic.requests.length = 0;
    anthropic.steps = [0, 1, 2].map(() => (_b: Json, res: ServerResponse) => jsonError(res, 429, anthropicOops('rate_limit_error', 'slow down'), { 'retry-after': '0' }));
    const limited = eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1) as Extract<ChatEvent, { type: 'done' }>;
    expect(limited).toMatchObject({ ok: false, error: 'Anthropic’s rate limit for this key was reached. Wait a minute, then try again.' });
    expect(anthropic.posts()).toHaveLength(3);
    // 401
    anthropic.steps = [(_b, res) => jsonError(res, 401, anthropicOops('authentication_error', 'invalid x-api-key'))];
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/^Anthropic refused the API key/) });
    // no credit
    anthropic.steps = [(_b, res) => jsonError(res, 400, anthropicOops('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'))];
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/no credit left/) });
    // a refusal: nothing from it runs
    anthropic.steps = [(_b, res) => sse(res, claudeReply({ id: 'x1', tools: [{ id: 'tx', name: 'delete', input: { map: MAP, ids: ['r1'] } }], stop: 'refusal' }))];
    const rev = s.store.get(MAP).rev;
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/declined/) });
    expect(s.store.get(MAP).rev).toBe(rev);
  });

  it('leaves the refusal fallback out when the account refuses its beta, and carries on', async () => {
    anthropic.steps = [
      (_b, res) => jsonError(res, 400, anthropicOops('invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.')),
      (_b, res) => sse(res, claudeReply({ id: 'b1', text: 'OK.', stop: 'end_turn' })),
    ];
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ ok: true });
    const posts = anthropic.requests.filter((r) => r.method === 'POST');
    expect(posts[1]!.headers['anthropic-beta']).toBeUndefined();
    expect(posts[1]!.body).not.toHaveProperty('fallbacks');
  });

  it('answers a call with arguments that aren’t JSON with an error, without running it', async () => {
    anthropic.steps = [
      (_b, res) =>
        sse(res, [
          ['message_start', { type: 'message_start', message: { id: 'j1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tj', name: 'add_room', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"map": "map_test4p", "rect": [1, 2' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
        ]),
      (_b, res) => sse(res, claudeReply({ id: 'j2', text: 'Sorry.', stop: 'end_turn' })),
    ];
    const rev = s.store.get(MAP).rev;
    await chat(s.app, { message: 'Hi' });
    const back = anthropic.posts()[1]!.messages as { content: Json[] }[];
    expect(back.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tj', is_error: true });
    expect(JSON.stringify(back.at(-1)!.content[0])).toContain('INVALID_JSON');
    expect(s.store.get(MAP).rev).toBe(rev);
  });

  it('stops in the middle of a reply: the request is cut, nothing more is asked or run', async () => {
    let stream: ServerResponse | null = null;
    anthropic.steps = [
      (_b, res) => {
        stream = res;
        sse(res, claudeReply({ id: 's1', text: 'Working on it, this takes a while', stop: 'end_turn' }).slice(0, 4), true);
      },
    ];
    const abort = new AbortController();
    const evs: ChatEvent[] = [];
    const run = s.backends.runLocal({
      mapId: MAP,
      request: { message: 'Build a huge dungeon', selection: [] },
      base: 'http://127.0.0.1:1',
      signal: abort.signal,
      send: (e) => {
        evs.push(e);
        if (e.type === 'text') abort.abort();
      },
    });
    await run;
    expect(evs.some((e) => e.type === 'text')).toBe(true);
    expect(evs.some((e) => e.type === 'done')).toBe(false);
    expect(anthropic.posts()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(anthropic.closedEarly).toBeGreaterThan(0);
    expect(stream).not.toBeNull();
  });

  it('says so when Anthropic can’t be reached', async () => {
    const dead = new FakeApi();
    await dead.start();
    const base = dead.base;
    await dead.stop();
    const store = new MapStore(':memory:');
    store.create(testMap, 't');
    const dir = mkdtempSync(join(tmpdir(), 'delve-api-dead-'));
    const app = buildApp({ version: 't', started: 'now' }, { store, openEdit: true, chatBackends: (c) => localChatBackends(c, { api: { box: plainBox, keysFile: join(dir, 'k.json'), providers: { anthropic: { base, retries: 0 } } } }) });
    try {
      expect((await put(app, { backend: 'anthropic', anthropic: { key: ANTHROPIC_KEY, model: 'claude-opus-5-5' } })).statusCode).toBe(200);
      const done = eventsOf((await chat(app, { message: 'Hi' })).body).at(-1);
      expect(done).toMatchObject({ ok: false, error: expect.stringMatching(/couldn’t reach 127\.0\.0\.1:\d+: is this computer online\?/) });
      // without a box the key is kept as it is, in a file only this user can read
      const view = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/chat/settings' })).body) as { keys: Record<string, Json> };
      expect(view.keys.anthropic).toMatchObject({ set: true, storage: 'file' });
      if (process.platform !== 'win32') expect(statSync(join(dir, 'k.json')).mode & 0o077).toBe(0);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the key: gone from disk, and the chat is off', async () => {
    const res = await put(s.app, { anthropic: { key: null } });
    expect(JSON.parse(res.body)).toMatchObject({ backend: 'none', keys: { anthropic: { set: false } } });
    expect(() => readFileSync(join(s.dir, 'chat-keys.json'), 'utf8')).toThrow(); // the last key: the file goes
  });
});

describe('the panel’s name follows who answers', () => {
  const anthropic = new FakeApi();
  const openai = new FakeApi();
  let s: Setup;
  beforeAll(async () => {
    await anthropic.start();
    await openai.start();
    anthropic.models = CLAUDE_MODELS;
    s = await setUp(anthropic, openai);
  });
  afterAll(async () => {
    await s.app.close();
    await anthropic.stop();
    await openai.stop();
    rmSync(s.dir, { recursive: true, force: true });
  });

  it('says Claude when Claude answers on the user’s key, and Assistant otherwise', async () => {
    const page = async () => (await s.app.inject({ method: 'GET', url: `/maps/${MAP}` })).body;
    expect(await page()).toContain('data-assistant="Assistant"');
    expect((await put(s.app, { backend: 'anthropic', anthropic: { key: ANTHROPIC_KEY } })).statusCode).toBe(200);
    const claude = await page();
    expect(claude).toContain('data-assistant="Claude"');
    expect(claude).toContain('Ask Claude to change the map');
    expect(claude).toContain('<span class="ed-panel-title">Claude</span>');
    // the page keeps the other backends' name, so the panel can rename itself on a switch (chat.ts)
    const initial = JSON.parse(/<script id="delve-initial" type="application\/json">(.*?)<\/script>/s.exec(claude)![1]!) as { chat: { backend: string; name: string } };
    expect(initial.chat).toMatchObject({ backend: 'anthropic', name: 'Assistant' });
    expect((await put(s.app, { backend: 'none' })).statusCode).toBe(200);
    expect(await page()).toContain('Ask Assistant to change the map');
  });
});

describe('OpenAI on the user’s own API key', () => {
  const anthropic = new FakeApi();
  const openai = new FakeApi();
  let s: Setup;
  beforeAll(async () => {
    await anthropic.start();
    await openai.start();
    openai.models = (res, req) =>
      req.headers.authorization === `Bearer ${OPENAI_KEY}`
        ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ['gpt-4o-mini', 'text-embedding-3-small', 'gpt-5-2025-08-07', 'whisper-1', 'gpt-5', 'dall-e-3', 'gpt-4o-realtime-preview', 'o3', 'o1-mini', 'gpt-image-1', 'tts-1', 'omni-moderation-latest', 'chatgpt-4o-latest', 'gpt-4.1'].map((id) => ({ id, object: 'model' })) }))
        : jsonError(res, 401, { error: { message: 'Incorrect API key provided: sk-proj-****0000.', type: 'invalid_request_error', code: 'invalid_api_key' } });
    s = await setUp(anthropic, openai);
  });
  afterAll(async () => {
    await s.app.close();
    await anthropic.stop();
    await openai.stop();
    rmSync(s.dir, { recursive: true, force: true });
  });
  afterEach(() => {
    openai.steps = [];
  });

  it('lists the chat models that take tools, newest first, from the key’s /v1/models', async () => {
    const res = JSON.parse((await s.app.inject({ method: 'POST', url: '/api/v1/chat/settings/test', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ backend: 'openai', key: OPENAI_KEY }) })).body) as { ok: boolean; models: { id: string }[] };
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-4.1', 'gpt-4o-mini', 'o3', 'gpt-5-2025-08-07']);
    const bad = JSON.parse((await s.app.inject({ method: 'POST', url: '/api/v1/chat/settings/test', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ backend: 'openai', key: 'sk-proj-WRONG-00000000000000000000' }) })).body) as Json;
    expect(bad).toEqual({ ok: false, error: 'OpenAI refused the API key: it may be wrong, revoked or deleted. Check it in the chat settings.' });
    // a model must be chosen before OpenAI can be switched on
    expect((await put(s.app, { backend: 'openai', openai: { key: OPENAI_KEY } })).statusCode).toBe(400);
    const ok = await put(s.app, { backend: 'openai', openai: { key: OPENAI_KEY, model: 'gpt-5' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(OPENAI_KEY);
  });

  it('answers with tool calls → tool results → text, the picture following as a user message, without being told it is Claude', async () => {
    const delta = (d: Json, extra: Json = {}) => ({ id: 'chatcmpl-1', model: 'gpt-5', choices: [{ index: 0, delta: d, finish_reason: null }], ...extra });
    const finish = (reason: string) => ({ id: 'chatcmpl-1', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    const usage = (p: number, c: number, cached: number) => ({ id: 'chatcmpl-1', model: 'gpt-5', choices: [], usage: { prompt_tokens: p, completion_tokens: c, prompt_tokens_details: { cached_tokens: cached } } });
    openai.steps = [
      (_b, res) =>
        openAiStream(res, [
          delta({ role: 'assistant', content: 'On it. ' }),
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_room', arguments: '{"map":"map_test4p",' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"rect":[50,2,6,4],"name":"Armoury"}' } }] }),
          finish('tool_calls'),
          usage(3000, 40, 0),
        ]),
      (_b, res) => openAiStream(res, [delta({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'render', arguments: '{"map":"map_test4p","ppg":10}' } }] }), finish('tool_calls'), usage(3200, 20, 2048)]),
      (_b, res) => openAiStream(res, [delta({ content: 'Added the Armoury.' }), finish('stop'), usage(3400, 10, 3072)]),
    ];
    const evs = eventsOf((await chat(s.app, { message: 'Add an armoury' })).body);
    const posts = openai.posts();
    expect(posts).toHaveLength(3);
    const req = openai.requests.find((r) => r.method === 'POST')!;
    expect(req.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(posts[0]).toMatchObject({ model: 'gpt-5', stream: true, stream_options: { include_usage: true }, tool_choice: 'auto' });
    const msgs0 = posts[0]!.messages as Json[];
    expect(String(msgs0[0]!.content)).toMatch(/^You are an AI assistant, working inside Delve/);
    const tool = (posts[0]!.tools as { function: { name: string; parameters: Json } }[]).find((t) => t.function.name === 'add_room')!;
    expect(JSON.stringify(tool.function.parameters)).not.toMatch(/additionalItems|\$schema|propertyNames/);
    const msgs1 = posts[1]!.messages as Json[];
    expect(msgs1.at(-2)).toMatchObject({ role: 'assistant', content: 'On it. ', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_room' } }] });
    expect(msgs1.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    const msgs2 = posts[2]!.messages as Json[];
    expect(msgs2.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
    const pic = msgs2.at(-1) as { role: string; content: Json[] };
    expect(pic.role).toBe('user');
    expect(String((pic.content[1]!.image_url as Json).url)).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(s.store.get(MAP).map.objects.some((o) => (o as { name?: string }).name === 'Armoury')).toBe(true);
    expect(evs.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name)).toEqual(['add_room', 'render']);
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true, tokens: { input: 9600, output: 70, cacheRead: 5120, cacheWrite: 0 } });
  });

  it('says what went wrong: no credit (insufficient_quota), a refused key with OpenAI’s masked key left out', async () => {
    openai.steps = [(_b, res) => jsonError(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } })];
    expect(eventsOf((await chat(s.app, { message: 'Hi' })).body).at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/no credit left/) });
    expect(openai.posts().length).toBeGreaterThan(0);
    openai.steps = [(_b, res) => jsonError(res, 401, { error: { message: 'Incorrect API key provided: sk-proj-****0000.', code: 'invalid_api_key' } })];
    const body = (await chat(s.app, { message: 'Hi' })).body;
    expect(eventsOf(body).at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/^OpenAI refused the API key/) });
    expect(body).not.toContain('sk-proj');
  });
});

describe('the pieces', () => {
  it('converts mcp.ts schemas for each API: tuples, $schema, OpenAI’s unsupported keywords', () => {
    const s = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        rect: { description: 'Rectangle [x, y, width, height]', type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number', exclusiveMinimum: 0 }, { type: 'number', exclusiveMinimum: 0 }], additionalItems: false, minItems: 4, maxItems: 4 },
        poly: { type: 'array', minItems: 3, items: { type: 'array', items: [{ type: 'number' }, { type: 'number' }], additionalItems: false } },
        tags: { type: 'object', propertyNames: { minLength: 1 }, additionalProperties: { type: 'string', format: 'uri' } },
      },
      required: ['rect'],
    };
    const a = apiSchema(s, 'anthropic');
    expect(a.$schema).toBeUndefined();
    expect((a.properties as Record<string, Json>).rect).toEqual({ description: 'Rectangle [x, y, width, height] (exactly 4 numbers)', type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 });
    expect(((a.properties as Record<string, Json>).poly!.items as Json).items).toEqual({ type: 'number' });
    expect((a.properties as Record<string, Json>).tags!.propertyNames).toBeDefined();
    const o = apiSchema(s, 'openai');
    expect(JSON.stringify(o)).not.toMatch(/propertyNames|format|additionalItems|\$schema/);
    expect(o.required).toEqual(['rect']);
    const tools = [{ name: 'a', description: 'A', inputSchema: s }, { name: 'b', inputSchema: { type: 'object' } }];
    expect(anthropicTools(tools, { eager: true, cache: true }).map((t) => [t.name, Boolean(t.cache_control), t.eager_input_streaming])).toEqual([['a', false, true], ['b', true, true]]);
    expect(openAiTools(tools)[1]).toEqual({ type: 'function', function: { name: 'b', description: '', parameters: { type: 'object', properties: {} } } });
  });

  it('knows what each Claude model takes', () => {
    expect(claudeFeatures('claude-opus-5-5')).toEqual({ version: 5.5, thinking: 'adaptive', effort: true, fallbacks: true });
    expect(claudeFeatures('claude-sonnet-5-5')).toMatchObject({ thinking: 'adaptive', fallbacks: true });
    expect(claudeFeatures('claude-haiku-5-5')).toMatchObject({ thinking: 'adaptive', effort: true, fallbacks: false });
    expect(claudeFeatures('claude-haiku-4-5-20251001')).toMatchObject({ version: 4.5, thinking: 'none', effort: false, fallbacks: false });
    expect(claudeFeatures('claude-fable-5-1')).toMatchObject({ thinking: 'omit', fallbacks: true });
    expect(claudeFeatures('claude-opus-4-20250514')).toMatchObject({ version: 4 });
    expect(offeredClaude('claude-opus-4-8')).toBe(true);
    expect(offeredClaude('claude-3-7-sonnet-20250219')).toBe(false);
  });

  it('passes back only what counts after a refusal fallback', () => {
    const { content, turn } = finishReply({
      id: 'm',
      model: 'claude-opus-4-8',
      stop: 'tool_use',
      usage: noUsage(),
      partial: new Map([
        [2, '{"x":1}'],
        [5, '{"y":2}'],
      ]),
      blocks: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'text', text: 'Part one. ' },
        { type: 'tool_use', id: 'before', name: 'delete', input: {} },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'Part two.' },
        { type: 'tool_use', id: 'after', name: 'add_room', input: {} },
      ],
    });
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'tool_use']);
    expect(turn.calls.map((c) => [c.id, c.input])).toEqual([['after', { y: 2 }]]);
    expect(turn.text).toBe('Part one. Part two.');
  });

  it('filters and orders OpenAI’s models', () => {
    expect(['gpt-5', 'gpt-4o-audio-preview', 'o1-preview', 'o4-mini', 'gpt-oss-120b', 'codex-mini-latest', 'gpt-4o-search-preview'].filter(openAiChatModel)).toEqual(['gpt-5', 'o4-mini']);
    expect(sortOpenAiModels(['gpt-4o', 'gpt-5-mini', 'gpt-4.1-2025-04-14', 'gpt-5'])).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4.1-2025-04-14']);
  });

  it('checks keys without echoing them', () => {
    expect(checkKey('anthropic', ANTHROPIC_KEY)).toEqual({ key: ANTHROPIC_KEY });
    expect(checkKey('anthropic', ` ${ANTHROPIC_KEY}\n`)).toEqual({ key: ANTHROPIC_KEY });
    for (const bad of ['', 'sk-ant-short', 'sk-ant-admin01-0000000000000000000000', 'sk-ant-with space 00000000000000000', OPENAI_KEY]) {
      const r = checkKey('anthropic', bad);
      expect('error' in r, bad).toBe(true);
      if ('error' in r && bad.length > 6) expect(r.error).not.toContain(bad.trim());
    }
    expect('error' in checkKey('openai', ANTHROPIC_KEY.replace('sk-ant-', 'xx-'))).toBe(true);
  });

  it('seals keys through the app over IPC (Electron safeStorage), and keeps them as they are without an app', async () => {
    // the server's box talking to the app's handler (apps/desktop/src/vault.ts) over a fake IPC channel
    const listeners = new Set<(m: unknown) => void>();
    const safe = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`dpapi(${s})`), decryptString: (b: Buffer) => b.toString().slice(6, -1) };
    const channel = {
      connected: true,
      send: (m: unknown) => {
        const reply = vaultReply(m, safe);
        if (reply) setImmediate(() => listeners.forEach((l) => l(reply)));
        return true;
      },
      on: (_e: 'message', fn: (m: unknown) => void) => listeners.add(fn),
      off: (_e: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
    };
    const box = ipcSecretBox(channel);
    expect(await box.available()).toBe(true);
    const sealed = await box.seal(ANTHROPIC_KEY);
    expect(sealed).not.toContain(ANTHROPIC_KEY);
    expect(await box.open(sealed)).toBe(ANTHROPIC_KEY);
    expect(listeners.size).toBe(0);
    // no app on the other end: not available, so the KeyStore keeps the key in its user-only file
    const lonely = ipcSecretBox({ on: () => {}, off: () => {} }, 50);
    expect(await lonely.available()).toBe(false);
    // the app without encryption
    expect(vaultReply({ type: 'vault', id: 'x', op: 'seal', data: 'k' }, { ...safe, isEncryptionAvailable: () => false })).toMatchObject({ ok: false });
    expect(vaultReply({ type: 'other' }, safe)).toBeNull();
  });
});
