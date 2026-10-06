// Claude's plan in the chat panel: the step list from the `plan` tool (as
// `plan` chat events), when each step started and finished as this browser saw
// it, the progress bar's fill and the time estimate. Pure functions; chat.ts
// draws the card. See docs/API.md, "Chat", "Claude's plan".
//
// The estimate: once a step is done, the average time per done step (from the
// first plan to the latest finished step, divided by the done steps) times the
// steps still to go, minus what the active step has already used (it counts at
// least a quarter step while it runs). Before the first step is done there is
// nothing to go by ("estimating…"); with every step done or skipped Claude is
// only answering ("finishing…").
//
// mode "activity": Claude has no plan of its own, so the server lists what it
// has been doing (chat/events.ts). There is no total to go by, so the card
// shows the time so far instead of an estimate, and a bar that only says
// "working".

export type PlanStatus = 'pending' | 'active' | 'done' | 'skipped';
export interface PlanStep {
  title: string;
  status: PlanStatus;
}
export interface StepTime {
  start?: number;
  end?: number;
}
export interface PlanState {
  steps: PlanStep[];
  note?: string;
  /** When each step started and finished (ms), by index. */
  times: StepTime[];
  /** When the first plan arrived. */
  started: number;
  /** Tool calls since the active step started (they fill its part of the bar). */
  tools: number;
  /** When the reply ended, and how. */
  ended?: number;
  outcome?: 'done' | 'stopped' | 'failed';
  /** "activity": the steps are what Claude has been doing, not a plan (no total, no estimate). */
  mode?: 'activity';
}

const STATUSES: readonly string[] = ['pending', 'active', 'done', 'skipped'];
const MAX_STEPS = 30;
/** The active step's share of the bar stays below this, so the bar never reaches the next step early. */
export const ACTIVE_CAP = 0.9;
/** Each tool call in the active step fills this share of what is left of it. */
const TOOL_FILL = 0.35;
/** While it runs, the active step still counts at least this share of a step in the estimate. */
const ACTIVE_FLOOR = 0.25;

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
const finished = (s: PlanStep) => s.status === 'done' || s.status === 'skipped';

