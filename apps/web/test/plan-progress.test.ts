// Claude's plan in the chat panel: step times, the progress bar's fill, the
// time estimate and the summary a finished reply keeps (plan-progress.ts).
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CAP,
  applyPlan,
  cardHead,
  cleanSteps,
  durationText,
  finishPlan,
  leftText,
  perStep,
  planProgress,
  planSummary,
  stepText,
  timeLeft,
  withTool,
  type PlanState,
  type PlanStep,
} from '../src/plan-progress.ts';

const S = 1000;
const plan = (...s: [string, PlanStep['status']][]) => s.map(([title, status]) => ({ title, status }));
const A = 'Make room 3 an octagon';
const B = 'Place a round table';
const C = 'Place 6 chairs';
const D = 'Write the GM notes';

/** A run: the plan at 0 s, step A done at 20 s, step B done at 40 s. */
function run(): PlanState {
  let p = applyPlan(undefined, plan([A, 'active'], [B, 'pending'], [C, 'pending'], [D, 'pending']), undefined, 0);
  p = applyPlan(p, plan([A, 'done'], [B, 'active'], [C, 'pending'], [D, 'pending']), undefined, 20 * S);
  p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'active'], [D, 'pending']), undefined, 40 * S);
  return p;
}

describe('cleanSteps', () => {
  it('keeps real steps with known statuses', () => {
    expect(cleanSteps([{ title: ' A ', status: 'done' }, { title: 'B', status: 'odd' }, { title: '  ' }, null, { status: 'done' }])).toEqual(plan(['A', 'done'], ['B', 'pending']));
    expect(cleanSteps('nope')).toEqual([]);
    expect(cleanSteps(Array.from({ length: 40 }, (_, i) => ({ title: `s${i}`, status: 'pending' })))).toHaveLength(30);
  });
});

describe('applyPlan', () => {
  it('times each step from when it starts to when it is finished', () => {
    const p = run();
    expect(p.started).toBe(0);
    expect(p.times).toEqual([{ start: 0, end: 20 * S }, { start: 20 * S, end: 40 * S }, { start: 40 * S }, {}]);
  });

  it('keeps times by title when steps move, and by position when one is renamed', () => {
    let p = run();
    p = applyPlan(p, plan(['Check the corridor', 'pending'], [A, 'done'], [B, 'done'], [C, 'active'], [D, 'pending']), undefined, 45 * S);
    expect(p.times[1]).toEqual({ start: 0, end: 20 * S });
    expect(p.times[3]).toEqual({ start: 40 * S });
    expect(p.times[0]).toEqual({});
    let q = run();
    q = applyPlan(q, plan([A, 'done'], [B, 'done'], ['Place six chairs', 'active'], [D, 'pending']), undefined, 45 * S);
    expect(q.times[2]).toEqual({ start: 40 * S });
  });

  it('starts a step finished without ever being active where the step before it ended', () => {
    let p = applyPlan(undefined, plan([A, 'active'], [B, 'pending'], [C, 'pending']), undefined, 0);
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'active']), undefined, 30 * S);
    expect(p.times).toEqual([{ start: 0, end: 30 * S }, { start: 30 * S, end: 30 * S }, { start: 30 * S }]);
  });

  it('counts tool calls in the active step and starts over with the next one', () => {
    let p = applyPlan(undefined, plan([A, 'active'], [B, 'pending']), 'note', 0);
    expect(p.note).toBe('note');
    p = withTool(withTool(p));
    expect(p.tools).toBe(2);
    p = applyPlan(p, plan([A, 'active'], [B, 'pending']), undefined, 5 * S); // the same step again
    expect(p.tools).toBe(2);
    p = applyPlan(p, plan([A, 'done'], [B, 'active']), undefined, 9 * S);
    expect(p.tools).toBe(0);
    const idle = applyPlan(undefined, plan([A, 'pending']), undefined, 0);
    expect(withTool(idle)).toBe(idle);
  });

  it('forgets the times of a step put back to pending', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'active'], [C, 'pending'], [D, 'pending']), undefined, 50 * S);
    expect(p.times[1]).toEqual({ start: 20 * S });
    expect(p.times[2]).toEqual({});
  });
});

