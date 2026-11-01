// The chat panel's endpoints. A message goes to the chat bridge, which runs
// Claude Code with Quillwarren's MCP tools (through a short-lived chat token), and
// the answer streams back as JSON lines (see events.ts). Only logged-in
// editors (or API token holders) can chat, the same people who can edit.
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError, type Bounds } from '@delve/core';
import { errorResponse, writeGuard } from '../api.ts';
import type { Sessions } from '../auth.ts';
import type { MapService } from '../service.ts';
import { levelsOf } from '../levels.ts';
import type { ChatEvent } from './events.ts';
import { CHAT_SYSTEM_PROMPT, chatPrompt } from './prompt.ts';
import type { ChatTokens } from './tokens.ts';

/** How often an idle chat stream gets a keep-alive newline (proxies cut silent responses, Cloudflare after 100 s). */
export const HEARTBEAT_MS = 15_000;

export interface ChatConfig {
  /** The chat bridge, e.g. http://127.0.0.1:8792 (DELVE_CHAT_URL). */
  bridgeUrl: string;
  /** This server's port. The bridge's Claude reaches Quillwarren's tools at http://127.0.0.1:<port>/mcp. */
  port: number;
  /** Default model alias (DELVE_CHAT_MODEL); the panel can pick another from CHAT_MODELS. */
  model?: string;
}

export const CHAT_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChatRequest {
  message: string;
  session?: string;
  selection: string[];
  view?: Bounds;
  model?: ChatModel;
}

export function parseChatRequest(body: unknown): ChatRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) problems.push('message: write something');
  else if (message.length > 8000) problems.push('message: keep it under 8000 characters');
  if (b.session !== undefined && b.session !== null && (typeof b.session !== 'string' || !UUID.test(b.session))) problems.push('session: not a chat session id');
  const selection = Array.isArray(b.selection) ? b.selection.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
  let view: Bounds | undefined;
  if (b.view !== undefined && b.view !== null) {
    const v = b.view as Record<string, unknown>;
    const nums = [v.x0, v.y0, v.x1, v.y1];
    if (nums.every((x) => typeof x === 'number' && Number.isFinite(x))) view = { x0: v.x0 as number, y0: v.y0 as number, x1: v.x1 as number, y1: v.y1 as number };
    else problems.push('view: needs x0, y0, x1, y1');
  }
  if (b.model !== undefined && b.model !== null && !CHAT_MODELS.includes(b.model as ChatModel)) problems.push(`model: one of ${CHAT_MODELS.join(', ')}`);
  if (problems.length) throw new ValidationError(problems);
  return {
    message,
    ...(typeof b.session === 'string' ? { session: b.session } : {}),
    selection,
    ...(view ? { view } : {}),
    ...(typeof b.model === 'string' ? { model: b.model as ChatModel } : {}),
  };
}

/**
 * The ways a chat message can be answered: the Claude Code bridge (above), a
 * local model, the user's own Anthropic or OpenAI API key (the desktop app
 * only: chat/api-chat.ts), or not at all.
 */
export const CHAT_BACKENDS = ['none', 'claude', 'local', 'anthropic', 'openai'] as const;
export type ChatBackendName = (typeof CHAT_BACKENDS)[number];

/** One message for the local model (chat/local-chat.ts answers it). */
export interface LocalChatRun {
  mapId: string;
  request: ChatRequest;
  /** The address the browser used, so links the tools hand out work there. */
  base: string;
  send(ev: ChatEvent): void;
  /** Aborted when the browser leaves or presses Stop. */
  signal: AbortSignal;
}

/**
 * More chat backends than the bridge, picked in the chat settings. The web
 * server never sets this: its chat is the bridge alone, exactly as before.
 * The desktop app does (desktop/main.ts with chat/local-chat.ts), offering
 * none and local. The editor shows its chat settings only when two or more
 * backends are offered.
 */
export interface ChatBackends {
  offered: readonly ChatBackendName[];
  /** The backend in use now. */
  current(): ChatBackendName;
  /** What the panel calls the assistant when it isn't Claude ("Assistant"). */
  name: string;
  /** GET /api/v1/chat with any backend but none and claude: whether the model can answer ({ ok, error?, model }). */
  localStatus(): Promise<Record<string, unknown>>;
  /** GET /api/v1/chat/settings */
  settings(): Record<string, unknown>;
  /** PUT /api/v1/chat/settings: checks and keeps them; throws ValidationError. */
  saveSettings(body: unknown): Promise<Record<string, unknown>>;
  /** POST /api/v1/chat/settings/test: does a model server answer at this address, and with which models. */
  test(body: unknown): Promise<Record<string, unknown>>;
  /** Answer one message with the backend in use (a local model, or an API key's), as chat events. */
  runLocal(run: LocalChatRun): Promise<void>;
}

export interface ChatDeps {
  service: MapService;
  token: string | undefined;
  sessions: Sessions;
  tokens: ChatTokens;
  config: ChatConfig | undefined;
  /** Desktop only; see ChatBackends. */
  backends?: ChatBackends | undefined;
}

