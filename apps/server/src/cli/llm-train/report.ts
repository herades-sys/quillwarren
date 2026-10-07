// The split into train and valid, stats.md (counts per family, turns and tool
// calls, what was dropped and why, estimated token lengths) and samples.md
// (a few conversations written out to read).
import type { AgentMessage, ToolDef } from '../../chat/local-agent.ts';
import { FAMILIES } from './families/index.ts';
import type { Example, GenResult } from './generate.ts';
import { CHARS_PER_TOKEN } from './output.ts';
import { hashSeed } from './rng.ts';

/**
 * About `share` of each family goes to valid, chosen by a hash of the
 * conversation's starting-map seed: no starting map is in both files, and
 * every family is in both.
 */
export function splitExamples(examples: readonly Example[], seed: number, share: number): { train: Example[]; valid: Example[] } {
  const valid = new Set<Example>();
  const byFamily = new Map<string, Example[]>();
  for (const e of examples) byFamily.set(e.family, [...(byFamily.get(e.family) ?? []), e]);
  for (const list of byFamily.values()) {
    const k = list.length >= 4 ? Math.max(1, Math.round(list.length * share)) : 0;
    const ranked = [...list].sort((a, b) => hashSeed(seed, 'split', a.mapSeed) - hashSeed(seed, 'split', b.mapSeed));
    for (const e of ranked.slice(0, k)) valid.add(e);
  }
  const byMap = new Set([...valid].map((e) => e.mapSeed));
  return { train: examples.filter((e) => !valid.has(e) && !byMap.has(e.mapSeed)), valid: examples.filter((e) => valid.has(e)) };
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)} %` : '–');
const quantile = (xs: readonly number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
};
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x));

export interface StatsInput {
  result: GenResult;
  train: Example[];
  valid: Example[];
  seed: number;
  count: number;
  seconds: number;
  setup: { text: string; setup: number };
  hooks: string[];
  /** The Delve code the data came from ("1cb651e + uncommitted changes"), or unknown. */
  source: string;
}

export function renderStats(s: StatsInput): string {
  const { result, train, valid } = s;
  const all = [...train, ...valid];
  const L: string[] = [];
  const setupTok = Math.round(s.setup.setup / CHARS_PER_TOKEN.setup);
  const skippedTotal = [...result.skipped.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
  L.push('# Delve training data: statistics', '');
  L.push(`Made by \`npm run llm-train-data -- --count ${s.count} --seed ${s.seed}\` in ${Math.round(s.seconds)} s. Every conversation was assembled by the generator from Delve's lean setup and real tool results, then replayed from scratch and checked (see README.md).`, '');
  L.push(`- **Kept:** ${all.length} conversations: ${train.length} in train.jsonl, ${valid.length} in valid.jsonl (${pct(valid.length, all.length)}).`);
  L.push(`- **Dropped after generation:** ${result.dropped.length} drafts (${pct(result.dropped.length, all.length + result.dropped.length)} of all drafts) failed validation; each slot then tried a new starting map.`);
  L.push(`- **Skipped before a conversation existed:** ${skippedTotal} draws where the starting map didn't suit the family (no room big enough, nothing to fix…).`);
  L.push(`- **Slots left empty:** ${[...result.unfilled.values()].reduce((a, b) => a + b, 0)} of ${s.count}.`);
  L.push(`- **Made from Delve:** ${s.source}. The system prompt, the tools and every tool result come from that code: after the tools or lean-prompt.md change, generate again.`);
  L.push(`- **Harness hooks wired in:** ${s.hooks.length ? s.hooks.join(', ') : 'none (conversations exactly as runAgent() sends them at 1cb651e)'}.`);
  L.push('');

  L.push('## Examples per family', '');
  L.push('| Family | What it teaches | Kept | Train | Valid | Dropped | Tool calls (mean) | User turns (mean) | Est. tokens p50 / p95 / max |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const f of FAMILIES) {
    const ex = all.filter((e) => e.family === f.id);
    if (!ex.length && !result.quotas.has(f.id)) continue;
    const toks = ex.map((e) => e.tokens);
    L.push(
      `| ${f.id} | ${f.title} | ${ex.length} | ${train.filter((e) => e.family === f.id).length} | ${valid.filter((e) => e.family === f.id).length} | ${result.dropped.filter((d) => d.family === f.id).length} | ${f1(mean(ex.map((e) => e.calls)))} | ${f1(mean(ex.map((e) => e.userTurns)))} | ${k(quantile(toks, 0.5))} / ${k(quantile(toks, 0.95))} / ${k(Math.max(0, ...toks))} |`,
    );
  }
  L.push('');
  L.push('Variants (sub-kinds) per family:', '');
  for (const f of FAMILIES) {
    const ex = all.filter((e) => e.family === f.id);
    if (!ex.length) continue;
    const v = new Map<string, number>();
    for (const e of ex) v.set(e.variant, (v.get(e.variant) ?? 0) + 1);
    L.push(`- **${f.id}:** ${[...v].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([n, c]) => `${n} ${c}`).join(', ')}${v.size > 14 ? `, and ${v.size - 14} more` : ''}`);
  }
  L.push('');

  L.push('## Turns and tool calls per conversation', '');
  const hist = (xs: number[], bins: [string, (x: number) => boolean][]) => bins.map(([name, test]) => `${name}: ${xs.filter(test).length} (${pct(xs.filter(test).length, xs.length)})`).join(' · ');
  L.push(`- **User messages:** ${hist(all.map((e) => e.userTurns), [['1', (x) => x === 1], ['2', (x) => x === 2], ['3 or more', (x) => x >= 3]])}`);
  L.push(`- **Assistant messages (tool-call replies and answers):** mean ${f1(mean(all.map((e) => e.assistantTurns)))}, median ${quantile(all.map((e) => e.assistantTurns), 0.5)}, max ${Math.max(0, ...all.map((e) => e.assistantTurns))}`);
  L.push(`- **Tool calls:** ${hist(all.map((e) => e.calls), [['0', (x) => x === 0], ['1', (x) => x === 1], ['2', (x) => x === 2], ['3–5', (x) => x >= 3 && x <= 5], ['6–10', (x) => x >= 6 && x <= 10], ['over 10', (x) => x > 10]])}; mean ${f1(mean(all.map((e) => e.calls)))}`);
  const parallel = all.filter((e) => e.messages.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 1)).length;
  L.push(`- **Several calls in one reply** (independent calls sent together): in ${parallel} conversations (${pct(parallel, all.length)}).`);
  const byTool = new Map<string, number>();
  for (const e of all) for (const m of e.messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) byTool.set(c.name, (byTool.get(c.name) ?? 0) + 1);
  L.push(`- **Calls by tool:** ${[...byTool].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ')}.`);
  const unused = result.tools.map((t) => t.name).filter((n) => !byTool.has(n));
  if (unused.length) L.push(`- **Lean tools never called:** ${unused.join(', ')}.`);
  const errs = all.reduce((a, e) => a + e.messages.filter((m) => m.role === 'tool' && /^(\w+: |Error)/.test(m.content) && !/^(Added|Moved|Updated|Deleted|Applied|Undid|No problems|\d+ problem)/.test(m.content)).length, 0);
  L.push(`- **Refused calls in the data** (recovery family only, each followed by the corrected call): about ${errs}.`);
  const kinds = new Map<string, number>();
  for (const e of all) kinds.set(`${e.start.kind}`, (kinds.get(e.start.kind) ?? 0) + 1);
  L.push(`- **Starting maps:** ${[...kinds].map(([n, c]) => `${n} ${c}`).join(', ')}.`);
  const metric = all.filter((e) => /1 square = [\d.]+ m\./.test((e.messages[1] as { content: string }).content)).length;
  L.push(`- **Units:** ${metric} conversations on metre maps, ${all.length - metric} on feet maps.`);
  L.push('');

  L.push('## What was dropped, and why', '');
  if (!result.dropped.length) L.push('Nothing was dropped.');
  else {
    const reasons = new Map<string, number>();
    for (const d of result.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
    L.push('| Reason | Drafts | Families |', '|---|---|---|');
    for (const [r, c] of [...reasons].sort((a, b) => b[1] - a[1])) {
      const fams = new Map<string, number>();
      for (const d of result.dropped.filter((x) => x.reason === r)) fams.set(d.family, (fams.get(d.family) ?? 0) + 1);
      L.push(`| ${r} | ${c} | ${[...fams].map(([n, x]) => `${n} ${x}`).join(', ')} |`);
    }
    L.push('', 'First examples of each reason:', '');
    for (const r of reasons.keys()) {
      for (const d of result.dropped.filter((x) => x.reason === r).slice(0, 3)) L.push(`- ${r} (${d.family}): ${d.detail.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  L.push('');
  if (skippedTotal) {
    L.push('Draws skipped before a conversation was made (the family looked at the starting map and passed):', '');
    for (const [fam, m] of result.skipped) L.push(`- **${fam}:** ${[...m].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ${c}`).join(', ')}`);
    L.push('');
  }

  L.push('## Estimated token lengths', '');
  L.push(`There is no Qwen tokenizer offline, so lengths are estimated from characters of the conversation rendered with Qwen3's chat template (thinking off): about ${CHARS_PER_TOKEN.setup} characters per token for the system prompt with the tool definitions and ${CHARS_PER_TOKEN.rest} for the rest (the context block is full of numbers). Calibrated on the 34 prompts of the 2026-10-06 llm-bench runs (qwen3:8b, Ollama's prompt_eval_count), largest error 3.9 %. train.py counts exactly with the real tokenizer and drops what is longer than its MAX_SEQ_LEN.`, '');
  const toks = all.map((e) => e.tokens);
  L.push(`- **The fixed part** (system prompt and the 17 tool definitions, in every example): about ${k(setupTok)} tokens (${s.setup.setup} characters).`);
  L.push(`- **Whole conversations:** min ${k(Math.min(...toks))}, median ${k(quantile(toks, 0.5))}, p90 ${k(quantile(toks, 0.9))}, p95 ${k(quantile(toks, 0.95))}, p99 ${k(quantile(toks, 0.99))}, max ${k(Math.max(...toks))}.`);
  for (const lim of [8192, 12288, 16384]) {
    const over = toks.filter((t) => t > lim).length;
    L.push(`- **Over ${lim / 1024}k tokens:** ${over} (${pct(over, toks.length)})`);
  }
  const buckets: [string, number, number][] = [['under 6k', 0, 6000], ['6k–7k', 6000, 7000], ['7k–8k', 7000, 8000], ['8k–9k', 8000, 9000], ['9k–10k', 9000, 10000], ['10k–12k', 10000, 12000], ['12k–16k', 12000, 16000], ['over 16k', 16000, Infinity]];
  L.push('', '| Estimated tokens | Conversations |', '|---|---|');
  for (const [name, lo, hi] of buckets) L.push(`| ${name} | ${toks.filter((t) => t >= lo && t < hi).length} |`);
  L.push('');
  const trainTok = train.reduce((a, e) => a + e.tokens, 0);
  L.push(`Total: about ${(trainTok / 1e6).toFixed(1)} M tokens in train.jsonl per epoch (${(train.reduce((a, e) => a + e.tokens - setupTok, 0) / 1e6).toFixed(1)} M without the fixed part); the model only learns from the assistant turns, about ${(all.reduce((a, e) => a + e.messages.filter((m) => m.role === 'assistant').reduce((x, m) => x + (m.role === 'assistant' ? m.content.length + JSON.stringify(m.toolCalls ?? []).length : 0), 0), 0) / CHARS_PER_TOKEN.rest / 1e6).toFixed(2)} M tokens of all of them.`);
  L.push('');

  L.push('## The held-out llm-bench tasks', '');
  const benchDrops = result.dropped.filter((d) => d.reason === 'matches an llm-bench task');
  L.push(`Every request is checked against the 8 llm-bench prompts (the same text, a word overlap of 0.6 or more with at least 5 shared words, or all the concepts of a task: e.g. a tavern in room 2, water with a bridge, trees along the north edge, a hill with a path; deliberately broad, so some unrelated requests that only mention room 2 and a taproom, say, are dropped too). The test-dungeon template is never used, and the generator doesn't produce the bench's empty-map tasks. ${benchDrops.length} draft${benchDrops.length === 1 ? '' : 's'} matched and ${benchDrops.length === 1 ? 'was' : 'were'} dropped${benchDrops.length ? ':' : '.'}`);
  for (const d of benchDrops.slice(0, 8)) L.push(`- ${d.detail.slice(0, 200)}`);
  L.push('');
  return L.join('\n');
}

const block = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``;

/** One conversation written out to read. */
function renderOne(e: Example, n: number): string {
  const L: string[] = [];
  L.push(`## ${n}. ${e.family} (${e.variant})`, '');
  L.push(`Starting map: ${e.start.kind}, seed ${e.start.seed} · about ${e.tokens} tokens · ${e.calls} tool call${e.calls === 1 ? '' : 's'}`, '');
  for (const m of e.messages.slice(1) as AgentMessage[]) {
    if (m.role === 'user') {
      const cut = m.content.lastIndexOf('[End of Delve context]');
      if (cut >= 0) {
        const ctx = m.content.slice(0, cut + '[End of Delve context]'.length);
        L.push('<details><summary>Context block (as the harness adds it)</summary>', '', block(ctx), '', '</details>', '');
        L.push(`**User:** ${m.content.slice(cut + '[End of Delve context]'.length).trim()}`, '');
      } else L.push(`**User:** ${m.content}`, '');
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) L.push(`**Assistant (tool call${m.toolCalls.length > 1 ? 's' : ''}):**`, '', block(m.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join('\n')), '');
      else L.push(`**Assistant:** ${m.content}`, '');
    } else if (m.role === 'tool') {
      L.push(`**Tool result (${m.name}):**`, '', block(m.content), '');
    }
  }
  return L.join('\n');
}

/** `count` conversations from different families (the first of each, in family order). */
export function renderSamples(examples: readonly Example[], count: number, tools: readonly ToolDef[]): string {
  const picked: Example[] = [];
  const wanted = ['room_beside', 'furnish_theme', 'recovery', 'multi_turn', 'question', 'terrain_region', 'scratch_build', 'delete', 'fix_problems', 'props_along', 'height', 'edit_fields', 'outdoor_scratch', 'find_and_place', 'explicit_coords'];
  for (const fam of wanted) {
    if (picked.length >= count) break;
    // prefer one with a little more going on than the simplest variant
    const ex = examples.filter((e) => e.family === fam);
    const e = ex.find((x) => x.calls >= 2 || x.userTurns > 1) ?? ex[0];
    if (e) picked.push(e);
  }
  const L = ['# Delve training data: samples', ''];
  L.push(`${picked.length} conversations from train/valid, written out to read. Every one starts with the same system prompt (${examples[0]?.messages[0]?.content.length ?? 0} characters, in system_prompt.txt) and the same ${tools.length} tool definitions (tools.json); they are left out here. The context block in each user message is folded away. In the JSONL files the tool calls carry ids (call_1, call_2…) and the arguments as JSON strings.`, '');
  picked.forEach((e, i) => L.push(renderOne(e, i + 1)));
  return L.join('\n');
}
