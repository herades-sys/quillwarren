// The training-data generator (npm run llm-train-data): conversations made by
// the program from Quillwarren's lean setup and real tool results, replayed and
// checked; the held-out llm-bench tasks stay out; the output formats.
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../src/chat/local-agent.ts';
import { LEAN_TOOLS } from '../src/chat/local-setup.ts';
import { TASKS } from '../src/cli/llm-bench-lib.ts';
import { Convo } from '../src/cli/llm-train/convo.ts';
import { Quillwarren } from '../src/cli/llm-train/delve.ts';
import { FAMILIES } from '../src/cli/llm-train/families/index.ts';
import { generate, quotas } from '../src/cli/llm-train/generate.ts';
import type { HarnessHooks } from '../src/cli/llm-train/harness-hooks.ts';
import { buildStart } from '../src/cli/llm-train/maps.ts';
import { estimateTokens, openAiTools, renderQwen3, toOpenAi, toShareGpt } from '../src/cli/llm-train/output.ts';
import { splitExamples } from '../src/cli/llm-train/report.ts';
import { Rng } from '../src/cli/llm-train/rng.ts';
import { call, ordered } from '../src/cli/llm-train/tools.ts';
import { benchOverlap, callErrors, schemaErrors } from '../src/cli/llm-train/validate.ts';

describe('the lean schema check', () => {
  it('passes calls the model may make and names what is wrong with others', async () => {
    const d = await Quillwarren.open();
    const c = new Convo(d, 'map_000000000000', 1);
    const tools = c.setup.tools;
    const def = (n: string) => tools.find((t) => t.name === n)!.parameters;
    expect(schemaErrors(call.roomBeside({ beside: 'r1', side: 'east', size: [6, 4], connect: true, door: 'locked' }).args, def('add_room'))).toEqual([]);
    expect(schemaErrors({ beside: 'r1', side: 'east', size: ['30 ft', '20 ft'] }, def('add_room'))).toEqual([]);
    expect(schemaErrors({ region: { corner: 'sw', size: 8 }, height: '3 m', edge: 'slope' }, def('add_height'))).toEqual([]);
    expect(schemaErrors({ beside: 'r1', side: 'east', map: 'map_x' }, def('add_room')).join()).toMatch(/map: not a parameter/);
    expect(schemaErrors({ rect: [0, 0, 4] }, def('add_room')).join()).toMatch(/exactly 4/);
    expect(schemaErrors({ ids: 'r1', dx: 1, dy: 0 }, def('move')).join()).toMatch(/an array/);
    expect(schemaErrors({ asset: 'chair', count: 'two' }, def('add_prop')).join()).toMatch(/count: an integer/);
    expect(schemaErrors({ asset: 'x', region: { edge: 'north', depth: '3 m' } }, def('add_terrain'))).toEqual([]);
    const msgs: AgentMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'resize', args: {} }] }];
    expect(callErrors(msgs, tools)).toEqual(['resize: not a lean tool']);
    await d.close();
  });

  it('orders arguments the way the lean tool lists its parameters', () => {
    const o = ordered({ name: 'add_room', args: { door: 'normal', size: [4, 4], beside: 'r2', connect: true, side: 'north' } });
    expect(Object.keys(o.args)).toEqual(LEAN_TOOLS.add_room!.params!.filter((k) => k in o.args));
  });
});

describe('the llm-bench tasks stay out', () => {
  it('flags every bench prompt and its paraphrases', () => {
    for (const t of TASKS) expect(benchOverlap(t.prompt), t.id).not.toBeNull();
    for (const p of [
      'Make room 2 a tavern with a bar counter.',
      'Plant some trees along the north edge of the map.',
      'Rename room 3 to "Armory".',
      'Put water in the boss chamber and a bridge over it.',
      'Make a crypt with 4 rooms on this empty map.',
      'How many doors does room 1 have?',
      'Add a 6x4 room to the east of room 1.',
      'Raise a hill and draw a dirt path up to it.',
    ]) expect(benchOverlap(p), p).not.toBeNull();
  });

  it('lets other requests through', () => {
    for (const p of [
      'Add a 6×4 room west of room 2, joined by a corridor with a door.',
      'Furnish room 4 as a tavern.',
      'Plant trees along the east edge of the map.',
      'This is an empty outdoor map. Cover x 0 to 20, y 0 to 27 with snow, then add a stream from the north edge to the south edge and trees along the east edge, 5 squares deep.',
      'Add a locked door on the south side of room 3.',
      'How many doors does room 4 have?',
      'Raise a hill 10 ft high in the north-east corner.',
    ]) expect(benchOverlap(p), p).toBeNull();
  });
});

