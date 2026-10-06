// Placing things by meaning instead of coordinates (see docs/API.md, "Placing
// things by meaning"): regions, props by place, rooms beside rooms, corridors
// that keep out of rooms, doors on walls, and the checks every tool reports.
export {
  SIDES,
  CORNERS,
  CORNER_WORDS,
  sideOf,
  cornerOf,
  mapBox,
  floorBox,
  hasOpenGround,
  compassWord,
  compassPhrase,
  squares,
  objectArea,
  roomAt,
  type Side,
  type Corner,
  type ObjectArea,
} from './common.ts';
export { resolveRegion, regionCentre, ringShape, type Region, type RegionKind, type RegionSpec } from './regions.ts';
export { parsePlace, placeProps, doorwayZones, PLACE_WORDS, type PlaceSpec, type PlaceRequest, type PlaceResult, type PlacedProp } from './props.ts';
export { besideRect, routeAround, corridorThrough, ROOM_CLEARANCE, type BesideRequest, type BesideResult } from './rooms.ts';
export { doorOnRoomWall, doorLeadsTo, type WallDoor } from './wall-doors.ts';
export { checkMap, checkMapText, checkObjects, type Problem, type ProblemKind } from './check.ts';
export { fillRegion, rowLines, type FillOptions, type FillCopy, type FillResult } from './fill.ts';
