// ============================================================================
// HARNESS HOOK: what the local harness adds to a conversation.
// ============================================================================
//
// The training data must look exactly like what the model sees at inference.
// Whatever the harness (apps/server/src/chat/local-agent.ts) adds or changes
// (a line in the context block, notes on failed or held-back calls in a
// batch, a final check before it accepts an answer…) has to happen here at the
// same places, or the model learns conversations it never meets.
//
// The context block needs no hook: it comes from buildSetup('lean').user(),
// so whatever local-setup.ts puts in it (e.g. a "next new ids" line) is in the
// data as soon as the generator runs on that code.
//
// THE HARNESS'S HELPING STEPS (local-steps.ts) are wired in at the bottom, as:
//
//   import { finalCheck, heldBackNote, notRunText, repeatNote } from '../../chat/local-steps.ts';
//   export const HARNESS_HOOKS: HarnessHooks = {
//     batch: { heldBackNote, notRunText },
//     repeatNote,
//     afterAnswer: (ctx) => finalCheck({ answer: ctx.answer, calls: ctx.records, start: ctx.start, now: ctx.map, request: ctx.request }),
//   };
//
// then run `npm run llm-train-data` again (the replay check runs the hooks a
// second time and compares, so a hook that isn't deterministic is caught).
// Check the argument shapes against local-steps.ts when you do: the adapters
// below follow the description of that code, not the code itself.
//
// Every hook is optional; with none set the conversations are exactly what
// runAgent() sends at 1cb651e: every call of a reply runs, no final check.
import type { DelveMap } from '@delve/core';
import type { AgentMessage, CallRecord, Json } from '../../chat/local-agent.ts';
import { finalCheck, heldBackNote, notRunText, repeatNote } from '../../chat/local-steps.ts';

/** A tool call as the harness records it (local-agent.ts CallRecord), plus notRun for calls held back in a batch. */
export type HookCall = CallRecord & { notRun?: boolean };

export interface HookContext {
  /** The map as it is now (after every tool call so far). */
  map: DelveMap;
  rev: number;
  /** The map when this turn's user message arrived. */
  start: DelveMap;
  /** The user's request in this turn, without the context block. */
  request: string;
  /** 0 for the first user message, 1 for the first follow-up… */
  turn: number;
  /** Everything in the conversation so far, system prompt first. */
  messages: readonly AgentMessage[];
  /** This turn's tool calls so far, as the harness records them: ok = !isError, result as the model saw it, notRun for held-back calls. */
  records: readonly HookCall[];
  /** Run a Quillwarren tool on this map, as the harness would (e.g. its own check_map pass). */
  exec(name: string, args: Json): Promise<{ text: string; isError: boolean }>;
}

export interface BatchHooks {
  /** Appended to the result of a call that failed while more calls of the same reply were waiting. */
  heldBackNote(failedIndex: number, rest: readonly { index: number; name: string }[]): string;
  /** The result of a waiting call that was not run: `failed` is the earlier call of the reply that failed (its index and name), as runAgent passes it. */
  notRunText(failed: { index: number; name: string }): string;
}

export interface HarnessHooks {
  /** The user message as the harness frames it; `framed` is the context block plus the request (local-setup.ts `user`). */
  frameUser?(framed: string, ctx: HookContext): string;
  /** After the user message, before the model's first reply of the turn (e.g. a plan reminder). */
  afterUser?(ctx: HookContext): AgentMessage[] | Promise<AgentMessage[]>;
  /** After each round of tool results, before the model's next reply (e.g. a state digest). */
  afterTools?(ctx: HookContext): AgentMessage[] | Promise<AgentMessage[]>;
  /** Before the model's final answer (messages the harness adds there). */
  beforeAnswer?(ctx: HookContext): AgentMessage[] | Promise<AgentMessage[]>;
  /**
   * After the model's answer: the harness's final check. A message means the
   * harness keeps the answer, adds the message as a user message and lets the
   * model reply again (once per request). The generator keeps a conversation
   * only when this returns null for every answer, unless a family shows the
   * recovery on purpose.
   */
  afterAnswer?(ctx: HookContext & { answer: string }): string | null | Promise<string | null>;
  /** Several calls in one reply: when one fails, the rest are held back (not run) and the failed one's result says so. Unset: every call runs. */
  batch?: BatchHooks;
  /** Appended to a result when the same call has been made this many times in a row (3 or more). Unset: runAgent's own wording at 1cb651e. */
  repeatNote?(times: number): string;
}

/**
 * The harness's helping steps (chat/local-steps.ts), as runAgent() runs them
 * with the lean default LEAN_STEPS: after a failed call the rest of the reply is
 * held back, the repeat note, and the final check once per request (plan off,
 * so no plan). The "next new ids" line comes in through buildSetup(...).user().
 */
export const HARNESS_HOOKS: HarnessHooks = {
  batch: { heldBackNote, notRunText },
  repeatNote,
  afterAnswer: (ctx) => finalCheck({ answer: ctx.answer, calls: ctx.records, start: ctx.start, now: ctx.map, plan: [], ...(ctx.request ? { request: ctx.request } : {}) }),
};

/** runAgent's note on the third identical call in a row, at 1cb651e. */
export const DEFAULT_REPEAT_NOTE = (times: number): string => `\nYou have now made this same call ${times} times in a row. Do something else, or give your final answer.`;

/** Which hooks were wired in when the data was made (for the stats). */
export function hooksInUse(h: HarnessHooks = HARNESS_HOOKS): string[] {
  return (['frameUser', 'afterUser', 'afterTools', 'beforeAnswer', 'afterAnswer', 'batch', 'repeatNote'] as const).filter((k) => h[k] !== undefined);
}
