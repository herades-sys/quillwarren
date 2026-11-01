// The desktop app's two chat backends with the user's own API key: "Claude
// (your Anthropic API key)" and "OpenAI (your API key)". local-chat.ts offers
// them next to None and Local model when desktop/main.ts passes `api`; this
// file has their settings (the key, kept by api-keys.ts; the model, from the
// provider's models endpoint once the key is checked), the key check, and the
// run: the normal chat system prompt and the full Quillwarren tool set, run by
// api-agent.ts, with Quillwarren's MCP tools in this process (no HTTP, no token).
// Requests go to https://api.anthropic.com or https://api.openai.com only.
// The web server never loads this file.
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ValidationError } from '@delve/core';
import type { AppContext } from '../app.ts';
import { levelsOf } from '../levels.ts';
import { buildMcpServer } from '../mcp.ts';
import { anthropicProvider, CLAUDE_CHOICES, DEFAULT_CLAUDE_MODEL, type AnthropicOptions } from './anthropic.ts';
import { apiStopText, ApiTranslator, runApiAgent, type ToolRunner } from './api-agent.ts';
import { checkKey, KEY_PROVIDERS, KeyStore, type KeyProvider, type SecretBox } from './api-keys.ts';
import { ApiError, scrubKeys, usageLine, type ApiProvider, type ModelChoice, type Picture } from './api-model.ts';
import type { ChatEvent } from './events.ts';
import type { Json, McpToolInfo } from './local-agent.ts';
import { taskTools } from './local-setup.ts';
import { openAiProvider, type OpenAiOptions } from './openai.ts';
import { CHAT_SYSTEM_PROMPT, chatPrompt } from './prompt.ts';
import type { LocalChatRun } from './route.ts';

export { KEY_PROVIDERS, type KeyProvider };

export interface ApiModelSettings {
  model: string;
  /** The models the key offered when it was last checked. */
  models?: ModelChoice[];
}

export const DEFAULT_API_SETTINGS: Record<KeyProvider, ApiModelSettings> = {
  anthropic: { model: DEFAULT_CLAUDE_MODEL },
  openai: { model: '' },
};

export const isKeyProvider = (b: unknown): b is KeyProvider => (KEY_PROVIDERS as readonly unknown[]).includes(b);

/** What the settings pane says about each backend (the page has no provider-specific words of its own). */
export const API_LABELS: Record<KeyProvider, [string, string]> = {
  anthropic: ['Claude (your Anthropic API key)', 'Claude by Anthropic, with your own API key. You pay Anthropic for what you use.'],
  openai: ['OpenAI (your API key)', 'OpenAI’s models, with your own API key. You pay OpenAI for what you use.'],
};
const NOTES: Record<KeyProvider, string> = {
  anthropic: 'The map and the chat go to Anthropic, and what you use is billed to your Anthropic account.',
  openai: 'The map and the chat go to OpenAI, and what you use is billed to your OpenAI account.',
};
const GET_KEY: Record<KeyProvider, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};
const PLACEHOLDER: Record<KeyProvider, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };

/** The system prompt for a provider: the chat's own, with OpenAI's model not told it is Claude. */
export function apiSystemPrompt(p: KeyProvider): string {
  return p === 'anthropic' ? CHAT_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT.replace(/^You are Claude,/, 'You are an AI assistant,');
}

/** A model id as the providers write them. */
export function checkModelId(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'choose a model (Check the key lists the ones your key can use)';
  if (v.length > 100 || !/^[A-Za-z0-9._:/-]+$/.test(v.trim())) return 'that is not a model id';
  return null;
}

export interface ApiChatOptions {
  box: SecretBox;
  /** <DELVE_DATA>/chat-keys.json; in memory without one. */
  keysFile?: string;
  /** Tests only: fake servers instead of the providers' own addresses. */
  providers?: { anthropic?: AnthropicOptions; openai?: OpenAiOptions };
  maxTurns?: number;
  maxToolCalls?: number;
  timeLimitMs?: number;
  log?: (msg: string) => void;
}

