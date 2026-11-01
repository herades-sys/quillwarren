// The local-model harness (chat/local-agent.ts, chat/local-setup.ts) without a
// real model: the repair helpers, the schema conversion, and whole runs
// against a fake OpenAI-compatible server (and a fake Ollama), with a fake
// tool executor and with Quillwarren's real MCP endpoint.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DelveMap } from '@delve/core';
import { buildApp } from '../src/app.ts';
import {
  coerceArgs,
  contentText,
  detectApi,
  fixJsonText,
  IMAGE_NOTE,
  malformed,
  mcpExecutor,
  ollamaClient,
  openAiClient,
  parseArguments,
  repairJson,
  resolveToolName,
  runAgent,
  simplifySchema,
  stripThink,
  textToolCalls,
  tokensPerSecond,
  toToolDefs,
  trimText,
  type Json,
  type McpToolInfo,
  type ToolDef,
  type ToolExecutor,
} from '../src/chat/local-agent.ts';
import { buildSetup, LEAN_TOOLS, leanContext, leanPrompt, leanUser, taskTools } from '../src/chat/local-setup.ts';
import {
  callText,
  finalCheck,
  heldBackNote,
  inventedIds,
  madeText,
  LEAN_STEPS,
  mapChanges,
  newProblems,
  nextIdsLine,
  notRunText,
  parsePlan,
  parseSteps,
  planLine,
  planReminder,
  repeatNote,
  stateDigest,
  stepsText,
  unresolvedCalls,
} from '../src/chat/local-steps.ts';
import { chatContext } from '../src/chat/prompt.ts';
import { newMap as templateMap } from '../src/api.ts';
import { applyOps, type MapObject } from '@delve/core';
import type { CallRecord } from '../src/chat/local-agent.ts';

// ---------- pure helpers ----------

describe('think blocks', () => {
  it('takes them out and keeps them for counting', () => {
    expect(stripThink('<think>plan the room</think>\nDone.')).toEqual({ text: 'Done.', think: 'plan the room' });
    expect(stripThink('<think>still thinking when it was cut')).toEqual({ text: '', think: 'still thinking when it was cut' });
    // the template opened the block, so only the end is in the text
    expect(stripThink('weighing it up</think>Added r7.')).toEqual({ text: 'Added r7.', think: 'weighing it up' });
    expect(stripThink('No thinking here.')).toEqual({ text: 'No thinking here.', think: '' });
  });
});

describe('JSON repair', () => {
  const fix = (s: string) => {
    const r = repairJson(s);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it('leaves valid JSON alone', () => {
    expect(fix('{"rect": [1, 2, 3, 4]}')).toEqual({ ok: true, value: { rect: [1, 2, 3, 4] }, repaired: false });
  });
  it('fixes what small models get wrong', () => {
    expect(fix('{"rect": [1, 2, 3, 4],}').value).toEqual({ rect: [1, 2, 3, 4] });
    expect(fix("{'name': 'Armoury', 'id': 'r3'}").value).toEqual({ name: 'Armoury', id: 'r3' });
    expect(fix("{'text': 'The \"Boar\"'}").value).toEqual({ text: 'The "Boar"' });
    expect(fix('{id: "r3", set: {style: "locked"}}').value).toEqual({ id: 'r3', set: { style: 'locked' } });
    expect(fix('{"open": True, "label": None, "secret": False}').value).toEqual({ open: true, label: null, secret: false });
    expect(fix('{"rect": [16, 26, 6, 4]').value).toEqual({ rect: [16, 26, 6, 4] }); // cut off
    expect(fix('{"path": [[1, 2], [3, 4]').value).toEqual({ path: [[1, 2], [3, 4]] });
    expect(fix('Here you go:\n```json\n{"asset": "chair", "at": [8.5, 16.5]}\n```\nThat places it.').value).toEqual({ asset: 'chair', at: [8.5, 16.5] });
    expect(fix('{"a": 1 "b": 2}').value).toEqual({ a: 1, b: 2 });
    expect(fix('{"a": 1, // the first\n "b": /* two */ 2}').value).toEqual({ a: 1, b: 2 });
    expect(fix('{"at": (3.5, 5.5), "dx": +2, "dy": .5}').value).toEqual({ at: [3.5, 5.5], dx: 2, dy: 0.5 });
    expect(fix('{"text": "line one\nline two"}').value).toEqual({ text: 'line one\nline two' });
    expect(fix('{"ids": ["r1", "r2"]} and then I will check').value).toEqual({ ids: ['r1', 'r2'] });
    expect(fix('{"x": 1,').value).toEqual({ x: 1 });
    expect(fix('{"name":').value).toEqual({ name: null });
  });
  it('gives up on what is not JSON at all', () => {
    expect(repairJson('add a room please').ok).toBe(false);
    expect(fixJsonText('')).toBe('');
  });
  it('reads arguments: strings, objects, double encoding and wrappers', () => {
    expect(parseArguments({ id: 'r3' })).toEqual({ ok: true, args: { id: 'r3' }, repaired: false });
    expect(parseArguments('')).toEqual({ ok: true, args: {}, repaired: false });
    expect(parseArguments('"{\\"id\\": \\"r3\\"}"')).toEqual({ ok: true, args: { id: 'r3' }, repaired: true });
    expect(parseArguments('{"arguments": {"id": "r3"}}')).toEqual({ ok: true, args: { id: 'r3' }, repaired: true });
    expect(parseArguments({ name: 'update', parameters: { id: 'r3' } }, 'update')).toEqual({ ok: true, args: { id: 'r3' }, repaired: true });
    // a real parameter called "input" next to others is not a wrapper
    expect(parseArguments({ input: { a: 1 }, b: 2 })).toEqual({ ok: true, args: { input: { a: 1 }, b: 2 }, repaired: false });
    expect(parseArguments('[1, 2]').ok).toBe(false);
    expect(parseArguments('make it locked').ok).toBe(false);
  });
});

describe('argument types', () => {
  const schema = simplifySchema({
    type: 'object',
    properties: {
      rect: { type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }, { type: 'number' }], description: 'Rectangle [x, y, width, height]' },
      at: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] },
      width: { type: 'number' },
      open: { type: 'boolean' },
      ids: { type: 'array', items: { type: 'string' } },
      id: { type: 'string' },
      label: { type: 'string' },
      set: { type: 'object', additionalProperties: {} },
    },
  });
  it('brings values to the schema where the intent is obvious', () => {
    const r = coerceArgs({ rect: '[1, 2, 6, 4]', at: { x: 3.5, y: 5.5 }, width: '2', open: 'true', ids: 'r1', id: 7, label: null, set: '{"style": "locked"}' }, schema);
    expect(r.args).toEqual({ rect: [1, 2, 6, 4], at: [3.5, 5.5], width: 2, open: true, ids: ['r1'], id: '7', set: { style: 'locked' } });
    expect(r.changed.sort()).toEqual(['at', 'id', 'ids', 'label', 'open', 'rect', 'set', 'width']);
    expect(coerceArgs({ rect: { x: 1, y: 2, width: 6, height: 4 } }, schema).args).toEqual({ rect: [1, 2, 6, 4] });
  });
  it('leaves right and unknowable values alone', () => {
    const r = coerceArgs({ rect: [1, 2, 6, 4], width: 'wide', extra: 'x' }, schema);
    expect(r).toEqual({ args: { rect: [1, 2, 6, 4], width: 'wide', extra: 'x' }, changed: [] });
  });
  it('finds tools by sloppy names', () => {
    const known = ['add_room', 'describe_map'];
    expect(resolveToolName('add_room', known)).toBe('add_room');
    expect(resolveToolName('functions.add_room', known)).toBe('add_room');
    expect(resolveToolName('mcp__delve__describe_map', known)).toBe('describe_map');
    expect(resolveToolName('quillwarren.add_room', known)).toBe('add_room');
    expect(resolveToolName('Add-Room', known)).toBe('add_room');
    expect(resolveToolName('add_rooms', known)).toBeUndefined();
  });
});

