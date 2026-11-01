// Claude through the user's own Anthropic API key: the desktop app's
// "Claude (your Anthropic API key)" chat backend. Plain fetch to the Messages
// API (no SDK in the project, and none is added), streamed:
// - API version 2026-10-21 (no sampling parameters on any request);
// - the full Quillwarren tool set (api-tools.ts), with eager input streaming, and
//   the tool inputs parsed strictly here (the MCP server validates them again);
// - prompt caching: a breakpoint on the last tool and on the system prompt
//   (tools + system are one stable prefix), and one on the newest message, so
//   each turn of a reply reads the turns before it from the cache;
// - adaptive thinking with effort "medium" on the models that take them, and
//   the thinking blocks passed back unchanged within a reply (history is
//   append-only; earlier replies go back as plain text, without them);
// - server-side refusal fallbacks ("fallbacks": "default", beta
//   server-side-fallback-2026-07-01) on the models that have them, dropped for
//   the rest of the run if the account refuses the beta;
// - the models endpoint for the settings' choice of models.
// Default model claude-opus-5-5, with claude-sonnet-5-5 and claude-haiku-5-5
// as the cheaper choices until the key has been checked.
import { anthropicTools } from './api-tools.ts';
import {
  ApiError,
  apiFetch,
  errorMessage,
  noUsage,
  retryAfter,
  type ApiConversation,
  type ApiProvider,
  type ApiToolCall,
  type ApiTurn,
  type ConversationInput,
  type ModelChoice,
  type StreamSink,
  type ToolOutcome,
  type TurnStop,
  type Usage,
} from './api-model.ts';
import type { Json } from './local-agent.ts';
import { sseEvents } from './sse.ts';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
/** Offered before the key has been checked (the models endpoint replaces them). */
export const CLAUDE_CHOICES: ModelChoice[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (cheaper)' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (cheapest)' },
];
const MAX_TOKENS = 64_000;

/** What a Claude model takes, from its id. */
export function claudeFeatures(model: string): { version: number; thinking: 'adaptive' | 'omit' | 'none'; effort: boolean; fallbacks: boolean } {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=$|-)/.exec(model);
  if (!m) return { version: 0, thinking: 'none', effort: false, fallbacks: false };
  const family = m[1]!;
  const version = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  const always = family === 'fable' || family === 'mythos'; // thinking is always on: the parameter is left out
  const adaptive = always || (family === 'haiku' ? version >= 5 : version >= 4.6);
  return {
    version,
    thinking: always ? 'omit' : adaptive ? 'adaptive' : 'none',
    effort: adaptive,
    fallbacks: family === 'fable' || (family === 'opus' && version >= 5) || (family === 'sonnet' && version >= 5.5),
  };
}

/** A model worth offering: Claude 4.5 and later (all take 64k output tokens and tools). */
export function offeredClaude(id: string): boolean {
  const f = claudeFeatures(id);
  return f.version >= 4.5 || /^claude-(fable|mythos)-/.test(id);
}

/** An error response in words (no key in it). */
export function anthropicError(res: Response, body: string): ApiError {
  const msg = errorMessage(body);
  const s = res.status;
  if (s === 401) return new ApiError('auth', 'Anthropic refused the API key: it may be wrong, revoked or deleted. Check it in the chat settings.', s);
  if (s === 402 || /credit balance|billing/i.test(msg)) return new ApiError('credit', 'Your Anthropic account has no credit left. Add credit in the Anthropic Console (Billing), then try again.', s);
  if (s === 403) return new ApiError('permission', `Anthropic doesn’t allow this key to do that: ${msg}`, s);
  if (s === 404) return new ApiError('model', `Anthropic doesn’t offer that to this key (${msg}). Choose another model in the chat settings.`, s);
  if (s === 413) return new ApiError('too_large', 'The request was too big for Anthropic. Start a new conversation, or ask for a smaller part of the map.', s);
  if (s === 429) return new ApiError('rate', 'Anthropic’s rate limit for this key was reached. Wait a minute, then try again.', s, retryAfter(res.headers.get('retry-after')));
  if (s === 529) return new ApiError('overloaded', 'Anthropic is overloaded right now. Try again in a minute, or choose a smaller model.', s, retryAfter(res.headers.get('retry-after')));
  if (s >= 500) return new ApiError('server', `Anthropic had a problem (HTTP ${s}). Try again in a moment.`, s, retryAfter(res.headers.get('retry-after')));
  if (s === 400 && /anthropic-beta|fallbacks/i.test(msg)) return new ApiError('beta', `Anthropic refused the refusal-fallback option: ${msg}`, s);
  return new ApiError('bad_request', `Anthropic refused the request: ${msg}`, s);
}

type Block = Json & { type: string };

/** The content blocks of one streamed reply, as they arrive. */
interface Building {
  id: string;
  model: string;
  blocks: Block[];
  partial: Map<number, string>;
  stop: string;
  usage: Usage;
}

