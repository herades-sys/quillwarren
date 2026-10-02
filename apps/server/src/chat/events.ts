// Chat events: what the browser's chat panel receives, one JSON object per
// line. The bridge turns Claude Code's stream-json output into these, and the
// Delve server passes them through.
import { parsePartialJson } from './partial-json.ts';

/** A step of Claude's plan (the MCP tool `plan`, see mcp.ts). */
export const PLAN_STATUSES = ['pending', 'active', 'done', 'skipped'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanStep {
  title: string;
  status: PlanStatus;
}
export const PLAN_MAX_STEPS = 30;
export const PLAN_MAX_TITLE = 120;

export type ChatEvent =
  | { type: 'start'; session: string; model?: string }
  /** A piece of Claude's reply; append it to the current message. */
  | { type: 'text'; text: string }
  /** Claude called a Delve tool. name has no "mcp__delve__" prefix. Calls of `plan` come as plan events instead. */
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  /**
   * Claude's plan for this reply, the whole list each time (it replaces the
   * last one). Sent as the plan call streams in, so it shows at once; while a
   * call is still arriving, its finished steps replace the first ones of the
   * previous plan and the rest stay as they were.
   */
  | { type: 'plan'; steps: PlanStep[]; note?: string }
  /** Subscription usage, 0..1 of each window. */
  | { type: 'usage'; fiveHour?: number; sevenDay?: number; status?: string; resetsAt?: number }
  | { type: 'done'; session: string; ok: boolean; turns: number; ms: number; error?: string }
  /** code "no_session": the conversation to resume is gone; start a new one. */
  | { type: 'error'; error: string; code?: 'no_session' | 'busy' | 'timeout' | 'bridge' };

type Json = Record<string, unknown>;
const TOOL_PREFIX = 'mcp__delve__';
const PLAN_TOOL = `${TOOL_PREFIX}plan`;

const PLAN_ALIASES: Record<string, PlanStatus> = { in_progress: 'active', running: 'active', completed: 'done', complete: 'done', finished: 'done', skip: 'skipped', todo: 'pending' };

/** The steps and note of a plan tool input; open holds the parts still streaming in (they are left out). */
export function planFromInput(input: unknown, open: Set<object> = new Set()): { steps: PlanStep[]; note?: string } {
  const a = (input && typeof input === 'object' ? input : {}) as Json;
  const steps: PlanStep[] = [];
  for (const s of Array.isArray(a.steps) ? (a.steps as unknown[]) : []) {
    if (!s || typeof s !== 'object' || open.has(s) || steps.length >= PLAN_MAX_STEPS) continue;
    const { title, status } = s as Json;
    const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, PLAN_MAX_TITLE) : '';
    if (!t) continue;
    const st = String(status ?? '').toLowerCase();
    steps.push({ title: t, status: (PLAN_STATUSES as readonly string[]).includes(st) ? (st as PlanStatus) : (PLAN_ALIASES[st] ?? 'pending') });
  }
  const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 300) : undefined;
  return note ? { steps, note } : { steps };
}

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
  /** tool_use blocks of the message streaming now, by content block index, with their input so far. */
  private blocks = new Map<number, { id: string; name: string; json: string }>();
  /** Calls of the plan tool: they become plan events, not tool events (the plan card shows them). */
  private planIds = new Set<string>();
  /** The plan as last sent: a call that is still streaming in is merged into it. */
  private plan: { steps: PlanStep[]; note?: string } = { steps: [] };
  private planSent = '';

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
      this.blocks.clear();
      return [];
    }
    if (ev.type === 'content_block_start') {
      const b = ev.content_block as Json | undefined;
      if (b?.type === 'tool_use') this.blocks.set(Number(ev.index ?? -1), { id: String(b.id ?? ''), name: String(b.name ?? ''), json: '' });
      return [];
    }
    const delta = ev.delta as Json | undefined;
    if (ev.type === 'content_block_delta' && delta?.type === 'text_delta') {
      if (this.current) this.streamed.add(this.current);
      return this.text(String(delta.text ?? ''));
    }
    if (ev.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
      const b = this.blocks.get(Number(ev.index ?? -1));
      if (!b || b.name !== PLAN_TOOL) return [];
      this.planIds.add(b.id);
      b.json += String(delta.partial_json ?? '');
      const parsed = parsePartialJson(b.json);
      if (!parsed) return [];
      const got = planFromInput(parsed.value, parsed.open);
      // The steps finished so far replace the first ones; the rest of the last plan stays until the call is complete.
      const note = got.note ?? this.plan.note;
      return this.sendPlan({ steps: [...got.steps, ...this.plan.steps.slice(got.steps.length)], ...(note ? { note } : {}) });
    }
    return [];
  }

  private sendPlan(p: { steps: PlanStep[]; note?: string }): ChatEvent[] {
    if (!p.steps.length) return []; // nothing usable yet, or a broken call: keep showing the last plan
    this.plan = p;
    const key = JSON.stringify(p);
    if (key === this.planSent) return [];
    this.planSent = key;
    return [{ type: 'plan', ...p }];
  }

  private assistant(msg: Json | undefined): ChatEvent[] {
    const out: ChatEvent[] = [];
    const content = Array.isArray(msg?.content) ? (msg!.content as Json[]) : [];
    const already = this.streamed.has(String(msg?.id ?? ''));
    for (const c of content) {
      if (c.type === 'text' && !already) out.push(...this.text(String(c.text ?? '')));
      if (c.type === 'tool_use') {
        const name = String(c.name ?? '');
        if (name === PLAN_TOOL) {
          this.planIds.add(String(c.id ?? ''));
          out.push(...this.sendPlan(planFromInput(c.input)));
        } else out.push({ type: 'tool', id: String(c.id ?? ''), name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input: c.input ?? {} });
        this.needBreak = true;
      }
    }
    return out;
  }

  private toolResults(msg: Json | undefined): ChatEvent[] {
    const content = Array.isArray(msg?.content) ? (msg!.content as Json[]) : [];
    return content
      .filter((c) => c.type === 'tool_result' && !this.planIds.has(String(c.tool_use_id ?? '')))
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
