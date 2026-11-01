// The agent loop for the desktop app's cloud models (Claude through the
// Anthropic API, OpenAI): ask the model, run the tools it calls through
// Quillwarren's MCP server in this process, send the results back, until it answers
// without a tool call or a limit is reached. These are strong models, so there
// is none of the small-model help of local-agent.ts runAgent (repaired JSON,
// tool calls read from text, held-back batches, final checks): every call of a
// reply runs, in order, and a call whose arguments weren't valid JSON is
// answered with an error instead of being run. Pictures (render) go back to the
// model as pictures.
//
// What the panel sees is made the same way as for the local model and the
// Claude Code bridge: the run is written as Claude Code's stream-json (with
// the text streaming in as deltas) and fed through the bridge's own
// StreamTranslator, so the text, the tool list, the plan / activity card and
// the end of a reply behave exactly alike. The task list the system prompt
// asks for (TaskCreate / TaskUpdate) is answered here (local-setup.ts
// taskTools) and becomes the plan card.
import { StreamTranslator, type ChatEvent } from './events.ts';
import { ApiError, addUsage, noUsage, type ApiConversation, type Picture, type StreamSink, type ToolOutcome, type Usage } from './api-model.ts';
import type { Json, LocalTool } from './local-agent.ts';
import { trimText } from './local-agent.ts';

const TOOL_PREFIX = 'mcp__delve__';
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
/** Claude Code's name for a tool: Quillwarren's with the MCP prefix, the task list's as they are (StreamTranslator tells them apart by that). */
const streamName = (name: string) => (TASK_TOOLS.has(name) ? name : `${TOOL_PREFIX}${name}`);

/** Writes a run as Claude Code's stream-json and turns it into chat events. */
export class ApiTranslator {
  private readonly t = new StreamTranslator();
  /** The text streamed so far in the reply being written. */
  private writing = '';

  private feed(line: Json): ChatEvent[] {
    return this.t.feed(JSON.stringify(line));
  }

  get session(): string {
    return this.t.session;
  }

  start(session: string, model: string): ChatEvent[] {
    return this.feed({ type: 'system', subtype: 'init', session_id: session, model, mcp_servers: [{ name: 'delve', status: 'connected' }] });
  }

  replyStart(id: string): ChatEvent[] {
    this.writing = '';
    return this.feed({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  }

  text(delta: string): ChatEvent[] {
    this.writing += delta;
    return this.feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
  }

  toolStart(index: number, id: string, name: string): ChatEvent[] {
    return this.feed({ type: 'stream_event', event: { type: 'content_block_start', index: index + 1, content_block: { type: 'tool_use', id, name: streamName(name) } } });
  }

  toolInput(index: number, partial: string): ChatEvent[] {
    return this.feed({ type: 'stream_event', event: { type: 'content_block_delta', index: index + 1, delta: { type: 'input_json_delta', partial_json: partial } } });
  }

  /** The finished reply: its text (already streamed, so not sent twice) and its tool calls. */
  replyEnd(id: string, text: string, calls: { id: string; name: string; input: unknown }[]): ChatEvent[] {
    const content = [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: streamName(c.name), input: c.input ?? {} }))];
    const out = this.feed({ type: 'assistant', message: { id, content } });
    this.writing = '';
    return out;
  }

  results(outcomes: ToolOutcome[]): ChatEvent[] {
    return this.feed({ type: 'user', message: { content: outcomes.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, is_error: r.isError })) } });
  }

  finish(o: { ok: boolean; turns: number; ms: number; text: string; usage: Usage }): ChatEvent[] {
    const evs = this.feed({ type: 'result', subtype: o.ok ? 'success' : 'error_during_execution', is_error: !o.ok, num_turns: o.turns, duration_ms: o.ms, result: o.text });
    // the tokens of this reply, for the panel (the bridge's own result lines never carry them here)
    return evs.map((e): ChatEvent => (e.type === 'done' ? { ...e, tokens: { input: o.usage.input, output: o.usage.output, cacheRead: o.usage.cacheRead, cacheWrite: o.usage.cacheWrite } } : e));
  }
}

export type ApiStop = 'answer' | 'turns' | 'tool_calls' | 'time' | 'errors' | 'refusal' | 'max_tokens' | 'context' | 'api_error' | 'stopped';

export interface ApiRun {
  stop: ApiStop;
  answer: string;
  /** The last thing the model said, even when the run stopped at a limit. */
  lastText: string;
  error?: string;
  errorKind?: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  usage: Usage;
  ms: number;
}

/** How a tool is run: Quillwarren's MCP tools in this process. */
export type ToolRunner = (name: string, args: Json) => Promise<{ text: string; isError: boolean; pictures: Picture[] }>;

export interface ApiLoopOptions {
  conversation: ApiConversation;
  run: ToolRunner;
  /** Tools answered here (the task list), by name. */
  local?: readonly LocalTool[];
  emit(evs: ChatEvent[]): void;
  translator: ApiTranslator;
  signal: AbortSignal;
  /** Model requests (default 40). */
  maxTurns?: number;
  /** Tool calls (default 150). */
  maxToolCalls?: number;
  /** Wall time (default 15 minutes). */
  timeLimitMs?: number;
  /** Failed tool calls in a row before stopping (default 8). */
  maxErrorsInARow?: number;
  /** Tool results are cut to this many characters (default 60 000). */
  maxResultChars?: number;
  now?: () => number;
}

