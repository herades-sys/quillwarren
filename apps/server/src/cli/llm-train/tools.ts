// EVERYTHING THAT DEPENDS ON TOOL NAMES AND ARGUMENTS LIVES HERE.
//
// The families (families.ts) and the starting maps (maps.ts) never write a
// tool name or an argument key themselves: they call these builders. When the
// tools change (another session is reworking them), adapt this file, then
// re-run `npm run llm-train-data`; the replay check (validate.ts) refuses
// every call that no longer fits the lean schema, so nothing stale slips into
// the data.
//
// Two kinds of builder:
// - `call.*`: what the model writes in the training data (lean tools only,
//   lean parameters only; the harness adds the map id itself).
// - `setup.*`: what the generator uses to build starting maps before the
//   conversation begins (any MCP tool and parameter: never seen by the model).
import type { Json } from '../../chat/local-agent.ts';
import { LEAN_TOOLS } from '../../chat/local-setup.ts';

export interface Call {
  name: string;
  args: Json;
}

export type Side = 'north' | 'south' | 'east' | 'west';
export type Corner = 'ne' | 'nw' | 'se' | 'sw';
export type Length = number | string;
export type DoorStyle = 'normal' | 'double' | 'locked' | 'secret' | 'portcullis' | 'archway';

export const SIDES: readonly Side[] = ['north', 'south', 'east', 'west'];
export const CORNERS: readonly Corner[] = ['ne', 'nw', 'se', 'sw'];
export const OPPOSITE: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Tool names, for the few places that look at a call's name (stats, replay). */
export const TOOL = {
  describe: 'describe_map',
  check: 'check_map',
  listAssets: 'list_assets',
  addRoom: 'add_room',
  connect: 'connect',
  addDoor: 'add_door',
  addStairs: 'add_stairs',
  addProp: 'add_prop',
  propsAlong: 'add_props_along',
  addTerrain: 'add_terrain',
  addHeight: 'add_height',
  addLabel: 'add_label',
  update: 'update',
  move: 'move',
  delete: 'delete',
  undo: 'undo',
  applyOps: 'apply_ops',
} as const;

/** Tools that build or change something (the prompt: call check_map once after several of them). */
export const BUILDING_TOOLS: ReadonlySet<string> = new Set([TOOL.addRoom, TOOL.connect, TOOL.addDoor, TOOL.addStairs, TOOL.addProp, TOOL.propsAlong, TOOL.addTerrain, TOOL.addHeight, TOOL.addLabel, TOOL.move]);

/** Tools that only read. */
export const READ_TOOLS: ReadonlySet<string> = new Set([TOOL.describe, TOOL.check, TOOL.listAssets]);

const clean = (o: Record<string, unknown>): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------- regions (add_terrain, add_height, add_props_along, add_label) ----------

export const region = {
  edge: (edge: Side, depth?: Length): Json => clean({ edge, depth }),
  corner: (corner: Corner, size?: Length): Json => clean({ corner, size }),
  in: (id: string): Json => ({ in: id }),
  inEdge: (id: string, edge: Side, depth?: Length): Json => clean({ in: id, edge, depth }),
  inCorner: (id: string, corner: Corner, size?: Length): Json => clean({ in: id, corner, size }),
  around: (id: string, margin?: Length): Json => clean({ around: id, margin }),
  between: (a: string | [number, number], b: string | [number, number], width?: Length): Json => clean({ between: [a, b], width }),
  rect: (rect: [number, number, number, number]): Json => ({ rect }),
};

// ---------- what the model writes ----------

