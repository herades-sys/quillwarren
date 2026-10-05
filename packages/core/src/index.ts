export * from './schema.ts';
export { validateMap, ValidationError } from './validate.ts';
export { applyOps, parseOps, OpError, OpSchema, MAP_FIELDS, type Op, type ApplyResult } from './ops.ts';
export { describeMap, type DescribeOptions } from './describe.ts';
export { nextId, nextLabel, doorAtEnd, connectOps, withAttachedDoors, ConnectError, type ConnectOptions, type ConnectPlan } from './build.ts';
export { rerouteOps, mouthDoor, type RerouteResult } from './build.ts';
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
export { downscale, dropGridLines, outlines, simplify, signedArea, distanceTransform, type RGB, type Mask } from './trace/raster.ts';
export { mainColours, classify, colourStats, toLab, deltaE, MERGE_DELTA_E, type Lab, type ColourStats, type ColourSpace, type ColourOptions } from './trace/colour.ts';
export { detectGrid, wallLattice, luminance, GRID_MIN_STRENGTH, GRID_MIN_FILL, type GridFit } from './trace/grid.ts';
export { analysePicture, coloursForMode, guessDungeonRoles, DEFAULT_COLOURS, PAINTED_COLOURS, PAINTED_TEXTURE, TYPICAL_WALL, type PictureAnalysis } from './trace/analyse.ts';
export { tracePainted, guessPaintedRoles, squareUp, splitBlock, minAreaRect, paintedScale, paintedSmoothing, type PaintedOptions, type PaintedResult } from './trace/painted.ts';
export { traceDungeon, wallThickness, type DungeonRole, type DungeonTraceOptions, type DungeonTraceResult } from './trace/dungeon.ts';
export { splitRooms, type RoomPiece, type Split } from './trace/rooms.ts';
export { snapRing, type SnapOptions } from './trace/snap.ts';
export { kuwahara, textureShare } from './trace/smooth.ts';
export { traceImage, guessRoles, tracedMap, dungeonRole, TRACE_ROLES, TRACE_MODES, TRACE_TERRAIN, TRACE_MIN_WIDTH, type TraceRole, type TraceMode, type TraceOptions, type TraceResult } from './trace/trace.ts';
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
export { corridorRoute, shapeRoute, endMouth, type CorridorRoute } from './geometry/corridors.ts';
export { outlineRoute, type OutlineRoute, type Mouth } from './geometry/attach.ts';
export { computeFloor, floorPaths, floorArea, polygonsOf } from './geometry/floor.ts';
export {
  computeWalls,
  wallPolylines,
  doorSegment,
  boundarySegments,
  segmentLength,
  onEdge,
  placeDoor,
  placeDoorBetween,
  shutDoorLines,
  type Segment,
  type Polyline,
} from './geometry/walls.ts';
export {
  angleVector,
  doorAngle,
  doorBetween,
  doorCentre,
  doorDirection,
  doorFromCentre,
  doorNormal,
  doorOnWall,
  doorSlot,
  foldAngle,
  gapReach,
  isTurned,
  nearestAxis,
  nearestWall,
  quarterTurn,
  slotCover,
  type DoorLine,
  type DoorSlot,
} from './geometry/doors.ts';
export { buildScene, terrainTint, terrainToneColour, type Scene, type Layer, type RenderOptions, type View, type AssetItem, type ImageItem } from './render/scene.ts';
export {
  terrainEdges,
  terrainEdgeSettings,
  terrainEdgeText,
  terrainMaterial,
  defaultTerrainEdge,
  pairEdge,
  pairWidth,
  edgeRecipe,
  tonePaletteName,
  MATERIAL_STACK,
  DEFAULT_FADE_WIDTH,
  type TerrainMaterial,
  type TerrainEdgeSettings,
  type TerrainEdges,
  type AreaEdges,
  type EdgeDetail,
  type EdgeRecipe,
  type Tone,
} from './render/terrain-edges.ts';
export {
  ASSETS,
  CATEGORIES,
  assetInfo,
  categoryOf,
  propBounds,
  propHidden,
  HIDDEN_ASSETS,
  propCentre,
  CUSTOM_CATEGORY,
  CUSTOM_PREFIX,
  CUSTOM_ID,
  PROP_CATEGORIES,
  isCustomAsset,
  registerAssets,
  customAssets,
  allAssets,
  customAssetsVersion,
  COLOUR_ASSETS,
  COLOUR_CATEGORIES,
  COLOUR_PREFIX,
  isColourAsset,
  hiddenByDefault,
  propLayer,
  isCanopy,
  CANOPY_INK,
  CANOPY_CATEGORY,
  groupVariants,
  modularAt,
  type AssetInfo,
  type AssetKind,
  type AssetLayer,
  type Blocks,
  type Category,
} from './assets/catalog.ts';
export { parseAssetSvg, recolor, assetSvg, INKS, type Palette, type ParsedAsset, type ParseOptions } from './assets/svg.ts';
export { COLOUR_PALETTE, COLOUR_HEX, colourMap, recolour, styleColour, rampLevels, lightness, nearestPaletteColour, type ColourMode, type ColourMap } from './assets/colour.ts';
export {
  checkPropSvg,
  checkPropSize,
  scaleBody,
  MAX_PROP_SVG_BYTES,
  MAX_PROP_BODY_BYTES,
  PROP_STROKE_WIDTHS,
  PROP_MIN_SIZE,
  PROP_MAX_SIZE,
  PROP_MARGIN,
  type PropCheck,
} from './assets/custom.ts';
export { inkBody, flattenPath } from './assets/ink.ts';
export { objectBounds, insidePolygons, clipPolylines } from './geometry/objects.ts';
export { openingsOf, openWallRings, cutSegments, floorTest } from './geometry/openings.ts';
export { outerArchways, archwayEnds, openAreas, type OuterArchway } from './render/open-ends.ts';
export { tightBounds, selectionBounds, unionOf, wholeSquares, cropFrame, frameQuery, cropScene, clipLinesToBox, MAX_CROP, MAX_RENDER_SIDE, MAX_RENDER_PIXELS, renderSizeProblem, type CropRequest } from './crop.ts';
export { roughFloor, drawnFloor, hasRoughness, amplitudeOf, ROUGHNESS_AMPLITUDE } from './geometry/rough.ts';
export { scatterAlong, type ScatterOptions, type Placement } from './scatter.ts';
export { isObstacle, propsOverlap, blockingProps, freeSpot, keepClear, overlapReport, OVERLAP_TOLERANCE, type Placed } from './placement.ts';
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
export { legendEntries, legendLayout, groupName, LEGEND_CAP, type LegendEntry, type LegendKind, type LegendLayout } from './render/legend.ts';
export { frameTransform, type HandoutFrame } from './render/handout.ts';
export {
  INSCRIPTION_SIZE,
  INSCRIPTION_FONT,
  INSCRIPTION_INK,
  inscriptionLines,
  inscriptionSeed,
  mapSeedOf,
  inscriptionsSvg,
  inscriptionBox,
  inscriptionBounds,
  inscriptionNear,
  inscriptionSvg,
  inscriptionsOf,
  inscriptionText,
} from './inscriptions.ts';
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
export {
  BLOCKING_EDGES,
  blockingEdges,
  crossers,
  defaultEdge,
  describeHeights,
  groundPaths,
  hasHeights,
  heightAreas,
  heightPlan,
  heightScene,
  heightText,
  rockWidth,
  slopeRun,
  stairsUphill,
  walkableMap,
  type CrossingKind,
  type EdgeSegment,
  type HeightCrossing,
  type HeightEdgeLine,
  type HeightOptions,
  type HeightPlan,
  type HeightRegion,
  type HeightScene,
  type HeightView,
  type Polygon3,
  type Walkable,
  type WalkableOptions,
} from './heights.ts';
export { heightDrawing, labelPoint, HEIGHT_TAG_SIZE, type HeightDrawing } from './render/heights.ts';
export { resolveStyle, PRESETS, type Style, type HatchStyle } from './render/style.ts';
export { hashString } from './render/rng.ts';

import type { DelveMap } from './schema.ts';
import { buildScene, type RenderOptions } from './render/scene.ts';
import { sceneToSvg, type SvgOptions } from './render/svg.ts';

/** One call from map to SVG string. */
export function renderSvg(map: DelveMap, opts: RenderOptions & SvgOptions = {}): string {
  return sceneToSvg(buildScene(map, opts), opts);
}
