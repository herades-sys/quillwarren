// @delve/table: the virtual tabletop's model, rules and dice (docs/TABLE.md).
// Pure TypeScript without Node or DOM APIs, so the server and the browser share it.
export type * from './protocol.ts';
export type * from './scene3d.ts';
export { TableError, DiceError } from './errors.ts';
export { newGame, addMember, addInvite, removeInvite, PALETTE } from './game.ts';
export { applyIntent, can, type ApplyContext, type Outcome } from './rules.ts';
export { viewFor, eventFor, chatFor, pageFor, publicMember, pageForPlayer, tokenForPlayer } from './views.ts';
export { roll, rollInline, MAX_DICE, MAX_EXPR, MAX_INLINE, type Rng } from './dice.ts';
export { parseChat, HELP, MAX_CHAT, type ParsedChat } from './chat.ts';
export {
  notebookPatch,
  notebookText,
  notebookTitle,
  NOTEBOOK_ID,
  NOTEBOOK_MAX_ENTRIES,
  NOTEBOOK_TEXT_MAX,
  NOTEBOOK_TITLE_MAX,
  UNTITLED,
  type NotebookPatch,
} from './notebook.ts';
export {
  PROP_LIGHTS,
  WALL_HALF,
  visionOf,
  isDynamic,
  doorIsOpen,
  doorBlocks,
  blockersOf,
  lightsOf,
  eyesOf,
  givesSight,
  playerControlled,
  affectsSight,
  SightCache,
  partySight,
  NO_SIGHT,
  nothingExplored,
  exploreMore,
  tokenSeen,
  seenTokens,
  sightFilter,
  controlsToken,
  mayGetToken,
  type PageVisionSettings,
  type LightSource,
  type Eye,
  type PartySight,
  type Explored,
  type TokenFilter,
} from './sight.ts';
export { respectsHeights, moveBlockersOf, moveRefusal, crossingAt, firstBlocker, type MoveBlocker } from './movement.ts';
export {
  visibilityPolygon,
  circle,
  boxRing,
  ringPoly,
  rectCorners,
  rectSamples,
  union,
  intersect,
  difference,
  inflate,
  area,
  simplify,
  bounds,
  pointIn,
  anyPointIn,
  segmentStrips,
  withWalls,
  ringArea,
  type Pt,
  type Seg,
  type Ring,
  type Poly,
  type Box,
} from './vision.ts';