export const call = {
  describe: (): Call => ({ name: TOOL.describe, args: {} }),
  check: (): Call => ({ name: TOOL.check, args: {} }),
  listAssets: (search: string, category?: string): Call => ({ name: TOOL.listAssets, args: clean({ search, category }) }),

  /** add_room beside another room (the meaning-level way). */
  roomBeside: (o: { beside: string; side: Side; size: [Length, Length]; gap?: Length; connect?: boolean; door?: DoorStyle; name?: string; notes?: string }): Call => ({
    name: TOOL.addRoom,
    args: clean({ beside: o.beside, side: o.side, size: o.size, gap: o.gap, connect: o.connect, door: o.door, name: o.name, notes: o.notes }),
  }),
  /** add_room with a rectangle (the first room on an empty map, or coordinates the user gave). */
  roomRect: (o: { rect: [number, number, number, number]; name?: string; notes?: string }): Call => ({ name: TOOL.addRoom, args: clean({ rect: o.rect, name: o.name, notes: o.notes }) }),

  connect: (o: { from: string; to: string; doors?: 'none' | 'from' | 'to' | 'both'; doorStyle?: DoorStyle; width?: Length }): Call => ({
    name: TOOL.connect,
    args: clean({ from: o.from, to: o.to, doors: o.doors, door_style: o.doorStyle, width: o.width }),
  }),

  doorOnWall: (o: { room: string; wall: Side; style?: DoorStyle; width?: Length }): Call => ({ name: TOOL.addDoor, args: clean({ room: o.room, wall: o.wall, style: o.style, width: o.width }) }),
  doorAt: (o: { at: [number, number]; along: 'x' | 'y'; style?: DoorStyle; width?: Length }): Call => ({ name: TOOL.addDoor, args: clean({ at: o.at, along: o.along, style: o.style, width: o.width }) }),

  stairs: (o: { rect: [number, number, number, number]; direction: 'n' | 'e' | 's' | 'w' }): Call => ({ name: TOOL.addStairs, args: { rect: o.rect, direction: o.direction } }),

  /** add_prop by place in a room ("center", "north wall", "ne corner", "near i3", "around i1"). */
  propIn: (o: { asset: string; in?: string; place: string; count?: number; notes?: string }): Call => ({ name: TOOL.addProp, args: clean({ asset: o.asset, in: o.in, place: o.place, count: o.count, notes: o.notes }) }),
  propAt: (o: { asset: string; at: [number, number]; rotation?: number; notes?: string }): Call => ({ name: TOOL.addProp, args: clean({ asset: o.asset, at: o.at, rotation: o.rotation, notes: o.notes }) }),

  propsRegion: (o: { asset: string; region: Json; spacing?: Length; placement?: 'regular' | 'irregular' }): Call => ({ name: TOOL.propsAlong, args: clean({ asset: o.asset, region: o.region, spacing: o.spacing, placement: o.placement }) }),
  propsPath: (o: { asset: string; path: [number, number][]; spacing?: Length; placement?: 'regular' | 'irregular'; spread?: Length }): Call => ({
    name: TOOL.propsAlong,
    args: clean({ asset: o.asset, path: o.path, spacing: o.spacing, placement: o.placement, spread: o.spread }),
  }),

  terrainRegion: (o: { asset: string; region: Json }): Call => ({ name: TOOL.addTerrain, args: { asset: o.asset, region: o.region } }),
  terrainRect: (o: { asset: string; rect: [number, number, number, number] }): Call => ({ name: TOOL.addTerrain, args: { asset: o.asset, rect: o.rect } }),

  heightRegion: (o: { region: Json; height: Length; edge?: 'cliff' | 'rock' | 'slope' | 'step'; name?: string }): Call => ({ name: TOOL.addHeight, args: clean({ region: o.region, height: o.height, edge: o.edge, name: o.name }) }),
  heightRect: (o: { rect: [number, number, number, number]; height: Length; edge?: 'cliff' | 'rock' | 'slope' | 'step'; name?: string }): Call => ({ name: TOOL.addHeight, args: clean({ rect: o.rect, height: o.height, edge: o.edge, name: o.name }) }),
  heightCircle: (o: { circle: [number, number, number]; height: Length; edge?: 'cliff' | 'rock' | 'slope' | 'step'; name?: string }): Call => ({ name: TOOL.addHeight, args: clean({ circle: o.circle, height: o.height, edge: o.edge, name: o.name }) }),

  labelIn: (o: { text: string; region: Json; size?: Length }): Call => ({ name: TOOL.addLabel, args: clean({ text: o.text, region: o.region, size: o.size }) }),
  labelAt: (o: { text: string; at: [number, number]; size?: Length }): Call => ({ name: TOOL.addLabel, args: clean({ text: o.text, at: o.at, size: o.size }) }),

  update: (id: string, set?: Json, unset?: string[]): Call => ({ name: TOOL.update, args: clean({ id, set, unset }) }),
  /** The fields update sets for the common edits. */
  set: {
    name: (name: string): Json => ({ name }),
    label: (label: string): Json => ({ label }),
    notes: (notes: string): Json => ({ notes }),
    doorStyle: (style: DoorStyle): Json => ({ style }),
    rect: (rect: [number, number, number, number]): Json => ({ shape: { rect } }),
  },
  unsetNotes: ['notes'] as string[],

  move: (ids: string[], dx: number, dy: number): Call => ({ name: TOOL.move, args: { ids, dx, dy } }),
  del: (ids: string[]): Call => ({ name: TOOL.delete, args: { ids } }),
  undo: (): Call => ({ name: TOOL.undo, args: {} }),
};

