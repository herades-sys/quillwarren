// The chat with a local model: the desktop app's chat backend. The editor's
// chat panel sends its message as always (POST /api/v1/maps/:id/chat); this
// answers it with a model on the user's own machine or network (Ollama, LM
// Studio, llama.cpp's llama-server, later Delve's built-in runtime) through the
// local-model harness (local-agent.ts runAgent, the lean setup of
// local-setup.ts and its helping steps LEAN_STEPS), with Delve's MCP tools run
// in this process. What the harness reports is turned into the panel's chat
// events (text, tool calls, the plan / activity card, errors) by feeding it
// through the same StreamTranslator the Claude bridge uses, so the panel can't
// tell the difference.
//
// Only desktop/main.ts imports this file: the web server's chat stays the
// Claude Code bridge, and its release carries none of this.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ValidationError } from '@delve/core';
import type { AppContext } from '../app.ts';
import { levelsOf } from '../levels.ts';
import { buildMcpServer } from '../mcp.ts';
import { StreamTranslator, type ChatEvent } from './events.ts';
import {
  detectApi,
  mcpExecutor,
  ModelError,
  ollamaClient,
  openAiClient,
  requestJson,
  runAgent,
  type AgentEvent,
  type AgentRun,
  type CallRecord,
  type Json,
  type McpToolInfo,
  type ModelClient,
  type ToolExecutor,
} from './local-agent.ts';
import { buildSetup } from './local-setup.ts';
import type { ChatBackendName, ChatBackends, LocalChatRun } from './route.ts';
import { apiChat, checkModelId, DEFAULT_API_SETTINGS, isKeyProvider, KEY_PROVIDERS, type ApiChatOptions, type ApiModelSettings, type KeyProvider } from './api-chat.ts';

// ---------- settings ----------

export interface LocalModelSettings {
  /** server: an OpenAI-compatible (or Ollama) server at url; builtin: Delve's own runtime (desktop/runtime.ts). */
  source: 'server' | 'builtin';
  /** e.g. http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:8080/v1 (llama-server). */
  url: string;
  model: string;
}

