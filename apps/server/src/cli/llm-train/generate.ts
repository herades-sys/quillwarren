// The generator: for each conversation slot, a family (by fixed quotas, so
// the counts per family come out as planned), a starting map, the family's
// request and scripted solution through the real tools, then validation by a
// replay from scratch. Everything is seeded from --seed, so a run repeats.
import type { DelveMap } from '@delve/core';
import type { AgentMessage, ToolDef } from '../../chat/local-agent.ts';
import { Convo } from './convo.ts';
import { Quillwarren } from './delve.ts';
import { FAMILIES } from './families/index.ts';
import { Skip, type Family } from './families/common.ts';
import { HARNESS_HOOKS, type HarnessHooks } from './harness-hooks.ts';
import { newProblems } from './kit.ts';
import { buildStart, type StartSpec } from './maps.ts';
import { estimateTokens, renderQwen3 } from './output.ts';
import { hashSeed, Rng } from './rng.ts';
import { benchOverlap, callErrors, shapeErrors } from './validate.ts';

export interface GenOptions {
  count: number;
  seed: number;
  /** Only these family ids (default: all). */
  families?: string[];
  /** Conversations above this estimated length are dropped. */
  maxTokens: number;
  hooks?: HarnessHooks;
  /** Tries per slot (each with a new starting map) before the slot is left empty. */
  attempts?: number;
  onProgress?: (done: number, total: number, kept: number) => void;
}

export interface Example {
  slot: number;
  family: string;
  variant: string;
  /** The conversation's seed and its starting map's seed (the split goes by the map). */
  seed: number;
  mapSeed: number;
  start: StartSpec;
  messages: AgentMessage[];
  requests: string[];
  tokens: number;
  calls: number;
  userTurns: number;
  assistantTurns: number;
}

export interface Dropped {
  family: string;
  reason: string;
  detail: string;
}

export interface GenResult {
  examples: Example[];
  dropped: Dropped[];
  /** Draws that never became a conversation (the starting map didn't suit the family): family → reason → count. */
  skipped: Map<string, Map<string, number>>;
  /** Slots left empty after every try. */
  unfilled: Map<string, number>;
  system: string;
  tools: ToolDef[];
  quotas: Map<string, number>;
}

/** Slots per family, in proportion to the weights (largest remainders get the leftovers). */
export function quotas(families: readonly Family[], count: number): Map<string, number> {
  const total = families.reduce((s, f) => s + f.weight, 0);
  const raw = families.map((f) => ({ id: f.id, exact: (count * f.weight) / total }));
  const out = new Map(raw.map((r) => [r.id, Math.floor(r.exact)]));
  let left = count - [...out.values()].reduce((s, v) => s + v, 0);
  for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left-- <= 0) break;
    out.set(r.id, out.get(r.id)! + 1);
  }
  return out;
}

/** The reason in a few words, for the stats table. */
function reasonOf(errs: readonly string[]): string {
  const e = errs[0] ?? 'unknown';
  if (/^final check:/.test(e)) return "the harness's final check objected";
  if (/^held-back/.test(e)) return 'held-back calls';
  if (/schema|not a parameter|required|not one of|a number|a string|an array|an object|not a lean tool/.test(e)) return 'call does not fit the lean schema';
  if (/replay/.test(e)) return 'replay differs';
  if (/^check:/.test(e)) return "family's own check failed";
  if (/new problem/.test(e)) return 'check_map: new problems';
  if (/answered over|warning|error result/.test(e)) return 'refusal or warning not handled';
  if (/tokens/.test(e)) return 'too long';
  if (/answer|JSON/.test(e)) return 'bad final answer';
  return e.slice(0, 60);
}

interface Built {
  convo: Convo;
  delve: Quillwarren;
  startMap: DelveMap;
}

async function build(spec: StartSpec, convSeed: number, hooks: HarnessHooks): Promise<Built & { start: Awaited<ReturnType<typeof buildStart>> }> {
  const delve = await Quillwarren.open();
  try {
    const start = await buildStart(delve, spec);
    const startMap = structuredClone(delve.get(start.mapId).map);
    return { convo: new Convo(delve, start.mapId, convSeed, hooks), delve, startMap, start };
  } catch (e) {
    await delve.close();
    throw e;
  }
}

/** Replay a conversation from scratch: the same starting map, the same calls; returns the replay. */
async function replay(spec: StartSpec, convSeed: number, hooks: HarnessHooks, original: Convo): Promise<Built> {
  const b = await build(spec, convSeed, hooks);
  for (const t of original.turns) {
    await b.convo.user(t.request, t.selection ? { selection: t.selection } : {});
    for (const e of t.events) {
      if (e.kind === 'step') await b.convo.step(...e.calls);
      else await b.convo.answer(e.text);
    }
  }
  return b;
}