/**
 * Arguments the harness adds to every call and the model never writes: the
 * map id (local-setup.ts `fixed`), and here also add_props_along's seed, so
 * the generator's runs repeat (the model's calls leave it out and Delve picks
 * one at random).
 */
export function hiddenArgs(name: string, mapId: string, seed: number): Json {
  return { map: mapId, ...(name === TOOL.propsAlong ? { seed } : {}) };
}

/** A call's arguments in the order the lean tool lists its parameters (the order the model sees). */
export function ordered(c: Call): Call {
  const order = LEAN_TOOLS[c.name]?.params ?? [];
  const keys = Object.keys(c.args).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e3 : ia) - (ib < 0 ? 1e3 : ib);
  });
  return { name: c.name, args: Object.fromEntries(keys.map((k) => [k, c.args[k]])) };
}

// ---------- building starting maps (never in the training data) ----------

export const setup = {
  roomRect: (rect: [number, number, number, number], extra: { name?: string; notes?: string; label?: string } = {}): Call => ({ name: 'add_room', args: clean({ rect, ...extra }) }),
  roomPreset: (kind: 'octagon' | 'hexagon' | 'oval', box: [number, number, number, number], extra: { name?: string; notes?: string } = {}): Call => ({ name: 'add_room', args: clean({ preset: { kind, box }, ...extra }) }),
  roomCircle: (circle: [number, number, number], extra: { name?: string; notes?: string } = {}): Call => ({ name: 'add_room', args: clean({ circle, ...extra }) }),
  connect: (from: string, to: string, doors: 'none' | 'from' | 'to' | 'both', style?: DoorStyle, width?: number): Call => ({ name: 'connect', args: clean({ from, to, doors, door_style: style, width }) }),
  doorOnWall: (room: string, wall: Side, style?: DoorStyle, width?: number): Call => ({ name: 'add_door', args: clean({ room, wall, style, width }) }),
  pillar: (rect: [number, number, number, number]): Call => ({ name: 'add_cutout', args: { rect, name: 'Pillar' } }),
  stairs: (rect: [number, number, number, number], direction: 'n' | 'e' | 's' | 'w'): Call => ({ name: 'add_stairs', args: { rect, direction } }),
  propIn: (asset: string, room: string, place: string, count?: number): Call => ({ name: 'add_prop', args: clean({ asset, in: room, place, count }) }),
  propAt: (asset: string, at: [number, number], rotation?: number): Call => ({ name: 'add_prop', args: clean({ asset, at, rotation }) }),
  terrainRect: (asset: string, rect: [number, number, number, number], name?: string): Call => ({ name: 'add_terrain', args: clean({ asset, rect, name }) }),
  terrainCircle: (asset: string, circle: [number, number, number], name?: string): Call => ({ name: 'add_terrain', args: clean({ asset, circle, name }) }),
  terrainRegion: (asset: string, r: Json, name?: string): Call => ({ name: 'add_terrain', args: clean({ asset, region: r, name }) }),
  height: (shape: { rect?: [number, number, number, number]; circle?: [number, number, number] }, height: number, edge: 'cliff' | 'rock' | 'slope' | 'step', name?: string): Call => ({ name: 'add_height', args: clean({ ...shape, height, edge, name }) }),
  propsRegion: (asset: string, r: Json): Call => ({ name: 'add_props_along', args: { asset, region: r } }),
  label: (text: string, at: [number, number]): Call => ({ name: 'add_label', args: { text, at } }),
  rawOps: (ops: unknown[]): Call => ({ name: 'apply_ops', args: { ops } }),
};

