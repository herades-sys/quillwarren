// A small agent loop that runs Delve's map chat on a local model (Ollama,
// LM Studio, any server with OpenAI-style function calling) instead of Claude.
// It is a test harness (`npm run local-llm`, `npm run llm-bench`) for deciding
// whether a local model is worth integrating; the live chat (bridge.ts) is
// untouched.
//
// The loop: send the system prompt, the context block plus the request, and
// the tools; run each tool call through Delve's MCP; feed the results back
// (trimmed, pictures replaced by a note, because these models read text
// only); repeat until the model answers without a tool call or a limit is hit.
// Small models are sloppy, so it repairs JSON arguments, reads tool calls that
// were written as text, strips <think> blocks (counting them), fixes argument
// types the schema makes obvious, and tells the model about unknown tools.
import http from 'node:http';
import https from 'node:https';

export type Json = Record<string, unknown>;

/** The part of JSON Schema that local tool parsers understand. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Arguments the harness adds to every call (the lean set's map id); not shown to the model. */
  fixed?: Json;
}

/** A tool the harness answers itself, without MCP (the task list the full prompt asks for). */
export interface LocalTool {
  def: ToolDef;
  run(args: Json): string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** A JSON string (OpenAI) or an object (Ollama's own API). */
  arguments: string | Json;
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: { id: string; name: string; args: Json }[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ModelReply {
  content: string;
  /** Thinking the server returned on its own (reasoning, reasoning_content, thinking). */
  reasoning: string;
  toolCalls: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  /** Server-side generation time (Ollama eval_duration, llama.cpp timings.predicted_ms). */
  evalMs?: number;
  promptMs?: number;
  loadMs?: number;
  finish?: string;
}

export interface ModelClient {
  readonly label: string;
  complete(messages: AgentMessage[], tools: ToolDef[], signal?: AbortSignal): Promise<ModelReply>;
}

export class ModelError extends Error {}

// ---------- HTTP ----------

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

/**
 * One request with node:http, not fetch: fetch (undici) gives up on headers
 * after 300 s, and a slow model on a long prompt can take longer than that.
 */
export function requestJson(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpResult> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: opts.method ?? (data ? 'POST' : 'GET'),
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...opts.headers },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new ModelError(`no answer within ${Math.round(opts.timeoutMs! / 1000)} s`)));
    req.end(data);
  });
}

function httpError(r: HttpResult): string {
  const j = r.json as { error?: unknown } | undefined;
  const e = j?.error;
  const msg = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as Json).message === 'string' ? ((e as Json).message as string) : r.text.slice(0, 300);
  return `HTTP ${r.status}: ${msg}`;
}

// ---------- model clients ----------

export interface ClientOptions {
  model: string;
  temperature?: number;
  /** Most tokens per reply (thinking included). */
  maxTokens?: number;
  seed?: number;
  /** Per request; default 10 minutes. */
  timeoutMs?: number;
  /** on/off, or an effort for models that take one (gpt-oss): low, medium, high. Unset: the model's default. */
  think?: 'on' | 'off' | 'low' | 'medium' | 'high';
}

const wireTool = (t: ToolDef) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } });

export function toOpenAiMessage(m: AgentMessage): Json {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
    };
  }
  return { role: m.role, content: m.content };
}

export function parseOpenAiReply(j: unknown): ModelReply {
  const body = (j ?? {}) as Json;
  const choice = ((body.choices as Json[] | undefined) ?? [])[0] ?? {};
  const m = (choice.message ?? {}) as Json;
  const raw = (m.tool_calls as Json[] | undefined) ?? (m.function_call ? [{ function: m.function_call }] : []);
  const toolCalls = raw.map((c, i) => {
    const f = (c.function ?? {}) as Json;
    return { id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, name: String(f.name ?? ''), arguments: (f.arguments as string | Json | undefined) ?? '' };
  });
  const usage = (body.usage ?? {}) as Json;
  const timings = (body.timings ?? {}) as Json; // llama.cpp server and LM Studio
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    content: typeof m.content === 'string' ? m.content : '',
    reasoning: String(m.reasoning_content ?? m.reasoning ?? ''),
    toolCalls,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    evalMs: num(timings.predicted_ms),
    promptMs: num(timings.prompt_ms),
    ...(typeof choice.finish_reason === 'string' ? { finish: choice.finish_reason } : {}),
  };
}

