// Shared by the local-model CLIs (local-llm.ts, llm-bench.ts): the command-line
// options for the model, the model client, and the Delve server the tools run
// on (DELVE_URL + DELVE_API_TOKEN, or a throwaway one started in this process).
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import { detectApi, ollamaClient, openAiClient, type ClientOptions, type McpToolInfo, type ModelClient } from '../chat/local-agent.ts';
import { TOOL_SETS, type ToolSet } from '../chat/local-setup.ts';
import { LEAN_STEPS, NO_STEPS, parseSteps, type Steps } from '../chat/local-steps.ts';

/** The helping steps from --steps (default: LEAN_STEPS for lean, none for full). */
export function stepsOf(f: { steps?: string }, tools: ToolSet): Steps {
  return parseSteps(f.steps, tools === 'lean' ? LEAN_STEPS : NO_STEPS);
}

/** parseArgs options for the model and the loop. */
export const MODEL_OPTIONS = {
  'base-url': { type: 'string' },
  model: { type: 'string' },
  api: { type: 'string', default: 'auto' },
  'api-key': { type: 'string' },
  'num-ctx': { type: 'string' },
  think: { type: 'string' },
  temperature: { type: 'string' },
  'max-tokens': { type: 'string', default: '6000' },
  seed: { type: 'string' },
  timeout: { type: 'string', default: '600' },
  tools: { type: 'string', default: 'lean' },
  steps: { type: 'string' },
  'prompt-file': { type: 'string' },
  'max-turns': { type: 'string', default: '30' },
  'max-calls': { type: 'string', default: '80' },
  'time-limit': { type: 'string', default: '600' },
  'max-result': { type: 'string', default: '4000' },
  verbose: { type: 'boolean', default: false },
} as const;

export interface ModelFlags {
  'base-url'?: string;
  model?: string;
  api?: string;
  'api-key'?: string;
  'num-ctx'?: string;
  think?: string;
  temperature?: string;
  'max-tokens'?: string;
  seed?: string;
  timeout?: string;
  tools?: string;
  steps?: string;
  'prompt-file'?: string;
  'max-turns'?: string;
  'max-calls'?: string;
  'time-limit'?: string;
  'max-result'?: string;
  verbose?: boolean;
}

export const MODEL_HELP = `Model:
  --base-url URL     the model server, e.g. http://192.168.1.40:11434/v1 (Ollama) or http://127.0.0.1:1234/v1 (LM Studio)
  --model NAME       e.g. qwen3:8b
  --api auto|openai|ollama   auto (default): Ollama's own API when the server is Ollama (so the context size can be set), else OpenAI
  --num-ctx N        Ollama context size (default 16384 lean, 32768 full)
  --think on|off|low|medium|high   thinking (default: the model's own)
  --temperature T  --seed N  --max-tokens N (per reply, default 6000)  --timeout S (per request, default 600)
  --api-key KEY      for servers that want one (or LLM_API_KEY)
Loop:
  --tools lean|full  the tool set and prompt (default lean)
  --steps LIST       helping steps for small models: ids, final, digest, plan, "all", "none" (default: ids,final for lean, none for full)
  --prompt-file F    another system prompt (lean: placeholders {{PROPS}}, {{TERRAIN}}, {{DOOR_STYLES}})
  --max-turns N (30)  --max-calls N (80)  --time-limit S (600 per task)  --max-result N (4000 characters per tool result)
  --verbose          print every reply and tool call
Delve: DELVE_URL + DELVE_API_TOKEN for a running server (a dev server, never the live one); without them a throwaway Delve runs in this process.`;

export function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}

export function toolSet(v: string | undefined): ToolSet {
  const t = (v ?? 'lean') as ToolSet;
  if (!TOOL_SETS.includes(t)) throw new Error(`--tools must be ${TOOL_SETS.join(' or ')}`);
  return t;
}

export interface ModelSetup {
  client: ModelClient;
  api: 'ollama' | 'openai';
  baseUrl: string;
  model: string;
  numCtx?: number;
  think?: string;
  serverVersion?: string;
}

