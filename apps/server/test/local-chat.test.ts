// The desktop app's chat with a local model (chat/local-chat.ts): the harness's
// events turned into the panel's chat events, and whole messages through
// POST /api/v1/maps/:id/chat against fake model servers (OpenAI-compatible
// like llama-server, and Ollama's own API), including follow-ups, a server
// that is down, and Stop.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { ChatEvent } from '../src/chat/events.ts';
import { friendlyError, LocalTranslator, parseChatSettings, recap, stopText } from '../src/chat/local-chat.ts';
import { localChatBackends } from '../src/chat/local-chat.ts';
import { emptyStats, type AgentRun, type CallRecord } from '../src/chat/local-agent.ts';
import { MapStore } from '../src/store.ts';

const testMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as unknown;

const call = (name: string, ok = true, result = 'Done.'): CallRecord => ({ turn: 1, name, args: { id: 'r1' }, ok, result, ms: 3, source: 'native', repaired: false });
const run = (stop: AgentRun['stop'], extra: Partial<AgentRun> = {}): AgentRun => ({ answer: stop === 'answer' ? 'Done.' : '', lastText: '', stop, stats: { ...emptyStats(), turns: 2, toolCalls: 1, wallMs: 1500 }, calls: [], messages: [], ...extra });

describe('LocalTranslator', () => {
  it('writes a run as the panel’s events: start, text, tool calls with results, done', () => {
    const t = new LocalTranslator();
    const out: ChatEvent[] = [
      ...t.start('11111111-1111-4111-8111-111111111111', 'qwen3:8b'),
      ...t.reply('Adding a guard room.'),
      ...t.toolStart('add_room', { beside: 'r1', side: 'east' }),
      ...t.call({ ...call('add_room'), result: 'Added room r7.' }),
      ...t.reply(''),
      ...t.reply('Done: room 7 is east of room 1.'),
      ...t.finish(run('answer')),
    ];
    expect(out).toEqual([
      { type: 'start', session: '11111111-1111-4111-8111-111111111111', model: 'qwen3:8b' },
      { type: 'text', text: 'Adding a guard room.' },
      { type: 'tool', id: 'local_2', name: 'add_room', input: { beside: 'r1', side: 'east' } },
      { type: 'tool_done', id: 'local_2', ok: true, text: 'Added room r7.' },
      { type: 'text', text: '\n\nDone: room 7 is east of room 1.' },
      { type: 'done', session: '11111111-1111-4111-8111-111111111111', ok: true, turns: 2, ms: 1500 },
    ]);
  });

  it('shows calls that never reached the tools (an unknown tool, held back) as failed tools', () => {
    const t = new LocalTranslator();
    t.start('s', 'm');
    expect(t.call(call('add_roooom', false, 'There is no tool "add_roooom".'))).toEqual([
      { type: 'tool', id: 'local_1', name: 'add_roooom', input: { id: 'r1' } },
      { type: 'tool_done', id: 'local_1', ok: false, text: 'There is no tool "add_roooom".' },
    ]);
  });

  it('gets the activity card after four tool calls, like Claude without a plan, and finishes it on a good end', () => {
    const t = new LocalTranslator();
    t.start('s', 'm');
    const out: ChatEvent[] = [];
    for (const name of ['add_room', 'add_room', 'add_door', 'add_prop']) {
      out.push(...t.toolStart(name, {}), ...t.call(call(name)));
    }
    const plans = out.filter((e) => e.type === 'plan');
    expect(plans.at(-1)).toEqual({
      type: 'plan',
      mode: 'activity',
      steps: [
        { title: 'Building rooms and corridors', status: 'done' },
        { title: 'Adding doors and stairs', status: 'done' },
        { title: 'Placing props', status: 'active' },
      ],
    });
    const end = t.finish(run('answer'));
    expect(end[0]).toMatchObject({ type: 'plan', mode: 'activity', steps: [{ status: 'done' }, { status: 'done' }, { status: 'done' }] });
    expect(end[1]).toMatchObject({ type: 'done', ok: true });
  });

  it('ends a run that stopped short with the reason, in words', () => {
    const t = new LocalTranslator();
    t.start('s', 'm');
    expect(t.finish(run('model_error', { error: 'connect ECONNREFUSED 127.0.0.1:11434' }))).toEqual([
      { type: 'done', session: 's', ok: false, turns: 2, ms: 1500, error: 'The local model failed: nothing answers at the server address. Is the model server (Ollama, llama-server) running?' },
    ]);
    expect(stopText(run('turns'))).toMatch(/stopped after 2 replies.*kept/);
    expect(stopText(run('time'), { timeLimitMs: 900_000 })).toMatch(/longer than 15 minutes/);
    expect(stopText(run('errors'))).toMatch(/8 tool calls in a row failed/);
    expect(friendlyError('getaddrinfo ENOTFOUND nope')).toMatch(/could not be found/);
  });
});

