// Helping steps for small models in the local-model harness (local-agent.ts):
// everything the harness writes into the conversation besides the model's own
// turns and the tools' replies. Each message comes from a pure function here
// (the first message from local-setup.ts, which uses nextIdsLine), so a
// training-data generator can write exactly the same messages for the same maps
// and calls. See docs/API.md, "Testing local models".
//
// - Batches (always on): calls in one reply run in order, each against the map
//   the earlier ones left; after the first failed call the rest are held back
//   (heldBackNote on the failed call, notRunText for each held-back one).
// - ids: the context block says which ids the next new objects get, so a reply
//   can make a hill and a path to it (h1) in one batch.
// - final: when the model answers after changing the map, the harness checks
//   the map once (check_map's problems with what this request made, ids the
//   answer names that don't exist, failed calls never done again, and after a
//   held-back batch the request itself with what was made where) and hands
//   back what it finds.
// - digest (not in LEAN_STEPS: the model copied it into its answers): after
//   each turn's calls, what this request has made, what is undone, the next ids.
// - plan (not in LEAN_STEPS: more replies and tokens, one-call jobs split up):
//   the model starts with a short numbered plan; each turn ends with a reminder.
import { assetInfo, checkMap, compassWord, mapBox, nextId, nextLabel, propBounds, shapeBounds, type DelveMap, type MapObject, type Problem } from '@delve/core';
import type { CallRecord, Json } from './local-agent.ts';

export const HELPING_STEPS = ['ids', 'final', 'digest', 'plan'] as const;
export type HelpingStep = (typeof HELPING_STEPS)[number];
export type Steps = { readonly [K in HelpingStep]?: boolean };

/** No helping steps (the full setup, and lean runs with --steps none). */
export const NO_STEPS: Steps = {};
/** What lean runs use unless told otherwise: the steps that helped in the trial runs (docs/llm-bench/2026-10-07-qwen3-8b-helping-steps.md). */
export const LEAN_STEPS: Steps = { ids: true, final: true };

/** "all", "none", "default" or a list such as "ids,final" (unknown names are an error). */
export function parseSteps(v: string | undefined, fallback: Steps): Steps {
  const t = (v ?? '').trim().toLowerCase();
  if (!t || t === 'default') return fallback;
  if (t === 'none') return NO_STEPS;
  if (t === 'all') return Object.fromEntries(HELPING_STEPS.map((s) => [s, true]));
  const out: Partial<Record<HelpingStep, boolean>> = {};
  for (const w of t.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(HELPING_STEPS as readonly string[]).includes(w)) throw new Error(`--steps: unknown step "${w}" (the steps are ${HELPING_STEPS.join(', ')}, or all, none, default)`);
    out[w as HelpingStep] = true;
  }
  return out;
}

/** "ids, final" or "none". */
export function stepsText(s: Steps): string {
  const on = HELPING_STEPS.filter((k) => s[k]);
  return on.length ? on.join(', ') : 'none';
}

// ---------- batches: in order, held back after a failure ----------

/** The tool result for a call that was not run because an earlier call in the same reply failed. */
export function notRunText(failed: { index: number; name: string }): string {
  return `Not run: call ${failed.index + 1} of this reply (${failed.name}) failed, and this call may need what that one was meant to make. It was not tried, so nothing in it is known to be wrong: send it again unchanged once that call works.`;
}

/** Added to a call's result when the model has made the very same call several times in a row. */
export function repeatNote(times: number): string {
  return `\nYou have now made this same call ${times} times in a row. Do something else, or give your final answer.`;
}

/** Added to a failed call's result when calls after it in the same reply were held back. */
export function heldBackNote(failedIndex: number, rest: readonly { name: string }[]): string {
  if (!rest.length) return '';
  const list = rest.map((c, k) => `${failedIndex + 2 + k}. ${c.name}`).join(', ');
  return rest.length === 1
    ? `\nThe call after this one in your reply was not run (${list}). Fix this call, then send that one again; the calls before this one are done.`
    : `\nThe ${rest.length} calls after this one in your reply were not run (${list}). Fix this call, then send them again; the calls before this one are done.`;
}

// ---------- ids ----------

const ID_KINDS: readonly [string, string][] = [
  ['r', 'room'],
  ['c', 'corridor'],
  ['d', 'door'],
  ['i', 'prop'],
  ['t', 'terrain'],
  ['h', 'height area'],
  ['l', 'label'],
];

/** The ids the next new objects get. */
export function nextIds(map: DelveMap): string {
  return ID_KINDS.map(([p, w]) => `${w} ${nextId(map, p)}${p === 'r' ? ` (number ${nextLabel(map)})` : ''}`).join(', ');
}

/** The line in the context block (step ids). */
export function nextIdsLine(map: DelveMap): string {
  return `Next new ids: ${nextIds(map)}; several props take the next ids in a row. The calls in one reply run in order, so a later call can use an id that an earlier one makes.`;
}