/** Quillwarren's MCP tools in this process, with pictures kept (these models can look at them). */
async function toolsInProcess(ctx: AppContext, base: string): Promise<{ tools: McpToolInfo[]; run: ToolRunner; close(): Promise<void> }> {
  const server = buildMcpServer(ctx.service, base, ctx.info.version, ctx.images, ctx.props);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'delve-api-chat', version: ctx.info.version });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return {
    tools: tools as McpToolInfo[],
    async run(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
      const pictures: Picture[] = [];
      const text: string[] = [];
      for (const c of res.content ?? []) {
        if (c.type === 'text') text.push(c.text ?? '');
        else if (c.type === 'image' && c.data && c.mimeType) pictures.push({ data: c.data, mimeType: c.mimeType });
        else text.push(`[${c.type} left out]`);
      }
      return { text: text.join('\n').trim(), isError: Boolean(res.isError), pictures };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

class History {
  private readonly items = new Map<string, { at: number; turns: { request: string; answer: string }[] }>();

  get(id: string | undefined): { request: string; answer: string }[] {
    return (id && this.items.get(id)?.turns) || [];
  }

  add(id: string, request: string, answer: string): void {
    const now = Date.now();
    for (const [k, v] of this.items) if (now - v.at > 6 * 3600_000) this.items.delete(k);
    const c = this.items.get(id) ?? { at: now, turns: [] };
    c.at = now;
    c.turns.push({ request, answer });
    if (c.turns.length > 20) c.turns.shift();
    this.items.set(id, c);
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value!);
  }
}

export type ApiSettingsOf = (p: KeyProvider) => ApiModelSettings;

export function apiChat(ctx: AppContext, o: ApiChatOptions) {
  const keys = new KeyStore(o.keysFile, o.box);
  const providers: Record<KeyProvider, ApiProvider> = { anthropic: anthropicProvider(o.providers?.anthropic), openai: openAiProvider(o.providers?.openai) };
  const history = new History();
  const log = o.log ?? (() => {});
  const timeLimitMs = o.timeLimitMs ?? 15 * 60_000;

  return {
    keys,

    /** What the settings pane shows for these backends (never a key). */
    view(settingsOf: ApiSettingsOf) {
      return {
        labels: API_LABELS,
        keys: Object.fromEntries(
          KEY_PROVIDERS.map((p) => {
            const s = settingsOf(p);
            const models = s.models?.length ? s.models : p === 'anthropic' ? CLAUDE_CHOICES : [];
            return [p, { ...keys.info(p), model: s.model, models, note: NOTES[p], placeholder: PLACEHOLDER[p], getKey: GET_KEY[p] }];
          }),
        ),
      };
    },

    /** Saves or removes the keys a settings body carries ({anthropic: {key: "sk-ant-…"}}, {openai: {key: null}}). */
    async applyKeys(body: Record<string, unknown>): Promise<void> {
      const problems: string[] = [];
      const todo: (() => Promise<void> | void)[] = [];
      for (const p of KEY_PROVIDERS) {
        const part = body[p] as Record<string, unknown> | undefined;
        if (!part || typeof part !== 'object' || !('key' in part)) continue;
        if (part.key === null || part.key === '') {
          todo.push(() => keys.remove(p));
          continue;
        }
        const k = checkKey(p, part.key);
        if ('error' in k) problems.push(`${p}.key: ${k.error}`);
        else todo.push(() => keys.set(p, k.key));
      }
      if (problems.length) throw new ValidationError(problems);
      for (const t of todo) await t();
      if (todo.length) log(`chat keys: ${KEY_PROVIDERS.filter((p) => keys.has(p)).join(', ') || 'none'} saved`);
    },

    /** "Check the key": the models the typed key (or the saved one) may use, or what is wrong, in words. */
    async test(p: KeyProvider, body: Record<string, unknown>): Promise<{ ok: boolean; models?: ModelChoice[]; error?: string }> {
      let key: string;
      if (typeof body.key === 'string' && body.key.trim()) {
        const k = checkKey(p, body.key);
        if ('error' in k) return { ok: false, error: k.error };
        key = k.key;
      } else {
        if (!keys.has(p)) return { ok: false, error: 'enter your API key first' };
        try {
          key = await keys.get(p);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      try {
        const models = await providers[p].models(key);
        if (!models.length) return { ok: false, error: `the key works, but ${providers[p].label} offers it no chat models` };
        return { ok: true, models };
      } catch (e) {
        return { ok: false, error: e instanceof ApiError ? e.message : `couldn’t check the key: ${scrubKeys((e as Error).message)}` };
      }
    },

    /** GET /api/v1/chat for these backends: a saved key is all that is checked (no request is sent). */
    status(p: KeyProvider, s: ApiModelSettings): Record<string, unknown> {
      if (!keys.has(p)) return { ok: false, model: s.model, error: 'no API key is saved: add yours in the chat settings' };
      return { ok: true, model: s.model };
    },

    /** Answers one message with the provider's model, as chat events. */
    async run(p: KeyProvider, s: ApiModelSettings, run: LocalChatRun): Promise<void> {
      const { mapId, request, base, send, signal } = run;
      const prior = history.get(request.session);
      const session = request.session && prior.length ? request.session : randomUUID();
      let key: string;
      try {
        key = await keys.get(p);
      } catch (e) {
        send({ type: 'error', code: 'bridge', error: `Couldn’t use your ${providers[p].label} key: ${(e as Error).message}` });
        return;
      }
      if (!s.model) {
        send({ type: 'error', code: 'bridge', error: 'Choose a model in the chat settings first (Check the key lists them).' });
        return;
      }
      const tools = await toolsInProcess(ctx, base);
      const t = new ApiTranslator();
      const emit = (evs: ChatEvent[]) => {
        for (const ev of evs) send(ev);
      };
      try {
        const local = taskTools();
        const current = ctx.service.store.get(mapId);
        const user = chatPrompt({ map: current.map, rev: current.rev, selection: request.selection, ...(request.view ? { view: request.view } : {}), levels: levelsOf(ctx.service, mapId) }, request.message);
        const conversation = providers[p].conversation({
          key,
          model: s.model,
          system: apiSystemPrompt(p),
          tools: [...tools.tools, ...local.map((l) => ({ name: l.def.name, description: l.def.description, inputSchema: l.def.parameters as unknown as Json }))],
          history: prior,
          user,
        });
        emit(t.start(session, s.model));
        const result = await runApiAgent({
          conversation,
          run: tools.run,
          local,
          emit,
          translator: t,
          signal,
          ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
          ...(o.maxToolCalls !== undefined ? { maxToolCalls: o.maxToolCalls } : {}),
          timeLimitMs,
        });
        log(`${p} chat ${session} map=${mapId} model=${s.model} stop=${result.stop} turns=${result.turns} calls=${result.toolCalls} errors=${result.toolErrors} ${usageLine(result.usage)} ${result.ms}ms${result.errorKind ? ` error=${result.errorKind}` : ''}`);
        if (signal.aborted) return; // the browser left or pressed Stop: nobody reads the end
        const ok = result.stop === 'answer';
        emit(t.finish({ ok, turns: result.turns, ms: result.ms, text: ok ? result.answer : apiStopText(result, { provider: providers[p].label, timeLimitMs }), usage: result.usage }));
        history.add(session, request.message, result.answer || result.lastText);
      } finally {
        await tools.close();
      }
    },
  };
}

export type ApiChat = ReturnType<typeof apiChat>;