/** Any server with an OpenAI-compatible /chat/completions and tools (LM Studio, llama.cpp, vLLM, Ollama's /v1). */
export function openAiClient(o: ClientOptions & { baseUrl: string; apiKey?: string }): ModelClient {
  const url = `${o.baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    label: `${o.model} via ${url}`,
    async complete(messages, tools, signal) {
      const effort = o.think === 'off' ? 'none' : o.think === 'low' || o.think === 'medium' || o.think === 'high' ? o.think : undefined;
      const body = {
        model: o.model,
        messages: messages.map(toOpenAiMessage),
        ...(tools.length ? { tools: tools.map(wireTool), tool_choice: 'auto' } : {}),
        stream: false,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.seed !== undefined ? { seed: o.seed } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      };
      const r = await requestJson(url, { body, headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, timeoutMs: o.timeoutMs ?? 600_000, ...(signal ? { signal } : {}) });
      const got = r.json as { error?: unknown; choices?: unknown } | undefined;
      if (r.status !== 200 || !got || got.error || !Array.isArray(got.choices)) throw new ModelError(httpError(r));
      return parseOpenAiReply(r.json);
    },
  };
}

export function toOllamaMessage(m: AgentMessage): Json {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
  if (m.role === 'assistant') {
    return { role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}) };
  }
  return { role: m.role, content: m.content };
}

export function parseOllamaReply(j: unknown): ModelReply {
  const body = (j ?? {}) as Json;
  const m = (body.message ?? {}) as Json;
  const toolCalls = ((m.tool_calls as Json[] | undefined) ?? []).map((c, i) => {
    const f = (c.function ?? {}) as Json;
    return { id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, name: String(f.name ?? ''), arguments: (f.arguments as string | Json | undefined) ?? {} };
  });
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v / 1e6 : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    content: typeof m.content === 'string' ? m.content : '',
    reasoning: typeof m.thinking === 'string' ? m.thinking : '',
    toolCalls,
    promptTokens: num(body.prompt_eval_count),
    completionTokens: num(body.eval_count),
    evalMs: ms(body.eval_duration),
    promptMs: ms(body.prompt_eval_duration),
    loadMs: ms(body.load_duration),
    ...(typeof body.done_reason === 'string' ? { finish: body.done_reason } : {}),
  };
}

/**
 * Ollama's own /api/chat. Its OpenAI endpoint can't set the context size and
 * runs every model at 4096 tokens (on an 8 GB card), which silently cuts the
 * front off a long system prompt; here num_ctx is set per request.
 */
export function ollamaClient(o: ClientOptions & { host: string; numCtx?: number; keepAlive?: string }): ModelClient {
  const url = `${o.host.replace(/\/$/, '')}/api/chat`;
  return {
    label: `${o.model} via ${url}${o.numCtx ? ` (num_ctx ${o.numCtx})` : ''}`,
    async complete(messages, tools, signal) {
      const think = o.think === 'on' ? true : o.think === 'off' ? false : o.think;
      const options = {
        ...(o.numCtx ? { num_ctx: o.numCtx } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.maxTokens ? { num_predict: o.maxTokens } : {}),
        ...(o.seed !== undefined ? { seed: o.seed } : {}),
      };
      const body = {
        model: o.model,
        messages: messages.map(toOllamaMessage),
        ...(tools.length ? { tools: tools.map(wireTool) } : {}),
        stream: false,
        ...(think !== undefined ? { think } : {}),
        ...(Object.keys(options).length ? { options } : {}),
        keep_alive: o.keepAlive ?? '15m',
      };
      const r = await requestJson(url, { body, timeoutMs: o.timeoutMs ?? 600_000, ...(signal ? { signal } : {}) });
      if (r.status !== 200 || !r.json) throw new ModelError(httpError(r));
      return parseOllamaReply(r.json);
    },
  };
}

/**
 * Which API to speak for a base URL: an Ollama server (it answers /api/version)
 * gets its own API, so the context size can be set; anything else the OpenAI one.
 */
export async function detectApi(baseUrl: string): Promise<{ api: 'ollama' | 'openai'; host: string; version?: string }> {
  const u = new URL(baseUrl);
  const host = `${u.protocol}//${u.host}`;
  try {
    const r = await requestJson(`${host}/api/version`, { timeoutMs: 5000 });
    const v = (r.json as Json | undefined)?.version;
    if (r.status === 200 && typeof v === 'string') return { api: 'ollama', host, version: v };
  } catch {
    // not Ollama, or not reachable: the OpenAI API will say
  }
  return { api: 'openai', host };
}

// ---------- tool schemas ----------

/**
 * MCP's JSON Schema (draft-07 from zod) cut down to what local tool parsers
 * understand: type, description, enum, properties, required, one items schema.
 * Tuples ([x, y, w, h]) become arrays of one type with the count in the
 * description; unions take their first non-null branch, except number-or-text
 * (lengths with units, "5 m"), which keeps no type; limits are dropped.
 */
