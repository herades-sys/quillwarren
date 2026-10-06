// Claude's plan in the chat: the forgiving parser for tool input that is still
// streaming in, plan calls in Claude Code's stream-json turning into plan
// events (and no tool events), the MCP tool `plan`, the prompt, and one whole
// fake run through the bridge (a fake `claude` replaying a recorded stream)
// and the /chat endpoint. Nothing here runs the real Claude.
// Also the fallbacks when Claude keeps no plan up to date or has none (guessed
// active steps, finishing on a good end, the activity list), with replays of
// two real chats (fixtures/chat, shrunk from Claude Code's transcripts).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createBridge } from '../src/chat/bridge.ts';
import { ACTIVITY_AFTER, ACTIVITY_LABELS, activityKind, PLAN_STATUSES, planFromInput, StreamTranslator, type ChatEvent, type PlanStep } from '../src/chat/events.ts';
import { parsePartialJson } from '../src/chat/partial-json.ts';
import { CHAT_SYSTEM_PROMPT } from '../src/chat/prompt.ts';

const SESSION = '22222222-2222-4222-8222-222222222222';

// ---------- a recorded stream, built the way Claude Code writes it ----------

/** stream-json lines for one assistant message: text, then tool calls whose input arrives in pieces of the given sizes. */
function message(id: string, blocks: ({ text: string } | { tool: string; toolId: string; input: unknown; pieces?: number[] })[]): object[] {
  const out: object[] = [{ type: 'stream_event', session_id: SESSION, event: { type: 'message_start', message: { id } } }];
  const content: object[] = [];
  blocks.forEach((b, index) => {
    if ('text' in b) {
      out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } });
      content.push({ type: 'text', text: b.text });
    } else {
      out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.toolId, name: b.tool, input: {} } } });
      const json = JSON.stringify(b.input);
      let at = 0;
      for (const n of b.pieces ?? [json.length]) {
        out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(at, at + n) } } });
        at += n;
      }
      if (at < json.length) out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(at) } } });
      content.push({ type: 'tool_use', id: b.toolId, name: b.tool, input: b.input });
    }
    out.push({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_stop', index } });
  });
  out.push({ type: 'assistant', session_id: SESSION, message: { id, content } });
  return out;
}
const result = (toolId: string, text: string, isError = false) => ({ type: 'user', session_id: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] } });
const steps = (...s: [string, PlanStep['status']][]) => s.map(([title, status]) => ({ title, status }));
/** Cut a JSON text into pieces of 7 characters: they end mid-key, mid-string and between tokens. */
const sevens = (input: unknown) => Array.from({ length: Math.ceil(JSON.stringify(input).length / 7) }, () => 7);

const PLAN_1 = { steps: steps(['Make room 3 an octagon', 'active'], ['Place a round table', 'pending'], ['Place 6 chairs', 'pending']) };
const PLAN_2 = { steps: steps(['Make room 3 an octagon', 'done'], ['Place a round table', 'active'], ['Place 6 chairs', 'pending']) };
const PLAN_3 = { steps: steps(['Make room 3 an octagon', 'done'], ['Place a round table', 'done'], ['Place 6 chairs', 'done']), note: 'Kept the west door.' };

/** Plan, octagon, plan update sent together with the table, the chairs, the final plan, the answer. */
const RECORDED: object[] = [
  { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'delve', status: 'connected' }] },
  ...message('m1', [{ tool: 'mcp__delve__plan', toolId: 'p1', input: PLAN_1, pieces: sevens(PLAN_1) }]),
  result('p1', 'ok'),
  ...message('m2', [{ tool: 'mcp__delve__resize', toolId: 't1', input: { map: 'map_x', id: 'r3', preset: { kind: 'octagon', box: [30, 8.5, 9, 9] } } }]),
  result('t1', 'Reshaped r3: 9×9 squares at 30,8.5. Map is at rev 2.'),
  ...message('m3', [
    { tool: 'mcp__delve__plan', toolId: 'p2', input: PLAN_2, pieces: sevens(PLAN_2) },
    { tool: 'mcp__delve__add_prop', toolId: 't2', input: { map: 'map_x', asset: 'furniture/table-round', at: [34.5, 13] } },
  ]),
  result('p2', 'ok'),
  result('t2', 'Added prop i1. Map is at rev 3.'),
  ...message('m4', [{ tool: 'mcp__delve__add_props_along', toolId: 't3', input: { map: 'map_x', asset: 'furniture/chair', path: [[33, 13], [36, 13]], spacing: 1 } }]),
  result('t3', 'Added 6 props. Map is at rev 4.'),
  ...message('m5', [
    { tool: 'mcp__delve__plan', toolId: 'p3', input: PLAN_3, pieces: [3, 1, 40, 2] },
    { text: 'Room 3 is now a 9 × 9 octagon with a round table and six chairs.' },
  ]),
  result('p3', 'ok'),
  { type: 'result', subtype: 'success', is_error: false, num_turns: 5, duration_ms: 4321, session_id: SESSION, result: 'Room 3 is now…' },
];