export interface ChatSettings {
  backend: ChatBackendName;
  local: LocalModelSettings;
  /** The API-key backends' models (chat/api-chat.ts); their keys are kept apart, in api-keys.ts. */
  anthropic?: ApiModelSettings;
  openai?: ApiModelSettings;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  backend: 'none',
  local: { source: 'server', url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  ...structuredClone(DEFAULT_API_SETTINGS),
};

/** The addresses the settings suggest (the default ports of each server). */
export const SERVER_SUGGESTIONS = [
  { label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { label: 'llama-server', url: 'http://127.0.0.1:8080/v1' },
  { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
];

/** An http(s) address of a model server, or what's wrong with it. */
export function checkServerUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'the server address is empty';
  if (v.length > 500) return 'the server address is too long';
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return `"${v}" is not an address (like http://127.0.0.1:11434/v1)`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'the server address must start with http:// or https://';
  if (u.username || u.password) return 'leave the user name and password out of the address';
  return null;
}

/** A model name as the servers write them ("qwen3:8b", "Qwen3-8B-Q4_K_M.gguf", "lmstudio-community/qwen3-8b"). */
export function checkModelName(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'the model name is empty';
  if (v.length > 200 || /[\u0000-\u001f]/.test(v)) return 'that is not a model name';
  return null;
}

/** The settings from a request body, checked against the backends on offer (throws ValidationError). */
export function parseChatSettings(body: unknown, offered: readonly ChatBackendName[], before: ChatSettings): ChatSettings {
  const b = (body ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const backend = (b.backend ?? before.backend) as ChatBackendName;
  if (!offered.includes(backend)) problems.push(`backend: one of ${offered.join(', ')}`);
  const l = (b.local ?? {}) as Record<string, unknown>;
  const local: LocalModelSettings = { ...before.local };
  if (l.url !== undefined || l.model !== undefined) {
    // an address typed in the settings means that server, not the built-in runtime
    local.source = l.source === 'builtin' ? 'builtin' : 'server';
    if (l.url !== undefined) local.url = String(l.url).trim();
    if (l.model !== undefined) local.model = String(l.model).trim();
  } else if (l.source === 'builtin' || l.source === 'server') local.source = l.source;
  if (backend === 'local' && local.source === 'server') {
    const u = checkServerUrl(local.url);
    const m = checkModelName(local.model);
    if (u) problems.push(`local.url: ${u}`);
    if (m) problems.push(`local.model: ${m}`);
  }
  // the API-key backends' model choice (their keys are handled before this, by api-chat.ts)
  const out: ChatSettings = { backend, local };
  for (const p of KEY_PROVIDERS) {
    let s: ApiModelSettings | undefined = before[p] ? { ...before[p] } : undefined;
    const part = b[p] as Record<string, unknown> | undefined;
    if (part && typeof part === 'object' && part.model !== undefined) {
      const problem = checkModelId(part.model);
      if (problem) problems.push(`${p}.model: ${problem}`);
      else s = { ...s, model: String(part.model).trim() };
    }
    if (backend === p && !s?.model) problems.push(`${p}.model: ${checkModelId('')}`);
    if (s) out[p] = s;
  }
  if (problems.length) throw new ValidationError(problems);
  return out;
}

/** The settings in <DELVE_DATA>/chat-settings.json (in memory without a file). */
export class ChatSettingsStore {
  private value: ChatSettings;
  private readonly file: string | undefined;

  constructor(file: string | undefined, defaults: ChatSettings = DEFAULT_CHAT_SETTINGS) {
    this.file = file;
    this.value = structuredClone(defaults);
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<ChatSettings>;
      if (saved && typeof saved === 'object') {
        if (typeof saved.backend === 'string') this.value.backend = saved.backend as ChatBackendName;
        if (saved.local && typeof saved.local === 'object') this.value.local = { ...this.value.local, ...saved.local };
        for (const p of KEY_PROVIDERS) {
          const s = saved[p];
          if (s && typeof s === 'object' && typeof s.model === 'string') this.value[p] = { model: s.model, ...(Array.isArray(s.models) ? { models: s.models.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string').slice(0, 200) } : {}) };
        }
      }
    } catch {
      // none yet, or unreadable: the defaults
    }
  }

  get(): ChatSettings {
    return structuredClone(this.value);
  }

  set(next: ChatSettings): void {
    this.value = structuredClone(next);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

// ---------- the built-in runtime (desktop/runtime.ts) ----------

/** Delve's own llama-server, as the chat sees it. */
export interface BuiltinModel {
  /** Whether it can run now (the binary is bundled and a model file is chosen), and if not, why. */
  status(): { available: boolean; model?: string; note?: string };
  /** Starts it when it isn't running; its OpenAI-compatible address with the per-launch key. */
  endpoint(): Promise<{ baseUrl: string; apiKey: string; model: string }>;
}

// ---------- the harness's events as chat events ----------

const TOOL_PREFIX = 'mcp__delve__';

/** What the panel says when a run ends without an answer. */
export function stopText(run: Pick<AgentRun, 'stop' | 'error' | 'stats'>, o: { timeLimitMs?: number; maxErrors?: number } = {}): string {
  const kept = 'Changes made so far are kept (undo removes them).';
  switch (run.stop) {
    case 'turns':
      return `The model stopped after ${run.stats.turns} replies without finishing. ${kept}`;
    case 'tool_calls':
      return `The model stopped after ${run.stats.toolCalls} tool calls. ${kept}`;
    case 'time':
      return `The model took longer than ${Math.round((o.timeLimitMs ?? 900_000) / 60_000)} minutes, so it was stopped. ${kept}`;
    case 'errors':
      return `${o.maxErrors ?? 8} tool calls in a row failed, so the model stopped. Try a smaller request. ${kept}`;
    case 'empty':
      return 'The model gave no answer. Try again, or try another model.';
    case 'model_error':
      return `The local model failed: ${friendlyError(run.error ?? 'unknown problem')}`;
    default:
      return 'The model stopped.';
  }
}

/** Network errors in words. */
export function friendlyError(msg: string): string {
  if (/ECONNREFUSED/.test(msg)) return 'nothing answers at the server address. Is the model server (Ollama, llama-server) running?';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'the server address could not be found.';
  if (/ETIMEDOUT|no answer within/.test(msg)) return `the server took too long to answer (${msg}).`;
  if (/HTTP 404/.test(msg) && /model/i.test(msg)) return `${msg}. Is the model name right (the settings can list the server's models)?`;
  return msg;
}

/**
 * Turns what runAgent reports into the chat panel's events. It writes the
 * run as Claude Code's stream-json would (init, assistant messages with text
 * and tool_use, user messages with tool_result, result) and lets the bridge's
 * StreamTranslator make the events, so the plan / activity card, the tool list
 * and the end of a reply behave exactly as with Claude.
 */
export class LocalTranslator {
  private readonly t = new StreamTranslator();
  private n = 0;
  /** The tool call running now (calls of one reply run one after another). */
  private running: { id: string; name: string } | null = null;

  private feed(line: Json): ChatEvent[] {
    return this.t.feed(JSON.stringify(line));
  }

  get session(): string {
    return this.t.session;
  }

  start(session: string, model: string): ChatEvent[] {
    return this.feed({ type: 'system', subtype: 'init', session_id: session, model, mcp_servers: [{ name: 'delve', status: 'connected' }] });
  }

  /** A model reply's visible text (tool calls follow as their own events). */
  reply(content: string): ChatEvent[] {
    if (!content.trim()) return [];
    return this.feed({ type: 'assistant', message: { id: `m${++this.n}`, content: [{ type: 'text', text: content }] } });
  }

  /** A call to one of Delve's tools starts. */
  toolStart(name: string, args: unknown): ChatEvent[] {
    const id = `local_${++this.n}`;
    this.running = { id, name };
    return this.feed({ type: 'assistant', message: { id: `m${this.n}`, content: [{ type: 'tool_use', id, name: `${TOOL_PREFIX}${name}`, input: args ?? {} }] } });
  }

  /** A call is done (or was refused or held back without reaching the tools). */
  call(r: CallRecord): ChatEvent[] {
    const out: ChatEvent[] = [];
    if (!this.running || this.running.name !== r.name) out.push(...this.toolStart(r.name, r.args));
    const id = this.running!.id;
    this.running = null;
    out.push(...this.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: r.result, is_error: !r.ok }] } }));
    return out;
  }

  event(e: AgentEvent): ChatEvent[] {
    if (e.type === 'reply') return this.reply(e.content);
    if (e.type === 'call') return this.call(e.record);
    return []; // nudges and the final check go to the model only
  }

  finish(run: AgentRun, o: { timeLimitMs?: number; maxErrors?: number } = {}): ChatEvent[] {
    const ok = run.stop === 'answer';
    return this.feed({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      num_turns: run.stats.turns,
      duration_ms: run.stats.wallMs,
      result: ok ? run.answer : stopText(run, o),
    });
  }
}

// ---------- conversations ----------

/** What a follow-up message gets to know of the conversation so far (the map itself is in the context block). */
export function recap(history: readonly { request: string; answer: string }[], message: string): string {
  if (!history.length) return message;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
  const lines = history.slice(-3).map((h) => `- The user asked: "${cut(h.request.replace(/\s+/g, ' '), 300)}" You answered: "${cut(h.answer.replace(/\s+/g, ' '), 300)}"`);
  return `Earlier in this conversation:\n${lines.join('\n')}\n\nThe user's new message:\n${message}`;
}

class Conversations {
  private readonly items = new Map<string, { at: number; history: { request: string; answer: string }[] }>();

  get(id: string | undefined): { request: string; answer: string }[] {
    return (id && this.items.get(id)?.history) || [];
  }

  add(id: string, request: string, answer: string): void {
    const now = Date.now();
    for (const [k, v] of this.items) if (now - v.at > 6 * 3600_000) this.items.delete(k);
    const c = this.items.get(id) ?? { at: now, history: [] };
    c.at = now;
    c.history.push({ request, answer });
    if (c.history.length > 10) c.history.shift();
    this.items.set(id, c);
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value!);
  }
}

// ---------- the backend ----------

export interface LocalChatOptions {
  /** <DELVE_DATA>/chat-settings.json; without it the settings live in memory. */
  settingsFile?: string;
  /** Default: none and local. */
  offered?: readonly ChatBackendName[];
  defaults?: ChatSettings;
  /** What the panel calls the assistant (default "Assistant"). */
  name?: string;
  /** The model manager page, linked from the settings. */
  links?: { models?: string };
  builtin?: BuiltinModel;
  /** Per run (defaults as the harness's: 30 replies, 80 tool calls; 15 minutes, local models are slow). */
  maxTurns?: number;
  maxToolCalls?: number;
  timeLimitMs?: number;
  /** Per model request; default 10 minutes. */
  requestTimeoutMs?: number;
  /** Ollama's context size (its OpenAI endpoint can't set one); default 16384, as the bench's lean runs. */
  numCtx?: number;
  log?: (msg: string) => void;
  /** Also offer Claude and OpenAI on the user's own API keys (chat/api-chat.ts): the desktop app. */
  api?: Omit<ApiChatOptions, 'log'>;
}

/** A model client that gives up as soon as the chat is stopped. */
function abortable(client: ModelClient, signal: AbortSignal): ModelClient {
  return {
    label: client.label,
    complete(messages, tools, own) {
      if (signal.aborted) return Promise.reject(new ModelError('stopped'));
      return client.complete(messages, tools, own ? AbortSignal.any([own, signal]) : signal);
    },
  };
}

/** The models a server offers (Ollama's /api/tags, or /models of an OpenAI-compatible one). */
export async function serverModels(url: string, timeoutMs = 5000): Promise<{ api: 'ollama' | 'openai'; models: string[] }> {
  const d = await detectApi(url);
  if (d.api === 'ollama') {
    const r = await requestJson(`${d.host}/api/tags`, { timeoutMs });
    if (r.status !== 200) throw new ModelError(`Ollama answered ${r.status}`);
    const models = ((r.json as { models?: { name?: unknown }[] } | undefined)?.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
    return { api: 'ollama', models };
  }
  const r = await requestJson(`${url.replace(/\/$/, '')}/models`, { timeoutMs });
  if (r.status !== 200) throw new ModelError(`the server answered ${r.status} at ${url.replace(/\/$/, '')}/models`);
  const models = ((r.json as { data?: { id?: unknown }[] } | undefined)?.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
  return { api: 'openai', models };
}

/** Delve's MCP tools in this process (no HTTP, no token): the same server /mcp runs per request. */
async function inProcessTools(ctx: AppContext, base: string): Promise<{ client: Client; tools: McpToolInfo[]; close(): Promise<void> }> {
  const server = buildMcpServer(ctx.service, base, ctx.info.version, ctx.images, ctx.props);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'delve-local-chat', version: ctx.info.version });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return {
    client,
    tools: tools as McpToolInfo[],
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The chat backends of the desktop app: none, a local model, and with `api` Claude and OpenAI on the user's own API keys. */
export function localChatBackends(ctx: AppContext, o: LocalChatOptions = {}): ChatBackends {
  const offered = o.offered ?? (o.api ? (['none', 'local', 'anthropic', 'openai'] as const) : (['none', 'local'] as const));
  const settings = new ChatSettingsStore(o.settingsFile, o.defaults);
  const conversations = new Conversations();
  const log = o.log ?? (() => {});
  const timeLimitMs = o.timeLimitMs ?? 15 * 60_000;
  const maxErrors = 8;
  const api = o.api ? apiChat(ctx, { ...o.api, log }) : undefined;
  const apiSettings = (p: KeyProvider): ApiModelSettings => settings.get()[p] ?? structuredClone(DEFAULT_API_SETTINGS[p]);

  async function client(local: LocalModelSettings): Promise<{ client: ModelClient; model: string }> {
    const timeoutMs = o.requestTimeoutMs ?? 600_000;
    if (local.source === 'builtin') {
      if (!o.builtin) throw new ModelError('the built-in model runtime is not part of this build');
      const ep = await o.builtin.endpoint();
      return { client: openAiClient({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model, maxTokens: 6000, timeoutMs }), model: ep.model };
    }
    const d = await detectApi(local.url);
    if (d.api === 'ollama') return { client: ollamaClient({ host: d.host, model: local.model, numCtx: o.numCtx ?? 16384, maxTokens: 6000, timeoutMs }), model: local.model };
    return { client: openAiClient({ baseUrl: local.url, model: local.model, maxTokens: 6000, timeoutMs }), model: local.model };
  }

  const view = () => {
    const s = settings.get();
    const b = o.builtin?.status();
    return {
      backend: offered.includes(s.backend) ? s.backend : 'none',
      offered,
      local: s.local,
      suggestions: SERVER_SUGGESTIONS,
      ...(o.links ? { links: o.links } : {}),
      ...(b ? { builtin: b } : {}),
      ...(api ? api.view(apiSettings) : {}),
    };
  };

  return {
    offered,
    name: o.name ?? 'Assistant',
    current: () => view().backend,
    settings: view,
    async saveSettings(body) {
      const b = (body ?? {}) as Record<string, unknown>;
      // everything is checked before anything is kept: the settings, then the keys (a bad one refuses the whole save)
      let next = parseChatSettings(b, offered, settings.get());
      if (api) await api.applyKeys(b);
      if (api && isKeyProvider(next.backend) && !api.keys.has(next.backend)) {
        if (b.backend === next.backend) throw new ValidationError([`${next.backend}.key: add your API key first`]);
        next = { ...next, backend: 'none' }; // its key was removed: the chat is off
      }
      settings.set(next);
      log(`chat settings: backend ${next.backend}, ${isKeyProvider(next.backend) ? next[next.backend]?.model : next.local.source === 'builtin' ? 'built-in runtime' : `${next.local.model} at ${next.local.url}`}`);
      return view();
    },
    async test(body) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (isKeyProvider(b.backend)) {
        if (!api || !offered.includes(b.backend)) throw new ValidationError([`backend: one of ${offered.join(', ')}`]);
        const got = await api.test(b.backend, b);
        // the key's models become the choice in the settings
        if (got.ok && got.models) settings.set({ ...settings.get(), [b.backend]: { ...apiSettings(b.backend), models: got.models } });
        return got;
      }
      const problem = checkServerUrl(b.url);
      if (problem) throw new ValidationError([`url: ${problem}`]);
      const model = typeof b.model === 'string' ? b.model.trim() : '';
      try {
        const got = await serverModels(String(b.url).trim());
        return { ok: true, api: got.api, models: got.models, ...(model ? { hasModel: got.models.length === 0 || got.models.includes(model) } : {}) };
      } catch (e) {
        return { ok: false, error: friendlyError((e as Error).message) };
      }
    },
    async localStatus() {
      const backend = view().backend;
      if (api && isKeyProvider(backend)) return api.status(backend, apiSettings(backend));
      const s = settings.get().local;
      if (s.source === 'builtin') {
        const b = o.builtin?.status() ?? { available: false, note: 'the built-in model runtime is not part of this build' };
        return { ok: b.available, model: b.model ?? '', ...(b.available ? {} : { error: b.note ?? 'the built-in runtime is not ready' }) };
      }
      try {
        const got = await serverModels(s.url, 3000);
        const has = got.models.length === 0 || got.models.includes(s.model);
        return { ok: has, model: s.model, ...(has ? {} : { error: `the server has no model "${s.model}" (it has ${got.models.slice(0, 5).join(', ')})` }) };
      } catch (e) {
        return { ok: false, model: s.model, error: friendlyError((e as Error).message) };
      }
    },
    async runLocal(run: LocalChatRun) {
      const backend = view().backend;
      if (api && isKeyProvider(backend)) return api.run(backend, apiSettings(backend), run);
      const { mapId, request, base, send, signal } = run;
      const s = settings.get();
      const history = conversations.get(request.session);
      const session = request.session && history.length ? request.session : randomUUID();
      let model: { client: ModelClient; model: string };
      try {
        model = await client(s.local);
      } catch (e) {
        send({ type: 'error', code: 'bridge', error: `Couldn't start the local model: ${friendlyError((e as Error).message)}` });
        return;
      }
      const tools = await inProcessTools(ctx, base);
      const t = new LocalTranslator();
      const emit = (evs: ChatEvent[]) => {
        for (const ev of evs) send(ev);
      };
      try {
        const setup = buildSetup('lean', tools.tools, mapId);
        const current = ctx.service.store.get(mapId);
        const user = setup.user({ map: current.map, rev: current.rev, selection: request.selection, ...(request.view ? { view: request.view } : {}), levels: levelsOf(ctx.service, mapId) }, recap(history, request.message));
        const inner = mcpExecutor(tools.client);
        const exec: ToolExecutor = {
          async call(name, args) {
            if (signal.aborted) throw new Error('stopped');
            emit(t.toolStart(name, args));
            return inner.call(name, args);
          },
        };
        emit(t.start(session, model.model));
        const result = await runAgent({
          client: abortable(model.client, signal),
          tools: setup.tools,
          local: setup.local,
          exec,
          system: setup.system,
          user,
          maxTurns: o.maxTurns ?? 30,
          maxToolCalls: o.maxToolCalls ?? 80,
          timeLimitMs,
          maxErrorsInARow: maxErrors,
          steps: setup.steps,
          readMap: async () => ctx.service.store.get(mapId).map,
          request: request.message,
          onEvent: (e) => emit(t.event(e)),
        });
        log(`local chat ${session} map=${mapId} stop=${result.stop} turns=${result.stats.turns} calls=${result.stats.toolCalls} errors=${result.stats.toolErrors} ${result.stats.wallMs}ms${result.error ? ` error=${result.error}` : ''}`);
        if (signal.aborted) return; // the browser left or pressed Stop: nobody reads the end
        emit(t.finish(result, { timeLimitMs, maxErrors }));
        conversations.add(session, request.message, result.answer || result.lastText);
      } finally {
        await tools.close();
      }
    },
  };
}