export function simplifySchema(s: unknown): JsonSchema {
  if (!s || typeof s !== 'object') return {};
  const x = s as Json;
  for (const k of ['anyOf', 'oneOf'] as const) {
    const branches = x[k];
    if (Array.isArray(branches) && branches.length) {
      // a number or text with a unit ("5 m"): no type at all, so the model may send either and neither counts as repaired
      const kinds = new Set(branches.map((b) => (b as Json)?.type).filter((t) => t !== 'null'));
      if (kinds.size === 2 && kinds.has('string') && (kinds.has('number') || kinds.has('integer'))) return typeof x.description === 'string' ? { description: x.description } : {};
      const branch = (branches.find((b) => (b as Json)?.type !== 'null') ?? branches[0]) as Json;
      return simplifySchema({ ...branch, ...(typeof x.description === 'string' ? { description: x.description } : {}) });
    }
  }
  const out: JsonSchema = {};
  let type = x.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0];
  if (typeof type === 'string') out.type = type;
  if (typeof x.description === 'string') out.description = x.description;
  if (Array.isArray(x.enum)) out.enum = x.enum.filter((v) => v !== null);
  else if (x.const !== undefined) out.enum = [x.const];
  const items = x.items ?? x.prefixItems;
  if (out.type === 'array' || items !== undefined) {
    out.type = 'array';
    if (Array.isArray(items)) {
      const kinds = items.map(simplifySchema);
      const first = kinds[0]?.type;
      out.items = first && kinds.every((k) => k.type === first) ? { type: first } : {};
      const what = first === 'number' || first === 'integer' ? 'numbers' : first === 'array' ? 'arrays' : 'items';
      out.description = `${out.description ? `${out.description} ` : ''}(exactly ${items.length} ${what})`;
    } else if (items && typeof items === 'object') {
      out.items = simplifySchema(items);
    } else out.items = {};
  }
  if (out.type === 'object' || (x.properties && typeof x.properties === 'object')) {
    out.type = 'object';
    if (x.properties && typeof x.properties === 'object') {
      out.properties = Object.fromEntries(Object.entries(x.properties as Json).map(([k, v]) => [k, simplifySchema(v)]));
      const req = Array.isArray(x.required) ? x.required.filter((k): k is string => typeof k === 'string' && k in out.properties!) : [];
      if (req.length) out.required = req;
    }
  }
  return out;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolPick {
  /** Replaces the MCP description. */
  description?: string;
  /** The parameters the model sees, in this order; the rest are left out. Default: all. */
  params?: string[];
  /** Replaces parameter descriptions. */
  paramDescriptions?: Record<string, string>;
  /** Parameters whose nested fields lose their descriptions (the parameter's own says what they are): keeps object-valued ones small. */
  bare?: string[];
}

/** A schema without the descriptions below its top. */
function stripNested(s: JsonSchema, top = true): JsonSchema {
  const out: JsonSchema = { ...s };
  if (!top) delete out.description;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, stripNested(v, false)]));
  if (s.items) out.items = stripNested(s.items, false);
  return out;
}

/**
 * MCP tools as tool definitions for the model. `only` picks and orders them
 * (with per-tool changes); `fixed` arguments (the map id) are taken out of the
 * schema and added to every call by the harness instead.
 */
export function toToolDefs(tools: readonly McpToolInfo[], opts: { only?: Record<string, ToolPick>; fixed?: Json } = {}): ToolDef[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const names = opts.only ? Object.keys(opts.only) : tools.map((t) => t.name);
  const out: ToolDef[] = [];
  for (const name of names) {
    const t = byName.get(name);
    if (!t) continue;
    const pick = opts.only?.[name] ?? {};
    const schema = simplifySchema(t.inputSchema ?? { type: 'object' });
    const props = schema.properties ?? {};
    const fixed: Json = {};
    for (const [k, v] of Object.entries(opts.fixed ?? {})) if (k in props) fixed[k] = v;
    const keep = (pick.params ?? Object.keys(props)).filter((k) => k in props && !(k in fixed));
    const properties: Record<string, JsonSchema> = {};
    for (const k of keep) {
      const d = pick.paramDescriptions?.[k];
      const p = pick.bare?.includes(k) ? stripNested(props[k]!) : props[k]!;
      properties[k] = d ? { ...p, description: d } : p;
    }
    const required = (schema.required ?? []).filter((k) => k in properties);
    out.push({
      name,
      description: pick.description ?? t.description ?? '',
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
      ...(Object.keys(fixed).length ? { fixed } : {}),
    });
  }
  return out;
}

// ---------- repairing what small models send ----------

/** <think>…</think> blocks taken out of a reply (an unclosed one runs to the end; a lone </think> ends one that began before the text). */
export function stripThink(text: string): { text: string; think: string } {
  let think = '';
  let s = text;
  const lone = /^([\s\S]*?)<\/think>/.exec(s);
  if (lone && !/<think>/.test(lone[1]!)) {
    think += lone[1]!;
    s = s.slice(lone[0].length);
  }
  s = s.replace(/<(think|thinking|reasoning)>([\s\S]*?)(<\/\1>|$)/g, (_m, _tag, inner: string) => {
    think += inner;
    return '';
  });
  return { text: s.trim(), think: think.trim() };
}