const translate = (lines: object[]) => {
  const t = new StreamTranslator();
  return lines.flatMap((l) => t.feed(JSON.stringify(l)));
};
const plans = (evs: ChatEvent[]) => evs.filter((e): e is Extract<ChatEvent, { type: 'plan' }> => e.type === 'plan');

// ---------- the parser ----------

describe('parsePartialJson', () => {
  it('parses complete JSON like JSON.parse', () => {
    const v = { a: [1, -2.5e3, 'x\n"y"é', true, false, null, { b: {} }], c: '' };
    const got = parsePartialJson(JSON.stringify(v))!;
    expect(got.value).toEqual(v);
    expect(got.open.size).toBe(0);
  });

  it('keeps what is complete and says which containers are still open', () => {
    const got = parsePartialJson('{"steps":[{"title":"A","status":"done"},{"title":"B","sta')!;
    const v = got.value as { steps: object[] };
    expect(v).toEqual({ steps: [{ title: 'A', status: 'done' }, { title: 'B' }] });
    expect(got.open.has(v)).toBe(true);
    expect(got.open.has(v.steps)).toBe(true);
    expect(got.open.has(v.steps[0]!)).toBe(false);
    expect(got.open.has(v.steps[1]!)).toBe(true);
  });

  it('leaves out strings, numbers and words cut off at the end', () => {
    expect(parsePartialJson('{"a":"hal')!.value).toEqual({});
    expect(parsePartialJson('{"a":"x\\')!.value).toEqual({});
    expect(parsePartialJson('{"a":"\\u00')!.value).toEqual({});
    expect(parsePartialJson('{"a":12')!.value).toEqual({});
    expect(parsePartialJson('{"a":1.')!.value).toEqual({});
    expect(parsePartialJson('{"a":-')!.value).toEqual({});
    expect(parsePartialJson('{"a":tr')!.value).toEqual({});
    expect(parsePartialJson('{"a":true')!.value).toEqual({ a: true });
    expect(parsePartialJson('{"a":1,')!.value).toEqual({ a: 1 });
    expect(parsePartialJson('{"ke')!.value).toEqual({});
    expect(parsePartialJson('{"key"')!.value).toEqual({});
    expect(parsePartialJson('{"key":')!.value).toEqual({});
    expect(parsePartialJson('[1, 2, ')!.value).toEqual([1, 2]);
    expect(parsePartialJson('  ')).toBeNull();
    expect(parsePartialJson('{')!.value).toEqual({});
  });

  it('says null for text that is not JSON', () => {
    expect(parsePartialJson('hello')).toBeNull();
    expect(parsePartialJson('{"a" 1}')).toBeNull();
    expect(parsePartialJson('{"a":1 "b"')).toBeNull();
    expect(parsePartialJson('{"a":"\\q"}')).toBeNull();
  });

  it('gives a growing plan at every cut of a real input', () => {
    const json = JSON.stringify(PLAN_2);
    let last = 0;
    for (let n = 0; n <= json.length; n++) {
      const got = parsePartialJson(json.slice(0, n));
      if (!got) {
        expect(n).toBe(0);
        continue;
      }
      const count = planFromInput(got.value, got.open).steps.length;
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(last).toBe(3);
  });
});

describe('planFromInput', () => {
  it('cleans titles and statuses and leaves out steps still streaming in', () => {
    expect(
      planFromInput({ steps: [{ title: '  Place   6 chairs ', status: 'done' }, { title: 'x', status: 'in_progress' }, { title: 'y', status: 'completed' }, { title: 'z', status: 'weird' }, { title: '' }, 'junk', { status: 'done' }], note: ' n ' }),
    ).toEqual({ steps: [{ title: 'Place 6 chairs', status: 'done' }, { title: 'x', status: 'active' }, { title: 'y', status: 'done' }, { title: 'z', status: 'pending' }], note: 'n' });
    expect(planFromInput(null)).toEqual({ steps: [] });
    const open = { title: 'B', status: 'pending' };
    expect(planFromInput({ steps: [{ title: 'A', status: 'active' }, open] }, new Set([open])).steps).toEqual([{ title: 'A', status: 'active' }]);
    expect(planFromInput({ steps: Array.from({ length: 50 }, (_, i) => ({ title: `s${i}`, status: 'pending' })) }).steps).toHaveLength(30);
    expect(planFromInput({ steps: [{ title: 'x'.repeat(300), status: 'pending' }] }).steps[0]!.title).toHaveLength(120);
  });
});

// ---------- the translator ----------

describe('plan calls in the stream', () => {
  it('become plan events as they stream in, and never tool events', () => {
    const evs = translate(RECORDED);
    // map tools still show; the plan's own calls and results don't
    expect(evs.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name)).toEqual(['resize', 'add_prop', 'add_props_along']);
    expect(evs.filter((e) => e.type === 'tool_done').map((e) => (e as { id: string }).id)).toEqual(['t1', 't2', 't3']);
    const ps = plans(evs);
    // the first plan grows step by step while its input arrives
    expect(ps.slice(0, 3).map((p) => p.steps.length)).toEqual([1, 2, 3]);
    expect(ps[2]).toEqual({ type: 'plan', ...PLAN_1 });
    // later plans arrive step by step too, but the list never shrinks meanwhile
    for (const p of ps.slice(3)) expect(p.steps).toHaveLength(3);
    expect(ps.at(-1)).toEqual({ type: 'plan', ...PLAN_3 });
    expect(ps.some((p) => JSON.stringify(p.steps) === JSON.stringify(PLAN_2.steps))).toBe(true);
    // no repeats: the complete assistant message after the deltas adds nothing new
    for (let i = 1; i < ps.length; i++) expect(ps[i]).not.toEqual(ps[i - 1]);
    // the order: the plan shows before the first map tool
    expect(evs.findIndex((e) => e.type === 'plan')).toBeLessThan(evs.findIndex((e) => e.type === 'tool'));
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true });
    expect(evs.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Room 3 is now a 9 × 9 octagon with a round table and six chairs.');
  });

  it('works without partial messages, and keeps the last plan when a call is broken', () => {
    const t = new StreamTranslator();
    const assistant = (id: string, input: unknown) => JSON.stringify({ type: 'assistant', session_id: SESSION, message: { id, content: [{ type: 'tool_use', id, name: 'mcp__delve__plan', input }] } });
    expect(t.feed(assistant('a', PLAN_1))).toEqual([{ type: 'plan', ...PLAN_1 }]);
    expect(t.feed(assistant('b', { steps: 'nope' }))).toEqual([]);
    expect(t.feed(JSON.stringify(result('b', 'steps: Expected array', true)))).toEqual([]);
    expect(t.feed(assistant('c', PLAN_1))).toEqual([]); // the same plan again
    expect(t.feed(assistant('d', PLAN_2))).toEqual([{ type: 'plan', ...PLAN_2 }]);
  });

  it("shows Claude Code's task list as the plan, and never as tool events", () => {
    const t = new StreamTranslator();
    const call = (id: string, tools: [string, string, unknown][]) =>
      JSON.stringify({ type: 'assistant', session_id: SESSION, message: { id, content: tools.map(([toolId, name, input]) => ({ type: 'tool_use', id: toolId, name, input })) } });
    const step = (title: string, status: string) => ({ title, status });
    expect(t.feed(call('m1', [['t1', 'TaskCreate', { subject: 'Lay the road', description: 'west to east' }], ['t2', 'TaskCreate', { subject: 'Plant the forest' }]]))).toEqual([
      { type: 'plan', steps: [step('Lay the road', 'pending')] },
      { type: 'plan', steps: [step('Lay the road', 'pending'), step('Plant the forest', 'pending')] },
    ]);
    expect(t.feed(JSON.stringify(result('t1', 'Task #4 created successfully: Lay the road')))).toEqual([]);
    expect(t.feed(JSON.stringify(result('t2', 'Task #5 created successfully: Plant the forest')))).toEqual([]);
    expect(t.feed(call('m2', [['u1', 'TaskUpdate', { taskId: '4', status: 'in_progress' }], ['a1', 'mcp__delve__add_terrain', { map: 'm' }]]))).toEqual([
      { type: 'plan', steps: [step('Lay the road', 'active'), step('Plant the forest', 'pending')] },
      { type: 'tool', id: 'a1', name: 'add_terrain', input: { map: 'm' } },
    ]);
    expect(t.feed(JSON.stringify(result('u1', 'Updated task #4 status')))).toEqual([]); // no tool_done for task calls
    // finishing the road with nothing else active makes the forest active until Claude drops it
    expect(t.feed(call('m3', [['u2', 'TaskUpdate', { taskId: '4', status: 'completed' }], ['u3', 'TaskUpdate', { taskId: '5', status: 'deleted' }], ['u4', 'TaskUpdate', { taskId: '99', status: 'completed' }], ['l1', 'TaskList', {}]]))).toEqual([
      { type: 'plan', steps: [step('Lay the road', 'done'), step('Plant the forest', 'active')] },
      { type: 'plan', steps: [step('Lay the road', 'done'), step('Plant the forest', 'skipped')] },
    ]);
  });

  it('ignores the input of other tools and of unknown blocks', () => {
    const evs = translate([
      { type: 'stream_event', session_id: SESSION, event: { type: 'message_start', message: { id: 'q' } } },
      { type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"steps":[' } } },
      ...message('q2', [{ tool: 'mcp__delve__add_room', toolId: 'r', input: { steps: PLAN_1.steps }, pieces: [5, 5, 5] }]),
    ]);
    expect(plans(evs)).toEqual([]);
    expect(evs).toEqual([{ type: 'tool', id: 'r', name: 'add_room', input: { steps: PLAN_1.steps } }]);
  });
});

// ---------- when Claude keeps no plan up to date, or has none ----------

/** One Claude Code assistant line with these tool calls ([id, name, input]). */
const calls = (id: string, tools: [string, string, unknown][]) =>
  JSON.stringify({ type: 'assistant', session_id: SESSION, message: { id, content: tools.map(([toolId, name, input]) => ({ type: 'tool_use', id: toolId, name, input })) } });
const res = (toolId: string, text: string) => JSON.stringify(result(toolId, text));
const OK = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 10, session_id: SESSION, result: 'ok' });
const FAILED = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, duration_ms: 10, session_id: SESSION, result: 'boom' });
const statuses = (evs: ChatEvent[]) => plans(evs).map((p) => p.steps.map((s) => s.status).join(','));
const feedAll = (t: StreamTranslator, lines: string[]) => lines.flatMap((l) => t.feed(l));

