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
   * previous plan and the rest stay as they were. mode "activity": Claude has
   * no plan of its own, and the steps are what it has been doing (see
   * ACTIVITY_AFTER); the panel shows them without an estimate.
   */
  | { type: 'plan'; steps: PlanStep[]; note?: string; mode?: 'activity' }
  /** Subscription usage, 0..1 of each window. */
  | { type: 'usage'; fiveHour?: number; sevenDay?: number; status?: string; resetsAt?: number }
  | { type: 'done'; session: string; ok: boolean; turns: number; ms: number; error?: string }
  /** code "no_session": the conversation to resume is gone; start a new one. */
  | { type: 'error'; error: string; code?: 'no_session' | 'busy' | 'timeout' | 'bridge' };

type Json = Record<string, unknown>;
const TOOL_PREFIX = 'mcp__delve__';
const PLAN_TOOL = `${TOOL_PREFIX}plan`;
/**
 * Claude Code's own task list, the checklist Claude is trained to keep for longer
 * work: TaskCreate / TaskUpdate become the plan as well (TaskList and TaskGet only
 * read it). Claude ignored the plan tool; it uses these.
 */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/**
 * When Claude doesn't keep its plan up to date, or has none (Sonnet often
 * creates tasks and never updates them, or makes none at all), the card still
 * shows the work:
 * - tasks without updates: a map tool call while no step is active makes the
 *   first pending one active; a step finished while no other is active makes
 *   the next pending one active. What Claude sets itself always wins: such a
 *   guessed step goes back to pending as soon as Claude names another one.
 * - a run that ends well finishes every step that is still open; an error or a
 *   stop keeps where it was.
 * - no plan at all: after ACTIVITY_AFTER tool calls, an activity checklist built
 *   from the calls themselves (consecutive calls of one kind are one phase; a
 *   kind that comes back takes up its old phase again). Tasks or a plan that
 *   arrive later replace it.
 */
export const ACTIVITY_AFTER = 4;

/** The activity checklist's phases, in words. */
export const ACTIVITY_LABELS = {
  maps: 'Opening maps',
  lookup: 'Looking through the props',
  build: 'Building rooms and corridors',
  doors: 'Adding doors and stairs',
  props: 'Placing props',
  terrain: 'Painting terrain',
  heights: 'Shaping heights',
  labels: 'Writing labels and notes',
  segments: 'Placing saved pieces',
  draw: 'Drawing a new prop',
  fog: 'Changing the fog',
  storeys: 'Working on the storeys',
  adjust: 'Adjusting the map',
  check: 'Checking the map',
  show: 'Showing the result',
  export: 'Making a download link',
} as const;
export type ActivityKind = keyof typeof ACTIVITY_LABELS;

const TOOL_KINDS: Record<string, ActivityKind> = {
  list_maps: 'maps', create_map: 'maps',
  list_assets: 'lookup', list_images: 'lookup', list_segments: 'lookup', get_prop: 'lookup',
  add_room: 'build', connect: 'build', add_cutout: 'build', add_opening: 'build', reroute: 'build',
  add_door: 'doors', add_stairs: 'doors', label_stairs: 'doors',
  add_prop: 'props', add_props_along: 'props', add_image: 'props',
  add_terrain: 'terrain',
  add_height: 'heights',
  add_label: 'labels', add_marker: 'labels', add_inscription: 'labels',
  save_segment: 'segments', place_segment: 'segments', fill_with_segment: 'segments',
  prop_rules: 'draw', create_prop: 'draw', update_prop: 'draw', delete_prop: 'draw',
  fog: 'fog',
  add_level: 'storeys',
  update: 'adjust', move: 'adjust', resize: 'adjust', delete: 'adjust', undo: 'adjust', redo: 'adjust', set_map: 'adjust',
  render: 'check', describe_map: 'check', get_map: 'check',
  focus: 'show',
  export: 'export',
};
const OBJECT_KINDS: Record<string, ActivityKind> = {
  room: 'build', corridor: 'build', cutout: 'build', opening: 'build',
  door: 'doors', stairs: 'doors',
  prop: 'props', image: 'props',
  terrain: 'terrain',
  height: 'heights',
  label: 'labels', marker: 'labels', inscription: 'labels',
};