// ---------- what a request has done ----------

export interface MapChanges {
  added: MapObject[];
  changed: MapObject[];
  removed: string[];
}

/** What changed between two versions of a map. */
export function mapChanges(start: DelveMap, now: DelveMap): MapChanges {
  const before = new Map(start.objects.map((o) => [o.id, o]));
  const after = new Set(now.objects.map((o) => o.id));
  const added: MapObject[] = [];
  const changed: MapObject[] = [];
  for (const o of now.objects) {
    const b = before.get(o.id);
    if (!b) added.push(o);
    else if (JSON.stringify(b) !== JSON.stringify(o)) changed.push(o);
  }
  return { added, changed, removed: start.objects.filter((o) => !after.has(o.id)).map((o) => o.id) };
}

/** What an object is, in a few words: "room 7", "Grass", "height +5", "locked door". */
function kindText(o: MapObject): string {
  switch (o.type) {
    case 'room':
      return `room${o.label ? ` ${o.label}` : ''}${o.name ? ` "${o.name}"` : ''}`;
    case 'prop':
    case 'terrain':
      return assetInfo(o.asset)?.name ?? o.asset;
    case 'height':
      return `height ${o.height > 0 ? '+' : ''}${o.height}`;
    case 'door':
      return `${o.style ?? 'normal'} door`;
    default:
      return o.type;
  }
}

/** "t1 (Grass)", "h1 (height +5)", "r7 (room 7)", "d7 (locked door)". */
export function shortName(o: MapObject): string {
  return `${o.id} (${kindText(o)})`;
}

/** What a request made, with where each room, area and prop lies on the map: `r1 (room 1 "Hall", north-west), h1 (height +5, south-west), c1 (corridor)`. */
export function madeText(start: DelveMap, now: DelveMap, max = 16): string {
  const added = mapChanges(start, now).added;
  const box = mapBox(now);
  const where = (o: MapObject): string => {
    const b = o.type === 'room' || o.type === 'terrain' || o.type === 'height' ? shapeBounds(o.shape) : o.type === 'prop' ? propBounds(o) : null;
    return b && box ? `, ${compassWord([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], box)}` : '';
  };
  const list = added.slice(0, max).map((o) => `${o.id} (${kindText(o)}${where(o)})`);
  return `${list.join(', ')}${added.length > max ? ` and ${added.length - max} more` : ''}`;
}

