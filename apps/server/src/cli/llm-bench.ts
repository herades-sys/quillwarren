// Benchmark a local model on Delve's map chat: 8 tasks from easy to hard, each
// on a fresh map, checked automatically; saves a picture and a transcript per
// task and a Markdown report (report.md, all runs in the folder).
//   npm run llm-bench -- --base-url http://192.168.1.40:11434/v1 --model qwen3:8b [--tools lean|full] [--tasks 1,3,5] [--out dir]
//   npm run llm-bench -- --report [--out dir]      rebuild report.md from the saved runs
//   npm run llm-bench -- --regrade [--out dir]     run the checks again on the saved transcripts, then the report
// See docs/API.md, "Testing local models".
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DelveMap } from '@delve/core';
import { mcpExecutor, runAgent, tokensPerSecond, malformed, type AgentEvent, type CallRecord } from '../chat/local-agent.ts';
import { buildSetup, setupSize } from '../chat/local-setup.ts';
import { callLog, grade, pickTasks, renderReport, TASKS, type RunResult, type TaskResult } from './llm-bench-lib.ts';
import { connectDelve, createMap, fmtMs, getMap, makeModel, MODEL_HELP, MODEL_OPTIONS, num, renderPng, slug, toolSet } from './llm-common.ts';

const { values } = parseArgs({
  options: {
    ...MODEL_OPTIONS,
    tasks: { type: 'string' },
    out: { type: 'string', default: 'llm-bench' },
    report: { type: 'boolean', default: false },
    regrade: { type: 'boolean', default: false },
    name: { type: 'string' },
    'no-warmup': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const out = values.out;

function writeReport(): string {
  const runs: RunResult[] = [];
  for (const f of readdirSync(out).filter((n) => n.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(out, f), 'utf8')) as RunResult;
      if (r && Array.isArray(r.tasks) && typeof r.model === 'string') runs.push(r);
    } catch {
      // not a run file
    }
  }
  runs.sort((a, b) => a.model.localeCompare(b.model) || (a.tools === b.tools ? a.started.localeCompare(b.started) : a.tools === 'lean' ? -1 : 1));
  const file = join(out, 'report.md');
  writeFileSync(file, renderReport(runs));
  return file;
}

if (values.help) {
  console.log(`npm run llm-bench -- --base-url URL --model NAME [--tools lean|full] [--tasks 1,3,5] [--out dir] [--name label] [--no-warmup] [--verbose]\n       npm run llm-bench -- --report|--regrade [--out dir]\n\n${MODEL_HELP}`);
  process.exit(0);
}
/** Run the checks again on the saved transcripts (after changing a check), without the model. */
function regrade(): void {
  for (const f of readdirSync(out).filter((n) => n.endsWith('.json'))) {
    let r: RunResult;
    try {
      r = JSON.parse(readFileSync(join(out, f), 'utf8')) as RunResult;
      if (!Array.isArray(r.tasks)) continue;
    } catch {
      continue;
    }
    for (const t of r.tasks) {
      const task = TASKS.find((x) => x.id === t.task);
      if (!task || !t.transcript) continue;
      const tr = JSON.parse(readFileSync(join(out, t.transcript), 'utf8')) as { beforeMap: DelveMap; finalMap: DelveMap; beforeRev: number; afterRev: number; answer: string; calls: CallRecord[] };
      const checks = task.check({ before: tr.beforeMap, after: tr.finalMap, beforeRev: tr.beforeRev, afterRev: tr.afterRev, answer: tr.answer, calls: tr.calls });
      const g = grade(checks);
      if (g !== t.grade) console.log(`${f} ${t.task}: ${t.grade} → ${g}`);
      t.checks = checks;
      t.grade = g;
      t.title = task.title;
    }
    writeFileSync(join(out, f), JSON.stringify(r, null, 1));
  }
}

if (values.report || values.regrade) {
  if (values.regrade) regrade();
  console.log(`wrote ${writeReport()}`);
  process.exit(0);
}

const tools = toolSet(values.tools);
const model = await makeModel(values, tools);
const tasks = pickTasks(values.tasks);
if (!tasks.length) throw new Error(`no task matches "${values.tasks}"`);
const runDir = `${slug(model.model)}-${tools}${values.name ? `-${slug(values.name)}` : ''}`;
mkdirSync(join(out, runDir), { recursive: true });

const delve = await connectDelve();
console.log(`model ${model.client.label} (${model.api} API) · tools ${tools} · Delve ${delve.version} at ${delve.base} · ${tasks.length} tasks`);

const started = new Date().toISOString();
let warmupMs: number | undefined;
if (!values['no-warmup']) {
  // load the model (with this context size) before the clock runs
  const t = Date.now();
  try {
    const r = await model.client.complete([{ role: 'user', content: 'Reply with the word OK.' }], []);
    warmupMs = Date.now() - t;
    console.log(`warm-up: ${fmtMs(warmupMs)}${r.loadMs ? ` (loading ${fmtMs(r.loadMs)})` : ''}`);
  } catch (e) {
    console.error(`the model doesn't answer: ${(e as Error).message}`);
    await delve.close();
    process.exit(1);
  }
}

const results: TaskResult[] = [];
let size = { system: 0, tools: 0, user: 0 };
let toolCount = 0;
const verbose = values.verbose;
const log = (e: AgentEvent) => {
  if (!verbose) return;
  if (e.type === 'reply') console.log(`    · reply ${e.turn}: ${fmtMs(e.ms)}, ${e.promptTokens ?? '?'} → ${e.completionTokens ?? '?'} tokens, ${e.calls} call(s)${e.think ? `, thought ${e.think.length} chars` : ''}${e.content ? `: ${e.content.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`);
  else if (e.type === 'call') console.log(`      ${e.record.ok ? '✓' : '✗'} ${e.record.name} ${JSON.stringify(e.record.args).slice(0, 200)}${e.record.repaired ? ' (repaired)' : ''}${e.record.source === 'text' ? ' (from text)' : ''} → ${e.record.result.slice(0, 160).replace(/\s+/g, ' ')}`);
  else console.log(`      nudge: ${e.text}`);
};

for (const task of tasks) {
  const created = await createMap(delve, { name: `llm-bench ${task.id} · ${model.model} · ${tools}`, template: task.template, ...(task.unit ? { unit: task.unit } : {}) });
  const before = await getMap(delve, created.id);
  const setup = buildSetup(tools, delve.tools, created.id, values['prompt-file'] ? { promptFile: values['prompt-file'] } : {});
  const user = setup.user({ map: before.map, rev: before.rev }, task.prompt);
  if (!results.length) {
    size = setupSize(setup, user);
    toolCount = setup.tools.length + setup.local.length;
  }
  console.log(`${task.n}. ${task.title}`);
  const run = await runAgent({
    client: model.client,
    tools: setup.tools,
    local: setup.local,
    exec: mcpExecutor(delve.mcp),
    system: setup.system,
    user,
    maxTurns: num(values['max-turns'], 'max-turns')!,
    maxToolCalls: num(values['max-calls'], 'max-calls')!,
    timeLimitMs: num(values['time-limit'], 'time-limit')! * 1000,
    maxResultChars: num(values['max-result'], 'max-result')!,
    onEvent: log,
  });
  const after = await getMap(delve, created.id);
  const checks = task.check({ before: before.map, after: after.map, beforeRev: before.rev, afterRev: after.rev, answer: run.answer, calls: run.calls });
  const g = grade(checks);
  const png = `${runDir}/${task.id}.png`;
  try {
    writeFileSync(join(out, png), await renderPng(delve, created.id, 40));
  } catch (e) {
    console.error(`  (no picture: ${(e as Error).message})`);
  }
  const transcript = `${runDir}/${task.id}.json`;
  writeFileSync(
    join(out, transcript),
    JSON.stringify(
      {
        task: task.id,
        prompt: task.prompt,
        tools,
        model: model.model,
        grade: g,
        checks,
        answer: run.answer,
        stop: run.stop,
        error: run.error,
        stats: run.stats,
        systemPromptChars: setup.system.length,
        messages: run.messages.slice(1),
        calls: run.calls,
        mapId: created.id,
        beforeRev: before.rev,
        afterRev: after.rev,
        beforeMap: before.map,
        finalMap: after.map,
      },
      null,
      1,
    ),
  );
  const result: TaskResult = {
    task: task.id,
    n: task.n,
    title: task.title,
    prompt: task.prompt,
    grade: g,
    checks,
    stop: run.stop,
    ...(run.error ? { error: run.error } : {}),
    answer: run.answer,
    lastText: run.lastText,
    stats: run.stats,
    mapId: created.id,
    png,
    transcript,
    callLog: callLog(run.calls),
  };
  results.push(result);
  const s = run.stats;
  const tps = tokensPerSecond(s);
  console.log(
    `   ${g.toUpperCase()} ${checks.filter((c) => c.ok).length}/${checks.length} · ${s.toolCalls} calls, ${s.toolErrors} errors, ${malformed(s)} malformed · ${fmtMs(s.wallMs)}${tps ? ` · ${Math.round(tps)} tok/s` : ''} · stop ${run.stop}${run.error ? ` (${run.error})` : ''}`,
  );
  for (const c of checks.filter((x) => !x.ok)) console.log(`     ✗ ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  if (run.answer) console.log(`   answer: ${run.answer.replace(/\s+/g, ' ').slice(0, 300)}`);
  // save as we go, so a stopped run still has its results
  const runResult: RunResult = {
    model: model.model,
    tools,
    ...(values.name ? { name: values.name } : {}),
    api: model.api,
    baseUrl: model.baseUrl,
    ...(model.numCtx ? { numCtx: model.numCtx } : {}),
    ...(model.think ? { think: model.think } : {}),
    ...(model.serverVersion ? { serverVersion: model.serverVersion } : {}),
    delveVersion: delve.version,
    started,
    finished: new Date().toISOString(),
    size,
    toolCount,
    ...(warmupMs !== undefined ? { warmupMs } : {}),
    tasks: results,
  };
  writeFileSync(join(out, `${runDir}.json`), JSON.stringify(runResult, null, 1));
  writeReport();
}

await delve.close();
const passed = results.filter((r) => r.grade === 'pass').length;
console.log(`\n${model.model} · ${tools}: ${passed} pass, ${results.filter((r) => r.grade === 'partial').length} partial, ${results.filter((r) => r.grade === 'fail').length} fail · report: ${join(out, 'report.md')}`);