/** What a Delve tool call is doing (name without the mcp__delve__ prefix). apply_ops counts by what it adds most. */
export function activityKind(name: string, input: unknown): ActivityKind {
  const a = (input && typeof input === 'object' ? input : {}) as Json;
  if (name === 'update' && a.set && typeof a.set === 'object' && 'notes' in (a.set as Json)) return 'labels';
  if (name !== 'apply_ops') return TOOL_KINDS[name] ?? 'adjust';
  const count = new Map<ActivityKind, number>();
  const walk = (ops: unknown) => {
    for (const op of Array.isArray(ops) ? (ops as Json[]) : []) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'batch') walk(op.ops);
      const kind = op.op === 'add' ? OBJECT_KINDS[String((op.object as Json | undefined)?.type ?? '')] : op.op === 'update' && op.set && typeof op.set === 'object' && 'notes' in (op.set as Json) ? 'labels' : undefined;
      if (kind) count.set(kind, (count.get(kind) ?? 0) + 1);
    }
  };
  walk(a.ops);
  let best: ActivityKind = 'adjust';
  let most = 0;
  for (const [k, n] of count) if (n > most) [best, most] = [k, n];
  return best;
}

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
  /** Calls of the plan tool and of the task list: they become plan events, not tool events (the plan card shows them). */
  private planIds = new Set<string>();
  /** Claude's own plan (its tasks, or the plan tool's steps) as Claude set it; a plan call still streaming in is merged into it. */
  private own: { steps: PlanStep[]; note?: string } = { steps: [] };
  /** A step shown as active though Claude didn't say so (see ACTIVITY_AFTER), by index into own.steps. */
  private guessed: number | null = null;
  private planSent = '';
  /** The tasks created in this run, in order; id is Claude Code's task number, known once its result arrives. */
  private tasks: { id?: string; step: PlanStep }[] = [];
  /** TaskCreate calls waiting for their result (the new task's number), by tool_use id. */
  private taskCreates = new Map<string, number>();
  /** TaskUpdate inputs for tasks whose number isn't known yet. */
  private waiting: Json[] = [];
  /** Map tool calls so far (task and plan calls don't count). */
  private toolCalls = 0;
  /** What Claude has been doing, while it has no plan of its own. */
  private phases: { kind: ActivityKind; step: PlanStep }[] = [];
  /** The plan last sent was the activity checklist. */
  private activityShown = false;

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
      case 'result': {
        this.done = true;
        const ok = m.is_error !== true && m.subtype === 'success';
        return [
          ...(ok ? this.finishPlan() : []), // an error keeps where it was
          {
            type: 'done',
            session: this.session,
            ok,
            turns: Number(m.num_turns ?? 0),
            ms: Number(m.duration_ms ?? 0),
            ...(ok ? {} : { error: String(m.result || m.subtype || 'Claude stopped with an error') }),
          },
        ];
      }
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
      if (!got.steps.length) return [];
      // The steps finished so far replace the first ones; the rest of the last plan stays until the call is complete.
      const note = got.note ?? this.own.note;
      return this.setOwn({ steps: [...got.steps, ...this.own.steps.slice(got.steps.length)], ...(note ? { note } : {}) });
    }
    return [];
  }

  private sendPlan(p: { steps: PlanStep[]; note?: string; mode?: 'activity' }): ChatEvent[] {
    if (!p.steps.length) return []; // nothing usable yet, or a broken call: keep showing the last plan
    this.activityShown = p.mode === 'activity';
    const key = JSON.stringify(p);
    if (key === this.planSent) return [];
    this.planSent = key;
    return [{ type: 'plan', ...p }];
  }

  /** Claude's own plan as shown: as Claude set it, plus the step guessed to be active while Claude names none. */
  private shown(): { steps: PlanStep[]; note?: string } {
    const steps = this.own.steps.map((s) => ({ ...s }));
    const g = this.guessed === null ? undefined : steps[this.guessed];
    if (g?.status === 'pending' && !steps.some((s) => s.status === 'active')) g.status = 'active';
    return { steps, ...(this.own.note ? { note: this.own.note } : {}) };
  }

  /**
   * Claude changed its own plan. If it names an active step, that one counts
   * and the guess is dropped; if it finished a step and none is active, the
   * next pending one is guessed to be active.
   */
  private setOwn(next: { steps: PlanStep[]; note?: string }): ChatEvent[] {
    if (!next.steps.length) return []; // a broken call: keep the last plan
    const before = this.own.steps;
    this.own = next;
    const steps = next.steps;
    if (steps.some((s) => s.status === 'active')) this.guessed = null;
    else {
      if (this.guessed !== null && steps[this.guessed]?.status !== 'pending') this.guessed = null;
      const finished = steps.flatMap((s, i) => (s.status === 'done' && before[i]?.status !== 'done' ? [i] : []));
      if (this.guessed === null && finished.length) {
        const after = Math.max(...finished);
        const next = steps.findIndex((s, i) => i > after && s.status === 'pending');
        const first = steps.findIndex((s) => s.status === 'pending');
        this.guessed = next >= 0 ? next : first >= 0 ? first : null;
      }
    }
    return this.sendPlan(this.shown());
  }

  /** A map tool call: work goes on in some step, or in the activity checklist. */
  private working(name: string, input: unknown): ChatEvent[] {
    this.toolCalls++;
    if (this.own.steps.length) {
      const shown = this.shown();
      if (shown.steps.some((s) => s.status === 'active')) return [];
      const first = this.own.steps.findIndex((s) => s.status === 'pending');
      if (first < 0) return [];
      this.guessed = first;
      return this.sendPlan(this.shown());
    }
    const kind = activityKind(name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input);
    for (const p of this.phases) if (p.kind !== kind && p.step.status === 'active') p.step.status = 'done';
    const phase = this.phases.find((p) => p.kind === kind);
    if (phase) phase.step.status = 'active';
    else if (this.phases.length < PLAN_MAX_STEPS) this.phases.push({ kind, step: { title: ACTIVITY_LABELS[kind], status: 'active' } });
    if (this.toolCalls < ACTIVITY_AFTER) return [];
    return this.sendPlan({ steps: this.phases.map((p) => ({ ...p.step })), mode: 'activity' });
  }

  /** The run ended well: every step still open is finished. */
  private finishPlan(): ChatEvent[] {
    const close = (s: PlanStep): PlanStep => (s.status === 'active' || s.status === 'pending' ? { ...s, status: 'done' } : s);
    if (this.own.steps.length) {
      const shown = this.shown();
      return this.sendPlan({ ...shown, steps: shown.steps.map(close) });
    }
    if (this.activityShown) return this.sendPlan({ steps: this.phases.map((p) => close(p.step)), mode: 'activity' });
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
        if (name === PLAN_TOOL) {
          this.planIds.add(String(c.id ?? ''));
          out.push(...this.setOwn(planFromInput(c.input)));
        } else if (TASK_TOOLS.has(name)) {
          this.planIds.add(String(c.id ?? ''));
          out.push(...this.task(name, String(c.id ?? ''), (c.input ?? {}) as Json));
        } else {
          // the plan first, so the panel counts this call to the step it belongs to
          out.push(...this.working(name, c.input));
          out.push({ type: 'tool', id: String(c.id ?? ''), name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input: c.input ?? {} });
        }
        this.needBreak = true;
      }
    }
    return out;
  }

  /** A TaskCreate or TaskUpdate call: the tasks of this run become the plan. */
  private task(name: string, useId: string, a: Json): ChatEvent[] {
    const title = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, PLAN_MAX_TITLE) : '');
    // Claude Code's statuses are pending / in_progress / completed, and deleted for a dropped task
    const status = (v: unknown, fallback: PlanStatus): PlanStatus => {
      const s = String(v ?? '').toLowerCase();
      if (s === 'deleted') return 'skipped';
      return (PLAN_STATUSES as readonly string[]).includes(s) ? (s as PlanStatus) : (PLAN_ALIASES[s] ?? fallback);
    };
    if (name === 'TaskCreate') {
      const t = title(a.subject) || title(a.activeForm) || title(a.description);
      if (!t || this.tasks.length >= PLAN_MAX_STEPS) return [];
      this.taskCreates.set(useId, this.tasks.length);
      this.tasks.push({ step: { title: t, status: status(a.status, 'pending') } });
    } else if (name === 'TaskUpdate') {
      const task = this.tasks.find((x) => x.id !== undefined && x.id === String(a.taskId ?? ''));
      if (!task) {
        // sent in the same message as its TaskCreate, before the result gave the number: try again then
        // (or a task from an earlier message, which never matches)
        if (this.taskCreates.size) this.waiting.push(a);
        return [];
      }
      if (a.status !== undefined) task.step.status = status(a.status, task.step.status);
      if (title(a.subject)) task.step.title = title(a.subject);
    } else return [];
    return this.setOwn({ steps: this.tasks.map((x) => ({ ...x.step })) });
  }

  private toolResults(msg: Json | undefined): ChatEvent[] {
    const content = Array.isArray(msg?.content) ? (msg!.content as Json[]) : [];
    // a created task's number, from its result ("Task #3 created successfully: ...")
    let numbered = false;
    for (const c of content) {
      const useId = String(c.tool_use_id ?? '');
      const i = c.type === 'tool_result' ? this.taskCreates.get(useId) : undefined;
      const m = i === undefined ? null : /#(\d+)/.exec(textOf(c.content));
      if (m && i !== undefined && this.tasks[i]) {
        this.tasks[i]!.id = m[1];
        this.taskCreates.delete(useId);
        numbered = true;
      }
    }
    const out: ChatEvent[] = [];
    if (numbered && this.waiting.length) {
      const waiting = this.waiting;
      this.waiting = [];
      for (const a of waiting) {
        if (this.tasks.some((x) => x.id === String(a.taskId ?? ''))) out.push(...this.task('TaskUpdate', '', a));
        else if (this.taskCreates.size) this.waiting.push(a); // its TaskCreate may still be waiting for its result
      }
    }
    out.push(
      ...content
        .filter((c) => c.type === 'tool_result' && !this.planIds.has(String(c.tool_use_id ?? '')))
        .map((c) => ({ type: 'tool_done' as const, id: String(c.tool_use_id ?? ''), ok: c.is_error !== true, text: textOf(c.content).slice(0, 400) })),
    );
    return out;
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
