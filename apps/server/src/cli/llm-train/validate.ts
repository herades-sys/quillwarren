// Keeping only good conversations: every tool call must fit the lean schema
// the model sees, no request may match an llm-bench task (the held-out test)
// or paraphrase one, and replaying the conversation from scratch must give the
// same messages, pass the family's own checks and leave check_map with no new
// problems.
import type { AgentMessage, Json, JsonSchema, ToolDef } from '../../chat/local-agent.ts';
import { TASKS } from '../llm-bench-lib.ts';
import { newProblems } from './kit.ts';
import { warns } from './tools.ts';

// ---------- the lean schema ----------

/** What is wrong with a value against the simplified JSON schema local-agent.ts gives the model (strict: unknown keys are errors). */
export function schemaErrors(v: unknown, s: JsonSchema, path = 'args'): string[] {
  const errs: string[] = [];
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  switch (s.type) {
    case undefined:
      // a length: a number or a text with a unit
      if (typeof v !== 'number' && typeof v !== 'string' && s.properties === undefined) errs.push(`${path}: a number or text, got ${typeof v}`);
      break;
    case 'string':
      if (typeof v !== 'string') errs.push(`${path}: a string, got ${JSON.stringify(v)}`);
      break;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path}: a number, got ${JSON.stringify(v)}`);
      break;
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) errs.push(`${path}: an integer, got ${JSON.stringify(v)}`);
      break;
    case 'boolean':
      if (typeof v !== 'boolean') errs.push(`${path}: true or false, got ${JSON.stringify(v)}`);
      break;
    case 'array': {
      if (!Array.isArray(v)) {
        errs.push(`${path}: an array, got ${JSON.stringify(v)}`);
        break;
      }
      const exactly = /exactly (\d+) /.exec(s.description ?? '')?.[1];
      if (exactly && v.length !== Number(exactly)) errs.push(`${path}: exactly ${exactly} items, got ${v.length}`);
      if (s.items) v.forEach((x, i) => errs.push(...schemaErrors(x, s.items!, `${path}[${i}]`)));
      break;
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errs.push(`${path}: an object, got ${JSON.stringify(v)}`);
        break;
      }
      const o = v as Json;
      for (const k of s.required ?? []) if (!(k in o)) errs.push(`${path}.${k}: required`);
      if (s.properties) {
        for (const [k, x] of Object.entries(o)) {
          const p = s.properties[k];
          if (!p) errs.push(`${path}.${k}: not a parameter of this tool`);
          else errs.push(...schemaErrors(x, p, `${path}.${k}`));
        }
      }
      break;
    }
  }
  return errs;
}

/** Every assistant tool call of a conversation against the lean tool definitions. */
export function callErrors(messages: readonly AgentMessage[], tools: readonly ToolDef[]): string[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const errs: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls ?? []) {
      const t = byName.get(c.name);
      if (!t) errs.push(`${c.name}: not a lean tool`);
      else errs.push(...schemaErrors(c.args, t.parameters).map((e) => `${c.name} ${e}`));
    }
  }
  return errs;
}

// ---------- the held-out llm-bench tasks ----------

const STOP = new Set('a an the and or of to in on at by with for from is it its this that be as all one some any into out up so you your me my i please can could would add make put'.split(' '));
const words = (s: string): string[] => s.toLowerCase().replace(/×/g, 'x').replace(/[^a-z0-9x ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/**
 * The concepts that make each benchmark task what it is. A request that has
 * all the concepts of one task is a paraphrase of it and is dropped. Each
 * concept is a regex over the lower-cased request.
 */
export const BENCH_SIGNATURES: { task: string; all: RegExp[] }[] = [
  { task: 't1-room-east', all: [/\broom 1\b|\bentrance hall\b/, /\beast\b|\bright of\b/, /\b6\s*(x|×|by)\s*4\b|\b4\s*(x|×|by)\s*6\b/] },
  { task: 't2-rename-lock', all: [/\barmou?ry\b/, /\broom 3\b|\bbarracks\b/] },
  { task: 't2-rename-lock', all: [/\brenam|\bcall\b|\bname\b/, /\broom 3\b/, /\block/] },
  { task: 't3-tavern', all: [/\btavern|\bbar counter|\btaproom/, /\broom 2\b|\bcrossroads\b/] },
  { task: 't4-water-bridge', all: [/\bwater\b/, /\bbridge\b/] },
  // trees along the north edge in one clause ("a stream from the north edge … and trees along the east edge" is another task)
  {
    task: 't5-forest-north',
    all: [/\b(forest|trees?|woods?|grove|pines?|oaks?|birch\w*)\b[^.,;]{0,30}\b(along|on|at|by) the north(ern)?\s+(edge|side|border|end)\b|\bnorth(ern)?\s+(edge|side|border|end)\b[^.,;]{0,15}\b(forest|trees?|woods?|grove)\b|\bnorth of the rooms\b/],
  },
  { task: 't6-hill-path', all: [/\bhill\b/, /\b(dirt )?(path|road|track|trail)\b/] },
  { task: 't6-hill-path', all: [/\bhill\b/, /\b5\s*m\b|\b5 metres?\b|\b5 meters?\b/, /\bsouth-?west\b|\bsw\b/] },
  { task: 't7-crypt', all: [/\bcrypt\b/, /\b(4|four)[ -]rooms?\b/] },
  { task: 't7-crypt', all: [/\bsecret door\b/, /\bsarcophag/, /\bempty map\b|\bfrom scratch\b|\bbuild\b/] },
  { task: 't8-question', all: [/\bhow many doors\b|\bwhich doors?\b|\bwhat doors\b/, /\broom 1\b/] },
  { task: 't8-question', all: [/\bleads? outside\b|\bway out\b|\bexit\b/, /\broom 1\b/] },
];

/** Jaccard similarity of the content words (0 when fewer than 5 are shared: short requests share a few words by chance). */
export function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both < 5 ? 0 : both / (A.size + B.size - both);
}

/** The llm-bench task a request matches or paraphrases, or null. */
export function benchOverlap(request: string): string | null {
  const t = request.toLowerCase();
  for (const task of TASKS) {
    if (t.includes(task.prompt.toLowerCase().slice(0, 40))) return `${task.id} (same text)`;
    if (similarity(request, task.prompt) >= 0.6) return `${task.id} (similar wording)`;
  }
  for (const sig of BENCH_SIGNATURES) if (sig.all.every((re) => re.test(t))) return `${sig.task} (same task)`;
  return null;
}

// ---------- the shape of a conversation ----------

/**
 * Things that make a conversation a poor example even when every call
 * worked: a refusal or warning that the next message ignores (the model
 * answering over it), errors outside the recovery family, an empty or
 * JSON-like final answer.
 */
export function shapeErrors(messages: readonly AgentMessage[], opts: { allowErrors: boolean; errorIds: ReadonlySet<string> }): string[] {
  const errs: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      const isError = opts.errorIds.has(m.toolCallId);
      if (!isError && !warns(m.content)) continue;
      if (isError && !opts.allowErrors) errs.push(`error result: ${m.content.slice(0, 80)}`);
      if (!isError && !opts.allowErrors) errs.push(`warning: ${m.content.slice(0, 80)}`);
      // the next assistant message must be another tool call, not the answer
      const next = messages.slice(i + 1).find((x) => x.role === 'assistant');
      if (!next || next.role !== 'assistant' || !next.toolCalls?.length) errs.push(`answered over a refusal or warning: ${m.content.slice(0, 80)}`);
    }
    if (m.role === 'assistant' && !m.toolCalls?.length) {
      if (!m.content.trim()) errs.push('empty answer');
      if (/[{}]|\[\s*"/.test(m.content)) errs.push('JSON in the answer');
      if (m.content.length > 700) errs.push(`answer too long (${m.content.length})`);
    }
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.toolCalls?.length) errs.push('does not end with an answer');
  return errs;
}

export { newProblems };
