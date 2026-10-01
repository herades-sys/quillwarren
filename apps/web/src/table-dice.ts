// The 3D dice bundle, built to /assets/table-dice.js: three.js and cannon-es
// with the dice overlay (apps/web/src/table/dice3d.ts). table.js imports it at
// runtime, only when a roll comes in with 3D dice switched on.
export { createDiceTable } from './table/dice3d.ts';
export type { Area, DiceTable, ThrowSpec } from './table/dice3d.ts';
