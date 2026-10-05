// The 3D table view's scene: what GET /api/v1/games/:id/pages/:pageId/scene3d.json
// sends, already filtered for whoever asked (see docs/TABLE.md, "3D table view").
// All positions are page cells (the Delve map's own grid for Delve pages), like tokens.
// Players never get anything outside the region they may see: walls are cut to it,
// and doors and stairs outside it are left out. Secret doors are plain wall for them.

export type ScenePoint = [number, number];

export interface SceneBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A polygon with holes, in cells. */
export interface ScenePolygon {
  outer: ScenePoint[];
  holes: ScenePoint[][];
}

export type SceneDoorStyle = 'normal' | 'double' | 'locked' | 'secret' | 'portcullis' | 'archway';

export interface SceneDoor {
  /** The door's two ends in cells. */
  a: ScenePoint;
  b: ScenePoint;
  /** "secret" only ever reaches the GM. */
  style: SceneDoorStyle;
  open?: boolean;
}

export interface SceneStairs {
  /** The stairs' bounds in cells. */
  box: SceneBox;
  /** The way the flight runs (it rises that way in 3D). */
  direction: 'n' | 'e' | 's' | 'w';
}

export interface Scene3D {
  pageId: string;
  /** The GM's whole map, or what the players see (the GM may ask for that too). */
  view: 'gm' | 'players';
  /** What the page is drawn from: a Delve map, a picture, or nothing (a grid). */
  kind: 'delve' | 'image' | 'none';
  /** The page frame in cells. */
  bounds: SceneBox;
  /** The floor picture and the cells it covers; null for a blank page. Delve pages use the members-only background.png. */
  floor: { url: string; box: SceneBox } | null;
  /** Wall segments in cells. */
  walls: [ScenePoint, ScenePoint][];
  doors: SceneDoor[];
  stairs: SceneStairs[];
  /** What this view may see: everything, or these polygons (today the Delve map's fog of war). */
  region: 'all' | ScenePolygon[];
  /** What the camera should frame first: the page, or what has been seen of it; null when nothing has been seen yet. */
  focus: SceneBox | null;
  /** Raised and sunken ground of the Delve map (its height areas), cut to `region`; left out when it has none. */
  heights?: SceneHeights;
}

/**
 * Height areas in 3D (core heightScene), every number in cells, heights too (a
 * 10 ft ledge on a 5 ft grid is 2 up). `pieces` are the ground as it's draped:
 * each at one height `h`, or with a `grid` of heights where it varies (hills,
 * ramps); pieces at different heights meet in a sheer face, and `base` is the
 * rest of the page at 0. `bands` are the areas' own heights (which end of a
 * flight of stairs is up). Walking along an edge's points, its low side is on
 * the right. Everything is cut to what the viewer may see, grids included.
 */
export interface SceneHeights {
  bands: { h: number; polygons: ScenePolygon[] }[];
  base: ScenePolygon[];
  edges: { points: ScenePoint[]; closed: boolean; hi: number; lo: number; kind: 'cliff' | 'rock' | 'slope' | 'step'; run: number }[];
  pieces?: ScenePiece[];
  /** The grids' lattice in cells, from the page's origin cell 0, 0. */
  step?: number;
  /** The colour rock faces are toned to (from the map's style). */
  rock?: string;
}

/** Heights on the lattice: rows of columns from post (i0, j0), each 16 bits between min and max, little-endian, base64. */
export interface SceneGrid {
  i0: number;
  j0: number;
  cols: number;
  rows: number;
  min: number;
  max: number;
  z: string;
}

export interface ScenePiece {
  polygons: ScenePolygon[];
  h: number;
  grid?: SceneGrid;
}
