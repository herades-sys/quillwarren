// Every task family, in the order the stats list them. Weights set each
// family's share of the conversations (generate.ts turns them into quotas).
import { connectRooms, doorWall, roomBeside, scratchBuild } from './build.ts';
import type { Family } from './common.ts';
import { deleteThings, editFields, moveThings, resizeRoom } from './edit.ts';
import { findAndPlace, furnishTheme, propsAlong, singleProp } from './furnish.ts';
import { explicitCoords, heights, labels, outdoorScratch, terrainRegion } from './ground.ts';
import { fixProblems, multiTurn, question, recovery } from './talk.ts';

export const FAMILIES: readonly Family[] = [
  roomBeside,
  connectRooms,
  doorWall,
  scratchBuild,
  outdoorScratch,
  editFields,
  moveThings,
  resizeRoom,
  deleteThings,
  furnishTheme,
  singleProp,
  findAndPlace,
  propsAlong,
  terrainRegion,
  heights,
  labels,
  explicitCoords,
  question,
  multiTurn,
  recovery,
  fixProblems,
];