describe('tool calls written as text', () => {
  const known = ['add_room', 'connect', 'describe_map', 'update'];
  it('reads Qwen/Hermes <tool_call> blocks', () => {
    const r = textToolCalls('I will add it.\n<tool_call>\n{"name": "add_room", "arguments": {"rect": [16, 26, 6, 4]}}\n</tool_call>\n<tool_call>{"name": "connect", "arguments": {"from": "r1", "to": "r7"}}</tool_call>', known);
    expect(r.calls).toEqual([
      { name: 'add_room', arguments: { rect: [16, 26, 6, 4] } },
      { name: 'connect', arguments: { from: 'r1', to: 'r7' } },
    ]);
    expect(r.rest).toBe('I will add it.');
  });
  it('reads Mistral, Llama, harmony and fenced forms', () => {
    expect(textToolCalls('[TOOL_CALLS] [{"name": "describe_map", "arguments": {}}]', known).calls).toEqual([{ name: 'describe_map', arguments: {} }]);
    expect(textToolCalls('[TOOL_CALLS]update[ARGS]{"id": "d2", "set": {"style": "locked"}}', known).calls).toEqual([{ name: 'update', arguments: '{"id": "d2", "set": {"style": "locked"}}' }]);
    expect(textToolCalls('<|python_tag|>{"name": "describe_map", "parameters": {}}', known).calls).toEqual([{ name: 'describe_map', arguments: {} }]);
    expect(textToolCalls('<function=update>{"id": "r3", "set": {"name": "Armoury"}}</function>', known).calls).toEqual([{ name: 'update', arguments: '{"id": "r3", "set": {"name": "Armoury"}}' }]);
    expect(textToolCalls('<function=add_room>\n<parameter=rect>\n[1, 2, 6, 4]\n</parameter>\n<parameter=name>\nShrine\n</parameter>\n</function>', known).calls).toEqual([{ name: 'add_room', arguments: { rect: [1, 2, 6, 4], name: 'Shrine' } }]);
    expect(textToolCalls('<|channel|>commentary to=functions.describe_map <|constrain|>json<|message|>{}<|call|>', known).calls).toEqual([{ name: 'describe_map', arguments: '{}' }]);
    expect(textToolCalls('```json\n{"name": "update", "arguments": {"id": "r3"}}\n```', known).calls).toEqual([{ name: 'update', arguments: { id: 'r3' } }]);
  });
  it('reads bare JSON and name({…}) lines for known tools only', () => {
    const r = textToolCalls('Calling it now: {"name": "update", "arguments": {"id": "d2", "set": {"style": "locked"}}} and done.', known);
    expect(r.calls).toEqual([{ name: 'update', arguments: { id: 'd2', set: { style: 'locked' } } }]);
    expect(r.rest).toBe('Calling it now:  and done.');
    expect(textToolCalls('connect({"from": "r1", "to": "r2"})', known).calls).toEqual([{ name: 'connect', arguments: '{"from": "r1", "to": "r2"}' }]);
    expect(textToolCalls('print({"a": 1})', known).calls).toEqual([]);
  });
  it('leaves ordinary answers alone', () => {
    for (const s of ['Room 1 has 2 doors: d1 and d5.', 'The room spans {x 4 to 10}.', 'Use {"name": "Bob"} as a name.']) {
      expect(textToolCalls(s, known)).toEqual({ calls: [], rest: s });
    }
  });
});