describe('the estimate', () => {
  it('waits for the first finished step', () => {
    const p = applyPlan(undefined, plan([A, 'active'], [B, 'pending'], [C, 'pending']), undefined, 0);
    expect(perStep(p)).toBeNull();
    expect(timeLeft(p, 15 * S)).toBeNull();
    expect(leftText(timeLeft(p, 15 * S))).toBe('estimating…');
  });

  it('is the average time per done step times the steps left, less what the active one has used', () => {
    const p = run();
    expect(perStep(p)).toBe(20 * S);
    // C is active since 40 s and D is pending: at 45 s, 15 s of C + 20 s of D
    expect(timeLeft(p, 45 * S)).toBe(35 * S);
    expect(leftText(timeLeft(p, 45 * S))).toBe('about 40 s left');
    // an active step that runs long still counts a quarter step
    expect(timeLeft(p, 90 * S)).toBe(25 * S);
  });

  it('skipped steps cost nothing and need no time', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'skipped'], [D, 'active']), undefined, 41 * S);
    expect(perStep(p)).toBe(20 * S);
    expect(timeLeft(p, 41 * S)).toBe(20 * S);
  });

  it('says finishing once every step is done or skipped', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'done'], [D, 'skipped']), undefined, 60 * S);
    expect(timeLeft(p, 61 * S)).toBe(0);
    expect(leftText(0)).toBe('finishing…');
  });

  it('rounds, and always says about', () => {
    expect(leftText(4 * S)).toBe('a few seconds left');
    expect(leftText(13 * S)).toBe('about 15 s left');
    expect(leftText(37 * S)).toBe('about 40 s left');
    expect(leftText(70 * S)).toBe('about 1 min left');
    expect(leftText(100 * S)).toBe('about 2 min left');
    expect(leftText(11 * 60 * S)).toBe('about 11 min left');
  });
});

describe('the progress bar', () => {
  it('fills by finished steps plus part of the active one, never reaching the next step early', () => {
    const p = run();
    // 2 of 4 done, C just started: half
    expect(planProgress(p, 40 * S)).toMatchObject({ total: 4, done: 2, skipped: 0, current: 3, fraction: 0.5 });
    // half of C's average time used: an eighth more
    expect(planProgress(p, 50 * S).fraction).toBeCloseTo(0.625);
    // long past its time, C still stays below the next step
    expect(planProgress(p, 500 * S).fraction).toBeCloseTo((2 + ACTIVE_CAP) / 4);
  });

  it('moves with tool calls before there is a time to go by', () => {
    let p = applyPlan(undefined, plan([A, 'active'], [B, 'pending']), undefined, 0);
    expect(planProgress(p, 0).fraction).toBe(0);
    p = withTool(p);
    const one = planProgress(p, 0).fraction;
    p = withTool(withTool(p));
    const three = planProgress(p, 0).fraction;
    expect(one).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(one);
    for (let i = 0; i < 30; i++) p = withTool(p);
    expect(planProgress(p, 0).fraction).toBeCloseTo(ACTIVE_CAP / 2);
  });

  it('is full when every step is finished', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'done'], [D, 'skipped']), undefined, 60 * S);
    expect(planProgress(p, 60 * S)).toMatchObject({ fraction: 1, current: 4, left: 0 });
    expect(stepText(planProgress(p, 60 * S))).toBe('4 of 4 steps');
    expect(stepText(planProgress(run(), 41 * S))).toBe('Step 3 of 4');
  });
});

