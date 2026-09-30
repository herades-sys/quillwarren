export * from './schema.ts';
export { validateMap, ValidationError } from './validate.ts';
export { applyOps, parseOps, OpError, OpSchema, MAP_FIELDS, type Op, type ApplyResult } from './ops.ts';
export { describeMap } from './describe.ts';
export { nextId, nextLabel, doorAtEnd, connectOps, withAttachedDoors, ConnectError, type ConnectOptions, type ConnectPlan } from './build.ts';
export {
  toDungeonScrawl,
  fromDungeonScrawl,
  DsImportError,
  DS_PX,
  type DsDocument,
  type DsGeometry,
  type DsExportOptions,
  type DsImportResult,
} from './interop/dungeonscrawl.ts';
export { fromWatabou, CityImportError, type CityImportOptions, type CityImportResult } from './interop/watabou.ts';
export { mainColours, classify, downscale, dropGridLines, outlines, simplify, signedArea, type RGB, type Mask } from './trace/raster.ts';
export { traceImage, guessRoles, tracedMap, TRACE_ROLES, TRACE_MIN_WIDTH, type TraceRole, type TraceOptions, type TraceResult } from './trace/trace.ts';
export {
  shapePath,
  shapeBounds,
  shapeArea,
  translateShape,
  type Ring,
  type Polygon,
  type Bounds,
} from './geometry/shapes.ts';
export { autoRoute, corridorPath, corridorOutline, corridorBounds, pathLength, roomsById } from './geometry/corridors.ts';
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
export { buildScene, terrainTint, type Scene, type Layer, type RenderOptions, type View, type AssetItem } from './render/scene.ts';
export {
  ASSETS,
  CATEGORIES,
  assetInfo,
  categoryOf,
  propBounds,
  propCentre,
  type AssetInfo,
  type AssetKind,
  type AssetLayer,
  type Blocks,
  type Category,
} from './assets/catalog.ts';
export { parseAssetSvg, recolor, assetSvg, INKS, type Palette, type ParsedAsset } from './assets/svg.ts';
export { objectBounds, insidePolygons, clipPolylines } from './geometry/objects.ts';
export { visiblePaths, visiblePolygons, visibleFloor, fogShade, revealedBounds, updateFog, fogSummary, type FogChange } from './fog.ts';
export { levelSiblings, connectorsOf, stairLinks, type LevelEntry, type Connector, type ConnectorKind, type StairPlan, type StoreyInput } from './levels.ts';
export { sceneToSvg, type SvgOptions } from './render/svg.ts';
export { handoutSvg, PAPERS, type Paper, type HandoutOptions, type Handout } from './render/handout.ts';
export { MARKERS, MARKER_RADIUS, markerGlyph, markerAt, type MarkerInfo } from './markers.ts';
export { resolveStyle, PRESETS, type Style, type HatchStyle } from './render/style.ts';

import type { DelveMap } from './schema.ts';
import { buildScene, type RenderOptions } from './render/scene.ts';
import { sceneToSvg, type SvgOptions } from './render/svg.ts';

/** One call from map to SVG string. */
export function renderSvg(map: DelveMap, opts: RenderOptions & SvgOptions = {}): string {
  return sceneToSvg(buildScene(map, opts), opts);
}