/** A run with three tasks created (numbers 1 to 3) and their results in. */
function threeTasks(): StreamTranslator {
  const t = new StreamTranslator();
  t.feed(calls('c', [['k1', 'TaskCreate', { subject: 'Build the rooms' }], ['k2', 'TaskCreate', { subject: 'Furnish them' }], ['k3', 'TaskCreate', { subject: 'Write the notes' }]]));
  for (const n of [1, 2, 3]) t.feed(res(`k${n}`, `Task #${n} created successfully: x`));
  return t;
}
const work = (t: StreamTranslator, id: string, name: string, input: unknown = {}) => t.feed(calls(`m-${id}`, [[id, `mcp__delve__${name}`, input]]));

/**
 * Two real chats from the editor, shrunk from Claude Code's transcripts (tool
 * calls, task calls, the kinds of objects apply_ops added, results cut short):
 * Sonnet creating 4 tasks and updating them late, and 11 messages with 148
 * tool calls and no tasks.
 */
const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, '../../../fixtures/chat', name), 'utf8').split('\n').filter(Boolean);
/** The runs in a transcript: each starts with a message the user wrote (the bridge has one translator per message). */
const runsOf = (lines: string[]) =>
  lines.reduce<string[][]>((runs, l) => {
    const m = JSON.parse(l) as { type: string; message?: { content?: unknown } };
    if (m.type === 'user' && typeof m.message?.content === 'string') runs.push([]);
    runs.at(-1)?.push(l);
    return runs;
  }, []);