/** A call as the model wrote it, without the map id the harness adds: `add_prop {"asset": "bar-counter", "in": "r2"}`. */
export function callText(name: string, args: Json, max = 200): string {
  const own = Object.entries(args).filter(([k]) => k !== 'map');
  const json = `{${own.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
  const s = `${name} ${json}`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const firstLine = (s: string, max = 180) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What a call is about, to tell a retry from another call of the same tool: the tool plus its asset or id. */
const callKey = (c: Pick<CallRecord, 'name' | 'args'>) => `${c.name} ${typeof c.args.asset === 'string' ? c.args.asset : ''} ${typeof c.args.id === 'string' ? c.args.id : ''}`;

/** The object ids a call acts on (id, ids). */
const callIds = (c: Pick<CallRecord, 'args'>): string[] => [c.args.id, ...(Array.isArray(c.args.ids) ? c.args.ids : [])].filter((x): x is string => typeof x === 'string' && x !== '');

/** Whether a refusal names this id as a word ("Door d1 (normal) is in that wall already"). */
const names = (text: string, id: string) => text.split(/[^\w-]+/).includes(id);

/**
 * Calls that failed (or were held back) and were never done again: no later
 * call of the same tool and the same asset or id worked, and no later call that
 * worked acted on an object the refusal named (the door already in that wall,
 * restyled with update instead of a second door).
 */
export function unresolvedCalls(calls: readonly CallRecord[]): CallRecord[] {
  const out: CallRecord[] = [];
  calls.forEach((c, k) => {
    if (c.ok) return;
    const key = callKey(c);
    if (calls.slice(k + 1).some((d) => d.ok && callKey(d) === key)) return;
    if (!c.notRun && calls.slice(k + 1).some((d) => d.ok && callIds(d).some((id) => names(c.result, id)))) return;
    // the same thing failing again later is listed once, as its last try
    if (calls.slice(k + 1).some((d) => !d.ok && callKey(d) === key)) return;
    out.push(c);
  });
  return out;
}

/** One line per unresolved call: what was asked and why it failed. */
function unresolvedLines(calls: readonly CallRecord[]): string[] {
  return unresolvedCalls(calls).map((c) => `${callText(c.name, c.args)} ${c.notRun ? 'was not run' : `failed: ${firstLine(c.result)}`}`);
}

// ---------- step digest: after each turn ----------

/** The line added after a turn's tool results (step digest): what this request has made, what is undone, the next ids. */
export function stateDigest(o: { start: DelveMap; now: DelveMap; calls: readonly CallRecord[] }): string {
  const ch = mapChanges(o.start, o.now);
  const parts: string[] = [];
  const list = (xs: readonly MapObject[]) => (xs.length > 12 ? `${xs.slice(0, 12).map(shortName).join(', ')} and ${xs.length - 12} more` : xs.map(shortName).join(', '));
  parts.push(ch.added.length ? `made ${list(ch.added)}` : 'nothing made yet');
  if (ch.changed.length) parts.push(`changed ${list(ch.changed)}`);
  if (ch.removed.length) parts.push(`removed ${ch.removed.join(', ')}`);
  const undone = unresolvedLines(o.calls);
  const tail = undone.length ? ` Not done yet: ${undone.join('; ')}.` : '';
  return `[So far in this request: ${parts.join('; ')}.${tail} Next new ids: ${nextIds(o.now)}.]`;
}

// ---------- step final: one check before the answer ----------

const ID_IN_TEXT = /\b([rcdithlspmwo])(\d{1,4})\b/g;

/** Dice, not doors: "roll a d20". */
const DICE = /^d(4|6|8|10|12|20|100)$/;

/** Ids an answer names that are on neither version of the map (made up). */
export function inventedIds(answer: string, start: DelveMap, now: DelveMap): string[] {
  const known = new Set([...start.objects, ...now.objects].map((o) => o.id));
  const out: string[] = [];
  for (const m of answer.matchAll(ID_IN_TEXT)) {
    const id = `${m[1]}${m[2]}`;
    if (!known.has(id) && !DICE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** check_map's problems that involve what this request made or changed and were not there before. */
export function newProblems(start: DelveMap, now: DelveMap): Problem[] {
  const ch = mapChanges(start, now);
  const touched = new Set([...ch.added, ...ch.changed].map((o) => o.id));
  if (!touched.size) return [];
  const old = new Set(checkMap(start).map((p) => p.text));
  return checkMap(now).filter((p) => !old.has(p.text) && p.ids.some((id) => touched.has(id)));
}

/**
 * The message the harness hands back when the model answers (step final), or
 * null to take the answer: layout problems with what this request made, ids the
 * answer names that are on no version of the map, calls that failed and were
 * never done again; after a batch that was held back (the model then sends its
 * calls again and easily drops or changes one), the request itself and what was
 * made where; and the plan if there is one. Only once per request.
 */
export function finalCheck(o: { answer: string; calls: readonly CallRecord[]; start: DelveMap; now: DelveMap; request?: string; plan?: readonly string[] }): string | null {
  const lines: string[] = [];
  for (const p of newProblems(o.start, o.now).slice(0, 8)) lines.push(`check_map: ${p.text}`);
  for (const id of inventedIds(o.answer, o.start, o.now).slice(0, 6)) lines.push(`Your answer names ${id}, but the map has no ${id}.`);
  for (const u of unresolvedLines(o.calls).slice(0, 6)) lines.push(`Not done: ${u}`);
  const held = o.request?.trim() && o.calls.some((c) => c.notRun);
  const review = held
    ? `\nSome calls of this request were held back after a failed one and sent again, so check that every part of it is done (how many, which kinds, where). The request was: "${o.request!.trim()}"\nIt made: ${madeText(o.start, o.now) || 'nothing'}.`
    : '';
  if (!lines.length && !review) return null;
  const shows = lines.length ? ` The map shows:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
  const plan = o.plan?.length ? `\nYour plan was:\n${o.plan.map((s, k) => `${k + 1}. ${s}`).join('\n')}` : '';
  return `Before you finish, check your work.${shows}${review}${plan}\nFix what you can with tool calls. Then give your final answer again, and say plainly what could not be done.`;
}

// ---------- step plan ----------

/** Added after the request in the first message (step plan). */
export function planLine(): string {
  return 'First write a short numbered plan: one line for each part of this request (at most 6). Then make the calls for it.';
}

/** The numbered lines of a plan ("1. Grass over x 0–30", "2) The hill"), or [] when there is none. */
export function parsePlan(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:step\s*)?(\d{1,2})[.):]\s+(.+?)\s*$/i.exec(line);
    if (m && Number(m[1]) === out.length + 1) out.push(m[2]!.replace(/\*\*/g, '').slice(0, 160));
    if (out.length >= 8) break;
  }
  return out.length >= 2 ? out : [];
}

/** Added after each turn's tool results (step plan): the plan, to keep the model on it. */
export function planReminder(plan: readonly string[]): string {
  return `[Your plan: ${plan.map((s, k) => `${k + 1}. ${s}`).join(' ')} Go on with the next part that is not done yet, or give your final answer when every part is done.]`;
}
