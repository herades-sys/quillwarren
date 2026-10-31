// OpenAI through the user's own API key: the desktop app's "OpenAI (your API
// key)" chat backend. Plain fetch to the Chat Completions API (no SDK in the
// project, and none is added), streamed, with the full Delve tool set as
// function tools (api-tools.ts). Pictures from tools (render) can't go into a
// tool message there, so they follow the tool results as a user message; a
// model that takes no pictures gets a note instead, from then on. OpenAI
// caches long prompts by itself; the usage says how much was read from it.
// The models come from /v1/models, cut to the chat models that take tools.
import { openAiTools } from './api-tools.ts';
import { ApiError, apiFetch, errorMessage, noUsage, retryAfter, type ApiConversation, type ApiProvider, type ApiToolCall, type ConversationInput, type ModelChoice, type ToolOutcome, type TurnStop } from './api-model.ts';
import type { Json } from './local-agent.ts';
import { IMAGE_NOTE } from './local-agent.ts';
import { sseEvents } from './sse.ts';

export const OPENAI_API = 'https://api.openai.com';

/** Model ids of chat models that take function tools (the rest of /v1/models is audio, images, embeddings, moderation…). */
export function openAiChatModel(id: string): boolean {
  if (!/^(gpt-|o\d)/.test(id)) return false;
  if (/(audio|realtime|transcribe|tts|search|image|instruct|embedding|moderation|whisper|dall-e|davinci|babbage|codex|deep-research|computer-use|-oss)/.test(id)) return false;
  if (/^o1-(mini|preview)/.test(id)) return false; // no tools
  return true;
}