// ---------- recognising Delve's refusals (the recovery family) ----------

export const refusal = {
  /** add_door: the wall has no free stretch (corridor mouths, other doors). */
  wallFull: (text: string) => /no free stretch of .* wall of/.test(text),
  /** add_room beside: no free spot on that side. */
  noRoomSpot: (text: string) => /beside: no free .* spot/.test(text),
  /** add_prop by place: nowhere to put it there. */
  noPropSpot: (text: string) => /no free spot|has no room for|doesn't fit|does not fit|Only \d+ of \d+ fit/i.test(text),
  /** add_prop at a spot: it stands on something (a warning, not an error). */
  propOverlap: (text: string) => /Warning: it overlaps/.test(text),
  /** The nearest free spot add_prop names. */
  freeSpot: (text: string): [number, number] | null => {
    const m = /nearest free spot is \[(-?[\d.]+), (-?[\d.]+)\]/.exec(text);
    return m ? [Number(m[1]), Number(m[2])] : null;
  },
  /** The free walls add_door's refusal names. */
  freeWalls: (text: string): Side[] => {
    const m = /Free walls of \w+: ([a-z, ]+)\./.exec(text);
    return m ? (m[1]!.split(/,\s*/).filter((s) => (SIDES as readonly string[]).includes(s)) as Side[]) : [];
  },
  /** A door already in the wall add_door was refused for. */
  doorInWall: (text: string): string | null => /Door (d\d+) \(/.exec(text)?.[1] ?? null,
};

/** A result that warns about something the model should fix before answering. */
export const warns = (text: string): boolean => /Check: WARNING|Warning:/.test(text);

// ---------- recognising what Delve says (the families read these, nothing else of the wording) ----------

export const said = {
  /** check_map found nothing. */
  noProblems: (text: string) => /^No problems found/.test(text),
  /** How many problems check_map listed. */
  problemCount: (text: string) => Number(/^(\d+) problems?/.exec(text)?.[1] ?? 0),
  /** add_prop by a wall: flush against it (not a square or more off it). */
  againstWall: (text: string) => /against the \w+ wall/.test(text) && !/off it/.test(text),
  /** add_prop in a corner: in it (not "as near … as is free"). */
  inCorner: (text: string) => /in the [\w-]+ corner of/.test(text) && !/as is free/.test(text),
  /** add_prop with count: every copy fit. */
  allFit: (text: string) => !/Only \d+ of/.test(text),
  /** add_prop by place landed where asked (a wall, a corner, the middle). */
  placedAsAsked: (text: string) => /(in the|against the) [\w-]+ (corner|wall)|in the middle|near the middle/.test(text),
  /** move: the doors that moved with a room. */
  doorsFollowed: (text: string) => /\(and doors ([^)]+)\)/.exec(text)?.[1],
  /** connect / add_room: the corridor went round rooms in the way. */
  routedAround: (text: string) => /goes round them instead/.test(text),
  /** add_terrain over a room: all of it. */
  coversAll: (text: string) => /covers all of/.test(text),
  /** add_prop refused at a wall: the walls that have room for it. */
  wallsWithRoom: (text: string): Side[] => (/the ([a-z, ]+) walls? ha(?:s|ve) room for it/.exec(text)?.[1]?.split(/,\s*/) ?? []).filter((s): s is Side => (SIDES as readonly string[]).includes(s)),
};
