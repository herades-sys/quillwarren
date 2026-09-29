// The chat panel's endpoints. A message goes to the chat bridge, which runs
// Claude Code with Delve's MCP tools (through a short-lived chat token), and
// the answer streams back as JSON lines (see events.ts). Only logged-in
// editors (or API token holders) can chat, the same people who can edit.
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ValidationError, type Bounds } from '@delve/core';
import { errorResponse, writeGuard } from '../api.ts';
import type { Sessions } from '../auth.ts';
import type { MapService } from '../service.ts';
import { CHAT_SYSTEM_PROMPT, chatPrompt } from './prompt.ts';
import type { ChatTokens } from './tokens.ts';

export interface ChatConfig {
  /** The chat bridge, e.g. http://127.0.0.1:8792 (DELVE_CHAT_URL). */
  bridgeUrl: string;
  /** This server's port. The bridge's Claude reaches Delve's tools at http://127.0.0.1:<port>/mcp. */
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

export interface ChatDeps {
  service: MapService;
  token: string | undefined;
  sessions: Sessions;
  tokens: ChatTokens;
  config: ChatConfig | undefined;
}

export function registerChat(app: FastifyInstance, { service, token, sessions, tokens, config }: ChatDeps): void {
  const writer = writeGuard(token, sessions);
  const bridge = (path: string) => `${config!.bridgeUrl.replace(/\/$/, '')}${path}`;
  const notSetUp = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'the chat isn\'t set up on this server (DELVE_CHAT_URL is not set)' });

  app.get('/api/v1/chat', { preHandler: writer }, async () => {
    if (!config) return { enabled: false };
    const base = { enabled: true, models: CHAT_MODELS, model: config.model ?? 'sonnet' };
    try {
      const res = await fetch(bridge('/health'), { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { ok?: boolean; claude?: string; error?: string };
      return { ...base, ok: res.ok && body.ok === true, ...(body.claude ? { claude: body.claude } : {}), ...(body.error ? { error: body.error } : {}) };
    } catch {
      return { ...base, ok: false, error: 'the chat bridge isn\'t running (delve-chat.service)' };
    }
  });

  app.post('/api/v1/maps/:id/chat', { preHandler: writer }, async (req, reply) => {
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
          prompt: chatPrompt({ map: current.map, rev: current.rev, selection: r.selection, view: r.view }, r.message),
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
    stream.on('close', done);
    stream.on('error', done);
    return reply.type('application/x-ndjson; charset=utf-8').header('cache-control', 'no-store').send(stream);
  });
}