export async function generate(o: GenOptions): Promise<GenResult> {
  const hooks = o.hooks ?? HARNESS_HOOKS;
  const families = FAMILIES.filter((f) => !o.families?.length || o.families.includes(f.id));
  if (!families.length) throw new Error(`no family matches ${o.families?.join(', ')}`);
  const q = quotas(families, o.count);
  const slots = new Rng(hashSeed(o.seed, 'slots')).shuffle(families.flatMap((f) => Array<Family>(q.get(f.id)!).fill(f)));
  const out: GenResult = { examples: [], dropped: [], skipped: new Map(), unfilled: new Map(), system: '', tools: [], quotas: q };
  const attempts = o.attempts ?? 10;
  for (let slot = 0; slot < slots.length; slot++) {
    const f = slots[slot]!;
    let done = false;
    for (let attempt = 0; attempt < attempts && !done; attempt++) {
      const convSeed = hashSeed(o.seed, 'conv', slot, attempt);
      const rng = new Rng(convSeed);
      const mapSeed = hashSeed(o.seed, 'map', slot, attempt);
      const spec: StartSpec = { ...f.start(rng.fork('start')), seed: mapSeed };
      let built: (Built & { start: Awaited<ReturnType<typeof buildStart>> }) | null = null;
      let again: Built | null = null;
      try {
        built = await build(spec, convSeed, hooks);
        const { convo, startMap, start } = built;
        if (!out.system) {
          out.system = convo.setup.system;
          out.tools = convo.setup.tools;
        }
        const result = await f.run({ rng: rng.fork('run'), convo, start, startMap });
        const overlap = convo.turns.map((t) => benchOverlap(t.request)).find(Boolean);
        if (overlap) {
          out.dropped.push({ family: f.id, reason: 'matches an llm-bench task', detail: `${overlap}: ${convo.turns[0]!.request}` });
          continue;
        }
        const errs: string[] = [];
        // the harness's final check (afterAnswer hook): every kept conversation passes it, or answers what it said
        if (convo.unanswered) errs.push(`final check: ${convo.turns.find((t) => t.finalCheck)?.finalCheck?.slice(0, 120)}`);
        for (const t of convo.turns) if (t.finalCheck && f.id !== 'recovery') errs.push(`final check: ${t.finalCheck.slice(0, 120)}`);
        // held-back calls (batch hook) only where Quillwarren refused something for a real reason
        if (convo.allSteps().some((s) => s.notRun) && f.id !== 'recovery') errs.push('held-back calls outside the recovery family');
        errs.push(...callErrors(convo.messages, convo.setup.tools).map((e) => `schema: ${e}`));
        const errorIds = new Set(convo.allSteps().filter((s) => s.run.isError).map((s) => s.id));
        errs.push(...shapeErrors(convo.messages, { allowErrors: f.id === 'recovery', errorIds }));
        again = await replay(spec, convSeed, hooks, convo);
        if (JSON.stringify(again.convo.messages) !== JSON.stringify(convo.messages)) errs.push('replay differs from the first run');
        const final = again.convo.map;
        errs.push(...result.check(final, again.startMap).map((e) => `check: ${e}`));
        if (!result.allowProblems) errs.push(...newProblems(again.startMap, final).map((p) => `new problem: ${p.text}`));
        const tokens = estimateTokens(renderQwen3(convo.messages, convo.setup.tools));
        if (tokens > o.maxTokens) errs.push(`tokens: about ${tokens}, over ${o.maxTokens}`);
        if (errs.length) {
          out.dropped.push({ family: f.id, reason: reasonOf(errs), detail: errs.slice(0, 3).join(' | ') });
          continue;
        }
        const msgs = convo.messages;
        out.examples.push({
          slot,
          family: f.id,
          variant: result.variant,
          seed: convSeed,
          mapSeed,
          start: spec,
          messages: msgs,
          requests: convo.turns.map((t) => t.request),
          tokens,
          calls: convo.allSteps().length,
          userTurns: convo.turns.length,
          assistantTurns: msgs.filter((m) => m.role === 'assistant').length,
        });
        done = true;
      } catch (e) {
        if (e instanceof Skip) {
          const per = out.skipped.get(f.id) ?? new Map<string, number>();
          per.set(e.message, (per.get(e.message) ?? 0) + 1);
          out.skipped.set(f.id, per);
        } else {
          out.dropped.push({ family: f.id, reason: 'generator error', detail: `${(e as Error).message}`.slice(0, 200) });
        }
      } finally {
        if (built) await built.delve.close();
        if (again) await again.delve.close();
      }
    }
    if (!done) out.unfilled.set(f.id, (out.unfilled.get(f.id) ?? 0) + 1);
    o.onProgress?.(slot + 1, slots.length, out.examples.length);
  }
  return out;
}