/** Newest first: by family number, plain names before dated snapshots. */
export function sortOpenAiModels(ids: string[]): string[] {
  const num = (id: string) => {
    const m = /^gpt-(\d+(?:\.\d+)?)/.exec(id) ?? /^o(\d+)/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  const dated = (id: string) => /-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(id);
  return [...new Set(ids)].sort((a, b) => Number(dated(a)) - Number(dated(b)) || num(b) - num(a) || a.length - b.length || a.localeCompare(b));
}

export function openAiError(res: Response, body: string): ApiError {
  const msg = errorMessage(body);
  let code = '';
  try {
    code = String(((JSON.parse(body) as Json).error as Json | undefined)?.code ?? '');
  } catch {
    // not JSON
  }
  const s = res.status;
  if (s === 401) return new ApiError('auth', 'OpenAI refused the API key: it may be wrong, revoked or deleted. Check it in the chat settings.', s);
  if (code === 'insufficient_quota' || s === 402) return new ApiError('credit', 'Your OpenAI account has no credit left, or reached its spending limit. Check Billing on platform.openai.com, then try again.', s);
  if (s === 429) return new ApiError('rate', 'OpenAI’s rate limit for this key was reached. Wait a minute, then try again.', s, retryAfter(res.headers.get('retry-after')));
  if (s === 403) return new ApiError('permission', `OpenAI doesn’t allow this key to do that: ${msg}`, s);
  if (s === 404 || code === 'model_not_found') return new ApiError('model', `OpenAI doesn’t offer that model to this key (${msg}). Choose another model in the chat settings.`, s);
  if (s >= 500) return new ApiError('server', `OpenAI had a problem (HTTP ${s}). Try again in a moment.`, s, retryAfter(res.headers.get('retry-after')));
  if (s === 400 && /image/i.test(msg)) return new ApiError('images', `the model takes no pictures: ${msg}`, s);
  if (s === 400 && /context|maximum.*tokens/i.test(msg)) return new ApiError('too_large', 'The conversation got too long for the model. Start a new conversation.', s);
  return new ApiError('bad_request', `OpenAI refused the request: ${msg}`, s);
}

const STOPS: Record<string, TurnStop> = { stop: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

export interface OpenAiOptions {
  /** Tests only: a fake server instead of https://api.openai.com. Never from settings or the environment. */
  base?: string;
  retries?: number;
  pauseMs?: number;
}

export function openAiProvider(o: OpenAiOptions = {}): ApiProvider {
  const base = (o.base ?? OPENAI_API).replace(/\/$/, '');
  const host = new URL(base).host;
  const fetchOpts = { host, fail: openAiError, ...(o.retries !== undefined ? { retries: o.retries } : {}), ...(o.pauseMs !== undefined ? { pauseMs: o.pauseMs } : {}) };
  const headers = (key: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });
  /** Models that refused pictures: notes instead, from then on. */
  const noPictures = new Set<string>();

  return {
    id: 'openai',
    label: 'OpenAI',
    async models(key, signal) {
      const res = await apiFetch(`${base}/v1/models`, { headers: headers(key), signal: signal ?? AbortSignal.timeout(15_000) }, { ...fetchOpts, retries: 1 });
      const j = (await res.json()) as { data?: Json[] };
      const ids = (j.data ?? []).map((m) => String(m.id ?? '')).filter(openAiChatModel);
      return sortOpenAiModels(ids).map((id) => ({ id, name: id }));
    },

    conversation(input: ConversationInput): ApiConversation {
      const messages: Json[] = [{ role: 'system', content: input.system }];
      for (const h of input.history) {
        if (!h.request.trim() || !h.answer.trim()) continue;
        messages.push({ role: 'user', content: h.request }, { role: 'assistant', content: h.answer });
      }
      messages.push({ role: 'user', content: input.user });
      const tools = openAiTools(input.tools);
      /** Pictures waiting to follow the next tool results. */
      let pictureMessage: Json | null = null;

      return {
        async next(signal, sink) {
          for (;;) {
            const pics = pictureMessage && !noPictures.has(input.model) ? [pictureMessage] : [];
            const body = { model: input.model, messages: [...messages, ...pics], tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true } };
            let res: Response;
            try {
              res = await apiFetch(`${base}/v1/chat/completions`, { method: 'POST', headers: headers(input.key), body: JSON.stringify(body), signal }, fetchOpts);
            } catch (e) {
              if (e instanceof ApiError && e.kind === 'images' && pics.length) {
                noPictures.add(input.model); // no pictures for this model: send the request again without them
                continue;
              }
              throw e;
            }
            if (pics.length) messages.push(...pics);
            pictureMessage = null;
            if (!res.body) throw new ApiError('stream', 'OpenAI sent an empty answer');
            let id = '';
            let model = input.model;
            let text = '';
            let stop = '';
            const usage = noUsage();
            const calls = new Map<number, { id: string; name: string; args: string }>();
            for await (const ev of sseEvents(res.body)) {
              if (ev.data === '[DONE]') break;
              let d: Json;
              try {
                d = JSON.parse(ev.data) as Json;
              } catch {
                continue;
              }
              if (d.error) throw new ApiError('stream', `OpenAI stopped the answer: ${errorMessage(JSON.stringify(d))}`);
              if (!id) {
                id = typeof d.id === 'string' && d.id ? d.id : `chatcmpl-local-${Date.now()}`;
                if (typeof d.model === 'string') model = d.model;
                sink.start(id, model);
              }
              const u = d.usage as Json | undefined;
              if (u) {
                usage.input = Number(u.prompt_tokens ?? 0);
                usage.output = Number(u.completion_tokens ?? 0);
                usage.cacheRead = Number((u.prompt_tokens_details as Json | undefined)?.cached_tokens ?? 0);
              }
              const choice = ((d.choices as Json[] | undefined) ?? [])[0];
              if (!choice) continue;
              const delta = (choice.delta ?? {}) as Json;
              if (typeof delta.content === 'string' && delta.content) {
                text += delta.content;
                sink.text(delta.content);
              }
              if (typeof delta.refusal === 'string' && delta.refusal) {
                text += delta.refusal;
                sink.text(delta.refusal);
                stop = 'content_filter';
              }
              for (const tc of (delta.tool_calls as Json[] | undefined) ?? []) {
                const i = Number(tc.index ?? 0);
                const f = (tc.function ?? {}) as Json;
                let c = calls.get(i);
                if (!c) {
                  c = { id: String(tc.id ?? `call_${i}`), name: String(f.name ?? ''), args: '' };
                  calls.set(i, c);
                  sink.toolStart(i, c.id, c.name);
                } else {
                  if (typeof tc.id === 'string' && tc.id) c.id = tc.id;
                  if (typeof f.name === 'string' && f.name && !c.name) c.name = f.name;
                }
                if (typeof f.arguments === 'string' && f.arguments) {
                  c.args += f.arguments;
                  sink.toolInput(i, f.arguments);
                }
              }
              if (typeof choice.finish_reason === 'string' && choice.finish_reason && stop !== 'content_filter') stop = choice.finish_reason;
            }
            const list: ApiToolCall[] = [...calls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, c]) => {
                let parsed: Json | null = {};
                if (c.args.trim()) {
                  try {
                    const v = JSON.parse(c.args) as unknown;
                    parsed = v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
                  } catch {
                    parsed = null;
                  }
                }
                return { id: c.id, name: c.name, input: parsed, raw: c.args };
              });
            const turnStop = STOPS[stop] ?? (list.length ? 'tool_use' : 'end');
            if (turnStop !== 'refusal') {
              messages.push({
                role: 'assistant',
                content: text || null,
                ...(list.length ? { tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })) } : {}),
              });
            }
            return { id: id || `chatcmpl-${Date.now()}`, model, text, calls: list, stop: turnStop, usage };
          }
        },
        results(outcomes: ToolOutcome[]) {
          for (const r of outcomes) {
            const note = r.pictures.length && noPictures.has(input.model) ? `\n${IMAGE_NOTE}` : '';
            messages.push({ role: 'tool', tool_call_id: r.id, content: `${r.text || (r.isError ? 'Error.' : 'Done.')}${note}` });
          }
          const pictures = outcomes.flatMap((r) => r.pictures.map((p) => ({ name: r.name, p })));
          if (pictures.length && !noPictures.has(input.model)) {
            pictureMessage = {
              role: 'user',
              content: [
                { type: 'text', text: `The picture${pictures.length > 1 ? 's' : ''} returned by ${[...new Set(pictures.map((x) => x.name))].join(', ')}:` },
                ...pictures.map((x) => ({ type: 'image_url', image_url: { url: `data:${x.p.mimeType};base64,${x.p.data}` } })),
              ],
            };
          }
        },
      };
    },
  };
}