const TASKS_RUN = fixture('tasks-without-updates.jsonl');
const ACTIVITY_RUN = runsOf(fixture('no-tasks-11-runs.jsonl'))[0]!;

describe('when Claude does not keep its tasks up to date', () => {
  it('makes the first pending task active when the work starts, before the tool event', () => {
    const t = threeTasks();
    const evs = work(t, 'a1', 'list_assets', { category: 'furniture' });
    expect(evs.map((e) => e.type)).toEqual(['plan', 'tool']);
    expect(statuses(evs)).toEqual(['active,pending,pending']);
    expect(plans(work(t, 'a2', 'apply_ops', { ops: [] }))).toEqual([]); // more work in the same step changes nothing
  });

  it('moves on to the next task when one is completed and none is active', () => {
    const t = threeTasks();
    work(t, 'a1', 'render');
    expect(statuses(t.feed(calls('m2', [['u1', 'TaskUpdate', { taskId: '1', status: 'completed' }]])))).toEqual(['done,active,pending']);
    expect(statuses(t.feed(calls('m3', [['u2', 'TaskUpdate', { taskId: '2', status: 'completed' }]])))).toEqual(['done,done,active']);
    expect(statuses(t.feed(calls('m4', [['u3', 'TaskUpdate', { taskId: '3', status: 'completed' }]])))).toEqual(['done,done,done']);
  });

  it('lets what Claude says win over a guess', () => {
    const t = threeTasks();
    work(t, 'a1', 'render'); // guessed: task 1
    // Claude starts task 2 itself: the guessed task 1 goes back to pending
    expect(statuses(t.feed(calls('m2', [['u1', 'TaskUpdate', { taskId: '2', status: 'in_progress' }]])))).toEqual(['pending,active,pending']);
    // a task completed while another is active guesses nothing
    expect(statuses(t.feed(calls('m3', [['u2', 'TaskUpdate', { taskId: '1', status: 'completed' }]])))).toEqual(['done,active,pending']);
    expect(plans(work(t, 'a2', 'render'))).toEqual([]);
  });

  it('counts an update sent together with its TaskCreate, once the number is known', () => {
    const t = new StreamTranslator();
    const evs = t.feed(calls('m1', [['k1', 'TaskCreate', { subject: 'A' }], ['k2', 'TaskCreate', { subject: 'B' }], ['u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' }]]));
    expect(statuses(evs)).toEqual(['pending', 'pending,pending']);
    expect(t.feed(res('k1', 'Task #7 created successfully: A'))).toEqual([{ type: 'plan', steps: [{ title: 'A', status: 'active' }, { title: 'B', status: 'pending' }] }]);
    expect(t.feed(res('k2', 'Task #8 created successfully: B'))).toEqual([]);
    expect(t.feed(res('u1', 'Updated task #7 status'))).toEqual([]);
    // a task from an earlier message (never created in this run) is left alone
    expect(t.feed(calls('m2', [['u2', 'TaskUpdate', { taskId: '3', status: 'completed' }]]))).toEqual([]);
  });

  it('finishes every open step when the run ends well, and keeps them after an error or a stop', () => {
    const good = threeTasks();
    work(good, 'a1', 'render');
    good.feed(calls('m2', [['u1', 'TaskUpdate', { taskId: '3', status: 'deleted' }]]));
    const end = good.feed(OK);
    expect(end.map((e) => e.type)).toEqual(['plan', 'done']);
    expect(statuses(end)).toEqual(['done,done,skipped']); // a dropped task stays dropped
    const bad = threeTasks();
    work(bad, 'a1', 'render');
    expect(bad.feed(FAILED).map((e) => e.type)).toEqual(['done']); // the card keeps task 1 as where it ended
    // a stop ends the stream without a result, so nothing changes either
  });

  it('does the same for the plan tool', () => {
    const t = new StreamTranslator();
    const plan = (id: string, a: PlanStep['status'], b: PlanStep['status']) => t.feed(calls(id, [[id, 'mcp__delve__plan', { steps: [{ title: 'A', status: a }, { title: 'B', status: b }] }]]));
    expect(statuses(plan('p1', 'pending', 'pending'))).toEqual(['pending,pending']);
    expect(statuses(work(t, 'a1', 'add_room'))).toEqual(['active,pending']);
    expect(statuses(plan('p2', 'done', 'pending'))).toEqual(['done,active']);
    expect(statuses(t.feed(OK))).toEqual(['done,done']);
  });
});