describe('schemas for local models', () => {
  it('turns tuples, unions and records into plain schemas', () => {
    expect(
      simplifySchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          rect: { description: 'Rectangle [x, y, width, height] in squares', type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number', exclusiveMinimum: 0 }, { type: 'number', exclusiveMinimum: 0 }], additionalItems: false, minItems: 4, maxItems: 4 },
          poly: { type: 'array', minItems: 3, items: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] } },
          roughness: { anyOf: [{ type: 'integer', minimum: 1, maximum: 10 }, { type: 'null' }], description: '1 to 10' },
          set: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
          kind: { type: 'string', enum: ['oval', 'hexagon'] },
          ops: { type: 'array', items: {} },
        },
        required: ['rect', 'nope'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        rect: { type: 'array', description: 'Rectangle [x, y, width, height] in squares (exactly 4 numbers)', items: { type: 'number' } },
        poly: { type: 'array', items: { type: 'array', description: '(exactly 2 numbers)', items: { type: 'number' } } },
        roughness: { type: 'integer', description: '1 to 10' },
        set: { type: 'object' },
        kind: { type: 'string', enum: ['oval', 'hexagon'] },
        ops: { type: 'array', items: {} },
      },
      required: ['rect'],
    });
  });
  it('picks, orders and trims tools, and keeps fixed arguments out of sight', () => {
    const mcp: McpToolInfo[] = [
      { name: 'add_room', description: 'Long description', inputSchema: { type: 'object', properties: { map: { type: 'string' }, rect: { type: 'array' }, roughness: { type: 'integer' }, name: { type: 'string' } }, required: ['map'] } },
      { name: 'describe_map', description: 'Summary', inputSchema: { type: 'object', properties: { map: { type: 'string' } }, required: ['map'] } },
      { name: 'render', description: 'Picture', inputSchema: { type: 'object', properties: { map: { type: 'string' } } } },
    ];
    const defs = toToolDefs(mcp, { only: { describe_map: {}, add_room: { description: 'Add a room.', params: ['rect', 'name', 'missing'], paramDescriptions: { name: 'Its title' } } }, fixed: { map: 'map_1' } });
    expect(defs).toEqual([
      { name: 'describe_map', description: 'Summary', parameters: { type: 'object', properties: {} }, fixed: { map: 'map_1' } },
      { name: 'add_room', description: 'Add a room.', parameters: { type: 'object', properties: { rect: { type: 'array', items: {} }, name: { type: 'string', description: 'Its title' } } }, fixed: { map: 'map_1' } },
    ]);
    expect(toToolDefs(mcp).map((d) => d.name)).toEqual(['add_room', 'describe_map', 'render']);
    expect(toToolDefs(mcp)[0]!.parameters.required).toEqual(['map']);
  });
});

describe('tool results', () => {
  it('replaces pictures with a note and trims long text', () => {
    expect(contentText([{ type: 'image' }, { type: 'text', text: '"Map" rev 3' }])).toEqual({ text: `${IMAGE_NOTE}\n"Map" rev 3`, images: 1 });
    expect(trimText('abcdefghij', 4)).toBe('abcd\n… (6 more characters cut)');
    expect(trimText('abc', 4)).toBe('abc');
  });
});

// ---------- helping steps (local-steps.ts): the messages the harness writes ----------