describe('chat settings and follow-ups', () => {
  const before = { backend: 'none' as const, local: { source: 'server' as const, url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } };

  it('checks the backend and the local model’s address and name', () => {
    expect(parseChatSettings({ backend: 'local' }, ['none', 'local'], before)).toEqual({ backend: 'local', local: before.local });
    expect(() => parseChatSettings({ backend: 'claude' }, ['none', 'local'], before)).toThrow(/backend/);
    expect(() => parseChatSettings({ backend: 'local', local: { url: 'ftp://x', model: 'a' } }, ['none', 'local'], before)).toThrow(/http/);
    expect(() => parseChatSettings({ backend: 'local', local: { url: 'http://user:pw@host/v1', model: 'a' } }, ['none', 'local'], before)).toThrow(/password/);
    expect(() => parseChatSettings({ backend: 'local', local: { model: '' } }, ['none', 'local'], before)).toThrow(/model/);
    // switched off, a half-typed address may stay
    expect(parseChatSettings({ backend: 'none', local: { url: 'nonsense', model: '' } }, ['none', 'local'], before).backend).toBe('none');
    expect(parseChatSettings({ backend: 'local', local: { source: 'builtin' } }, ['none', 'local'], before).local.source).toBe('builtin');
  });

  it('reminds the model of the conversation so far, briefly', () => {
    expect(recap([], 'Hi')).toBe('Hi');
    const r = recap([{ request: 'Add a room east of room 1', answer: 'Added room 7.' }, { request: 'x'.repeat(500), answer: 'ok' }], 'Now give it a door');
    expect(r).toContain('Earlier in this conversation:');
    expect(r).toContain('"Add a room east of room 1" You answered: "Added room 7."');
    expect(r).toContain('…');
    expect(r.endsWith('The user\'s new message:\nNow give it a door')).toBe(true);
  });
});

// ---------- whole messages against fake model servers ----------

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;

async function fakeServer(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      } catch {
        // not JSON
      }
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function chatApp(): FastifyInstance {
  const store = new MapStore(':memory:');
  store.create(testMap, 'test');
  const app = buildApp({ version: 'test', started: 'now' }, { store, openEdit: true, chatBackends: (ctx) => localChatBackends(ctx, { timeLimitMs: 60_000 }) });
  app.addHook('onClose', async () => store.close());
  return app;
}

const events = (body: string): ChatEvent[] =>
  body
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChatEvent);