export async function runApiAgent(o: ApiLoopOptions): Promise<ApiRun> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const maxTurns = o.maxTurns ?? 40;
  const maxToolCalls = o.maxToolCalls ?? 150;
  const timeLimit = o.timeLimitMs ?? 15 * 60_000;
  const maxErrors = o.maxErrorsInARow ?? 8;
  const maxResult = o.maxResultChars ?? 60_000;
  const local = new Map((o.local ?? []).map((l) => [l.def.name, l]));
  const timer = AbortSignal.timeout(timeLimit);
  const signal = AbortSignal.any([o.signal, timer]);
  const r: ApiRun = { stop: 'answer', answer: '', lastText: '', turns: 0, toolCalls: 0, toolErrors: 0, usage: noUsage(), ms: 0 };
  let errorsInARow = 0;
  const t = o.translator;
  const sink: StreamSink = {
    start: (id) => o.emit(t.replyStart(id)),
    text: (d) => o.emit(t.text(d)),
    toolStart: (i, id, name) => o.emit(t.toolStart(i, id, name)),
    toolInput: (i, p) => o.emit(t.toolInput(i, p)),
  };
  const stopped = (): ApiStop | null => (o.signal.aborted ? 'stopped' : timer.aborted ? 'time' : null);

  try {
    for (;;) {
      const s = stopped();
      if (s) {
        r.stop = s;
        break;
      }
      if (r.turns >= maxTurns) {
        r.stop = 'turns';
        break;
      }
      r.turns++;
      let turn;
      try {
        turn = await o.conversation.next(signal, sink);
      } catch (e) {
        r.stop = stopped() ?? 'api_error';
        if (r.stop === 'api_error') {
          r.error = (e as Error).message;
          r.errorKind = e instanceof ApiError ? e.kind : 'other';
        }
        break;
      }
      r.usage = addUsage(r.usage, turn.usage);
      if (turn.text.trim()) r.lastText = turn.text;
      if (turn.stop === 'refusal') {
        o.emit(t.replyEnd(turn.id, turn.text, []));
        r.stop = 'refusal';
        break;
      }
      o.emit(t.replyEnd(turn.id, turn.text, turn.calls));
      if (turn.stop === 'max_tokens' || turn.stop === 'context') {
        // a cut-off reply: its tool calls may be cut off too, so none of them runs
        r.stop = turn.stop;
        break;
      }
      if (!turn.calls.length) {
        r.answer = turn.text;
        r.stop = 'answer';
        break;
      }
      const outcomes: ToolOutcome[] = [];
      for (const c of turn.calls) {
        let out: { text: string; isError: boolean; pictures: Picture[] };
        if (r.toolCalls >= maxToolCalls) out = { text: 'Not run: the limit of tool calls for one message is reached.', isError: true, pictures: [] };
        else if (stopped()) out = { text: 'Not run: the user stopped the chat.', isError: true, pictures: [] };
        else if (c.input === null) {
          r.toolCalls++;
          out = { text: JSON.stringify({ INVALID_JSON: c.raw.slice(0, 2000) }), isError: true, pictures: [] };
        } else {
          r.toolCalls++;
          const l = local.get(c.name);
          try {
            out = l ? { text: l.run(c.input), isError: false, pictures: [] } : await o.run(c.name, c.input);
          } catch (e) {
            out = { text: `The tool call failed: ${(e as Error).message}`, isError: true, pictures: [] };
          }
        }
        if (out.isError) {
          r.toolErrors++;
          errorsInARow++;
        } else errorsInARow = 0;
        outcomes.push({ id: c.id, name: c.name, text: trimText(out.text || (out.isError ? 'Error.' : 'Done.'), maxResult), isError: out.isError, pictures: out.pictures });
      }
      o.conversation.results(outcomes);
      o.emit(t.results(outcomes));
      if (r.toolCalls >= maxToolCalls) {
        r.stop = 'tool_calls';
        break;
      }
      if (errorsInARow >= maxErrors) {
        r.stop = 'errors';
        break;
      }
    }
  } finally {
    r.ms = now() - t0;
  }
  return r;
}

/** What the panel says when a run ends without an answer. */
export function apiStopText(r: ApiRun, o: { provider: string; timeLimitMs?: number; maxErrors?: number }): string {
  const kept = 'Changes made so far are kept (undo removes them).';
  switch (r.stop) {
    case 'turns':
      return `The model stopped after ${r.turns} replies without finishing. ${kept}`;
    case 'tool_calls':
      return `The model stopped after ${r.toolCalls} tool calls. ${kept}`;
    case 'time':
      return `The model took longer than ${Math.round((o.timeLimitMs ?? 900_000) / 60_000)} minutes, so it was stopped. ${kept}`;
    case 'errors':
      return `${o.maxErrors ?? 8} tool calls in a row failed, so the model stopped. Try a smaller request. ${kept}`;
    case 'refusal':
      return `${o.provider}’s model declined this request. Try asking differently.`;
    case 'max_tokens':
      return `The model’s reply was cut off at its length limit. ${kept}`;
    case 'context':
      return 'The conversation got too long for the model. Start a new conversation.';
    case 'api_error':
      return r.error ?? `${o.provider} failed.`;
    case 'stopped':
      return `Stopped. ${kept}`;
    default:
      return 'The model stopped.';
  }
}