describe('starting maps', () => {
  it('are the same for the same seed and never the test dungeon', async () => {
    for (const kind of ['dungeon', 'outdoor', 'small', 'empty'] as const) {
      const a = await Quillwarren.open();
      const b = await Quillwarren.open();
      const ma = await buildStart(a, { kind, seed: 4242, furnished: true });
      const mb = await buildStart(b, { kind, seed: 4242, furnished: true });
      expect(JSON.stringify(a.get(ma.mapId))).toBe(JSON.stringify(b.get(mb.mapId)));
      // the test dungeon's six rooms never come back
      const names = a.get(ma.mapId).map.objects.flatMap((o) => (o.type === 'room' ? [o.name ?? ''] : [])).join(',');
      expect(names).not.toBe('Entrance hall,Crossroads,Barracks,Storeroom,Boss chamber,Vault');
      await a.close();
      await b.close();
    }
  }, 30_000);
});

describe('the generator', () => {
  it('makes, replays and checks a conversation in every family, the same each time', async () => {
    for (const f of FAMILIES) {
      const one = await generate({ count: 2, seed: 77, families: [f.id], maxTokens: 30_000 });
      const two = await generate({ count: 2, seed: 77, families: [f.id], maxTokens: 30_000 });
      expect(one.examples.length, f.id).toBeGreaterThan(0);
      expect(JSON.stringify(one.examples.map((e) => e.messages))).toBe(JSON.stringify(two.examples.map((e) => e.messages)));
      for (const e of one.examples) {
        expect(callErrors(e.messages, one.tools), f.id).toEqual([]);
        expect(e.messages[0]!.role).toBe('system');
        const last = e.messages[e.messages.length - 1]!;
        expect(last.role === 'assistant' && !last.toolCalls?.length, f.id).toBe(true);
        for (const r of e.requests) expect(benchOverlap(r), r).toBeNull();
      }
    }
  }, 240_000);

  it('frames user messages with the context block and leaves the map id to the harness', async () => {
    const r = await generate({ count: 3, seed: 3, families: ['room_beside'], maxTokens: 30_000 });
    const e = r.examples[0]!;
    const user = e.messages[1] as { content: string };
    expect(user.content).toMatch(/^\[Quillwarren context: added by the editor, not written by the user\]/);
    expect(user.content).toContain('[End of Quillwarren context]');
    expect(user.content).not.toMatch(/Plan: if this request takes 3 or more steps/);
    for (const m of e.messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) expect(c.args).not.toHaveProperty('map');
    for (const t of r.tools) expect(t.parameters.properties ?? {}).not.toHaveProperty('map');
  }, 60_000);

  it('puts what the harness hooks add where the harness adds it, and replays it', async () => {
    const hooks: HarnessHooks = {
      afterTools: (ctx) => [{ role: "user", content: `[harness] ${ctx.records.length} call(s) so far, map at rev ${ctx.rev}.` }],
      beforeAnswer: async (ctx) => [{ role: 'user', content: `[harness] check: ${(await ctx.exec('check_map', {})).text.split('\n')[0]}` }],
    };
    const r = await generate({ count: 2, seed: 9, families: ['furnish_theme'], maxTokens: 30_000, hooks });
    expect(r.examples.length).toBeGreaterThan(0);
    const msgs = r.examples[0]!.messages;
    const digests = msgs.filter((m) => m.role === 'user' && m.content.startsWith('[harness]'));
    expect(digests.length).toBeGreaterThanOrEqual(2);
    // each digest follows a tool result, and the final answer comes after the last one
    const i = msgs.findIndex((m) => m.role === 'user' && / call\(s\) so far/.test(m.content));
    expect(i).toBeGreaterThan(0);
    expect(msgs[i - 1]!.role).toBe('tool');
    expect(msgs[msgs.length - 2]!.role).toBe('user');
  }, 60_000);

  it('holds back the rest of a reply after a failed call, as the batch hook says, and records it for the final check', async () => {
    const d = await Quillwarren.open();
    const start = await buildStart(d, { kind: 'dungeon', seed: 11 });
    const seen: string[] = [];
    const hooks: HarnessHooks = {
      batch: {
        heldBackNote: (i, rest) => `\n[held back after call ${i}: ${rest.map((r) => `${r.index} ${r.name}`).join(', ')}]`,
        notRunText: (c) => `[not run: call ${c.index} ${c.name}]`,
      },
      afterAnswer: (ctx) => {
        seen.push(ctx.records.map((r) => `${r.name}:${r.ok ? 'ok' : 'failed'}${r.notRun ? ':not run' : ''}`).join(' '));
        return ctx.records.some((r) => r.notRun) ? '[final check] Two calls were not run; make them again.' : null;
      },
    };
    const c = new Convo(d, start.mapId, 5, hooks);
    await c.user('Add a bed and a chest to room 1.');
    const runs = await c.step(call.propIn({ asset: 'bed-single', in: 'r99', place: 'center' }), call.propIn({ asset: 'chest-closed', in: 'r1', place: 'center' }), call.check());
    expect(runs[0]!.isError).toBe(true);
    const results = c.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
    expect(results[0]).toMatch(/\[held back after call 0: 1 add_prop, 2 check_map\]$/);
    expect(results.slice(1)).toEqual(['[not run: call 0 add_prop]', '[not run: call 0 add_prop]']); // notRunText names the call that failed, as runAgent does
    expect(c.map.objects.filter((o) => o.type === 'prop')).toHaveLength(0);
    await c.answer('Done.');
    expect(seen).toEqual(['add_prop:failed add_prop:failed:not run check_map:failed:not run']);
    expect(c.unanswered).toBe(true);
    expect(c.messages[c.messages.length - 1]).toEqual({ role: 'user', content: '[final check] Two calls were not run; make them again.' });
    // the check runs once per request
    await c.answer('Done again.');
    expect(seen).toHaveLength(1);
    expect(c.unanswered).toBe(false);
    await d.close();
  });

  it('keeps no conversation the final check objects to', async () => {
    const r = await generate({ count: 2, seed: 4, families: ['single_prop'], maxTokens: 30_000, attempts: 1, hooks: { afterAnswer: () => 'Check your work.' } });
    expect(r.examples).toHaveLength(0);
    expect(r.dropped.map((x) => x.reason)).toContain("the harness's final check objected");
  }, 60_000);

  it('notes a third identical call in a row as runAgent does', async () => {
    const d = await Quillwarren.open();
    const start = await buildStart(d, { kind: 'small', seed: 3 });
    const c = new Convo(d, start.mapId, 5);
    await c.user('Check the map three times.');
    for (let k = 0; k < 3; k++) await c.step(call.check());
    const last = c.messages[c.messages.length - 1] as { content: string };
    expect(last.content).toMatch(/You have now made this same call 3 times in a row/);
    await d.close();
  });

  it('gives each family its share of the slots', () => {
    const q = quotas(FAMILIES, 1000);
    expect([...q.values()].reduce((a, b) => a + b, 0)).toBe(1000);
    const total = FAMILIES.reduce((s, f) => s + f.weight, 0);
    for (const f of FAMILIES) expect(Math.abs(q.get(f.id)! - (1000 * f.weight) / total)).toBeLessThan(1);
  });
});