const WORDS: Record<string, string> = { true: 'true', false: 'false', null: 'null', True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null', Infinity: 'null' };

/**
 * The text made into JSON where it is close: code fences and text around the
 * value, single quotes, unquoted keys, Python's True/False/None, comments,
 * trailing or missing commas, (tuples), +5 and .5, raw line breaks in strings,
 * and brackets left open at the end (a reply cut off).
 */
export function fixJsonText(input: string): string {
  let t = input.trim();
  const fence = /```[a-zA-Z_]*\s*\n?([\s\S]*?)(```|$)/.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/[{[]/);
  if (start > 0) t = t.slice(start);
  let out = '';
  const stack: string[] = [];
  let last: 'none' | 'value' | 'open' | 'comma' | 'colon' = 'none';
  const beginValue = () => {
    if (last === 'value' && stack.length) out += ',';
  };
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === '"' || c === "'") {
      beginValue();
      let j = i + 1;
      let str = '';
      while (j < t.length && t[j] !== c) {
        const ch = t[j]!;
        if (ch === '\\' && j + 1 < t.length) {
          const next = t[j + 1]!;
          str += c === "'" && next === "'" ? "'" : ch + next;
          j += 2;
          continue;
        }
        if (ch === '\n') str += '\\n';
        else if (ch === '\r') str += '\\r';
        else if (ch === '\t') str += '\\t';
        else if (c === "'" && ch === '"') str += '\\"';
        else str += ch;
        j++;
      }
      out += `"${str}"`;
      i = j + 1;
      last = 'value';
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      beginValue();
      stack.push(c === '{' ? '}' : ']');
      out += c === '(' ? '[' : c;
      last = 'open';
      i++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      const want = c === ')' ? ']' : c;
      out = out.replace(/,\s*$/, '');
      if (stack.includes(want)) {
        while (stack.length && stack[stack.length - 1] !== want) out += stack.pop();
        stack.pop();
        out += want;
        last = 'value';
      }
      i++;
      if (!stack.length) break; // the value is complete: whatever follows is talk
      continue;
    }
    if (c === '/' && t[i + 1] === '/') {
      while (i < t.length && t[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      i = end < 0 ? t.length : end + 2;
      continue;
    }
    if (c === ',') {
      if (last !== 'comma' && last !== 'open') out += ',';
      last = 'comma';
      i++;
      continue;
    }
    if (c === ':') {
      out += ':';
      last = 'colon';
      i++;
      continue;
    }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(t.slice(i));
    if (num) {
      beginValue();
      out += String(Number(num[0]));
      i += num[0].length;
      last = 'value';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      beginValue();
      let j = i;
      while (j < t.length && /[\w$-]/.test(t[j]!)) j++;
      const word = t.slice(i, j);
      const isKey = /^\s*:/.test(t.slice(j));
      out += isKey ? JSON.stringify(word) : (WORDS[word] ?? JSON.stringify(word));
      i = j;
      last = 'value';
      continue;
    }
    if (!/\s/.test(c)) {
      i++; // a stray character: dropped
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,\s*$/, '');
  if (/:\s*$/.test(out)) out += 'null';
  while (stack.length) {
    out = out.replace(/,\s*$/, '');
    out += stack.pop();
  }
  return out;
}

export type Parsed = { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string };

export function repairJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch (e) {
    const first = (e as Error).message;
    try {
      const fixed = fixJsonText(text);
      if (!fixed) return { ok: false, error: first };
      return { ok: true, value: JSON.parse(fixed), repaired: true };
    } catch {
      return { ok: false, error: first };
    }
  }
}

const WRAPPERS = ['arguments', 'parameters', 'args', 'input', 'params'];

/** A tool call's arguments as an object: parsed, repaired, unwrapped ({"arguments": {...}}), or what's wrong. */
export function parseArguments(raw: string | Json | undefined, toolName?: string): { ok: true; args: Json; repaired: boolean } | { ok: false; error: string } {
  let value: unknown = raw ?? {};
  let repaired = false;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return { ok: true, args: {}, repaired: false };
    const p = repairJson(s);
    if (!p.ok) return p;
    value = p.value;
    repaired = p.repaired;
    if (typeof value === 'string') {
      // encoded twice: "{\"rect\": …}"
      const q = repairJson(value);
      if (q.ok && q.value && typeof q.value === 'object') {
        value = q.value;
        repaired = true;
      }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'the arguments must be one JSON object, like {"id": "r3"}' };
  let args = value as Json;
  const keys = Object.keys(args);
  const inner = keys.find((k) => WRAPPERS.includes(k));
  const wrapped = inner && args[inner] && typeof args[inner] === 'object' && !Array.isArray(args[inner]) && (keys.length === 1 || (keys.length === 2 && keys.includes('name') && (!toolName || args.name === toolName)));
  if (wrapped) {
    args = args[inner] as Json;
    repaired = true;
  }
  return { ok: true, args, repaired };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** {x, y, width, height} or {x, y} written as an object where the schema wants [x, y, w, h] or [x, y]. */
function objectAsTuple(v: Json, schema: JsonSchema): number[] | null {
  const want = /exactly (\d) numbers/.exec(schema.description ?? '')?.[1];
  const pick = (...ks: string[]) => ks.map((k) => v[k]).find(isNum);
  const x = pick('x', 'x0', 'left'), y = pick('y', 'y0', 'top');
  if (x === undefined || y === undefined) return null;
  if (want === '2') return [x, y];
  if (want === '4') {
    const w = pick('w', 'width'), h = pick('h', 'height');
    return w !== undefined && h !== undefined ? [x, y, w, h] : null;
  }
  if (want === '3') {
    const r = pick('r', 'radius');
    return r !== undefined ? [x, y, r] : null;
  }
  return null;
}

/** One value brought to the schema's type where the intent is obvious; undefined: drop the key. */
function coerceValue(v: unknown, s: JsonSchema | undefined): { value: unknown; changed: boolean } {
  if (!s?.type) return { value: v, changed: false };
  const t = s.type;
  if (v === null) return { value: undefined, changed: true };
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v)) return { value: Number(v), changed: true };
  if (t === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return { value: v.trim().toLowerCase() === 'true', changed: true };
  if (t === 'string' && (isNum(v) || typeof v === 'boolean')) return { value: String(v), changed: true };
  if ((t === 'array' || t === 'object') && typeof v === 'string') {
    const p = repairJson(v);
    if (p.ok && p.value && typeof p.value === 'object' && Array.isArray(p.value) === (t === 'array')) return { value: coerceValue(p.value, s).value, changed: true };
    if (t === 'array' && s.items?.type === 'string') return { value: [v], changed: true }; // "r1" for ["r1"]
    return { value: v, changed: false };
  }
  if (t === 'array' && v && typeof v === 'object' && !Array.isArray(v)) {
    const tuple = objectAsTuple(v as Json, s);
    if (tuple) return { value: tuple, changed: true };
  }
  if (t === 'array' && Array.isArray(v) && s.items) {
    let changed = false;
    const value = v.map((x) => {
      const r = coerceValue(x, s.items);
      changed ||= r.changed;
      return r.value;
    });
    return { value, changed };
  }
  if (t === 'object' && v && typeof v === 'object' && !Array.isArray(v) && s.properties) {
    const r = coerceArgs(v as Json, s);
    return { value: r.args, changed: r.changed.length > 0 };
  }
  return { value: v, changed: false };
}

/** Arguments brought to the schema's types where the intent is obvious ("5" → 5, "[1,2]" → [1, 2], null → left out). */
export function coerceArgs(args: Json, schema: JsonSchema): { args: Json; changed: string[] } {
  const out: Json = {};
  const changed: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const r = coerceValue(v, schema.properties?.[k]);
    if (r.changed) changed.push(k);
    if (r.value !== undefined) out[k] = r.value;
  }
  return { args: out, changed };
}