describe('helping steps', () => {
  const dungeon = () => templateMap({ name: 'steps', template: 'test-dungeon' });
  const add = (map: ReturnType<typeof dungeon>, ...objects: MapObject[]) => applyOps(map, objects.map((object) => ({ op: 'add' as const, object }))).map;
  const rec = (name: string, args: Record<string, unknown>, ok: boolean, result = '', extra: Partial<CallRecord> = {}): CallRecord => ({ turn: 1, name, args, ok, result, ms: 1, source: 'native', repaired: false, ...extra });

  it('are picked by name, all or none', () => {
    expect(parseSteps(undefined, LEAN_STEPS)).toBe(LEAN_STEPS);
    expect(stepsText(LEAN_STEPS)).toBe('ids, final');
    expect(stepsText(parseSteps('all', {}))).toBe('ids, final, digest, plan');
    expect(stepsText(parseSteps('none', LEAN_STEPS))).toBe('none');
    expect(stepsText(parseSteps('digest, ids', {}))).toBe('ids, digest');
    expect(() => parseSteps('ids,nap', {})).toThrow(/unknown step "nap"/);
  });

  it('batches: the failed call says which calls were held back, and each of those says why', () => {
    expect(heldBackNote(0, [{ name: 'add_height' }, { name: 'add_terrain' }])).toBe(
      '\nThe 2 calls after this one in your reply were not run (2. add_height, 3. add_terrain). Fix this call, then send them again; the calls before this one are done.',
    );
    expect(heldBackNote(1, [{ name: 'add_prop' }])).toBe('\nThe call after this one in your reply was not run (3. add_prop). Fix this call, then send that one again; the calls before this one are done.');
    expect(heldBackNote(2, [])).toBe('');
    expect(notRunText({ index: 0, name: 'add_terrain' })).toBe(
      'Not run: call 1 of this reply (add_terrain) failed, and this call may need what that one was meant to make. It was not tried, so nothing in it is known to be wrong: send it again unchanged once that call works.',
    );
    expect(repeatNote(3)).toBe('\nYou have now made this same call 3 times in a row. Do something else, or give your final answer.');
  });

  it('ids: the next new ids, in the context block', () => {
    const m = dungeon();
    const line = nextIdsLine(m);
    expect(line).toBe('Next new ids: room r7 (number 7), corridor c6, door d7, prop i1, terrain t1, height area h1, label l1; several props take the next ids in a row. The calls in one reply run in order, so a later call can use an id that an earlier one makes.');
    const ctx = leanContext({ map: m, rev: 1 }, { ids: true });
    expect(ctx.split('\n').slice(-2)).toEqual([line, '[End of Quillwarren context]']);
    expect(leanContext({ map: m, rev: 1 })).not.toContain('Next new ids');
    expect(leanUser({ map: m, rev: 1 }, ' Add a room. ', { plan: true })).toMatch(/\[End of Quillwarren context\]\n\nAdd a room\.\n\nFirst write a short numbered plan/);
    expect(planLine()).toBe('First write a short numbered plan: one line for each part of this request (at most 6). Then make the calls for it.');
  });

  it('what a request did: changes, unresolved calls, the digest', () => {
    const start = dungeon();
    const now = applyOps(add(start, { id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 4, 4] } }), [{ op: 'update', id: 'r3', set: { name: 'Armoury' } }, { op: 'delete', ids: ['d6'] }]).map;
    const ch = mapChanges(start, now);
    expect(ch.added.map((o) => o.id)).toEqual(['t1']);
    expect(ch.changed.map((o) => o.id)).toEqual(['r3']);
    expect(ch.removed).toEqual(['d6']);
    const calls = [
      rec('add_prop', { asset: 'bar-counter', in: 'r2', place: 'east wall', map: 'm' }, false, 'Along the east wall it does not fit.'),
      rec('add_prop', { asset: 'chair', in: 'r2', map: 'm' }, true),
      rec('add_terrain', { asset: 'dirt', map: 'm' }, false, 'region.between: there is no object "h1"'),
      rec('add_height', { height: 5, map: 'm' }, false, notRunText({ index: 2, name: 'add_terrain' }), { notRun: true }),
      rec('add_terrain', { asset: 'dirt', map: 'm' }, true),
    ];
    // the bar counter was never done again (a chair is something else); the dirt was; the held-back hill never sent again
    expect(unresolvedCalls(calls).map((c) => `${c.name} ${String(c.args.asset ?? '')}`)).toEqual(['add_prop bar-counter', 'add_height ']);
    // a refused door dealt with by restyling the door the refusal named is done; one that names d12 is not dealt with by d1
    const door = rec('add_door', { room: 'r2', wall: 'west', style: 'locked', map: 'm' }, false, 'wall: no free stretch on the west wall of r2. Door d1 (normal) is in that wall already: update {"id": "d1", "set": {"style": "…"}} changes its style.');
    expect(unresolvedCalls([door, rec('update', { id: 'd1', set: { style: 'locked' }, map: 'm' }, true)])).toEqual([]);
    expect(unresolvedCalls([{ ...door, result: 'Door d12 is in that wall already.' }, rec('update', { id: 'd1', set: { style: 'locked' }, map: 'm' }, true)])).toHaveLength(1);
    expect(callText('add_prop', { asset: 'bar-counter', in: 'r2', map: 'm' })).toBe('add_prop {"asset": "bar-counter", "in": "r2"}');
    expect(stateDigest({ start, now, calls })).toBe(
      '[So far in this request: made t1 (Grass); changed r3 (room 3 "Armoury"); removed d6. Not done yet: add_prop {"asset": "bar-counter", "in": "r2", "place": "east wall"} failed: Along the east wall it does not fit.; add_height {"height": 5} was not run. Next new ids: room r7 (number 7), corridor c6, door d6, prop i1, terrain t2, height area h1, label l1.]',
    );
  });

  it('final: layout problems with what was made, made-up ids, failed calls never done again; or nothing', () => {
    const start = dungeon();
    const clean = add(start, { id: 'i1', type: 'prop', asset: 'table-rect', at: [10, 18] });
    expect(finalCheck({ answer: 'Added table i1 in room 2.', calls: [rec('add_prop', { asset: 'table-rect' }, true)], start, now: clean })).toBeNull();
    // a question: nothing changed, and the answer names doors that are there
    expect(finalCheck({ answer: 'Room 1 has 2 doors: d1 and d5.', calls: [], start, now: start })).toBeNull();
    const sloppy = add(start, { id: 'i1', type: 'prop', asset: 'bar-counter', at: [10, 15] });
    expect(newProblems(start, sloppy).map((p) => p.kind)).toContain('prop-outside-room');
    expect(inventedIds('Added i1, i6 and the secret door d9 next to d5.', start, sloppy)).toEqual(['i6', 'd9']);
    expect(inventedIds('Roll a d20 at the door.', start, sloppy)).toEqual([]);
    const back = finalCheck({
      answer: 'Added bar counter i1 and stool i6.',
      calls: [rec('add_door', { room: 'r2', wall: 'west', style: 'secret' }, false, 'wall: no free stretch of 1 square on the west wall of r2')],
      start,
      now: sloppy,
      plan: ['Bar counter', 'Secret door'],
    })!;
    expect(back).toMatch(/^Before you finish, check your work\. The map shows:\n- check_map: half of i1 \(Bar Counter with Tankards\) is outside r2/);
    expect(back).toContain('\n- Your answer names i6, but the map has no i6.');
    expect(back).toContain('\n- Not done: add_door {"room": "r2", "wall": "west", "style": "secret"} failed: wall: no free stretch of 1 square on the west wall of r2');
    expect(back).toContain('\nYour plan was:\n1. Bar counter\n2. Secret door\n');
    expect(back.endsWith('Fix what you can with tool calls. Then give your final answer again, and say plainly what could not be done.')).toBe(true);
    // after a held-back batch: the request again, and what was made where (final run 2 of the first pair dropped a crypt room this way)
    const crypt = add(templateMap({ name: 'c', template: 'empty' }), { id: 'r1', type: 'room', label: '1', name: 'Antechamber', shape: { rect: [0, 0, 6, 4] } }, { id: 'r2', type: 'room', label: '2', shape: { rect: [0, 6, 6, 4] } });
    const empty0 = templateMap({ name: 'c', template: 'empty' });
    expect(madeText(empty0, crypt)).toBe('r1 (room 1 "Antechamber", north), r2 (room 2, south)');
    const held = [rec('add_room', { beside: 'r1', side: 'east' }, false, 'beside: there is no room "r1"'), rec('add_room', { beside: 'r2', side: 'south' }, false, 'Not run', { notRun: true }), rec('add_room', { rect: [0, 0, 6, 4] }, true), rec('add_room', { beside: 'r1', side: 'south' }, true)];
    const review = finalCheck({ answer: 'Added rooms r1 and r2.', calls: held, start: empty0, now: crypt, request: ' Build 3 rooms in a row. ' })!;
    expect(review).toBe(
      'Before you finish, check your work.\nSome calls of this request were held back after a failed one and sent again, so check that every part of it is done (how many, which kinds, where). The request was: "Build 3 rooms in a row."\nIt made: r1 (room 1 "Antechamber", north), r2 (room 2, south).\nFix what you can with tool calls. Then give your final answer again, and say plainly what could not be done.',
    );
    // without the request (or with nothing held back) there is nothing to restate
    expect(finalCheck({ answer: 'Added rooms r1 and r2.', calls: held, start: empty0, now: crypt })).toBeNull();
    expect(finalCheck({ answer: 'Added rooms r1 and r2.', calls: held.filter((c) => !c.notRun), start: empty0, now: crypt, request: 'Build 3 rooms.' })).toBeNull();
    // problems that were on the map before (or with things this request didn't touch) are not handed back
    expect(newProblems(sloppy, add(sloppy, { id: 'i2', type: 'prop', asset: 'table-rect', at: [10, 18] }))).toHaveLength(0);
    expect(newProblems(sloppy, add(sloppy, { id: 'i2', type: 'prop', asset: 'chair', at: [3, 3] })).map((p) => p.kind)).toEqual(['prop-stray']);
  });

  it('plan: the numbered lines of a reply, and the reminder', () => {
    expect(parsePlan('Plan:\n1. Grass over the area\n2) **The hill** in the south-west\n3: A path to it\nThen I call the tools.')).toEqual(['Grass over the area', 'The hill in the south-west', 'A path to it']);
    expect(parsePlan('1. Only one step')).toEqual([]);
    expect(parsePlan('2. Starts at two\n3. And three')).toEqual([]);
    expect(planReminder(['Grass', 'Hill'])).toBe('[Your plan: 1. Grass 2. Hill Go on with the next part that is not done yet, or give your final answer when every part is done.]');
  });
});