describe('the activity list, when Claude has no plan', () => {
  const step = (title: string, status: PlanStep['status']) => ({ title, status });

  it('starts after a few tool calls, with the phases so far', () => {
    const t = new StreamTranslator();
    expect(ACTIVITY_AFTER).toBe(4);
    for (const [i, name] of ['list_assets', 'list_assets', 'add_terrain'].entries()) expect(plans(work(t, `a${i}`, name))).toEqual([]);
    const evs = work(t, 'a3', 'add_props_along');
    expect(evs.map((e) => e.type)).toEqual(['plan', 'tool']);
    expect(plans(evs)).toEqual([{ type: 'plan', mode: 'activity', steps: [step('Looking through the props', 'done'), step('Painting terrain', 'done'), step('Placing props', 'active')] }]);
  });

  it('makes calls of one kind in a row one phase, and a kind that comes back takes up its step again', () => {
    const t = new StreamTranslator();
    for (const [i, name] of ['add_room', 'connect', 'render', 'add_prop', 'add_prop', 'render', 'focus'].entries()) work(t, `b${i}`, name);
    const back = work(t, 'b7', 'add_room');
    expect(plans(back)).toEqual([
      {
        type: 'plan',
        mode: 'activity',
        steps: [step('Building rooms and corridors', 'active'), step('Checking the map', 'done'), step('Placing props', 'done'), step('Showing the result', 'done')],
      },
    ]);
    expect(plans(work(t, 'b8', 'connect'))).toEqual([]); // the same phase: nothing new to show
  });

  it('names apply_ops by what it adds most, and notes as notes', () => {
    const add = (type: string) => ({ op: 'add', object: { type } });
    expect(activityKind('apply_ops', { ops: [{ op: 'batch', ops: [add('room'), add('room'), add('door')] }] })).toBe('build');
    expect(activityKind('apply_ops', { ops: [add('prop'), add('prop'), add('terrain')] })).toBe('props');
    expect(activityKind('apply_ops', { ops: [add('height')] })).toBe('heights');
    expect(activityKind('apply_ops', { ops: [{ op: 'delete', ids: ['r1'] }] })).toBe('adjust');
    expect(activityKind('apply_ops', { ops: [{ op: 'update', id: 'r1', set: { notes: 'x' } }] })).toBe('labels');
    expect(activityKind('update', { id: 'r1', set: { notes: 'Two ogres' } })).toBe('labels');
    expect(activityKind('update', { id: 'd1', set: { style: 'locked' } })).toBe('adjust');
    expect(activityKind('add_door', {})).toBe('doors');
    expect(activityKind('describe_map', {})).toBe('check');
    expect(activityKind('a_tool_from_later', {})).toBe('adjust');
    expect(ACTIVITY_LABELS.show).toBe('Showing the result');
  });

  it('gives way to tasks that come later', () => {
    const t = new StreamTranslator();
    for (const i of [0, 1, 2, 3]) work(t, `c${i}`, 'render');
    expect(plans(t.feed(calls('k', [['k1', 'TaskCreate', { subject: 'Fix the doors' }]])))).toEqual([{ type: 'plan', steps: [step('Fix the doors', 'pending')] }]);
    expect(plans(t.feed(OK))).toEqual([{ type: 'plan', steps: [step('Fix the doors', 'done')] }]);
  });

  it('finishes on a good end, keeps where it was after an error, and stays away from short runs', () => {
    const run = () => {
      const t = new StreamTranslator();
      for (const [i, name] of ['add_room', 'add_room', 'add_door', 'render'].entries()) work(t, `d${i}`, name);
      return t;
    };
    expect(plans(run().feed(OK))).toEqual([{ type: 'plan', mode: 'activity', steps: [step('Building rooms and corridors', 'done'), step('Adding doors and stairs', 'done'), step('Checking the map', 'done')] }]);
    expect(plans(run().feed(FAILED))).toEqual([]);
    const short = new StreamTranslator();
    work(short, 'e0', 'render');
    expect(plans(short.feed(OK))).toEqual([]);
  });
});