export async function makeModel(f: ModelFlags, tools: ToolSet): Promise<ModelSetup> {
  const baseUrl = f['base-url'];
  const model = f.model;
  if (!baseUrl || !model) throw new Error('--base-url and --model are required');
  const think = f.think as ClientOptions['think'];
  if (think && !['on', 'off', 'low', 'medium', 'high'].includes(think)) throw new Error('--think must be on, off, low, medium or high');
  const common: ClientOptions = {
    model,
    ...(think ? { think } : {}),
    ...(f.temperature ? { temperature: num(f.temperature, 'temperature')! } : {}),
    ...(f['max-tokens'] ? { maxTokens: num(f['max-tokens'], 'max-tokens')! } : {}),
    ...(f.seed ? { seed: num(f.seed, 'seed')! } : {}),
    timeoutMs: (num(f.timeout, 'timeout') ?? 600) * 1000,
  };
  let api = f.api ?? 'auto';
  if (!['auto', 'openai', 'ollama'].includes(api)) throw new Error('--api must be auto, openai or ollama');
  let host = new URL(baseUrl).origin;
  let serverVersion: string | undefined;
  if (api === 'auto') {
    const d = await detectApi(baseUrl);
    api = d.api;
    host = d.host;
    serverVersion = d.version;
  }
  if (api === 'ollama') {
    const numCtx = num(f['num-ctx'], 'num-ctx') ?? (tools === 'full' ? 32768 : 16384);
    return { client: ollamaClient({ ...common, host, numCtx }), api: 'ollama', baseUrl: host, model, numCtx, ...(think ? { think } : {}), ...(serverVersion ? { serverVersion } : {}) };
  }
  const apiKey = f['api-key'] ?? process.env.LLM_API_KEY;
  return { client: openAiClient({ ...common, baseUrl, ...(apiKey ? { apiKey } : {}) }), api: 'openai', baseUrl, model, ...(think ? { think } : {}) };
}

// ---------- Delve ----------

export interface Delve {
  base: string;
  token: string;
  version: string;
  mcp: Client;
  tools: McpToolInfo[];
  close(): Promise<void>;
}

export async function connectDelve(): Promise<Delve> {
  let base = process.env.DELVE_URL?.replace(/\/$/, '');
  let token = process.env.DELVE_API_TOKEN;
  let stopServer = async () => {};
  if (base) {
    if (!token) throw new Error('DELVE_URL is set but DELVE_API_TOKEN is not');
  } else {
    // a throwaway Delve in this process: in-memory maps, temp dirs for props and images
    const { buildApp } = await import('../app.ts');
    token = randomBytes(18).toString('base64url');
    const app = buildApp({ version: 'llm-bench', started: new Date().toISOString() }, { token });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    stopServer = async () => {
      await app.close();
    };
  }
  const health = (await (await fetch(`${base}/health`)).json()) as { version?: string };
  const mcp = new Client({ name: 'delve-local-llm', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const { tools } = await mcp.listTools();
  return {
    base,
    token,
    version: health.version ?? '?',
    mcp,
    tools: tools as McpToolInfo[],
    async close() {
      await mcp.close();
      await stopServer();
    },
  };
}

async function rest(d: Delve, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${d.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${d.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function createMap(d: Delve, o: { name: string; template: 'empty' | 'test-dungeon'; unit?: string }): Promise<{ id: string; rev: number; map: DelveMap }> {
  return (await (await rest(d, 'POST', '/api/v1/maps', { name: o.name, template: o.template, ...(o.unit ? { unit: o.unit } : {}), by: 'llm-bench' })).json()) as { id: string; rev: number; map: DelveMap };
}

export async function getMap(d: Delve, id: string): Promise<{ rev: number; map: DelveMap }> {
  return (await (await rest(d, 'GET', `/api/v1/maps/${encodeURIComponent(id)}`)).json()) as { rev: number; map: DelveMap };
}

export async function renderPng(d: Delve, id: string, ppg = 40): Promise<Buffer> {
  return Buffer.from(await (await rest(d, 'GET', `/api/v1/maps/${encodeURIComponent(id)}/render.png?view=gm&ppg=${ppg}`)).arrayBuffer());
}

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
