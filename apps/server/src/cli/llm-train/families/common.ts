// What every task family shares: the context a family runs in, the result it
// returns (its own checks on the final map), Skip for starting maps that don't
// suit it, and the phrasing helpers the request grammars are built from.
import type { DelveMap } from '@delve/core';
import type { Convo } from '../convo.ts';
import type { ToolRun } from '../delve.ts';
import { cap, newProblems, roomWords, type Room } from '../kit.ts';
import type { StartMap, StartSpec } from '../maps.ts';
import type { Rng } from '../rng.ts';
import { warns, type Call, type Side } from '../tools.ts';

export interface FamilyCtx {
  rng: Rng;
  convo: Convo;
  start: StartMap;
  /** The map before the conversation. */
  startMap: DelveMap;
}

export interface FamilyResult {
  /** The family's own checks on the final map: what is wrong (empty: all good). */
  check(final: DelveMap, startMap: DelveMap): string[];
  /** A sub-kind for the stats ("rename", "ask-first"…). */
  variant: string;
  /** Problems check_map may list afterwards that the family made on purpose (none so far). */
  allowProblems?: boolean;
}

export interface Family {
  id: string;
  /** What the family teaches, for the stats and the README. */
  title: string;
  /** Relative share of the conversations. */
  weight: number;
  /** The starting map it wants (the seed is added by the generator). */
  start(rng: Rng): Omit<StartSpec, 'seed'>;
  run(ctx: FamilyCtx): Promise<FamilyResult>;
}

/** This starting map doesn't suit the family (no room big enough, nowhere to put it…): the generator draws another. */
export class Skip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Skip';
  }
}

export function skip(reason: string): never {
  throw new Skip(reason);
}

/** A result that went through cleanly: no error, no warning. */
export const clean = (r: ToolRun): boolean => !r.isError && !warns(r.text);

/** Probe calls on a copy of the map: all clean and no new layout problem. */
export async function works(convo: Convo, ...calls: Call[]): Promise<ToolRun[] | null> {
  const before = convo.map;
  const runs = await convo.probe(...calls);
  if (!runs.every(clean)) return null;
  const after = runs[runs.length - 1]!.map;
  return newProblems(before, after).length ? null : runs;
}

// ---------- phrasing ----------

/** Wrap an imperative ("add a 6×4 room east of room 2") in one of the ways people ask. */
export function ask(rng: Rng, imperative: string): string {
  const i = imperative.replace(/\.$/, '');
  return rng.weighted<string>([
    [`${cap(i)}.`, 40],
    [`Please ${i}.`, 10],
    [`Can you ${i}?`, 12],
    [`Could you ${i}, please?`, 5],
    [`${i}`, 12],
    [`${cap(i)}`, 8],
    [`I'd like you to ${i}.`, 3],
    [`Now ${i}.`, 4],
    [`Next: ${i}.`, 2],
    [`${cap(i)}, thanks.`, 4],
  ]);
}

/** "east of", "to the east of", "on the east side of" — and the words of a viewer (above, below, left, right). */
export function sidePhrase(rng: Rng, side: Side): string {
  const view: Record<Side, string[]> = { north: ['above', 'north of'], south: ['below', 'south of'], east: ['to the right of', 'east of'], west: ['to the left of', 'west of'] };
  return rng.weighted<string>([
    [`${side} of`, 45],
    [`to the ${side} of`, 20],
    [`on the ${side} side of`, 15],
    [rng.pick(view[side]), 10],
    [`directly ${side} of`, 5],
    [`just ${side} of`, 5],
  ]);
}

/** A size before a noun, the way a user types it: "6×4", "6x4", "6 by 4" (a 6×4 room). */
export function sizePhrase(rng: Rng, w: number, h: number): string {
  return rng.weighted<string>([
    [`${w}×${h}`, 40],
    [`${w}x${h}`, 30],
    [`${w} by ${h}`, 30],
  ]);
}

/** A size on its own: also "6 by 4 squares" (a room, 6 by 4 squares, ...). */
export function sizeAlone(rng: Rng, w: number, h: number): string {
  return rng.chance(0.4) ? `${sizePhrase(rng, w, h)} squares` : sizePhrase(rng, w, h);
}

/** How a user names a room: a number, a name, or "this room" with the room selected in the editor. */
export function refRoom(rng: Rng, r: Room, opts: { selectable?: boolean; unique?: boolean } = {}): { text: string; selection?: string[] } {
  if (opts.selectable !== false && rng.chance(0.08)) return { text: rng.pick(['this room', 'the selected room']), selection: [r.id] };
  return { text: roomWords(r, rng, { allowName: opts.unique !== false }) };
}

/** Article for a word. */
export const an = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

export const ORDINAL_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** 3 → "3" or "three". */
export const numWord = (rng: Rng, k: number): string => (k <= 10 && rng.chance(0.5) ? ORDINAL_WORDS[k]! : String(k));

export const STYLE_WORDS: Record<string, readonly string[]> = {
  normal: ['door', 'normal door', 'wooden door', 'plain door'],
  locked: ['locked door'],
  secret: ['secret door', 'hidden door'],
  double: ['double door'],
  portcullis: ['portcullis'],
  archway: ['archway', 'open archway'],
};

/** A door style as an answer says it: "locked", "a secret door", "an archway", "a portcullis". */
export function styleAs(style: string): string {
  if (style === 'locked') return 'locked';
  if (style === 'normal') return 'a normal door';
  if (style === 'archway') return 'an archway';
  if (style === 'portcullis') return 'a portcullis';
  return `${an(style)} door`;
}

/** A count after `prev`: in words when `prev` ends in a digit ("room 2 two squares", never "room 2 2 squares"). */
export const numAfter = (rng: Rng, k: number, prev: string): string => (/\d$/.test(prev) && k <= 10 ? ORDINAL_WORDS[k]! : numWord(rng, k));