function usageOf(u: Json | undefined, into: Usage): void {
  if (!u) return;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const input = n(u.input_tokens), write = n(u.cache_creation_input_tokens), read = n(u.cache_read_input_tokens), out = n(u.output_tokens);
  if (input !== undefined || write !== undefined || read !== undefined) {
    into.cacheWrite = write ?? into.cacheWrite;
    into.cacheRead = read ?? into.cacheRead;
    into.input = (input ?? 0) + into.cacheWrite + into.cacheRead;
  }
  if (out !== undefined) into.output = out;
}

const STOPS: Record<string, TurnStop> = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', model_context_window_exceeded: 'context', pause_turn: 'end' };

/**
 * The reply as history and as a turn. After a refusal fallback, the declined
 * model's thinking and tool calls before the last "fallback" block are left
 * out (only its text stays), and the block itself is dropped.
 */
export function finishReply(b: Building): { content: Block[]; turn: ApiTurn } {
  const lastFallback = b.blocks.map((x) => x.type).lastIndexOf('fallback');
  const content: Block[] = [];
  const calls: ApiToolCall[] = [];
  let text = '';
  b.blocks.forEach((blk, i) => {
    if (!blk) return;
    if (blk.type === 'fallback') return;
    if (i < lastFallback && blk.type !== 'text') return;
    if (blk.type === 'text') text += String(blk.text ?? '');
    if (blk.type === 'tool_use') {
      const raw = b.partial.get(i) ?? '';
      let input: Json | null = {};
      if (raw.trim()) {
        try {
          const v = JSON.parse(raw) as unknown;
          input = v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
        } catch {
          input = null;
        }
      } else if (blk.input && typeof blk.input === 'object') input = blk.input as Json;
      calls.push({ id: String(blk.id), name: String(blk.name), input, raw });
      content.push({ type: 'tool_use', id: blk.id, name: blk.name, input: input ?? {} });
      return;
    }
    content.push(blk);
  });
  return { content, turn: { id: b.id, model: b.model, text, calls, stop: STOPS[b.stop] ?? (calls.length ? 'tool_use' : 'other'), usage: b.usage } };
}

/** Reads one streamed reply. */
async function readStream(res: Response, sink: StreamSink): Promise<Building> {
  const b: Building = { id: '', model: '', blocks: [], partial: new Map(), stop: '', usage: noUsage() };
  if (!res.body) throw new ApiError('stream', 'Anthropic sent an empty answer');
  for await (const ev of sseEvents(res.body)) {
    let d: Json;
    try {
      d = JSON.parse(ev.data) as Json;
    } catch {
      continue;
    }
    const type = String(d.type ?? ev.event);
    if (type === 'message_start') {
      const m = (d.message ?? {}) as Json;
      b.id = String(m.id ?? '');
      b.model = String(m.model ?? '');
      usageOf(m.usage as Json | undefined, b.usage);
      sink.start(b.id, b.model);
    } else if (type === 'content_block_start') {
      const i = Number(d.index ?? b.blocks.length);
      const blk = { ...((d.content_block ?? {}) as Block) };
      if (blk.type === 'tool_use') {
        b.partial.set(i, '');
        sink.toolStart(i, String(blk.id ?? ''), String(blk.name ?? ''));
      }
      b.blocks[i] = blk;
    } else if (type === 'content_block_delta') {
      const i = Number(d.index ?? -1);
      const blk = b.blocks[i];
      const delta = (d.delta ?? {}) as Json;
      if (!blk) continue;
      if (delta.type === 'text_delta') {
        blk.text = String(blk.text ?? '') + String(delta.text ?? '');
        sink.text(String(delta.text ?? ''));
      } else if (delta.type === 'thinking_delta') blk.thinking = String(blk.thinking ?? '') + String(delta.thinking ?? '');
      else if (delta.type === 'signature_delta') blk.signature = String(delta.signature ?? '');
      else if (delta.type === 'input_json_delta') {
        const part = String(delta.partial_json ?? '');
        b.partial.set(i, (b.partial.get(i) ?? '') + part);
        sink.toolInput(i, part);
      }
    } else if (type === 'message_delta') {
      const delta = (d.delta ?? {}) as Json;
      if (typeof delta.stop_reason === 'string') b.stop = delta.stop_reason;
      usageOf(d.usage as Json | undefined, b.usage);
    } else if (type === 'error') {
      const e = (d.error ?? {}) as Json;
      const kind = e.type === 'overloaded_error' ? 'overloaded' : e.type === 'rate_limit_error' ? 'rate' : 'stream';
      throw new ApiError(kind, kind === 'overloaded' ? 'Anthropic is overloaded right now. Try again in a minute, or choose a smaller model.' : `Anthropic stopped the answer: ${String(e.message ?? e.type ?? 'unknown error')}`);
    }
  }
  return b;
}

