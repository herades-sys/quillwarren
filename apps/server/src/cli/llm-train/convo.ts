// One training conversation, assembled by the program: the system prompt and
// tools from buildSetup (lean), each user message framed with the context
// block exactly as the local harness frames it, every tool call run through
// Delve's real MCP tools (in process), the results trimmed as the harness
// trims them, and the harness hooks (harness-hooks.ts) at the places the
// harness would add its own messages.
import type { DelveMap } from '@delve/core';
import { trimText, type AgentMessage, type Json } from '../../chat/local-agent.ts';
import { buildSetup, type Setup } from '../../chat/local-setup.ts';
import { Delve, type ToolRun } from './delve.ts';
import { DEFAULT_REPEAT_NOTE, HARNESS_HOOKS, type HarnessHooks, type HookCall, type HookContext } from './harness-hooks.ts';
import { hashSeed } from './rng.ts';
import { hiddenArgs, ordered, type Call } from './tools.ts';

/** What the harness cuts tool results to (local-agent.ts maxResultChars, `--max-result`). */
export const MAX_RESULT_CHARS = 4000;

export interface Step {
  id: string;
  name: string;
  args: Json;
  run: ToolRun;
  /** Held back: an earlier call of the same reply failed, so the harness didn't run this one (batch hook). */
  notRun?: boolean;
}

/** What happened in a turn, in order, for the replay. */
export type TurnEvent = { kind: 'step'; calls: Call[] } | { kind: 'answer'; text: string };

export interface Turn {
  request: string;
  selection?: string[];
  steps: Step[][];
  /** The last answer of the turn. */
  answer: string;
  events: TurnEvent[];
  /** The map when the user message arrived. */
  start: DelveMap;
  /** The turn's calls as the harness records them (for the hooks). */
  records: HookCall[];
  /** The final check ran (once per request) and, if it objected, what it said. */
  checked: boolean;
  finalCheck?: string;
}

export class Convo {
  readonly delve: Delve;
  readonly mapId: string;
  readonly setup: Setup;
  readonly seed: number;
  readonly hooks: HarnessHooks;
  readonly messages: AgentMessage[] = [];
  readonly turns: Turn[] = [];
  private calls = 0;
  private lastKey = '';
  private repeats = 0;

  constructor(delve: Delve, mapId: string, seed: number, hooks: HarnessHooks = HARNESS_HOOKS) {
    this.delve = delve;
    this.mapId = mapId;
    this.seed = seed;
    this.hooks = hooks;
    this.setup = buildSetup('lean', delve.tools, mapId);
    this.messages.push({ role: 'system', content: this.setup.system });
  }

  get map(): DelveMap {
    return this.delve.get(this.mapId).map;
  }

  get rev(): number {
    return this.delve.get(this.mapId).rev;
  }

  /** The turn in progress. */
  get turn(): Turn {
    const t = this.turns[this.turns.length - 1];
    if (!t) throw new Error('no user message yet');
    return t;
  }

  private ctx(): HookContext {
    const { map, rev } = this.delve.get(this.mapId);
    const t = this.turns[this.turns.length - 1];
    return {
      map,
      rev,
      start: t?.start ?? map,
      request: t?.request ?? '',
      turn: Math.max(0, this.turns.length - 1),
      messages: this.messages,
      records: t?.records ?? [],
      exec: async (name, args) => {
        const r = await this.delve.call(this.mapId, name, { ...args, map: this.mapId });
        return { text: r.text, isError: r.isError };
      },
    };
  }

  private async hook(which: 'afterUser' | 'afterTools' | 'beforeAnswer'): Promise<void> {
    const fn = this.hooks[which];
    if (!fn) return;
    for (const m of await fn(this.ctx())) this.messages.push(m);
  }

  /** A user message: the context block of the map as it is now, then the request. Each user message starts a run of the harness. */
  async user(request: string, opts: { selection?: string[] } = {}): Promise<void> {
    const { map, rev } = this.delve.get(this.mapId);
    this.turns.push({ request, ...(opts.selection?.length ? { selection: opts.selection } : {}), steps: [], answer: '', events: [], start: structuredClone(map), records: [], checked: false });
    this.lastKey = '';
    this.repeats = 0;
    let content = this.setup.user({ map, rev, ...(opts.selection?.length ? { selection: opts.selection } : {}) }, request);
    if (this.hooks.frameUser) content = this.hooks.frameUser(content, this.ctx());
    this.messages.push({ role: 'user', content });
    await this.hook('afterUser');
  }

