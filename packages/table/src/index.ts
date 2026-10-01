// @delve/table: the virtual tabletop's model, rules and dice (docs/TABLE.md).
// Pure TypeScript without Node or DOM APIs, so the server and the browser share it.
export type * from './protocol.ts';
export type * from './scene3d.ts';
export { TableError, DiceError } from './errors.ts';
export { newGame, addMember, addInvite, removeInvite, PALETTE } from './game.ts';
export { applyIntent, can, type ApplyContext, type Outcome } from './rules.ts';
export { viewFor, eventFor, chatFor, pageFor, publicMember } from './views.ts';
export { roll, rollInline, MAX_DICE, MAX_EXPR, MAX_INLINE, type Rng } from './dice.ts';
export { parseChat, HELP, MAX_CHAT, type ParsedChat } from './chat.ts';
