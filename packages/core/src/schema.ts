// The delve.map v1 document: zod schemas and the types derived from them.
// All positions are in grid squares (origin top left, y down).
import { z } from 'zod';

export const FORMAT = 'delve.map';
export const FORMAT_VERSION = 1;

const positive = z.number().positive('must be greater than 0');

/** Wall roughness: 1 is smooth, 10 extremely rough (caves). */
export const Roughness = z.number().int().min(1, 'from 1 (smooth) to 10 (caves)').max(10, 'from 1 (smooth) to 10 (caves)');

export const Id = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'must start with a letter and use only letters, digits, _ or - (max 64)');

export const Point = z.tuple([z.number(), z.number()]);

export const RectShape = z.strictObject({ rect: z.tuple([z.number(), z.number(), positive, positive]) });
export const PolyShape = z.strictObject({ poly: z.array(Point).min(3, 'needs at least 3 points') });
export const CircleShape = z.strictObject({ circle: z.tuple([z.number(), z.number(), positive]) });
export const Shape = z.union([RectShape, PolyShape, CircleShape]);

const common = {
  id: Id,
  name: z.string().max(200).optional(),
  notes: z.string().max(10_000).optional(),
};

export const Room = z.strictObject({
  type: z.literal('room'),
  ...common,
  shape: Shape,
  label: z.string().max(20).optional(),
  roughness: Roughness.optional(),
});

export const Corridor = z.strictObject({
  type: z.literal('corridor'),
  ...common,
  from: Id.optional(),
  to: Id.optional(),
  width: positive,
  path: z.array(Point).min(2, 'needs at least 2 points').optional(),
  roughness: Roughness.optional(),
});

/** How a cutout looks: "rock" (the default) shows what's around the dungeon; "solid" fills it with the wall colour (pillars, wall blocks). */
export const CUTOUT_FILLS = ['rock', 'solid'] as const;

export const Cutout = z.strictObject({
  type: z.literal('cutout'),
  ...common,
  shape: Shape,
  roughness: Roughness.optional(),
  fill: z.enum(CUTOUT_FILLS).optional(),
});

/** The GM label of a stair, ladder or trapdoor: floor number, then the letter of its flight ("0A", "-1C"). */
const StairLabel = z.string().max(8, 'at most 8 characters, e.g. "0A" or "-1C"');

export const DOOR_STYLES = ['normal', 'double', 'locked', 'secret', 'portcullis', 'archway'] as const;

export const Door = z.strictObject({
  type: z.literal('door'),
  ...common,
  at: Point,
  along: z.enum(['x', 'y']),
  width: positive,
  style: z.enum(DOOR_STYLES).optional(),
  open: z.boolean().optional(),
});

export const Stairs = z.strictObject({
  type: z.literal('stairs'),
  ...common,
  shape: Shape,
  direction: z.enum(['n', 'e', 's', 'w']),
  label: StairLabel.optional(),
});

export const Label = z.strictObject({
  type: z.literal('label'),
  ...common,
  text: z.string().min(1).max(200),
  at: Point,
  size: positive.optional(),
});

export const Prop = z.strictObject({
  type: z.literal('prop'),
  ...common,
  asset: z.string().min(1).max(100),
  at: Point,
  rotation: z.number().optional(),
  scale: positive.optional(),
  /** Ladders, trapdoors and spiral stairs: the GM stair label, like a stairs object's. */
  label: StairLabel.optional(),
  /**
   * Hidden from players: drawn only in the GM view. Unset: the asset decides
   * (hidden traps such as pressure plates are hidden, everything else is shown);
   * false shows a hidden trap once the players have found it.
   */
  gmOnly: z.boolean().optional(),
});

/** An area filled with a repeating terrain tile (water, grass, lava…), drawn over the floor and under props. */
export const Terrain = z.strictObject({
  type: z.literal('terrain'),
  ...common,
  shape: Shape,
  asset: z.string().min(1).max(100),
  /** Rings cut out of the shape, [[x, y], ...] each: e.g. the rooms inside a forest filled around them. */
  holes: z.array(z.array(Point).min(3, 'needs at least 3 points')).max(2000).optional(),
});

export const MARKER_KINDS = ['discover', 'interact', 'trap'] as const;

/**
 * A GM note pinned to a spot: something to discover ("?"), something to
 * interact with ("!") or a trap (skull). Only in the GM view; `done` strikes it through.
 */
export const Marker = z.strictObject({
  type: z.literal('marker'),
  ...common,
  kind: z.enum(MARKER_KINDS),
  at: Point,
  text: z.string().max(2000),
  done: z.boolean().optional(),
});

