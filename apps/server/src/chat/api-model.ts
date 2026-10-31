// What the desktop app's cloud chat backends have in common (chat/anthropic.ts,
// chat/openai.ts): one model request at a time as a provider-neutral turn,
// tool results going back, the errors in plain words, and the one place their
// HTTP requests are made. Requests go only to the provider's fixed address
// (ANTHROPIC_API, OPENAI_API); a different base is a constructor option that
// only tests pass, never settings or the environment. Redirects are refused,
// so a key header can't follow one to another host.
import type { Json, McpToolInfo } from './local-agent.ts';

export interface Usage {
  /** Every input token, cached ones included. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const noUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export interface ApiToolCall {
  id: string;
  name: string;
  /** The parsed arguments; null when they weren't valid JSON (raw has what came). */
  input: Json | null;
  raw: string;
}

export type TurnStop = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'context' | 'other';

export interface ApiTurn {
  id: string;
  model: string;
  /** The visible text of this reply. */
  text: string;
  calls: ApiToolCall[];
  stop: TurnStop;
  usage: Usage;
}

export interface Picture {
  data: string;
  mimeType: string;
}

export interface ToolOutcome {
  id: string;
  name: string;
  text: string;
  isError: boolean;
  pictures: Picture[];
}

/** What streams in while a reply is written (fed to the chat panel). */
export interface StreamSink {
  start(id: string, model: string): void;
  text(delta: string): void;
  toolStart(index: number, id: string, name: string): void;
  toolInput(index: number, partial: string): void;
}

/** One conversation with the model: a request per turn, the tool results appended after it. */
export interface ApiConversation {
  next(signal: AbortSignal, sink: StreamSink): Promise<ApiTurn>;
  results(outcomes: ToolOutcome[]): void;
}

export interface ModelChoice {
  id: string;
  name: string;
}

export interface ConversationInput {
  key: string;
  model: string;
  system: string;
  tools: readonly McpToolInfo[];
  /** Earlier requests and answers of this chat, as plain text. */
  history: readonly { request: string; answer: string }[];
  /** The context block and the new message. */
  user: string;
}

export interface ApiProvider {
  readonly id: 'anthropic' | 'openai';
  /** "Anthropic", "OpenAI": for messages. */
  readonly label: string;
  /** The models this key may use, for the settings (throws ApiError). */
  models(key: string, signal?: AbortSignal): Promise<ModelChoice[]>;
  conversation(input: ConversationInput): ApiConversation;
}

// ---------- errors ----------

export type ApiErrorKind = 'auth' | 'credit' | 'permission' | 'model' | 'rate' | 'overloaded' | 'server' | 'network' | 'timeout' | 'too_large' | 'bad_request' | 'beta' | 'images' | 'stream';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(kind: ApiErrorKind, message: string, status = 0, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable(): boolean {
    return this.kind === 'rate' || this.kind === 'overloaded' || this.kind === 'server';
  }
}

/** A network failure (fetch's TypeError and its cause) in words, as an ApiError. */
export function networkError(e: unknown, host: string): ApiError {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new ApiError('timeout', `${host} took too long to answer`);
  const code = err?.cause?.code ?? '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new ApiError('network', `couldn’t find ${host}: is this computer online?`);
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR/.test(code)) return new ApiError('network', `couldn’t reach ${host}: is this computer online?`);
  return new ApiError('network', `couldn’t reach ${host} (${err?.cause?.message ?? err?.message ?? 'network error'}): is this computer online?`);
}

/** retry-after in milliseconds (seconds or an HTTP date), capped. */
export function retryAfter(h: string | null, capMs = 30_000): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, capMs) : undefined;
}

/** Waits, or rejects as soon as the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * One HTTP request to a provider: fetch with redirects refused, the response
 * checked, retried (up to `retries` times, with a growing pause or the
 * server's retry-after) when the error is a rate limit, an overload or a
 * server error. `fail` turns an error response into an ApiError.
 */
export async function apiFetch(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  o: { host: string; fail: (res: Response, body: string) => ApiError; retries?: number; pauseMs?: number },
): Promise<Response> {
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'error' });
    } catch (e) {
      if (init.signal.aborted) throw e;
      throw networkError(e, o.host);
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    const err = o.fail(res, body);
    if (!err.retryable || attempt >= retries) throw err;
    await sleep(err.retryAfterMs ?? (o.pauseMs ?? 2000) * 3 ** attempt, init.signal);
  }
}

/** The "message" of an API error body ({error: {message}} or {error: "..."}), short. */
export function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j.error;
    const m = typeof e === 'string' ? e : e && typeof e === 'object' ? (e as Json).message : j.message;
    if (typeof m === 'string' && m.trim()) return scrubKeys(m.trim()).slice(0, 300);
  } catch {
    // not JSON
  }
  return scrubKeys(body.trim()).slice(0, 200);
}

/** API keys (even masked ones, as OpenAI's errors quote them) never reach the panel or a log. */
export function scrubKeys(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_*.-]{6,}/g, '[key]');
}

/** A short, honest description of what the reply's tokens were, for the panel. */
export function usageLine(u: Usage): string {
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cached = u.cacheRead ? ` (${k(u.cacheRead)} cached)` : '';
  return `${k(u.input)} tokens in${cached}, ${k(u.output)} out`;
}