  /**
   * One assistant reply with these tool calls (several are sent together,
   * like a model's parallel calls), run in order as runAgent runs them: each
   * result cut to MAX_RESULT_CHARS, the repeat note on a third identical call
   * in a row, and with the batch hook, the calls after a failed one held back.
   */
  async step(...calls: Call[]): Promise<ToolRun[]> {
    if (!calls.length) throw new Error('a step needs a call');
    const turn = this.turn;
    const reply = turn.steps.length + 1;
    turn.events.push({ kind: 'step', calls });
    const steps: Step[] = calls.map((c) => {
      const o = ordered(c);
      return { id: `call_${++this.calls}`, name: o.name, args: o.args, run: undefined as unknown as ToolRun };
    });
    this.messages.push({ role: 'assistant', content: '', toolCalls: steps.map((s) => ({ id: s.id, name: s.name, args: s.args })) });
    let failed: { index: number; name: string } | null = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const fixedArgs = { ...s.args, map: this.mapId };
      let text: string;
      if (failed && this.hooks.batch) {
        // held back: not run, and the harness says so
        const before = this.delve.get(this.mapId);
        s.notRun = true;
        text = this.hooks.batch.notRunText(failed);
        s.run = { text, isError: true, rev: before.rev, map: before.map, added: [], removed: [], changed: [] };
      } else {
        s.run = await this.delve.call(this.mapId, s.name, { ...s.args, ...hiddenArgs(s.name, this.mapId, hiddenSeed(this.seed, s)) });
        text = trimText(s.run.text || (s.run.isError ? 'Error.' : 'Done.'), MAX_RESULT_CHARS);
        const key = `${s.name} ${JSON.stringify(fixedArgs)}`;
        this.repeats = key === this.lastKey ? this.repeats + 1 : 0;
        this.lastKey = key;
        if (this.repeats >= 2) text += (this.hooks.repeatNote ?? DEFAULT_REPEAT_NOTE)(this.repeats + 1);
        if (s.run.isError && this.hooks.batch && i < steps.length - 1) {
          failed = { index: i, name: s.name };
          text += this.hooks.batch.heldBackNote(i, steps.slice(i + 1).map((x, k) => ({ index: i + 1 + k, name: x.name })));
        }
      }
      this.messages.push({ role: 'tool', toolCallId: s.id, name: s.name, content: text });
      turn.records.push({ turn: reply, name: s.name, args: fixedArgs, ok: !s.run.isError, result: text, ms: 0, source: 'native', repaired: false, ...(s.notRun ? { notRun: true } : {}) });
    }
    turn.steps.push(steps);
    await this.hook('afterTools');
    return steps.map((s) => s.run);
  }

  /**
   * The answer of this turn, then the harness's final check (once per
   * request): if it objects, its message follows as a user message and the
   * family must answer it (else the generator drops the conversation).
   */
  async answer(text: string): Promise<void> {
    await this.hook('beforeAnswer');
    const t = text.trim();
    const turn = this.turn;
    turn.events.push({ kind: 'answer', text: t });
    turn.answer = t;
    this.messages.push({ role: 'assistant', content: t });
    if (this.hooks.afterAnswer && !turn.checked) {
      turn.checked = true;
      const note = await this.hooks.afterAnswer({ ...this.ctx(), answer: t });
      if (note) {
        turn.finalCheck = note;
        this.messages.push({ role: 'user', content: note });
      }
    }
  }

  /** The harness's final check objected to an answer and nothing has answered it since. */
  get unanswered(): boolean {
    const last = this.messages[this.messages.length - 1];
    return last?.role === 'user' && this.turns.some((t) => t.finalCheck === last.content);
  }

  /** Every step of the conversation so far. */
  allSteps(): Step[] {
    return this.turns.flatMap((t) => t.steps.flat());
  }

  /**
   * Try calls on a copy of the map without touching the conversation: the
   * generator uses it to pick requests the straightforward call can do (or,
   * for the recovery family, ones Delve refuses for a real reason).
   */
  async probe(...calls: Call[]): Promise<ToolRun[]> {
    const box = await Sandbox.of(this.map, this.seed);
    try {
      const out: ToolRun[] = [];
      for (const c of calls) out.push(await box.run(c));
      return out;
    } finally {
      await box.close();
    }
  }

  /** A copy of the map to plan several calls on (keep what works, undo what doesn't). */
  sandbox(): Promise<Sandbox> {
    return Sandbox.of(this.map, this.seed);
  }
}

/**
 * The seed the harness would pass for add_props_along: from the conversation
 * and the call's own arguments, so a probe and the real call place the same
 * copies.
 */
export function hiddenSeed(convSeed: number, c: Call): number {
  return (hashSeed(convSeed, c.name, JSON.stringify(ordered(c).args)) % 2_000_000_000) + 1;
}

/** A throwaway copy of a map in its own Delve. */
export class Sandbox {
  private readonly d: Delve;
  readonly mapId: string;
  private readonly seed: number;

  private constructor(d: Delve, mapId: string, seed: number) {
    this.d = d;
    this.mapId = mapId;
    this.seed = seed;
  }

  static async of(map: DelveMap, convSeed: number): Promise<Sandbox> {
    const d = await Delve.open();
    d.createMap({ id: map.id, name: map.name, unit: map.grid.unit ?? '5 ft', style: map.style?.preset ?? 'classic-hatching', seed: map.seed ?? 1, objects: structuredClone(map.objects) });
    return new Sandbox(d, map.id, convSeed);
  }

  get map(): DelveMap {
    return this.d.get(this.mapId).map;
  }

  run(c: Call): Promise<ToolRun> {
    return this.d.call(this.mapId, c.name, { ...c.args, ...hiddenArgs(c.name, this.mapId, hiddenSeed(this.seed, c)) });
  }

  /** Run a call and keep it if `ok` says so; otherwise undo it and return null. */
  async keep(c: Call, ok: (r: ToolRun) => boolean): Promise<ToolRun | null> {
    const rev = this.d.get(this.mapId).rev;
    const r = await this.run(c);
    if (ok(r)) return r;
    if (r.rev > rev) await this.d.call(this.mapId, 'undo', { map: this.mapId });
    return null;
  }

  close(): Promise<void> {
    return this.d.close();
  }
}