/** "<sha256>.<ext>": the name of an uploaded picture (served at /api/v1/images/<src>). Nothing else may appear as a src. */
export const IMAGE_SRC = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
export const IMAGE_LAYERS = ['floor', 'props'] as const;

/**
 * An uploaded picture placed on the map (the user's own table, a rug, a painted
 * mosaic): centred on `at`, w × h squares, turned clockwise by `rotation`
 * degrees. Layer 'floor' lies under the grid and walls; 'props' (the default)
 * stands on top of the walls with the props. `gmOnly` keeps it out of the players' view.
 */
export const MapImage = z.strictObject({
  type: z.literal('image'),
  ...common,
  src: z.string().regex(IMAGE_SRC, 'must be the "<sha256>.<png|jpg|webp|gif>" name of an uploaded image (see GET /api/v1/images)'),
  at: Point,
  w: positive.max(1000),
  h: positive.max(1000),
  rotation: z.number().optional(),
  layer: z.enum(IMAGE_LAYERS).optional(),
  opacity: z.number().min(0).max(1).optional(),
  gmOnly: z.boolean().optional(),
});

/**
 * An open area, drawn by hand: inside its shape the map has no hatching, no
 * shading and no drop shadow, so an edge reads as open instead of walled in
 * (the top of a corridor that leads out of the map). With `walls`, the wall
 * lines inside the shape are left out too: a cave mouth, a ledge that drops
 * away. It changes the picture in both views but is never drawn itself (the
 * editor shows a dashed outline while it is selected or its tool is on).
 * Archways on the floor's outer edge get an open end like this by themselves.
 */
export const Opening = z.strictObject({
  type: z.literal('opening'),
  ...common,
  shape: Shape,
  walls: z.boolean().optional(),
});

export const OBJECT_TYPES = ['room', 'corridor', 'cutout', 'door', 'stairs', 'label', 'prop', 'terrain', 'marker', 'image', 'opening'] as const;

export const MapObject = z.discriminatedUnion('type', [Room, Corridor, Cutout, Door, Stairs, Label, Prop, Terrain, Marker, MapImage, Opening]);

/**
 * Fog of war for the players' screen. With it on, players see only the revealed
 * rooms and corridors plus `show` areas, minus `hide` areas (applied last).
 */
export const Fog = z.strictObject({
  on: z.boolean(),
  revealed: z.array(Id).max(2000).optional(),
  show: z.array(Shape).max(500).optional(),
  hide: z.array(Shape).max(500).optional(),
});

/** A storey of a multi-storey place: maps with the same group are the storeys of one building, shown in `order`. */
export const Level = z.strictObject({
  group: Id,
  name: z.string().min(1).max(60),
  order: z.number().int(),
});

export const MapDoc = z.strictObject({
  format: z.literal(FORMAT),
  version: z.literal(FORMAT_VERSION),
  id: Id,
  name: z.string().min(1).max(200),
  grid: z.strictObject({
    type: z.literal('square'),
    unit: z.string().max(20).optional(),
    bounds: z.tuple([z.number(), z.number(), positive, positive]).optional(),
  }),
  style: z
    .strictObject({
      preset: z.string().min(1),
      overrides: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  seed: z.number().int().optional(),
  level: Level.optional(),
  /** The library shelf the map is filed under on the start page ("Dungeons", "Cities"…); storeys of one place share it. */
  category: z.string().min(1).max(60).optional(),
  fog: Fog.optional(),
  /** Wall roughness for the whole map (rooms, corridors and cutouts can set their own). Unset: the style's own look. */
  roughness: Roughness.optional(),
  objects: z.array(MapObject),
});

export type Point = z.infer<typeof Point>;
export type Shape = z.infer<typeof Shape>;
export type Room = z.infer<typeof Room>;
export type Corridor = z.infer<typeof Corridor>;
export type Cutout = z.infer<typeof Cutout>;
export type Door = z.infer<typeof Door>;
export type Stairs = z.infer<typeof Stairs>;
export type Label = z.infer<typeof Label>;
export type Prop = z.infer<typeof Prop>;
export type Terrain = z.infer<typeof Terrain>;
export type Marker = z.infer<typeof Marker>;
export type MarkerKind = (typeof MARKER_KINDS)[number];
export type CutoutFill = (typeof CUTOUT_FILLS)[number];
export type MapImage = z.infer<typeof MapImage>;
export type Opening = z.infer<typeof Opening>;
export type ImageLayer = (typeof IMAGE_LAYERS)[number];
export type Level = z.infer<typeof Level>;
export type Fog = z.infer<typeof Fog>;
export type MapObject = z.infer<typeof MapObject>;
export type ObjectType = MapObject['type'];
export type DelveMap = z.infer<typeof MapDoc>;
