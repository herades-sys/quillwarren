// Chat events: what the browser's chat panel receives, one JSON object per
// line. The bridge turns Claude Code's stream-json output into these, and the
// Delve server passes them through.

export type ChatEvent =
  | { type: 'start'; session: string; model?: string }
  /** A piece of Claude's reply; append it to the current message. */
  | { type: 'text'; text: string }
  /** Claude called a Delve tool. name has no "mcp__delve__" prefix. */
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  /** Subscription usage, 0..1 of each window. */
  | { type: 'usage'; fiveHour?: number; sevenDay?: number; status?: string; resetsAt?: number }
  | { type: 'done'; session: string; ok: boolean; turns: number; ms: number; error?: string }
  /** code "no_session": the conversation to resume is gone; start a new one. */
  | { type: 'error'; error: string; code?: 'no_session' | 'busy' | 'timeout' | 'bridge' };

type Json = Record<string, unknown>;
const TOOL_PREFIX = 'mcp__delve__';

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && (c as Json).type === 'text' ? String((c as Json).text ?? '') : ''))
    .join('\n');
};

/** Feed Claude Code `--output-format stream-json --include-partial-messages` lines, get chat events. */
export class StreamTranslator {
  session = '';
  done = false;
  private wroteText = false;
  private needBreak = false;
  /** Assistant messages whose text already arrived as deltas. */
  private streamed = new Set<string>();
  private current = '';

  feed(line: string): ChatEvent[] {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return [];
    }
    if (typeof m.session_id === 'string') this.session = m.session_id;
    switch (m.type) {
      case 'system':
        return m.subtype === 'init' ? this.init(m) : [];
      case 'stream_event':
        return this.partial(m.event as Json | undefined);
      case 'assistant':
        return this.assistant(m.message as Json | undefined);
      case 'user':
        return this.toolResults(m.message as Json | undefined);
      case 'rate_limit_event':
        return this.usage(m.rate_limit_info as Json | undefined);
      case 'result':
        this.done = true;
        return [
          {
            type: 'done',
            session: this.session,
            ok: m.is_error !== true && m.subtype === 'success',
            turns: Number(m.num_turns ?? 0),
            ms: Number(m.duration_ms ?? 0),
            ...(m.is_error === true || m.subtype !== 'success' ? { error: String(m.result || m.subtype || 'Claude stopped with an error') } : {}),
          },
        ];
      default:
        return [];
    }
  }

  private init(m: Json): ChatEvent[] {
    const out: ChatEvent[] = [{ type: 'start', session: this.session, ...(typeof m.model === 'string' ? { model: m.model } : {}) }];
    const servers = Array.isArray(m.mcp_servers) ? (m.mcp_servers as Json[]) : [];
    const delve = servers.find((s) => s.name === 'delve');
    if (!delve || delve.status !== 'connected') {
      out.push({ type: 'error', error: `Claude couldn't reach Delve's map tools (${delve ? String(delve.status) : 'not loaded'}).`, code: 'bridge' });
    }
    return out;
  }

  private text(t: string): ChatEvent[] {
    if (!t) return [];
    const prefix = this.needBreak && this.wroteText ? '\n\n' : '';
    this.needBreak = false;
    this.wroteText = true;
    return [{ type: 'text', text: prefix + t }];
  }

  private partial(ev: Json | undefined): ChatEvent[] {
    if (!ev) return [];
    if (ev.type === 'message_start') {
      this.current = String((ev.message as Json | undefined)?.id ?? '');
      return [];
    }
    const delta = ev.delta as Json | undefined;
    if (ev.type === 'content_block_delta' && delta?.type === 'text_delta') {
      if (this.current) this.streamed.add(this.current);
      return this.text(String(delta.text ?? ''));
    }
    return [];
  }

  private assistant(msg: Json | undefined): ChatEvent[] {
    const out: ChatEvent[] = [];
    const content = Array.isArray(msg?.content) ? (msg!.content as Json[]) : [];
    const already = this.streamed.has(String(msg?.id ?? ''));
    for (const c of content) {
      if (c.type === 'text' && !already) out.push(...this.text(String(c.text ?? '')));
      if (c.type === 'tool_use') {
        const name = String(c.name ?? '');
        out.push({ type: 'tool', id: String(c.id ?? ''), name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input: c.input ?? {} });
        this.needBreak = true;
      }
    }
    return out;
  }

  private toolResults(msg: Json | undefined): ChatEvent[] {
    const content = Array.isArray(msg?.content) ? (msg!.content as Json[]) : [];
    return content
      .filter((c) => c.type === 'tool_result')
      .map((c) => ({ type: 'tool_done' as const, id: String(c.tool_use_id ?? ''), ok: c.is_error !== true, text: textOf(c.content).slice(0, 400) }));
  }

  private usage(info: Json | undefined): ChatEvent[] {
    if (!info) return [];
    const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number } | undefined>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const ev: Extract<ChatEvent, { type: 'usage' }> = { type: 'usage' };
    const five = num(windows.five_hour?.utilization);
    const seven = num(windows.seven_day?.utilization);
    if (five !== undefined) ev.fiveHour = five;
    if (seven !== undefined) ev.sevenDay = seven;
    if (typeof info.status === 'string') ev.status = info.status;
    const resets = num(info.resetsAt);
    if (resets !== undefined) ev.resetsAt = resets;
    return [ev];
  }
}