// ---------- whole runs against a fake model server ----------

type Reply = Json | ((body: Json) => Json | Promise<Json>) | 'hang';
interface FakeServer {
  url: string;
  requests: { path: string; body: Json }[];
  close(): Promise<void>;
}
const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** An OpenAI-compatible (or Ollama) server that answers from a script, one entry per request. */
async function fakeServer(script: Reply[], extra: Record<string, Json> = {}): Promise<FakeServer> {
  const requests: { path: string; body: Json }[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString('utf8')));
    req.on('end', async () => {
      if (req.method === 'GET' && extra[req.url ?? '']) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(extra[req.url!]));
      }
      if (req.method === 'GET') {
        res.writeHead(404);
        return res.end('not found');
      }
      const body = JSON.parse(text) as Json;
      requests.push({ path: req.url ?? '', body });
      const step = script[Math.min(n++, script.length - 1)]!;
      if (step === 'hang') return;
      const out = typeof step === 'function' ? await step(body) : step;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const s: FakeServer = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  servers.push(s);
  return s;
}

const usage = { prompt_tokens: 1000, completion_tokens: 50 };
const say = (content: string, extra: Json = {}): Json => ({ choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage });
const call = (name: string, args: string | Json, content = ''): Json => ({
  choices: [{ message: { role: 'assistant', content, tool_calls: [{ id: `id_${name}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
  usage,
});

const TOOLS: ToolDef[] = [
  { name: 'add_room', description: 'Add a room', parameters: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' }, description: '(exactly 4 numbers)' }, name: { type: 'string' } } }, fixed: { map: 'map_x' } },
  { name: 'describe_map', description: 'Describe', parameters: { type: 'object', properties: {} }, fixed: { map: 'map_x' } },
  { name: 'render', description: 'Picture', parameters: { type: 'object', properties: {} } },
];

function fakeExec(): ToolExecutor & { seen: { name: string; args: Json }[] } {
  const seen: { name: string; args: Json }[] = [];
  return {
    seen,
    async call(name, args) {
      seen.push({ name, args });
      if (name === 'render') return { ...contentText([{ type: 'image' }, { type: 'text', text: 'rev 2' }]), isError: false };
      if (name === 'add_room' && !Array.isArray(args.rect)) return { text: 'rect: expected array', isError: true };
      return { text: name === 'add_room' ? 'Added room r7 (label 7).' : '1 room', isError: false };
    },
  };
}

const run = (url: string, script: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({ client: openAiClient({ baseUrl: `${url}/v1`, model: 'fake' }), tools: TOOLS, exec: fakeExec(), system: 'You edit maps.', user: 'Add a room.', ...script });

describe('the agent loop', () => {
  it('runs tool calls, feeds results back and stops at the answer', async () => {
    const s = await fakeServer([call('add_room', { rect: [16, 26, 6, 4], name: 'Guard post' }), say('Added room r7.')]);
    const exec = fakeExec();
    const r = await run(s.url, { exec });
    expect(r.stop).toBe('answer');
    expect(r.answer).toBe('Added room r7.');
    // the fixed map id goes in with the call, not in the schema the model saw
    expect(exec.seen).toEqual([{ name: 'add_room', args: { rect: [16, 26, 6, 4], name: 'Guard post', map: 'map_x' } }]);
    const first = s.requests[0]!.body as { tools: { function: { name: string; parameters: Json } }[]; messages: Json[] };
    expect(s.requests[0]!.path).toBe('/v1/chat/completions');
    expect(first.tools.map((t) => t.function.name)).toEqual(['add_room', 'describe_map', 'render']);
    expect(JSON.stringify(first.tools)).not.toContain('map_x');
    expect(first.messages).toEqual([
      { role: 'system', content: 'You edit maps.' },
      { role: 'user', content: 'Add a room.' },
    ]);
    const second = s.requests[1]!.body as { messages: Json[] };
    expect(second.messages.slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'id_add_room', type: 'function', function: { name: 'add_room', arguments: JSON.stringify({ rect: [16, 26, 6, 4], name: 'Guard post' }) } }] },
      { role: 'tool', tool_call_id: 'id_add_room', name: 'add_room', content: 'Added room r7 (label 7).' },
    ]);
    expect(r.stats).toMatchObject({ turns: 2, toolCalls: 1, toolErrors: 0, promptTokens: 2000, completionTokens: 100, maxPrompt: 1000 });
    expect(malformed(r.stats)).toBe(0);
    expect(r.calls[0]).toMatchObject({ name: 'add_room', ok: true, source: 'native', repaired: false, turn: 1 });
  });

  it('repairs arguments, and reports unreadable ones and unknown tools to the model', async () => {
    const s = await fakeServer([
      call('add_room', "{'rect': [16, 26, 6, 4]"), // single quotes, cut off
      call('add_room', 'a big room please'),
      call('add_corridor', { from: 'r1' }),
      call('functions.describe_map', {}),
      say('Done.'),
    ]);
    const exec = fakeExec();
    const r = await run(s.url, { exec });
    expect(r.stop).toBe('answer');
    expect(exec.seen.map((c) => c.name)).toEqual(['add_room', 'describe_map']);
    expect(exec.seen[0]!.args.rect).toEqual([16, 26, 6, 4]);
    const toolMsgs = (s.requests[4]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMsgs[1]).toMatch(/^The arguments for add_room are not valid JSON/);
    expect(toolMsgs[2]).toBe('There is no tool "add_corridor". The tools are: add_room, describe_map, render.');
    expect(r.stats).toMatchObject({ toolCalls: 4, toolErrors: 2, badJson: 1, unknownTools: 1, repaired: 2 });
    expect(malformed(r.stats)).toBe(4);
  });

  it('runs tool calls written into the text, and strips thinking', async () => {
    const s = await fakeServer([
      say('<think>Room 1 ends at x 13, so x 16 leaves a gap.</think>\n<tool_call>\n{"name": "add_room", "arguments": {"rect": [16, 26, 6, 4]}}\n</tool_call>'),
      say('Added r7.', { reasoning: 'All good.' }),
    ]);
    const exec = fakeExec();
    const r = await run(s.url, { exec });
    expect(r.answer).toBe('Added r7.');
    expect(exec.seen).toEqual([{ name: 'add_room', args: { rect: [16, 26, 6, 4], map: 'map_x' } }]);
    expect(r.calls[0]!.source).toBe('text');
    expect(r.stats.textCalls).toBe(1);
    expect(r.stats.thinkChars).toBe('Room 1 ends at x 13, so x 16 leaves a gap.'.length + 'All good.'.length);
    // the call goes back into the history as a proper tool call, without the thinking
    const history = s.requests[1]!.body.messages as Json[];
    expect(history[2]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_room' } }] });
  });

  it('replaces pictures in results and cuts long ones', async () => {
    const s = await fakeServer([call('render', {}), say('ok')]);
    await run(s.url, { maxResultChars: 30 });
    const tool = (s.requests[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    expect(tool.content.startsWith(IMAGE_NOTE.slice(0, 30))).toBe(true);
    expect(tool.content).toContain('more characters cut');
  });

  it('nudges after an empty reply, then gives up', async () => {
    const s = await fakeServer([say(''), say('<think>hmm</think>'), say('')]);
    const r = await run(s.url);
    expect(r.stop).toBe('empty');
    expect(r.stats.empty).toBe(3);
    const last = s.requests[2]!.body.messages as { role: string; content: string }[];
    expect(last.at(-1)).toEqual({ role: 'user', content: 'Continue: call the next tool, or give your final answer in one or two sentences.' });
  });

  it('stops at the limits: turns, tool calls, errors in a row, time', async () => {
    const loop = await fakeServer([call('describe_map', {})]);
    const turns = await run(loop.url, { maxTurns: 3 });
    expect(turns.stop).toBe('turns');
    expect(turns.stats.turns).toBe(3);
    // the same call again and again: the model is told so
    expect(turns.calls[2]!.result).toContain('You have now made this same call 3 times in a row');

    const calls = await run(loop.url, { maxToolCalls: 2 });
    expect(calls.stop).toBe('tool_calls');
    expect(calls.stats.toolCalls).toBe(2);

    const bad = await fakeServer([call('add_room', { rect: 'big' })]);
    const errors = await run(bad.url, { maxErrorsInARow: 3 });
    expect(errors.stop).toBe('errors');
    expect(errors.stats.toolErrors).toBe(3);

    const slow = await fakeServer(['hang']);
    const t0 = Date.now();
    const time = await run(slow.url, { timeLimitMs: 300 });
    expect(time.stop).toBe('time');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('says when the model server fails', async () => {
    const s = await fakeServer([{ error: { message: 'model "nope" not found' } }]);
    const client = openAiClient({ baseUrl: `${s.url}/v1`, model: 'nope' });
    const r = await runAgent({ client, tools: TOOLS, exec: fakeExec(), system: 's', user: 'u' });
    expect(r.stop).toBe('model_error');
    expect(r.error).toBe('HTTP 200: model "nope" not found');
    const down = await runAgent({ client: openAiClient({ baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }), tools: TOOLS, exec: fakeExec(), system: 's', user: 'u' });
    expect(down.stop).toBe('model_error');
    expect(down.error).toBeTruthy();
  });

  it('runs a batch in order and holds back the calls after a failed one', async () => {
    const batch = (calls: [string, Json][]): Json => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args], k) => ({ id: `b${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }],
      usage,
    });
    const s = await fakeServer([batch([['describe_map', {}], ['add_room', { rect: 'big' }], ['add_room', { rect: [1, 2, 3, 4] }], ['describe_map', {}]]), say('Done.')]);
    const exec = fakeExec();
    const r = await run(s.url, { exec });
    // the first two ran, in order; the two after the failed one did not
    expect(exec.seen.map((c) => c.name)).toEqual(['describe_map', 'add_room']);
    const tools = (s.requests[1]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools).toEqual([
      '1 room',
      `rect: expected array${heldBackNote(1, [{ name: 'add_room' }, { name: 'describe_map' }])}`,
      notRunText({ index: 1, name: 'add_room' }),
      notRunText({ index: 1, name: 'add_room' }),
    ]);
    expect(r.stats).toMatchObject({ toolCalls: 2, toolErrors: 1, notRun: 2 });
    expect(r.calls.map((c) => [c.name, c.ok, Boolean(c.notRun)])).toEqual([
      ['describe_map', true, false],
      ['add_room', false, false],
      ['add_room', false, true],
      ['describe_map', false, true],
    ]);
  });

  it('final check: hands what it finds back once, then takes the answer', async () => {
    const start = templateMap({ name: 'x', template: 'test-dungeon' });
    const s = await fakeServer([say('Added room r9 east of room 1.'), say('I could not add the room: nothing was made.')]);
    let reads = 0;
    const r = await run(s.url, { steps: { final: true }, readMap: async () => (reads++, start) });
    expect(reads).toBe(2); // at the start and before the answer
    expect(r.stats.finalChecks).toBe(1);
    expect(r.answer).toBe('I could not add the room: nothing was made.');
    const sent = s.requests[1]!.body.messages as { role: string; content: string }[];
    expect(sent.slice(-2)).toEqual([
      { role: 'assistant', content: 'Added room r9 east of room 1.' },
      { role: 'user', content: finalCheck({ answer: 'Added room r9 east of room 1.', calls: [], start, now: start })! },
    ]);
    expect(sent.at(-1)!.content).toContain('Your answer names r9, but the map has no r9.');
    // without the step (or without a way to read the map) the first answer stands
    const plain = await fakeServer([say('Added room r9 east of room 1.')]);
    expect((await run(plain.url, { steps: { final: true } })).answer).toBe('Added room r9 east of room 1.');
  });

  it('digest and plan: a line after each turn of tool results', async () => {
    const start = templateMap({ name: 'x', template: 'test-dungeon' });
    const s = await fakeServer([call('describe_map', {}, '1. Look at the map\n2. Answer'), say('It has 6 rooms.')]);
    const r = await run(s.url, { steps: { digest: true, plan: true }, readMap: async () => start });
    expect(r.plan).toEqual(['Look at the map', 'Answer']);
    const tool = (s.requests[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    expect(tool.content).toBe(`1 room\n${stateDigest({ start, now: start, calls: r.calls })}\n${planReminder(['Look at the map', 'Answer'])}`);
    expect(tool.content).toContain('[So far in this request: nothing made yet. Next new ids: room r7');
  });

  it('answers the task list itself in the full setup', async () => {
    const s = await fakeServer([call('TaskCreate', { subject: 'Build the rooms' }), call('TaskUpdate', { taskId: 1, status: 'in_progress' }), say('ok')]);
    const r = await run(s.url, { local: taskTools() });
    expect(r.calls.map((c) => [c.name, c.result, c.local])).toEqual([
      ['TaskCreate', 'Task #1 created successfully: Build the rooms', true],
      ['TaskUpdate', 'Updated task #1 status', true],
    ]);
    expect(r.calls[1]!.args.taskId).toBe('1'); // a number where the schema wants a string
  });
});

describe("Ollama's own API", () => {
  it('is found by /api/version and gets num_ctx, think and object arguments', async () => {
    const reply = (msg: Json): Json => ({ message: { role: 'assistant', ...msg }, done_reason: 'stop', prompt_eval_count: 4000, eval_count: 120, eval_duration: 2e9, prompt_eval_duration: 1e9, load_duration: 5e8 });
    const s = await fakeServer([reply({ content: '', thinking: 'Plan.', tool_calls: [{ function: { name: 'add_room', arguments: { rect: [1, 2, 6, 4] } } }] }), reply({ content: 'Added r7.' })], { '/api/version': { version: '0.35.1' } });
    expect(await detectApi(`${s.url}/v1`)).toEqual({ api: 'ollama', host: s.url, version: '0.35.1' });
    const exec = fakeExec();
    const r = await runAgent({ client: ollamaClient({ host: s.url, model: 'qwen3:8b', numCtx: 16384, think: 'off' }), tools: TOOLS, exec, system: 's', user: 'u' });
    expect(r.answer).toBe('Added r7.');
    expect(exec.seen[0]!.args).toEqual({ rect: [1, 2, 6, 4], map: 'map_x' });
    const body = s.requests[1]!.body as { options: Json; think: boolean; stream: boolean; messages: Json[] };
    expect(s.requests[0]!.path).toBe('/api/chat');
    expect(body).toMatchObject({ options: { num_ctx: 16384 }, think: false, stream: false });
    expect(body.messages.slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_room', arguments: { rect: [1, 2, 6, 4] } } }] },
      { role: 'tool', content: 'Added room r7 (label 7).', tool_name: 'add_room' },
    ]);
    expect(r.stats).toMatchObject({ completionTokens: 240, evalMs: 4000, promptMs: 2000, loadMs: 1000, thinkChars: 5 });
    expect(tokensPerSecond(r.stats)).toBe(60);
  });

  it('falls back to the OpenAI API for other servers', async () => {
    const s = await fakeServer([say('hi')]);
    expect((await detectApi(`${s.url}/v1`)).api).toBe('openai');
  });
});

// ---------- with Quillwarren's real MCP endpoint ----------

describe('lean and full setups on a real Quillwarren', () => {
  const TOKEN = 'local-llm-test-token';
  let app: ReturnType<typeof buildApp>;
  let base: string;
  let mcp: Client;
  let tools: McpToolInfo[];
  beforeAll(async () => {
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    mcp = new Client({ name: 'local-llm-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    tools = (await mcp.listTools()).tools as McpToolInfo[];
  });
  afterAll(async () => {
    await mcp.close();
    await app.close();
  });
  const newMap = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name: 'lean test', template: 'test-dungeon' } });
    return res.json() as { id: string; rev: number; map: DelveMap };
  };

  it('the lean set: 17 short tools without the map id, and a short prompt', async () => {
    const m = await newMap();
    const lean = buildSetup('lean', tools, m.id);
    expect(lean.tools.map((t) => t.name)).toEqual(Object.keys(LEAN_TOOLS));
    expect(lean.tools.length).toBe(17);
    for (const t of lean.tools) {
      if (t.name !== 'list_assets') expect(t.fixed).toEqual({ map: m.id }); // list_assets takes no map
      expect(t.parameters.properties).not.toHaveProperty('map');
      expect(t.parameters.required ?? []).not.toContain('map');
    }
    expect(Object.keys(lean.tools.find((t) => t.name === 'add_terrain')!.parameters.properties!)).toEqual(['asset', 'region', 'rect', 'poly']);
    // lengths with units keep no type, so a number or "5 m" both go through unrepaired
    expect(lean.tools.find((t) => t.name === 'add_height')!.parameters.properties!.height).not.toHaveProperty('type');
    expect(lean.tools.find((t) => t.name === 'add_props_along')!.parameters.properties!.region!.properties).toHaveProperty('edge');
    const prompt = leanPrompt();
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain('chair');
    expect(prompt).toContain('water-deep');
    expect(prompt).toContain('normal, double, locked, secret');
    const full = buildSetup('full', tools, m.id);
    expect(full.tools.length).toBe(tools.length);
    expect(full.local.map((l) => l.def.name)).toEqual(['TaskCreate', 'TaskUpdate', 'TaskList']);
    const leanSize = JSON.stringify(lean.tools).length + lean.system.length;
    const fullSize = JSON.stringify(full.tools).length + full.system.length;
    expect(leanSize * 4).toBeLessThan(fullSize);
    // the context block is today's, less the task-list reminder
    const ctx = leanContext({ map: m.map, rev: m.rev });
    expect(chatContext({ map: m.map, rev: m.rev })).toContain('Plan: if this request');
    expect(ctx).not.toContain('Plan: if this request');
    expect(ctx).toContain('r1 room "Entrance hall" label "1" rect [7, 25, 6, 6]');
    // the lean setup runs with LEAN_STEPS: its first message names the next ids; full has no steps
    expect(lean.steps).toBe(LEAN_STEPS);
    expect(lean.user({ map: m.map, rev: m.rev }, 'Add a room.')).toBe(leanUser({ map: m.map, rev: m.rev }, 'Add a room.', LEAN_STEPS));
    expect(lean.user({ map: m.map, rev: m.rev }, 'Add a room.')).toContain(nextIdsLine(m.map));
    expect(full.steps).toEqual({});
    expect(buildSetup('lean', tools, m.id, { steps: {} }).user({ map: m.map, rev: m.rev }, 'Add a room.')).toBe(`${ctx}\n\nAdd a room.`);
  });

  it('a scripted model builds through MCP, with the map id filled in', async () => {
    const m = await newMap();
    const setup = buildSetup('lean', tools, m.id);
    const s = await fakeServer([
      call('add_room', { rect: [16, 26, 6, 4], name: 'Guard post' }),
      call('connect', '{"from": "r1", "to": "r7", "doors": "to"}'),
      call('update', { id: 'r3', set: '{"name": "Armoury"}' }), // set as a string: brought to an object
      call('add_door', { at: [4, 14], along: 'sideways', width: 1 }), // Quillwarren refuses this
      call('describe_map', {}),
      say('Added r7 east of room 1 with corridor c6 and door d7; renamed r3.'),
    ]);
    const r = await runAgent({ client: openAiClient({ baseUrl: `${s.url}/v1`, model: 'fake' }), tools: setup.tools, local: setup.local, exec: mcpExecutor(mcp), system: setup.system, user: setup.user({ map: m.map, rev: m.rev }, 'Add a room.') });
    expect(r.stop).toBe('answer');
    expect(r.calls.map((c) => `${c.name}${c.ok ? '' : '✗'}`)).toEqual(['add_room', 'connect', 'update', 'add_door✗', 'describe_map']);
    expect(r.calls[0]!.result).toContain('Added room r7 "Guard post" (label 7)');
    expect(r.calls[3]!.result).toMatch(/along/);
    expect(r.calls[4]!.result).toContain('7 rooms');
    const after = (await app.inject({ url: `/api/v1/maps/${m.id}` })).json() as { map: DelveMap };
    expect(after.map.objects.find((o) => o.id === 'r3')).toMatchObject({ name: 'Armoury' });
    expect(after.map.objects.some((o) => o.type === 'corridor' && o.from === 'r1' && o.to === 'r7')).toBe(true);
  });
});
