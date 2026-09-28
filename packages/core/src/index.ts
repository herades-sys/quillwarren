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
export { computeFloor, floorPaths, floorArea, polygonsOf } from './geometry/floor.ts';
export {
  computeWalls,
  wallPolylines,
  doorSegment,
  boundarySegments,
  segmentLength,
  type Segment,
  type Polyline,
} from './geometry/walls.ts';
export { buildScene, type Scene, type Layer, type RenderOptions, type View } from './render/scene.ts';
export { sceneToSvg, type SvgOptions } from './render/svg.ts';
export { resolveStyle, PRESETS, type Style, type HatchStyle } from './render/style.ts';

import type { DelveMap } from './schema.ts';
import { buildScene, type RenderOptions } from './render/scene.ts';
import { sceneToSvg, type SvgOptions } from './render/svg.ts';

/** One call from map to SVG string. */
export function renderSvg(map: DelveMap, opts: RenderOptions & SvgOptions = {}): string {
  return sceneToSvg(buildScene(map, opts), opts);
}