describe('replays of real chats (fixtures/chat)', () => {
  it('tasks created and then left alone: the card follows the work and ends with every step done', () => {
    const t = new StreamTranslator();
    const evs = feedAll(t, TASKS_RUN);
    // the four tasks, then step 1 active at the first lookup (Claude only said so 75 s and 9 lookups later)
    const firstTool = evs.findIndex((e) => e.type === 'tool');
    expect(statuses(evs.slice(0, firstTool))).toEqual(['pending', 'pending,pending', 'pending,pending,pending', 'pending,pending,pending,pending', 'active,pending,pending,pending']);
    // the transcript was copied mid-run: the last task is under way
    expect(statuses(evs).at(-1)).toBe('done,done,done,active');
    const end = t.feed(OK);
    expect(plans(end)).toEqual([
      {
        type: 'plan',
        steps: ['Build ground floor rooms and corridors', 'Build 1st floor and 2nd floor boss room', 'Add stairs, labels and connections', 'Add terrain and colour props'].map((title) => ({ title, status: 'done' })),
      },
    ]);
    expect(end.at(-1)).toMatchObject({ type: 'done', ok: true });
  });

  it('a long chat without tasks: every run with a few tool calls shows what Claude is doing', () => {
    const seen = runsOf(fixture('no-tasks-11-runs.jsonl')).map((run) => {
      const evs = feedAll(new StreamTranslator(), [...run, OK]);
      const tools = evs.filter((e) => e.type === 'tool').length;
      const ps = plans(evs);
      if (tools < ACTIVITY_AFTER) expect(ps).toEqual([]);
      else {
        expect(ps.every((p) => p.mode === 'activity')).toBe(true);
        expect(ps.slice(0, -1).every((p) => p.steps.filter((s) => s.status === 'active').length === 1)).toBe(true);
        expect(ps.at(-1)!.steps.every((s) => s.status === 'done')).toBe(true);
      }
      return { tools, phases: ps.at(-1)?.steps.map((s) => s.title) ?? [] };
    });
    expect(seen.map((s) => s.tools)).toEqual([56, 49, 11, 11, 0, 1, 5, 4, 2, 0, 9]); // 148 tool calls in 11 messages
    expect(seen[0]!.phases).toEqual(['Looking through the props', 'Painting terrain', 'Shaping heights', 'Checking the map', 'Placing props', 'Adjusting the map', 'Showing the result']);
    expect(seen[1]!.phases).toEqual(['Adjusting the map', 'Shaping heights', 'Placing props', 'Placing saved pieces', 'Checking the map', 'Showing the result']);
  });
});