describe('the output files', () => {
  it('writes OpenAI chat lines, sharegpt turns that alternate, and a Qwen3 rendering', async () => {
    const r = await generate({ count: 6, seed: 21, families: ['furnish_theme', 'multi_turn', 'recovery'], maxTokens: 30_000 });
    const tools = openAiTools(r.tools);
    expect(tools[0]).toEqual({ type: 'function', function: { name: r.tools[0]!.name, description: r.tools[0]!.description, parameters: r.tools[0]!.parameters } });
    expect(JSON.stringify(tools)).not.toContain('"fixed"');
    for (const e of r.examples) {
      const oa = toOpenAi(e.messages);
      for (const m of oa) {
        if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls as { function: { arguments: unknown } }[]) expect(typeof c.function.arguments).toBe('string');
        if (m.role === 'tool') expect(m).toHaveProperty('tool_call_id');
      }
      const sg = toShareGpt(e.messages, r.tools) as { conversations: { from: string }[]; system: string; tools: string };
      expect(sg.system).toBe(r.system);
      expect(JSON.parse(sg.tools)).toHaveLength(r.tools.length);
      sg.conversations.forEach((t, i) => expect(i % 2 === 0 ? ['human', 'observation'] : ['gpt', 'function_call'], `${e.family} turn ${i}`).toContain(t.from));
      const q = renderQwen3(e.messages, r.tools);
      expect(q.text).toContain('<tools>');
      expect(q.text).toContain('<|im_start|>assistant\n<think>\n\n</think>\n\n');
      expect(q.text.slice(q.setup)).toContain('<tool_response>');
      expect(estimateTokens(q)).toBeGreaterThan(5000);
    }
  }, 60_000);

  it('splits by starting map, about 5 % of each family into valid', () => {
    const rng = new Rng(1);
    const fake = Array.from({ length: 400 }, (_, i) => ({ family: `f${i % 4}`, mapSeed: rng.int(1, 1e9), slot: i }) as unknown as Parameters<typeof splitExamples>[0][number]);
    const { train, valid } = splitExamples(fake, 1, 0.05);
    expect(train.length + valid.length).toBe(400);
    expect(valid.length).toBe(20);
    const maps = new Set(valid.map((e) => e.mapSeed));
    expect(train.some((e) => maps.has(e.mapSeed))).toBe(false);
    for (const f of ['f0', 'f1', 'f2', 'f3']) expect(valid.filter((e) => e.family === f).length).toBe(5);
  });
});
