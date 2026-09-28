export * from './schema.ts';
export { validateMap, ValidationError } from './validate.ts';
export { applyOps, parseOps, OpError, OpSchema, type Op, type ApplyResult } from './ops.ts';
export { describeMap } from './describe.ts';
export {
  shapePath,
  shapeBounds,
  shapeArea,
  translateShape,
  type Ring,
  type Polygon,
  type Bounds,
} from './geometry/shapes.ts';
export { autoRoute, corridorPath, corridorOutline, pathLength } from './geometry/corridors.ts';
export { computeFloor, floorPaths, floorArea } from './geometry/floor.ts';
export { computeWalls, doorSegment, boundarySegments, segmentLength, type Segment } from './geometry/walls.ts';