/** Clean steps from an event: real titles, known statuses, at most 30. */
export function cleanSteps(steps: unknown): PlanStep[] {
  if (!Array.isArray(steps)) return [];
  const out: PlanStep[] = [];
  for (const s of steps as { title?: unknown; status?: unknown }[]) {
    if (!s || typeof s.title !== 'string' || !s.title.trim()) continue;
    out.push({ title: s.title.trim().slice(0, 120), status: STATUSES.includes(String(s.status)) ? (s.status as PlanStatus) : 'pending' });
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/**
 * A new plan from Claude (it replaces the whole list). Steps keep their times
 * by title, or by position when a step was renamed; a step that becomes active
 * starts now, one that is done or skipped ends now. A plan of the other mode
 * (Claude's tasks after the activity list) starts over.
 */
export function applyPlan(prev: PlanState | undefined, raw: unknown, note: string | undefined, now: number, mode?: 'activity'): PlanState {
  if (prev && prev.mode !== mode) prev = undefined;
  const steps = cleanSteps(raw);
  const old = prev?.steps ?? [];
  const used = new Set<number>();
  const match: (number | undefined)[] = steps.map((s) => {
    const j = old.findIndex((o, k) => !used.has(k) && norm(o.title) === norm(s.title));
    if (j < 0) return undefined;
    used.add(j);
    return j;
  });
  steps.forEach((_, i) => {
    if (match[i] === undefined && i < old.length && !used.has(i)) {
      used.add(i);
      match[i] = i;
    }
  });
  const started = prev?.started ?? now;
  let lastEnd = started;
  const times = steps.map((s, i) => {
    const t: StepTime = { ...(match[i] !== undefined ? prev?.times[match[i]!] : undefined) };
    if (s.status === 'active') {
      t.start ??= now;
      delete t.end;
    } else if (finished(s)) {
      t.start ??= Math.min(lastEnd, now); // finished without ever being active: it ran since the step before it
      t.end ??= now;
    } else {
      delete t.start;
      delete t.end;
    }
    if (t.end !== undefined) lastEnd = t.end;
    return t;
  });
  const wasActive = old.findIndex((s) => s.status === 'active');
  const isActive = steps.findIndex((s) => s.status === 'active');
  const sameActive = isActive >= 0 && wasActive >= 0 && match[isActive] === wasActive;
  return {
    steps,
    ...(note ? { note: note.slice(0, 300) } : {}),
    times,
    started,
    tools: sameActive ? (prev?.tools ?? 0) : 0,
    ...(prev?.ended !== undefined ? { ended: prev.ended } : {}),
    ...(prev?.outcome ? { outcome: prev.outcome } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** Claude called a map tool: the active step's part of the bar grows. */
export function withTool(p: PlanState): PlanState {
  return p.steps.some((s) => s.status === 'active') ? { ...p, tools: p.tools + 1 } : p;
}

/** The reply ended. When it ended well, a step still marked active counts as done (Claude often skips the last update). */
export function finishPlan(p: PlanState, outcome: 'done' | 'stopped' | 'failed', now: number): PlanState {
  const steps = p.steps.map((s) => (outcome === 'done' && s.status === 'active' ? { ...s, status: 'done' as const } : s));
  const times = p.times.map((t, i) => (outcome === 'done' && p.steps[i]?.status === 'active' ? { ...t, end: now } : t));
  return { ...p, steps, times, ended: now, outcome };
}

/** Average time of a done step (ms), or null before the first one is done. */
export function perStep(p: PlanState): number | null {
  const ends = p.steps.flatMap((s, i) => (s.status === 'done' && p.times[i]?.end !== undefined ? [p.times[i]!.end!] : []));
  if (!ends.length) return null;
  return Math.max(0, Math.max(...ends) - p.started) / ends.length;
}

/** Time left (ms): null while there is nothing to go by yet, 0 when every step is done or skipped. */
export function timeLeft(p: PlanState, now: number): number | null {
  const at = p.ended ?? now;
  const pending = p.steps.filter((s) => s.status === 'pending').length;
  const active = p.steps.findIndex((s) => s.status === 'active');
  if (!pending && active < 0) return 0;
  const per = perStep(p);
  if (per === null) return null;
  let activeLeft = 0;
  if (active >= 0) {
    const used = Math.max(0, at - (p.times[active]?.start ?? at));
    activeLeft = Math.max(per - used, per * ACTIVE_FLOOR);
  }
  return pending * per + activeLeft;
}

export interface PlanProgress {
  total: number;
  done: number;
  skipped: number;
  /** The step being worked on, from 1 (the last one once all are finished). */
  current: number;
  /** How full the bar is, 0 to 1. */
  fraction: number;
  /** See timeLeft. */
  left: number | null;
}

export function planProgress(p: PlanState, now: number): PlanProgress {
  const at = p.ended ?? now;
  const total = p.steps.length;
  const done = p.steps.filter((s) => s.status === 'done').length;
  const skipped = p.steps.filter((s) => s.status === 'skipped').length;
  const active = p.steps.findIndex((s) => s.status === 'active');
  let part = 0;
  if (active >= 0) {
    const per = perStep(p);
    const used = Math.max(0, at - (p.times[active]?.start ?? at));
    const byTools = 1 - (1 - TOOL_FILL) ** p.tools;
    const byTime = per ? used / per : 0;
    part = Math.min(ACTIVE_CAP, Math.max(byTools, byTime));
  }
  const next = p.steps.findIndex((s) => !finished(s));
  const current = active >= 0 ? active + 1 : next >= 0 ? next + 1 : total;
  return { total, done, skipped, current, fraction: total ? Math.min(1, (done + skipped + part) / total) : 0, left: timeLeft(p, now) };
}

/** The estimate as words: rounded, and always "about". */
export function leftText(ms: number | null): string {
  if (ms === null) return 'estimating…';
  if (ms <= 0) return 'finishing…';
  const s = ms / 1000;
  if (s < 10) return 'a few seconds left';
  if (s < 20) return `about ${Math.round(s / 5) * 5} s left`;
  if (s < 55) return `about ${Math.round(s / 10) * 10} s left`;
  if (s < 90) return 'about 1 min left';
  return `about ${Math.round(s / 60)} min left`;
}

/** "48 s", "1 min 12 s", "12 min". */
export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m >= 10 || !r ? `${m} min` : `${m} min ${r} s`;
}

const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`;

/** The line a finished reply keeps: "4 steps · 1 min 12 s", "Stopped at step 3 of 5 · 48 s". since: when the reply started. */
export function planSummary(p: PlanState, since?: number): string {
  const time = durationText((p.ended ?? p.started) - (since ?? p.started));
  if (p.mode === 'activity') {
    // no plan, so no "step 3 of 5": what Claude did, or what it was doing when it ended
    if (p.outcome === 'done') return `What Claude did · ${steps(p.steps.length)} · ${time}`;
    const doing = p.steps.find((s) => s.status === 'active');
    return `${p.outcome === 'stopped' ? 'Stopped' : 'Ended'}${doing ? ` while ${doing.title.charAt(0).toLowerCase()}${doing.title.slice(1)}` : ''} · ${time}`;
  }
  const { total, done, skipped, current } = planProgress(p, p.ended ?? p.started);
  if (p.outcome !== 'done') return `${p.outcome === 'stopped' ? 'Stopped' : 'Ended'} at step ${current} of ${total} · ${time}`;
  if (done + skipped < total) return `${done} of ${steps(total)} done · ${time}`;
  return `${steps(done)}${skipped ? ` · ${skipped} skipped` : ''} · ${time}`;
}

/** "Step 2 of 5" while working; "5 of 5 steps" once all are finished. */
export function stepText(pr: PlanProgress): string {
  return pr.done + pr.skipped >= pr.total ? `${pr.total} of ${steps(pr.total)}` : `Step ${pr.current} of ${pr.total}`;
}

/** The working card's head: [title, the right-hand text]. A plan: "Step 2 of 5" and the estimate; activity: what it is and the time so far. since: when the reply started. */
export function cardHead(p: PlanState, now: number, since?: number): [string, string] {
  if (p.mode === 'activity') return ['What Claude is doing', `${durationText(now - (since ?? p.started))} so far`];
  const pr = planProgress(p, now);
  return [stepText(pr), leftText(pr.left)];
}
