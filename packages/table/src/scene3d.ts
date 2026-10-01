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
}