const servers: Server[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function useLocal(app: FastifyInstance, url: string, model: string) {
  const res = await app.inject({ method: 'PUT', url: '/api/v1/chat/settings', payload: { backend: 'local', local: { url, model } } });
  expect(res.statusCode).toBe(200);
}

const send = (app: FastifyInstance, message: string, session?: string) =>
  app.inject({ method: 'POST', url: '/api/v1/maps/map_test4p/chat', payload: { message, selection: [], ...(session ? { session } : {}) } });

describe('the local model through the chat endpoint', () => {
  it('runs an OpenAI-compatible server’s tool calls on the map and streams the reply (llama-server, LM Studio)', async () => {
    const seen: Record<string, unknown>[] = [];
    const fake = await fakeServer((req, body, res) => {
      if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'fake-8b' }] });
      if (req.url !== '/v1/chat/completions') return json(res, 404, { error: 'no' });
      seen.push(body);
      const msgs = body.messages as { role: string; content: string }[];
      if (msgs.length === 2) {
        // the start of a run (the request, or the follow-up): one room each; after that (tool results, the final check) the answer
        const name = msgs[1]!.content.includes('armoury') ? 'Armoury' : 'Guard room';
        return json(res, 200, { choices: [{ message: { content: '', tool_calls: [{ id: `c${seen.length}`, type: 'function', function: { name: 'add_room', arguments: JSON.stringify({ beside: 'r4', side: 'south', size: [4, 4], name }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 20 } });
      }
      return json(res, 200, { choices: [{ message: { content: 'Added it.' }, finish_reason: 'stop' }] });
    });
    servers.push(fake.server);
    const app = chatApp();
    apps.push(app);
    await useLocal(app, `${fake.url}/v1`, 'fake-8b');

    const status = (await app.inject({ method: 'GET', url: '/api/v1/chat' })).json();
    expect(status).toEqual({ enabled: true, backend: 'local', backends: ['none', 'local'], name: 'Assistant', ok: true, model: 'fake-8b' });

    const res = await send(app, 'Add a 4×4 guard room south of room 4');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const evs = events(res.body);
    const start = evs[0] as Extract<ChatEvent, { type: 'start' }>;
    expect(start).toMatchObject({ type: 'start', model: 'fake-8b' });
    expect(evs.filter((e) => e.type === 'tool')).toEqual([{ type: 'tool', id: 'local_1', name: 'add_room', input: expect.objectContaining({ beside: 'r4', name: 'Guard room', map: 'map_test4p' }) }]);
    expect(evs.find((e) => e.type === 'tool_done')).toMatchObject({ ok: true });
    expect(evs.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toContain('Added it.');
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true, session: start.session });
    const map = (await app.inject({ method: 'GET', url: '/api/v1/maps/map_test4p' })).json() as { map: { objects: { type: string; name?: string }[] } };
    expect(map.map.objects.some((o) => o.type === 'room' && o.name === 'Guard room')).toBe(true);

    // what the model got: the lean setup (short prompt, the 17 tools, the map id filled in by the harness)
    const first = seen[0]!;
    expect(first.model).toBe('fake-8b');
    const tools = (first.tools as { function: { name: string; parameters: { properties: Record<string, unknown> } } }[]).map((t) => t.function);
    expect(tools.map((t) => t.name)).toContain('add_room');
    expect(tools.map((t) => t.name)).not.toContain('create_prop');
    expect(tools.find((t) => t.name === 'add_room')!.parameters.properties).not.toHaveProperty('map');
    const msgs = first.messages as { role: string; content: string }[];
    expect(msgs[1]!.content).toContain('Next new ids'); // LEAN_STEPS ids
    expect(msgs[1]!.content).toContain('Add a 4×4 guard room south of room 4');

    // a follow-up in the same conversation remembers the first message
    const again = events((await send(app, 'Now an armoury the same size', start.session)).body);
    expect(again.at(-1)).toMatchObject({ type: 'done', ok: true, session: start.session });
    const starts = seen.map((b) => b.messages as { role: string; content: string }[]).filter((m) => m.length === 2);
    expect(starts).toHaveLength(2);
    const follow = starts[1]![1]!.content;
    expect(follow).toContain('Earlier in this conversation');
    expect(follow).toContain('Add a 4×4 guard room south of room 4');
  });

  it('speaks Ollama’s own API to an Ollama server, with the context size set', async () => {
    const seen: Record<string, unknown>[] = [];
    const fake = await fakeServer((req, body, res) => {
      if (req.url === '/api/version') return json(res, 200, { version: '0.12.6' });
      if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] });
      if (req.url !== '/api/chat') return json(res, 404, { error: 'no' });
      seen.push(body);
      if (seen.length === 1) return json(res, 200, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'update', arguments: { id: 'r1', set: { name: 'Gatehouse' } } } }] }, done_reason: 'stop', eval_count: 10 });
      return json(res, 200, { message: { role: 'assistant', content: 'Renamed room 1.' }, done_reason: 'stop' });
    });
    servers.push(fake.server);
    const app = chatApp();
    apps.push(app);
    await useLocal(app, `${fake.url}/v1`, 'qwen3:8b');
    const test = (await app.inject({ method: 'POST', url: '/api/v1/chat/settings/test', payload: { url: `${fake.url}/v1`, model: 'qwen3:14b' } })).json();
    expect(test).toEqual({ ok: true, api: 'ollama', models: ['qwen3:8b', 'llama3.2:3b'], hasModel: false });

    const evs = events((await send(app, 'Call room 1 the Gatehouse')).body);
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true });
    expect(seen[0]).toMatchObject({ model: 'qwen3:8b', options: { num_ctx: 16384 } });
    const map = (await app.inject({ method: 'GET', url: '/api/v1/maps/map_test4p' })).json() as { map: { objects: { id: string; name?: string }[] } };
    expect(map.map.objects.find((o) => o.id === 'r1')!.name).toBe('Gatehouse');
  });

  it('says so when the model server is down', async () => {
    const app = chatApp();
    apps.push(app);
    await useLocal(app, 'http://127.0.0.1:9/v1', 'qwen3:8b');
    const status = (await app.inject({ method: 'GET', url: '/api/v1/chat' })).json();
    expect(status).toMatchObject({ enabled: true, ok: false });
    const evs = events((await send(app, 'Add a room')).body);
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: false });
    expect((evs.at(-1) as { error: string }).error).toMatch(/nothing answers at the server address/);
  });

  it('stops the model’s request when the browser presses Stop', async () => {
    let closed: () => void = () => {};
    const gone = new Promise<void>((r) => (closed = r));
    const fake = await fakeServer((req, _body, res) => {
      if (req.url === '/v1/chat/completions') {
        res.on('close', () => closed()); // never answers; the chat must hang up
        return;
      }
      json(res, 404, {});
    });
    servers.push(fake.server);
    const app = chatApp();
    apps.push(app);
    await useLocal(app, `${fake.url}/v1`, 'slow');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/maps/map_test4p/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Add a room' }), signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"start"');
    abort.abort();
    await expect(Promise.race([gone.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still open'), 3000))])).resolves.toBe('closed');
  });
});