export interface AnthropicOptions {
  /** Tests only: a fake server instead of https://api.anthropic.com. Never from settings or the environment. */
  base?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  retries?: number;
  pauseMs?: number;
}

export function anthropicProvider(o: AnthropicOptions = {}): ApiProvider {
  const base = (o.base ?? ANTHROPIC_API).replace(/\/$/, '');
  const host = new URL(base).host;
  const maxOut = new Map<string, number>();
  /** The account refused the fallback beta once: leave it out from then on. */
  let noFallbacks = false;
  const headers = (key: string, beta: boolean): Record<string, string> => ({
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    ...(beta ? { 'anthropic-beta': FALLBACK_BETA } : {}),
  });
  const fetchOpts = { host, fail: anthropicError, ...(o.retries !== undefined ? { retries: o.retries } : {}), ...(o.pauseMs !== undefined ? { pauseMs: o.pauseMs } : {}) };

  return {
    id: 'anthropic',
    label: 'Anthropic',
    async models(key, signal) {
      const out: (ModelChoice & { created: string })[] = [];
      let after = '';
      for (let page = 0; page < 5; page++) {
        const res = await apiFetch(`${base}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: headers(key, false), signal: signal ?? AbortSignal.timeout(15_000) }, { ...fetchOpts, retries: 1 });
        const j = (await res.json()) as { data?: Json[]; has_more?: boolean; last_id?: string };
        for (const m of j.data ?? []) {
          const id = String(m.id ?? '');
          if (!id || !offeredClaude(id)) continue;
          if (typeof m.max_tokens === 'number') maxOut.set(id, m.max_tokens);
          out.push({ id, name: String(m.display_name ?? id), created: String(m.created_at ?? '') });
        }
        if (!j.has_more || !j.last_id) break;
        after = j.last_id;
      }
      const rank = (id: string) => {
        const i = CLAUDE_CHOICES.findIndex((c) => c.id === id);
        return i < 0 ? CLAUDE_CHOICES.length : i;
      };
      out.sort((a, b) => rank(a.id) - rank(b.id) || b.created.localeCompare(a.created));
      return out.map(({ id, name }) => ({ id, name: CLAUDE_CHOICES.find((c) => c.id === id)?.name ?? name }));
    },

    conversation(input: ConversationInput): ApiConversation {
      const messages: { role: 'user' | 'assistant'; content: string | Block[] }[] = [];
      for (const h of input.history) {
        if (!h.request.trim() || !h.answer.trim()) continue;
        messages.push({ role: 'user', content: h.request }, { role: 'assistant', content: h.answer });
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: input.user }] });
      const features = claudeFeatures(input.model);
      const tools = anthropicTools(input.tools, { eager: true, cache: true });
      const system = [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }];

      /** The messages with a cache breakpoint on the newest one's last block. */
      const withBreakpoint = () =>
        messages.map((m, i) => {
          if (i !== messages.length - 1 || typeof m.content === 'string') return m;
          const content = m.content.map((b, j) => (j === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b));
          return { ...m, content };
        });

      return {
        async next(signal, sink) {
          for (;;) {
            const fallbacks = features.fallbacks && !noFallbacks;
            const body = {
              model: input.model,
              max_tokens: Math.min(o.maxTokens ?? MAX_TOKENS, maxOut.get(input.model) ?? MAX_TOKENS),
              stream: true,
              system,
              tools,
              messages: withBreakpoint(),
              ...(features.thinking === 'adaptive' ? { thinking: { type: 'adaptive' } } : {}),
              ...(features.effort ? { output_config: { effort: o.effort ?? 'medium' } } : {}),
              ...(fallbacks ? { fallbacks: 'default' } : {}),
            };
            let res: Response;
            try {
              res = await apiFetch(`${base}/v1/messages`, { method: 'POST', headers: headers(input.key, fallbacks), body: JSON.stringify(body), signal }, fetchOpts);
            } catch (e) {
              if (e instanceof ApiError && e.kind === 'beta' && fallbacks) {
                noFallbacks = true; // the account doesn't have the fallback beta: the same request without it
                continue;
              }
              throw e;
            }
            const built = await readStream(res, sink);
            const { content, turn } = finishReply(built);
            // a refused reply stays out of the history (nothing is run from it, and the run ends)
            if (turn.stop !== 'refusal') messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no answer)' }] });
            return turn;
          }
        },
        results(outcomes: ToolOutcome[]) {
          messages.push({
            role: 'user',
            content: outcomes.map((r) => ({
              type: 'tool_result',
              tool_use_id: r.id,
              content: [{ type: 'text', text: r.text || (r.isError ? 'Error.' : 'Done.') }, ...r.pictures.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }))],
              ...(r.isError ? { is_error: true } : {}),
            })),
          });
        },
      };
    },
  };
}
