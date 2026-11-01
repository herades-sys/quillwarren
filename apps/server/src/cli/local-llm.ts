// Send one chat message to a local model with Quillwarren's tools and watch it work.
//   npm run local-llm -- --base-url http://192.168.1.40:11434/v1 --model qwen3:8b [--tools lean|full] [--map <id> | --template test-dungeon|empty] [--png out.png] "Add a 6×4 room east of room 1"
// The map is DELVE_URL's (with DELVE_API_TOKEN), or a new one on a throwaway in-process Quillwarren.
// --steps picks the helping steps for small models (local-steps.ts; default ids,final for lean).
// See docs/API.md, "Testing local models".
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { malformed, mcpExecutor, runAgent, tokensPerSecond } from '../chat/local-agent.ts';
import { buildSetup, setupSize } from '../chat/local-setup.ts';
import { connectDelve, createMap, fmtMs, getMap, makeModel, MODEL_HELP, MODEL_OPTIONS, num, renderPng, stepsOf, toolSet } from './llm-common.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...MODEL_OPTIONS,
    map: { type: 'string' },
    template: { type: 'string', default: 'test-dungeon' },
    png: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const message = positionals.join(' ').trim();
if (values.help || !message) {
  console.log(`npm run local-llm -- --base-url URL --model NAME [--map ID | --template test-dungeon|empty] [--png out.png] "message"\n\n${MODEL_HELP}`);
  process.exit(values.help ? 0 : 2);
}
const template = values.template as 'test-dungeon' | 'empty';
if (!['test-dungeon', 'empty'].includes(template)) throw new Error('--template must be test-dungeon or empty');

const tools = toolSet(values.tools);
const model = await makeModel(values, tools);
const delve = await connectDelve();
try {
  const id = values.map ?? (await createMap(delve, { name: `local-llm ${model.model}`, template })).id;
  const current = await getMap(delve, id);
  const setup = buildSetup(tools, delve.tools, id, { steps: stepsOf(values, tools), ...(values['prompt-file'] ? { promptFile: values['prompt-file'] } : {}) });
  const user = setup.user({ map: current.map, rev: current.rev }, message);
  const size = setupSize(setup, user);
  console.log(`${model.client.label} · ${tools}: ${setup.tools.length + setup.local.length} tools · prompt ${size.system} + tools ${size.tools} + message ${size.user} characters · map ${id} (${delve.base}/maps/${id})`);
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
    steps: setup.steps,
    readMap: async () => (await getMap(delve, id)).map,
    request: message,
    onEvent: (e) => {
      if (e.type === 'reply') {
        console.log(`· reply ${e.turn}: ${fmtMs(e.ms)}, ${e.promptTokens ?? '?'} → ${e.completionTokens ?? '?'} tokens${e.think ? `, thought ${e.think.length} chars` : ''}`);
        if (values.verbose && e.think) console.log(`  (thinking) ${e.think.replace(/\s+/g, ' ').slice(0, 600)}`);
        if (e.content) console.log(`  ${e.content.replace(/\n/g, '\n  ')}`);
      } else if (e.type === 'call') {
        const r = e.record;
        console.log(`  ${r.notRun ? '⊘' : r.ok ? '✓' : '✗'} ${r.name} ${JSON.stringify(r.args)}${r.repaired ? ' (repaired)' : ''}${r.source === 'text' ? ' (written as text)' : ''}`);
        console.log(`    → ${(values.verbose ? r.result : r.result.slice(0, 240)).replace(/\n/g, '\n      ')}`);
      } else if (e.type === 'step') console.log(`  [step ${e.step}] ${e.text.replace(/\n/g, '\n    ')}`);
      else console.log(`  nudge: ${e.text}`);
    },
  });
  const s = run.stats;
  const tps = tokensPerSecond(s);
  console.log(`\n${run.stop === 'answer' ? 'Answer' : `Stopped (${run.stop}${run.error ? `: ${run.error}` : ''})`}: ${run.answer || run.lastText || '(nothing)'}`);
  console.log(`${s.turns} replies, ${s.toolCalls} tool calls (${s.toolErrors} errors, ${malformed(s)} malformed), ${fmtMs(s.wallMs)}${tps ? `, ${Math.round(tps)} tok/s` : ''}, largest prompt ${s.maxPrompt} tokens`);
  if (values.png) {
    writeFileSync(values.png, await renderPng(delve, id, 40));
    console.log(`picture: ${values.png}`);
  }
} finally {
  await delve.close();
}