export function registerChat(app: FastifyInstance, { service, token, sessions, tokens, config, backends }: ChatDeps): void {
  const writer = writeGuard(token, sessions);
  const bridge = (path: string) => `${config!.bridgeUrl.replace(/\/$/, '')}${path}`;
  const notSetUp = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'the chat isn\'t set up on this server (DELVE_CHAT_URL is not set)' });
  if (backends) registerBackends(app, writer, backends);

  app.get('/api/v1/chat', { preHandler: writer }, async () => {
    if (backends && backends.current() !== 'claude') {
      const backend = backends.current();
      const head = { enabled: backend !== 'none', backend, backends: backends.offered, name: backends.name };
      return backend !== 'none' ? { ...head, ...(await backends.localStatus()) } : { ...head, ok: false };
    }
    if (!config) return { enabled: false };
    const base = { enabled: true, models: CHAT_MODELS, model: config.model ?? 'sonnet', ...(backends ? { backend: 'claude', backends: backends.offered, name: 'Claude' } : {}) };
    try {
      const res = await fetch(bridge('/health'), { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { ok?: boolean; claude?: string; error?: string };
      return { ...base, ok: res.ok && body.ok === true, ...(body.claude ? { claude: body.claude } : {}), ...(body.error ? { error: body.error } : {}) };
    } catch {
      return { ...base, ok: false, error: 'the chat bridge isn\'t running (delve-chat.service)' };
    }
  });

  app.post('/api/v1/maps/:id/chat', { preHandler: writer }, async (req, reply) => {
    if (backends && backends.current() !== 'claude') return answerLocally(req, reply, service, backends);
    if (!config) return notSetUp(reply);
    const { id } = req.params as { id: string };
    let r: ChatRequest;
    let current: ReturnType<typeof service.store.get>;
    try {
      r = parseChatRequest(req.body);
      current = service.store.get(id);
    } catch (e) {
      const { status, body } = errorResponse(e);
      return reply.code(status).send(body);
    }

    const base = (process.env.DELVE_PUBLIC_URL ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
    const mcpToken = tokens.mint(base);
    const done = () => tokens.revoke(mcpToken);
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort()); // the browser left or pressed Stop: the bridge stops Claude

    let res: Response;
    try {
      res = await fetch(bridge('/run'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: chatPrompt({ map: current.map, rev: current.rev, selection: r.selection, view: r.view, levels: levelsOf(service, id) }, r.message),
          system: CHAT_SYSTEM_PROMPT,
          ...(r.session ? { resume: r.session } : {}),
          model: r.model ?? config.model ?? 'sonnet',
          mcp: { url: `http://127.0.0.1:${config.port}/mcp`, token: mcpToken },
        }),
        signal: abort.signal,
      });
    } catch {
      done();
      return reply.code(502).send({ error: 'the chat bridge isn\'t running (delve-chat.service)' });
    }
    if (!res.ok || !res.body) {
      done();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return reply.code(res.status === 429 ? 429 : 502).send({ error: body.error ?? `the chat bridge answered ${res.status}` });
    }
    const stream = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    // A bare newline every 15 s while Claude works: a proxy cuts a response that
    // sends nothing for a while (Cloudflare after 100 s, while Claude writes one
    // big step), and the page skips empty lines.
    const out = new PassThrough();
    const beat = setInterval(() => out.write('\n'), HEARTBEAT_MS);
    const stop = () => {
      clearInterval(beat);
      done();
    };
    stream.on('close', stop);
    stream.on('error', () => {
      stop();
      out.end();
    });
    stream.pipe(out);
    return reply.type('application/x-ndjson; charset=utf-8').header('cache-control', 'no-store').send(out);
  });
}

// ---------- other backends (desktop only: registerChat gets them only from desktop/main.ts) ----------

type Guard = ReturnType<typeof writeGuard>;

/** The chat settings: shown and changed only where there is a choice (two or more backends). */
function registerBackends(app: FastifyInstance, writer: Guard, backends: ChatBackends): void {
  if (backends.offered.length < 2) return;
  app.get('/api/v1/chat/settings', { preHandler: writer }, async () => backends.settings());
  app.put('/api/v1/chat/settings', { preHandler: writer }, async (req, reply) => {
    try {
      return await backends.saveSettings(req.body);
    } catch (e) {
      const { status, body } = errorResponse(e);
      return reply.code(status).send(body);
    }
  });
  app.post('/api/v1/chat/settings/test', { preHandler: writer }, async (req, reply) => {
    try {
      return await backends.test(req.body);
    } catch (e) {
      const { status, body } = errorResponse(e);
      return reply.code(status).send(body);
    }
  });
}

/** A message for the local model (or for no backend at all), streamed back as chat events like the bridge's. */
async function answerLocally(req: FastifyRequest, reply: FastifyReply, service: MapService, backends: ChatBackends) {
  if (backends.current() === 'none') {
    return reply.code(503).send({ error: `the chat is off: choose ${backends.offered.length > 2 ? 'who answers' : 'a local model'} in the chat settings` });
  }
  const { id } = req.params as { id: string };
  let request: ChatRequest;
  try {
    request = parseChatRequest(req.body);
    service.store.get(id);
  } catch (e) {
    const { status, body } = errorResponse(e);
    return reply.code(status).send(body);
  }
  const base = `${req.protocol}://${req.headers.host}`.replace(/\/$/, '');
  const abort = new AbortController();
  reply.raw.on('close', () => abort.abort()); // the browser left or pressed Stop
  const out = new PassThrough();
  const beat = setInterval(() => out.write('\n'), HEARTBEAT_MS);
  const send = (ev: ChatEvent) => {
    if (!out.writableEnded) out.write(`${JSON.stringify(ev)}\n`);
  };
  void backends
    .runLocal({ mapId: id, request, base, send, signal: abort.signal })
    .catch((e: unknown) => send({ type: 'error', code: 'bridge', error: `${backends.current() === 'local' ? 'The local model' : 'The assistant'} failed: ${(e as Error).message}` }))
    .finally(() => {
      clearInterval(beat);
      out.end();
    });
  return reply.type('application/x-ndjson; charset=utf-8').header('cache-control', 'no-store').send(out);
}