/** The tool a sloppy name means: functions.add_room, mcp__delve__add_room, Add-Room. */
export function resolveToolName(name: string, known: readonly string[]): string | undefined {
  if (known.includes(name)) return name;
  const norm = (s: string) => s.toLowerCase().replace(/^(functions?|tools?|mcp__delve|delve)[._:]+/, '').replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  const n = norm(name);
  return known.find((k) => norm(k) === n);
}

// ---------- tool calls written as text ----------

export interface TextCall {
  name: string;
  arguments: string | Json;
}

/** From an opening { or [ to its matching end (string-aware), or to the end of the text if it never closes. */
export function balancedJson(text: string, from: number): string {
  const open = text[from];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"') inStr = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

function callsFromJson(value: unknown, known: readonly string[], loose: boolean): TextCall[] {
  const list = Array.isArray(value) ? value : [value];
  const out: TextCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Json;
    const f = (o.function && typeof o.function === 'object' ? o.function : o) as Json;
    const name = typeof f.name === 'string' ? f.name : typeof o.tool === 'string' ? o.tool : typeof o.tool_name === 'string' ? o.tool_name : undefined;
    if (!name) continue;
    const args = (f.arguments ?? f.parameters ?? f.args ?? f.input ?? o.arguments ?? o.parameters ?? {}) as string | Json;
    if (!loose && !resolveToolName(name, known) && !('arguments' in f || 'parameters' in f)) continue;
    out.push({ name, arguments: args });
  }
  return out;
}

function parseLoose(text: string): unknown {
  const p = repairJson(text.trim());
  return p.ok ? p.value : undefined;
}

/**
 * Tool calls a model wrote into its text instead of the API's tool_calls:
 * <tool_call>{…}</tool_call> (Qwen, Hermes), <function=name>{…}</function> and
 * <function=name><parameter=k>v</parameter> (Llama, Qwen coder), [TOOL_CALLS] (Mistral),
 * <|python_tag|>, the harmony "to=functions.name … <|message|>{…}" (gpt-oss),
 * ```json fences and bare {"name": …, "arguments": …} objects, and a line
 * name({…}) for a known tool. `rest` is the text without them.
 */