// ---------- the MCP tool and the prompt ----------

describe('the plan tool', () => {
  const TOKEN = 'test-token';
  let app: FastifyInstance;
  let client: Client;
  let base: string;

  beforeAll(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    client = new Client({ name: 'delve-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  });
  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it('is listed with the statuses the chat understands', async () => {
    const { tools } = await client.listTools();
    const plan = tools.find((t) => t.name === 'plan')!;
    expect(plan.description).toContain('3 or more steps');
    expect(plan.annotations?.readOnlyHint).toBe(true);
    const props = plan.inputSchema.properties as { steps: { items: { properties: { status: { enum: string[] } } } } };
    expect(props.steps.items.properties.status.enum).toEqual([...PLAN_STATUSES]);
  });

  it('says ok and changes no map', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { template: 'test-dungeon' } })).json().id as string;
    const before = (await app.inject({ url: `/api/v1/maps/${id}`, headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const res = (await client.callTool({ name: 'plan', arguments: PLAN_2 })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    const after = (await app.inject({ url: `/api/v1/maps/${id}`, headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(after.rev).toBe(before.rev);
    expect(after.map).toEqual(before.map);
  });

  it('refuses a plan it can\'t show', async () => {
    const bad = async (args: unknown) => {
      try {
        return ((await client.callTool({ name: 'plan', arguments: args as Record<string, unknown> })) as { isError?: boolean }).isError;
      } catch {
        return true; // an invalid-params error
      }
    };
    expect(await bad({ steps: [] })).toBe(true);
    expect(await bad({ steps: [{ title: 'x', status: 'in_progress' }] })).toBe(true);
    expect(await bad({ steps: [{ title: '', status: 'pending' }] })).toBe(true);
  });
});

describe('what Claude is told about plans', () => {
  it('asks for a plan for 3 or more steps, kept current, and none for small requests', () => {
    for (const s of [
      '# Showing your plan (the task list)',
      '3 or more steps',
      'one TaskCreate call per step',
      'TaskUpdate {"taskId": "1", "status": "in_progress"} in the same message as the step\'s first tool call',
      'TaskUpdate {"taskId": "1", "status": "completed"} in the same message as the next step\'s first tool call',
      'Example, "Build a crypt',
      '"deleted"',
      'Small requests',
      'in the user\'s language',
    ]) {
      expect(CHAT_SYSTEM_PROMPT).toContain(s);
    }
  });
});

// ---------- one whole fake run: fake claude -> bridge -> /chat ----------

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  // "STREAM=<name>" in the message picks <name>.jsonl next to this file
  const name = /STREAM=(\\w+)/.exec(stdin)?.[1] ?? 'stream';
  const lines = readFileSync(new URL('./' + name + '.jsonl', import.meta.url), 'utf8').split('\\n').filter(Boolean);
  for (const l of lines) {
    process.stdout.write(l + '\\n');
    await new Promise((r) => setTimeout(r, 1));
  }
});
`;

describe('a whole fake run with a plan', () => {
  const TOKEN = 'test-token';
  let dir: string;
  let bridge: Server;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'delve-plan-'));
    const bin = join(dir, 'fake-claude.mjs');
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'stream.jsonl'), RECORDED.map((l) => JSON.stringify(l)).join('\n'));
    // the two real chats (fixtures/chat), each run ending well
    writeFileSync(join(dir, 'tasks.jsonl'), [...TASKS_RUN, OK].join('\n'));
    writeFileSync(join(dir, 'activity.jsonl'), [...ACTIVITY_RUN, OK].join('\n'));
    bridge = createBridge({ claudeBin: bin, dir: join(dir, 'home'), timeoutMs: 10_000 });
    await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
    const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, chat: { bridgeUrl, port: 8790 } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams the plan to the panel as plan events, between the map tools', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon' } })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, headers: auth, payload: { message: 'Make the chapter house an octagon with a round table and six chairs' } });
    expect(res.statusCode).toBe(200);
    const evs = res.body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
    expect(evs).toEqual(translate(RECORDED)); // the bridge and the route pass the translator's events through untouched
    const kinds = evs.map((e) => (e.type === 'tool' ? `tool:${e.name}` : e.type)).filter((k, i, all) => k !== all[i - 1]);
    expect(kinds).toEqual(['start', 'plan', 'tool:resize', 'tool_done', 'plan', 'tool:add_prop', 'tool_done', 'tool:add_props_along', 'tool_done', 'plan', 'text', 'done']);
    expect(plans(evs).at(-1)!.steps.every((s) => s.status === 'done')).toBe(true);
  });

  const chat = async (message: string) => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: {} })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/api/v1/maps/${id}/chat`, headers: auth, payload: { message } });
    expect(res.statusCode).toBe(200);
    return res.body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
  };

  it('replays the chat whose tasks were never updated: step 1 starts with the work, and all 4 end done', async () => {
    const evs = await chat('STREAM=tasks Create a 3-story dungeon battle map');
    expect(evs).toEqual(feedAll(new StreamTranslator(), [...TASKS_RUN, OK]));
    const ps = plans(evs);
    expect(ps.find((p) => p.steps.some((s) => s.status === 'active'))!.steps.map((s) => s.status)).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(ps.at(-1)!.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(evs.at(-1)).toMatchObject({ type: 'done', ok: true });
  });

  it('replays a chat without tasks as the activity list', async () => {
    const evs = await chat('STREAM=activity Make me a battle map');
    expect(evs).toEqual(feedAll(new StreamTranslator(), [...ACTIVITY_RUN, OK]));
    const ps = plans(evs);
    expect(ps.length).toBeGreaterThan(3);
    expect(ps.every((p) => p.mode === 'activity')).toBe(true);
    expect(ps.at(-1)!.steps.map((s) => `${s.status}:${s.title}`)).toEqual(['Looking through the props', 'Painting terrain', 'Shaping heights', 'Checking the map', 'Placing props', 'Adjusting the map', 'Showing the result'].map((t) => `done:${t}`));
    expect(evs.filter((e) => e.type === 'tool')).toHaveLength(56);
  });
});