describe('when the reply ends', () => {
  it('keeps a summary line with the steps and the time', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'done'], [D, 'active']), undefined, 60 * S);
    // Claude answered without the last update: the active step counts as done
    p = finishPlan(p, 'done', 72 * S);
    expect(p.steps.every((s) => s.status === 'done')).toBe(true);
    expect(p.times[3]).toEqual({ start: 60 * S, end: 72 * S });
    expect(planSummary(p, -5 * S)).toBe('4 steps · 1 min 17 s');
    expect(planSummary(p)).toBe('4 steps · 1 min 12 s');
  });

  it('counts skipped steps and steps that were never reached', () => {
    let p = run();
    p = applyPlan(p, plan([A, 'done'], [B, 'done'], [C, 'skipped'], [D, 'done']), undefined, 48 * S);
    expect(planSummary(finishPlan(p, 'done', 50 * S))).toBe('3 steps · 1 skipped · 50 s');
    const early = finishPlan(applyPlan(run(), plan([A, 'done'], [B, 'done'], [C, 'done'], [D, 'pending']), undefined, 55 * S), 'done', 56 * S);
    expect(planSummary(early)).toBe('3 of 4 steps done · 56 s');
  });

  it('shows where it stopped, and freezes there', () => {
    const p = finishPlan(run(), 'stopped', 48 * S);
    expect(p.steps[2]!.status).toBe('active');
    expect(planSummary(p)).toBe('Stopped at step 3 of 4 · 48 s');
    expect(planProgress(p, 999 * S)).toEqual(planProgress(p, 48 * S));
    expect(planSummary(finishPlan(run(), 'failed', 41 * S))).toBe('Ended at step 3 of 4 · 41 s');
    expect(planSummary({ ...run(), ended: 41 * S })).toBe('Ended at step 3 of 4 · 41 s'); // saved mid-run, no outcome
  });

  it('writes durations the short way', () => {
    expect(durationText(200)).toBe('1 s');
    expect(durationText(48 * S)).toBe('48 s');
    expect(durationText(60 * S)).toBe('1 min');
    expect(durationText(72 * S)).toBe('1 min 12 s');
    expect(durationText(12 * 60 * S + 5 * S)).toBe('12 min');
  });
});

describe('the activity list (Claude without a plan of its own)', () => {
  const L = 'Looking through the props';
  const P = 'Placing props';
  const K = 'Checking the map';
  /** Sent at 10 s (the reply started at 0 s): lookups done, props being placed. */
  const activity = () => applyPlan(undefined, plan([L, 'done'], [P, 'active']), undefined, 10 * S, 'activity');

  it('shows the time so far instead of an estimate', () => {
    const p = activity();
    expect(p.mode).toBe('activity');
    expect(cardHead(p, 72 * S, 0)).toEqual(['What Claude is doing', '1 min 12 s so far']);
    // a plan of Claude's own keeps its step count and estimate
    expect(cardHead(run(), 45 * S)).toEqual(['Step 3 of 4', 'about 40 s left']);
  });

  it('keeps its times while the phases change', () => {
    let p = activity();
    p = applyPlan(p, plan([L, 'done'], [P, 'done'], [K, 'active']), undefined, 30 * S, 'activity');
    expect(p.started).toBe(10 * S);
    expect(p.times).toEqual([{ start: 10 * S, end: 10 * S }, { start: 10 * S, end: 30 * S }, { start: 30 * S }]);
  });

  it("starts over when Claude's own tasks replace it", () => {
    const tasks = applyPlan(activity(), plan([A, 'pending'], [B, 'pending']), undefined, 50 * S);
    expect(tasks.mode).toBeUndefined();
    expect(tasks.started).toBe(50 * S);
    expect(tasks.times).toEqual([{}, {}]);
  });

  it('sums up what Claude did, or what it was doing when it ended', () => {
    const p = activity();
    expect(planSummary(finishPlan(applyPlan(p, plan([L, 'done'], [P, 'done'], [K, 'done']), undefined, 60 * S, 'activity'), 'done', 72 * S), 0)).toBe('What Claude did · 3 steps · 1 min 12 s');
    expect(planSummary(finishPlan(p, 'stopped', 48 * S), 0)).toBe('Stopped while placing props · 48 s');
    expect(planSummary(finishPlan(p, 'failed', 48 * S), 0)).toBe('Ended while placing props · 48 s');
  });
});