export function textToolCalls(content: string, known: readonly string[]): { calls: TextCall[]; rest: string } {
  const calls: TextCall[] = [];
  let rest = content;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => TextCall[]) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const found = fn(m);
      calls.push(...found);
      return found.length ? '' : m[0];
    });
  };
  take(/<tool_call>\s*([\s\S]*?)\s*(<\/tool_call>|$)/g, (m) => callsFromJson(parseLoose(m[1]!), known, true));
  take(/<function=([\w.-]+)>\s*([\s\S]*?)\s*(<\/function>|$)/g, (m) => {
    const body = m[2]!;
    const params = [...body.matchAll(/<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)];
    if (params.length) {
      const args: Json = {};
      for (const p of params) {
        const v = parseLoose(p[2]!);
        args[p[1]!] = v === undefined || (typeof v === 'string' && !/^["']/.test(p[2]!.trim())) ? p[2]!.trim() : v;
      }
      return [{ name: m[1]!, arguments: args }];
    }
    return [{ name: m[1]!, arguments: body.trim() || '{}' }];
  });
  take(/\[TOOL_CALLS\]\s*([\w.-]+)\[ARGS\]\s*(\{[\s\S]*)/g, (m) => [{ name: m[1]!, arguments: balancedJson(m[2]!, 0) }]);
  take(/\[TOOL_CALLS\]\s*([[{][\s\S]*)/g, (m) => callsFromJson(parseLoose(balancedJson(m[1]!, 0)), known, true));
  take(/<\|python_tag\|>\s*(\{[\s\S]*)/g, (m) => callsFromJson(parseLoose(balancedJson(m[1]!, 0)), known, true));
  take(/to=(?:functions\.)?([\w.-]+)[^\n]*?<\|message\|>\s*(\{[\s\S]*?)(<\|call\|>|$)/g, (m) => [{ name: m[1]!, arguments: m[2]!.trim() }]);
  if (!calls.length) {
    take(/```(?:json|tool_call|tool_code|tool|function)?\s*\n?([\s\S]*?)```/g, (m) => callsFromJson(parseLoose(m[1]!), known, false));
  }
  if (!calls.length) {
    // bare JSON objects naming a known tool
    for (let i = rest.indexOf('{'); i >= 0 && i < rest.length; i = rest.indexOf('{', i + 1)) {
      const chunk = balancedJson(rest, i);
      if (!/"(name|tool)"\s*:/.test(chunk)) continue;
      const found = callsFromJson(parseLoose(chunk), known, false).filter((c) => resolveToolName(c.name, known));
      if (found.length) {
        calls.push(...found);
        rest = rest.slice(0, i) + rest.slice(i + chunk.length);
        i--;
      }
    }
  }
  if (!calls.length) {
    take(/^\s*([a-z_][\w]*)\s*\(\s*(\{[\s\S]*?\})\s*\)\s*$/gm, (m) => (resolveToolName(m[1]!, known) ? [{ name: m[1]!, arguments: m[2]! }] : []));
  }
  return { calls, rest: rest.trim() };
}

// ---------- tool results ----------

export interface ToolExecutor {
  call(name: string, args: Json): Promise<{ text: string; isError: boolean; images?: number }>;
}

export const IMAGE_NOTE = '[A picture of the map was left out: you read text only. Call describe_map to check the map as text.]';

/** MCP result content as text: pictures replaced by a note. */
export function contentText(content: readonly { type: string; text?: string }[]): { text: string; images: number } {
  let images = 0;
  const parts = content.map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'image') {
      images++;
      return IMAGE_NOTE;
    }
    return `[${c.type} left out]`;
  });
  return { text: parts.join('\n').trim(), images };
}

export function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n… (${text.length - max} more characters cut)`;
}

/** Tools through an MCP client (the official SDK's Client, or anything with callTool). */
export function mcpExecutor(client: { callTool(req: { name: string; arguments: Json }): Promise<unknown> }): ToolExecutor {
  return {
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const { text, images } = contentText(res.content ?? []);
      return { text, isError: Boolean(res.isError), images };
    },
  };
}

// ---------- the loop ----------

export interface AgentOptions {
  client: ModelClient;
  tools: ToolDef[];
  exec: ToolExecutor;
  local?: LocalTool[];
  system: string;
  user: string;
  /** Model requests (default 30). */
  maxTurns?: number;
  /** Tool calls (default 80). */
  maxToolCalls?: number;
  /** Wall time for the whole run (default 10 minutes); a request still running is stopped. */
  timeLimitMs?: number;
  /** Tool results are cut to this (default 4000 characters). */
  maxResultChars?: number;
  /** Stop after this many failed tool calls in a row (default 8). */
  maxErrorsInARow?: number;
  onEvent?: (e: AgentEvent) => void;
  now?: () => number;
}

export type AgentEvent =
  | { type: 'reply'; turn: number; ms: number; content: string; think: string; calls: number; promptTokens?: number; completionTokens?: number }
  | { type: 'call'; record: CallRecord }
  | { type: 'nudge'; text: string };

export interface CallRecord {
  turn: number;
  name: string;
  args: Json;
  ok: boolean;
  /** The result as the model saw it. */
  result: string;
  ms: number;
  /** native: the API's tool_calls; text: written into the reply. */
  source: 'native' | 'text';
  /** The arguments needed repairing (JSON, types, wrapping). */
  repaired: boolean;
  local?: boolean;
}

export type StopReason = 'answer' | 'turns' | 'tool_calls' | 'time' | 'errors' | 'empty' | 'model_error';

export interface AgentStats {
  turns: number;
  toolCalls: number;
  /** Calls that came back as errors (Delve refused them, unknown tool, unreadable arguments). */
  toolErrors: number;
  /** Arguments that were not JSON even after repair. */
  badJson: number;
  /** Arguments that needed repair (JSON fixed, wrapper removed, types brought to the schema). */
  repaired: number;
  /** Calls written into the text instead of tool_calls. */
  textCalls: number;
  unknownTools: number;
  /** Replies with neither text nor a tool call (each gets a nudge). */
  empty: number;
  promptTokens: number;
  completionTokens: number;
  /** Characters of thinking (<think> blocks and reasoning fields). */
  thinkChars: number;
  /** Characters of visible text and tool arguments, to put thinkChars in proportion. */
  outputChars: number;
  modelMs: number;
  /** Server-side generation and prompt times, when the server reports them. */
  evalMs: number;
  promptMs: number;
  loadMs: number;
  /** The largest prompt of the run (tokens). */
  maxPrompt: number;
  wallMs: number;
}

export interface AgentRun {
  answer: string;
  /** The last thing the model said, even when the run stopped at a limit. */
  lastText: string;
  stop: StopReason;
  error?: string;
  stats: AgentStats;
  calls: CallRecord[];
  messages: AgentMessage[];
}

export function emptyStats(): AgentStats {
  return { turns: 0, toolCalls: 0, toolErrors: 0, badJson: 0, repaired: 0, textCalls: 0, unknownTools: 0, empty: 0, promptTokens: 0, completionTokens: 0, thinkChars: 0, outputChars: 0, modelMs: 0, evalMs: 0, promptMs: 0, loadMs: 0, maxPrompt: 0, wallMs: 0 };
}

/** Malformed calls in the report: unreadable or repaired arguments, calls written as text, unknown tool names. */
export const malformed = (s: AgentStats): number => s.badJson + s.repaired + s.textCalls + s.unknownTools;

interface Prepared {
  id: string;
  name: string;
  args: Json;
  problem?: string;
  repaired: boolean;
  source: 'native' | 'text';
  local?: LocalTool;
}

export async function runAgent(o: AgentOptions): Promise<AgentRun> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const maxTurns = o.maxTurns ?? 30;
  const maxToolCalls = o.maxToolCalls ?? 80;
  const timeLimit = o.timeLimitMs ?? 600_000;
  const maxResult = o.maxResultChars ?? 4000;
  const maxErrors = o.maxErrorsInARow ?? 8;
  const local = new Map((o.local ?? []).map((l) => [l.def.name, l]));
  const defs = [...o.tools, ...(o.local ?? []).map((l) => l.def)];
  const byName = new Map(defs.map((d) => [d.name, d]));
  const names = defs.map((d) => d.name);
  const messages: AgentMessage[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: o.user },
  ];
  const stats = emptyStats();
  const calls: CallRecord[] = [];
  const emit = o.onEvent ?? (() => {});
  let answer = '';
  let lastText = '';
  let stop: StopReason | null = null;
  let error: string | undefined;
  let errorsInARow = 0;
  let lastKey = '';
  let repeats = 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeLimit);
  timer.unref?.();

  const nudge = (text: string) => {
    messages.push({ role: 'user', content: text });
    emit({ type: 'nudge', text });
  };

  const prepare = (c: ToolCall, source: 'native' | 'text', index: number): Prepared => {
    const id = c.id || `call_${stats.turns}_${index}`;
    const name = resolveToolName(c.name, names);
    if (!name) {
      stats.unknownTools++;
      return { id, name: c.name || '(no name)', args: {}, source, repaired: false, problem: `There is no tool "${c.name}". The tools are: ${names.join(', ')}.` };
    }
    const def = byName.get(name)!;
    const parsed = parseArguments(c.arguments, name);
    if (!parsed.ok) {
      stats.badJson++;
      return { id, name, args: {}, source, repaired: false, problem: `The arguments for ${name} are not valid JSON (${parsed.error}). Send the call again with its arguments as one JSON object.` };
    }
    const { args, changed } = coerceArgs(parsed.args, def.parameters);
    const repaired = parsed.repaired || changed.length > 0 || name !== c.name;
    if (repaired) stats.repaired++;
    return { id, name, args: { ...args, ...def.fixed }, source, repaired, ...(local.has(name) ? { local: local.get(name)! } : {}) };
  };

  try {
    while (!stop) {
      if (stats.turns >= maxTurns) {
        stop = 'turns';
        break;
      }
      if (now() - t0 >= timeLimit || ctrl.signal.aborted) {
        stop = 'time';
        break;
      }
      stats.turns++;
      const tm = now();
      let reply: ModelReply;
      try {
        reply = await o.client.complete(messages, defs, ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) stop = 'time';
        else {
          stop = 'model_error';
          error = (e as Error).message;
        }
        break;
      }
      const ms = now() - tm;
      stats.modelMs += ms;
      stats.promptTokens += reply.promptTokens ?? 0;
      stats.completionTokens += reply.completionTokens ?? 0;
      stats.maxPrompt = Math.max(stats.maxPrompt, reply.promptTokens ?? 0);
      stats.evalMs += reply.evalMs ?? 0;
      stats.promptMs += reply.promptMs ?? 0;
      stats.loadMs += reply.loadMs ?? 0;
      const { text: visible, think } = stripThink(reply.content);
      const thinking = [reply.reasoning.trim(), think].filter(Boolean).join('\n');
      stats.thinkChars += thinking.length;
      let content = visible;
      let raw: { call: ToolCall; source: 'native' | 'text' }[] = reply.toolCalls.map((call) => ({ call, source: 'native' as const }));
      if (!raw.length && content) {
        const found = textToolCalls(content, names);
        if (found.calls.length) {
          stats.textCalls += found.calls.length;
          raw = found.calls.map((c, i) => ({ call: { id: `text_${stats.turns}_${i}`, name: c.name, arguments: c.arguments }, source: 'text' as const }));
          content = found.rest;
        }
      }
      stats.outputChars += content.length + raw.reduce((s, r) => s + (typeof r.call.arguments === 'string' ? r.call.arguments.length : JSON.stringify(r.call.arguments).length), 0);
      if (content) lastText = content;
      emit({ type: 'reply', turn: stats.turns, ms, content, think: thinking, calls: raw.length, ...(reply.promptTokens !== undefined ? { promptTokens: reply.promptTokens } : {}), ...(reply.completionTokens !== undefined ? { completionTokens: reply.completionTokens } : {}) });

      if (!raw.length) {
        if (content) {
          answer = content;
          messages.push({ role: 'assistant', content });
          stop = 'answer';
          break;
        }
        stats.empty++;
        if (stats.empty > 2) {
          stop = 'empty';
          break;
        }
        messages.push({ role: 'assistant', content: '' });
        nudge(reply.finish === 'length' ? 'Your reply was cut off before it said anything. Think less: call the next tool now, or give your final answer.' : 'Continue: call the next tool, or give your final answer in one or two sentences.');
        continue;
      }

      const prepared = raw.map((r, i) => prepare(r.call, r.source, i));
      messages.push({ role: 'assistant', content, toolCalls: prepared.map((p) => ({ id: p.id, name: p.name, args: p.args })) });
      for (const p of prepared) {
        if (stats.toolCalls >= maxToolCalls) {
          stop = 'tool_calls';
          messages.push({ role: 'tool', toolCallId: p.id, name: p.name, content: 'Not run: the limit of tool calls is reached.' });
          continue;
        }
        stats.toolCalls++;
        const tc = now();
        let res: { text: string; isError: boolean };
        if (p.problem) res = { text: p.problem, isError: true };
        else if (p.local) {
          try {
            res = { text: p.local.run(p.args), isError: false };
          } catch (e) {
            res = { text: (e as Error).message, isError: true };
          }
        } else {
          try {
            res = await o.exec.call(p.name, p.args);
          } catch (e) {
            res = { text: `The tool call failed: ${(e as Error).message}`, isError: true };
          }
        }
        let text = trimText(res.text || (res.isError ? 'Error.' : 'Done.'), maxResult);
        const key = `${p.name} ${JSON.stringify(p.args)}`;
        repeats = key === lastKey ? repeats + 1 : 0;
        lastKey = key;
        if (repeats >= 2) text += `\nYou have now made this same call ${repeats + 1} times in a row. Do something else, or give your final answer.`;
        if (res.isError) {
          stats.toolErrors++;
          errorsInARow++;
        } else errorsInARow = 0;
        messages.push({ role: 'tool', toolCallId: p.id, name: p.name, content: text });
        const record: CallRecord = { turn: stats.turns, name: p.name, args: p.args, ok: !res.isError, result: text, ms: now() - tc, source: p.source, repaired: p.repaired, ...(p.local ? { local: true } : {}) };
        calls.push(record);
        emit({ type: 'call', record });
      }
      if (!stop && errorsInARow >= maxErrors) stop = 'errors';
    }
  } finally {
    clearTimeout(timer);
  }
  stats.wallMs = now() - t0;
  return { answer, lastText, stop: stop ?? 'answer', ...(error ? { error } : {}), stats, calls, messages };
}

/** Generated tokens per second: from the server's generation time when it says, else from the request times. */
export function tokensPerSecond(s: AgentStats): number | undefined {
  const ms = s.evalMs || s.modelMs;
  return s.completionTokens && ms ? s.completionTokens / (ms / 1000) : undefined;
}

/** Prompt tokens read per second (only when the server reports its prompt time). */
export function promptPerSecond(s: AgentStats): number | undefined {
  return s.promptTokens && s.promptMs ? s.promptTokens / (s.promptMs / 1000) : undefined;
}
