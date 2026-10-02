export * from './schema.ts';
export { validateMap, ValidationError } from './validate.ts';
export { applyOps, parseOps, OpError, OpSchema, MAP_FIELDS, type Op, type ApplyResult } from './ops.ts';
export { describeMap, type DescribeOptions } from './describe.ts';
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
export { METRES_PER_FOOT, SQUARE_SIZES, metresPerSquare, parseSquareUnit, squareUnit, type SquareUnit } from './units.ts';
export { fromWatabou, CityImportError, type CityImportOptions, type CityImportResult } from './interop/watabou.ts';
export { mainColours, classify, downscale, dropGridLines, outlines, simplify, signedArea, type RGB, type Mask } from './trace/raster.ts';
export { traceImage, guessRoles, tracedMap, TRACE_ROLES, TRACE_MIN_WIDTH, type TraceRole, type TraceOptions, type TraceResult } from './trace/trace.ts';
export {
  shapePath,
  shapeBounds,
  shapeArea,
  translateShape,
  pointInShape,
  pointInRing,
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
export { buildScene, terrainTint, type Scene, type Layer, type RenderOptions, type View, type AssetItem, type ImageItem } from './render/scene.ts';
export {
  ASSETS,
  CATEGORIES,
  assetInfo,
  categoryOf,
  propBounds,
  propHidden,
  HIDDEN_ASSETS,
  propCentre,
  type AssetInfo,
  type AssetKind,
  type AssetLayer,
  type Blocks,
  type Category,
} from './assets/catalog.ts';
export { parseAssetSvg, recolor, assetSvg, INKS, type Palette, type ParsedAsset } from './assets/svg.ts';
export { objectBounds, insidePolygons, clipPolylines } from './geometry/objects.ts';
export { openingsOf, openWallRings, cutSegments, floorTest } from './geometry/openings.ts';
export { outerArchways, archwayEnds, openAreas, type OuterArchway } from './render/open-ends.ts';
export { tightBounds, selectionBounds, unionOf, wholeSquares, cropFrame, frameQuery, cropScene, clipLinesToBox, MAX_CROP, type CropRequest } from './crop.ts';
export { roughFloor, drawnFloor, hasRoughness, amplitudeOf, ROUGHNESS_AMPLITUDE } from './geometry/rough.ts';
export { scatterAlong, type ScatterOptions, type Placement } from './scatter.ts';
export {
  collectSegment,
  placeSegmentOps,
  fillSegmentOps,
  fillArea,
  regionAround,
  turnSegment,
  quarterTurns,
  segmentMap,
  segmentCounts,
  countsText,
  type MapSegment,
  type SegmentContent,
  type SegmentPick,
  type PlaceResult,
  type FillOptions,
  type FillResult,
} from './segments.ts';
export { terrainArea, terrainPolygons } from './geometry/terrain.ts';
export { visiblePaths, visiblePolygons, visibleFloor, fogShade, revealedBounds, updateFog, fogSummary, type FogChange } from './fog.ts';
export { levelSiblings, connectorsOf, stairLinks, type LevelEntry, type Connector, type ConnectorKind, type StairPlan, type StoreyInput } from './levels.ts';
export { floorOf, floorText, labelText, storeyTitle, isConnector, chainLetter, stairLabels, stairLabelOps, stairTags, MINUS, type StoreyMap } from './floors.ts';
export { DRAW_SHAPES, PRESET_SHAPES, OVAL_POINTS, shapeFromBox, shapeFromDrag, dragBox, freehandShape, type DrawShape, type BoxShape, type PresetShape, type Box, type FreehandOptions } from './geometry/draw.ts';
export { solidCutouts } from './geometry/solid.ts';
export { sceneToSvg, type SvgOptions } from './render/svg.ts';
export { handoutSvg, PAPERS, type Paper, type HandoutOptions, type Handout } from './render/handout.ts';
export { MARKERS, MARKER_RADIUS, MIN_MARKER_RADIUS, markerGlyph, markerAt, markerRadius, type MarkerInfo } from './markers.ts';
export {
  NOTES_MAX,
  NOTE_AREA_TYPES,
  isNoteArea,
  hasNotes,
  areaContains,
  noteAreasAt,
  noteAreaAt,
  areaTitle,
  noteAnchor,
  notedAreas,
  notesOnly,
  notesOps,
  type NoteArea,
} from './notes.ts';
export { imageUrl, imageFit, imageBounds, onImage, imageCentre } from './images.ts';
export { resolveStyle, PRESETS, type Style, type HatchStyle } from './render/style.ts';
export { hashString } from './render/rng.ts';

import type { DelveMap } from './schema.ts';
import { buildScene, type RenderOptions } from './render/scene.ts';
import { sceneToSvg, type SvgOptions } from './render/svg.ts';

/** One call from map to SVG string. */
export function renderSvg(map: DelveMap, opts: RenderOptions & SvgOptions = {}): string {
  return sceneToSvg(buildScene(map, opts), opts);
}
