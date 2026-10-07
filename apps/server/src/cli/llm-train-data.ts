// Training data for a Delve-specific local model, made by a program: every
// conversation is assembled from Delve's own lean setup (system prompt, tool
// schemas, the context block as the local harness frames it) and the real MCP
// tools run in process, from procedurally generated starting maps and
// templated requests with scripted solutions. No language model writes,
// rewrites or grades anything. See docs/API.md, "Training data for a local
// model".
//   npm run llm-train-data -- [--count 4000] [--seed 1] [--out ~/llm-train] [--families a,b] [--max-tokens 16384]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FAMILIES } from './llm-train/families/index.ts';
import { generate } from './llm-train/generate.ts';
import { hooksInUse } from './llm-train/harness-hooks.ts';
import { CHARS_PER_TOKEN, openAiTools, renderQwen3, shareGptAlternates, toOpenAi, toShareGpt } from './llm-train/output.ts';
import { renderSamples, renderStats, splitExamples } from './llm-train/report.ts';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '4000' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string', default: 'llm-train' },
    families: { type: 'string' },
    'max-tokens': { type: 'string', default: '16384' },
    'valid-share': { type: 'string', default: '0.05' },
    samples: { type: 'string', default: '10' },
    'no-sharegpt': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`npm run llm-train-data -- [--count N] [--seed N] [--out DIR] [--families id,id] [--max-tokens N] [--valid-share 0.05] [--samples 10] [--no-sharegpt]
Families: ${FAMILIES.map((f) => f.id).join(', ')}`);
  process.exit(0);
}

const num = (v: string | undefined, name: string): number => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`--${name} must be a number, got "${v}"`);
  return x;
};

const count = num(values.count, 'count');
const seed = num(values.seed, 'seed');
const out = values.out;
const t0 = Date.now();
mkdirSync(out, { recursive: true });

let last = 0;
const result = await generate({
  count,
  seed,
  ...(values.families ? { families: values.families.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  maxTokens: num(values['max-tokens'], 'max-tokens'),
  onProgress: (done, total, kept) => {
    if (values.quiet) return;
    const now = Date.now();
    if (now - last > 5000 || done === total) {
      last = now;
      console.log(`${done}/${total} slots, ${kept} kept · ${Math.round((now - t0) / 1000)} s`);
    }
  },
});

const { train, valid } = splitExamples(result.examples, seed, num(values['valid-share'], 'valid-share'));
const tools = openAiTools(result.tools);
const line = (ex: (typeof train)[number]) => JSON.stringify({ messages: toOpenAi(ex.messages), tools });
writeFileSync(join(out, 'train.jsonl'), train.map(line).join('\n') + '\n');
writeFileSync(join(out, 'valid.jsonl'), valid.map(line).join('\n') + '\n');
if (!values['no-sharegpt']) {
  // LLaMA-Factory's turns must alternate; a harness hook that adds a user message after tool results breaks that
  const sgTrain = train.map((ex) => toShareGpt(ex.messages, result.tools));
  const sgValid = valid.map((ex) => toShareGpt(ex.messages, result.tools));
  const broken = [...sgTrain, ...sgValid].filter((s) => !shareGptAlternates(s)).length;
  if (broken) console.warn(`sharegpt files not written: ${broken} conversations don't alternate human/gpt turns (harness messages between tool results and replies); use train.jsonl / valid.jsonl`);
  else {
    writeFileSync(join(out, 'train_sharegpt.jsonl'), sgTrain.map((s) => JSON.stringify(s)).join('\n') + '\n');
    writeFileSync(join(out, 'valid_sharegpt.jsonl'), sgValid.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const info = (file: string) => ({ file_name: file, formatting: 'sharegpt', columns: { messages: 'conversations', system: 'system', tools: 'tools' } });
    writeFileSync(join(out, 'dataset_info.json'), JSON.stringify({ delve_train: info('train_sharegpt.jsonl'), delve_valid: info('valid_sharegpt.jsonl') }, null, 2) + '\n');
  }
}
// what every example shares, and one line per example about where it came from
writeFileSync(join(out, 'tools.json'), JSON.stringify(tools, null, 2) + '\n');
writeFileSync(join(out, 'system_prompt.txt'), result.system + '\n');
writeFileSync(
  join(out, 'examples.meta.jsonl'),
  [...train.map((e) => ({ e, split: 'train' })), ...valid.map((e) => ({ e, split: 'valid' }))]
    .map(({ e, split }) => JSON.stringify({ split, family: e.family, variant: e.variant, seed: e.seed, map_seed: e.start.seed, map_kind: e.start.kind, est_tokens: e.tokens, tool_calls: e.calls, user_turns: e.userTurns, requests: e.requests }))
    .join('\n') + '\n',
);
const setupTokens = renderQwen3([{ role: 'system', content: result.system }], result.tools);
writeFileSync(join(out, 'stats.md'), renderStats({ result, train, valid, seed, count, seconds: (Date.now() - t0) / 1000, setup: setupTokens, hooks: hooksInUse(), source: sourceVersion() }));
writeFileSync(join(out, 'samples.md'), renderSamples(result.examples, num(values.samples, 'samples'), result.tools));

// the README, the training script and the Modelfile travel with the data
const pkg = new URL('./llm-train/package/', import.meta.url);
for (const f of readdirSync(pkg).filter((n) => /\.(md|py|template)$/.test(n))) {
  const src = new URL(f, pkg);
  if (f.endsWith('.md')) {
    const toks = [...train, ...valid].map((e) => e.tokens).sort((a, b) => a - b);
    const at = (q: number) => toks[Math.min(toks.length - 1, Math.floor(q * (toks.length - 1) + 0.5))] ?? 0;
    const over = (n: number) => `${toks.filter((t) => t > n).length} (${toks.length ? ((100 * toks.filter((t) => t > n).length) / toks.length).toFixed(1) : '0'} %)`;
    const fill: Record<string, string> = {
      TRAIN: String(train.length),
      VALID: String(valid.length),
      SEED: String(seed),
      COUNT: String(count),
      DROPPED: String(result.dropped.length),
      FAMILIES: String(new Set(result.examples.map((e) => e.family)).size),
      SETUP_TOKENS: String(Math.round(setupTokens.setup / CHARS_PER_TOKEN.setup)),
      TOK_MEDIAN: String(at(0.5)),
      TOK_P95: String(at(0.95)),
      TOK_MAX: String(toks[toks.length - 1] ?? 0),
      OVER_7K: over(7168),
      OVER_8K: over(8192),
      OVER_12K: over(12288),
      TRAIN_MTOK: (train.reduce((s, e) => s + e.tokens, 0) / 1e6).toFixed(1),
      SOURCE: sourceVersion(),
      HOOKS: hooksInUse().join(', ') || 'none',
    };
    const text = readFileSync(src, 'utf8').replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => fill[k] ?? m);
    writeFileSync(join(out, f), text);
  } else copyFileSync(src, join(out, f));
}

console.log(`wrote ${train.length} train + ${valid.length} valid conversations to ${out} (${result.dropped.length} dropped, ${Math.round((Date.now() - t0) / 1000)} s)`);

/** The git commit the generator ran on, and whether tracked files had changes on top. */
function sourceVersion(): string {
  try {
    const root = new URL('../../../../', import.meta.url);
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
    return dirty ? `${commit} plus uncommitted changes (${dirty.split('\n').length} tracked files)` : commit;
  } catch {
    return 'unknown (not a git checkout)';
  }
}
