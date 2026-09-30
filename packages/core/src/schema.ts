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

export const Cutout = z.strictObject({
  type: z.literal('cutout'),
  ...common,
  shape: Shape,
  roughness: Roughness.optional(),
});

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
});

/** An area filled with a repeating terrain tile (water, grass, lava…), drawn over the floor and under props. */
export const Terrain = z.strictObject({
  type: z.literal('terrain'),
  ...common,
  shape: Shape,
  asset: z.string().min(1).max(100),
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

export const OBJECT_TYPES = ['room', 'corridor', 'cutout', 'door', 'stairs', 'label', 'prop', 'terrain', 'marker'] as const;

export const MapObject = z.discriminatedUnion('type', [Room, Corridor, Cutout, Door, Stairs, Label, Prop, Terrain, Marker]);

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
export type Level = z.infer<typeof Level>;
export type Fog = z.infer<typeof Fog>;
export type MapObject = z.infer<typeof MapObject>;
export type ObjectType = MapObject['type'];
export type DelveMap = z.infer<typeof MapDoc>;
