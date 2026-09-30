// MCP endpoint (Streamable HTTP, stateless) at /mcp, protected by the API
// token. The tools are thin wrappers over the same ops the REST API uses, so
// every change is one undoable revision and shows up live in open viewers.
import { randomInt } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ASSETS,
  assetInfo,
  CATEGORIES,
  connectOps,
  describeMap,
  DOOR_STYLES,
  MARKER_KINDS,
  fogSummary,
  nextId,
  nextLabel,
  parseOps,
  PRESETS,
  propBounds,
  shapeBounds,
  updateFog,
  ValidationError,
  scatterAlong,
  withAttachedDoors,
  type AssetInfo,
  type MapObject,
  type Op,
  type Point,
  type Room,
  type Shape,
} from '@delve/core';
import { errorResponse, newMap, tokenGuard } from './api.ts';
import { bearer } from './auth.ts';
import type { ChatTokens } from './chat/tokens.ts';
import { addLevel, levelsOf } from './levels.ts';
import { render } from './render.ts';
import type { MapService } from './service.ts';

const BY = 'claude';

const INSTRUCTIONS = `Delve is a dungeon map editor for tabletop games. You build maps with these tools while the user watches them change live in their browser.
Coordinates are grid squares (1 square = 5 ft unless the map says otherwise): x grows to the right, y grows downward, the origin is top-left, and positions use whole or half squares.
Typical flow: create_map, then add_room (rect [x, y, width, height]) for each room, connect rooms (auto-routed corridors, optional doors at the ends), add_cutout for pillars or pits, add_door / add_stairs / add_label for details.
Each tool call is one undoable step. Check your work with render (returns a picture) or describe_map (text). Use focus to point the user's viewer at what you just did.
Room labels are room numbers: shown in the GM view, hidden in the players' view, which also draws secret doors as plain wall. Exports default to Roll20's 70 pixels per square.
Furnish with add_prop (see list_assets for the ids; at is the centre of the footprint, fronts face south at rotation 0) and paint ground with add_terrain (water, grass, lava…). GM symbols (category symbols) only show in the GM view.
A place with several storeys is several maps in one group: add_level adds a storey above or below. Keep one coordinate grid across storeys so stairs line up.
Fog of war (fog): reveal rooms and corridors by id as the players explore; with fog on, the players' view shows only what's revealed.
Wall roughness: set_map roughness 1 (smooth) to 10 (caves); rooms, corridors and cutouts can have their own (update {"roughness": 9}). Rows of props (trees along a road): add_props_along.
GM markers (add_marker): a clickable note for the GM, "discover" (?), "interact" (!) or "trap" (skull); GM view only, and update {"done": true} strikes one through.`;

const presetNames = Object.keys(PRESETS) as [string, ...string[]];

const mapId = z.string().describe('Map id, e.g. map_1a2b3c4d5e6f (see list_maps)');
const point = z.tuple([z.number(), z.number()]).describe('[x, y] in squares');
const shapeArgs = {
  rect: z
    .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
    .optional()
    .describe('Rectangle [x, y, width, height] in squares'),
  poly: z.array(point).min(3).optional().describe('Polygon: corner points [[x, y], ...]'),
  circle: z.tuple([z.number(), z.number(), z.number().positive()]).optional().describe('Circle [centreX, centreY, radius]'),
};

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    let msg: string;
    try {
      msg = errorResponse(e).body.error; // ValidationError messages already list every problem
    } catch {
      msg = `internal error: ${(e as Error).message}`;
    }
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}

function oneShape(a: { rect?: [number, number, number, number]; poly?: Point[]; circle?: [number, number, number] }): Shape {
  const given = [a.rect && { rect: a.rect }, a.poly && { poly: a.poly }, a.circle && { circle: a.circle }].filter(Boolean) as Shape[];
  if (given.length !== 1) throw new ValidationError(['give exactly one of rect, poly or circle']);
  return given[0]!;
}

/** One catalog line for Claude: id, name, footprint, what it blocks. */
export function assetLine(a: AssetInfo): string {
  if (a.kind === 'terrain') return `${a.id} — ${a.name} (terrain${a.difficult ? ', difficult' : ''})`;
  const blocks = a.blocks === 'none' ? 'walk over' : a.blocks === 'movement' ? 'blocks movement' : 'blocks sight';
  return `${a.id} — ${a.name}, ${a.w}×${a.h}, ${blocks}, ${a.category}`;
}

function where(shape: Shape): string {
  const b = shapeBounds(shape);
  return `${b.x1 - b.x0}×${b.y1 - b.y0} squares at ${b.x0},${b.y0}`;
}

export function buildMcpServer(service: MapService, base: string, version: string): McpServer {
  const server = new McpServer({ name: 'delve', title: 'Delve map editor', version }, { instructions: INSTRUCTIONS });
  const { store } = service;
  const viewer = (id: string) => `${base}/maps/${encodeURIComponent(id)}`;
  const change = (id: string, ops: Op[], summary: string, baseRev?: number) => {
    const c = service.apply(id, ops, { by: BY, baseRev });
    return text(`${summary} Map is at rev ${c.rev}.`);
  };
  const addObject = (id: string, object: MapObject, summary: string) => change(id, [{ op: 'add', object }], summary);

  server.registerTool(
    'list_maps',
    { title: 'List maps', description: 'All saved maps, newest first, with ids and viewer links.', inputSchema: {}, annotations: { readOnlyHint: true } },
    () =>
      guarded(() => {
        const maps = store.list();
        if (!maps.length) return text('No maps yet. Use create_map.');
        const storey = (m: (typeof maps)[number]) => (m.level ? ` · storey "${m.level.name}" (order ${m.level.order}) of group ${m.level.group}` : '');
        return text(maps.map((m) => `${m.id} · "${m.name}"${storey(m)} · rev ${m.rev} · ${m.objects} objects · updated ${m.updated} · ${viewer(m.id)}`).join('\n'));
      }),
  );

  server.registerTool(
    'create_map',
    {
      title: 'Create map',
      description: 'Start a new map. template "test-dungeon" starts from the 6-room sample dungeon.',
      inputSchema: {
        name: z.string().min(1).max(200),
        style: z.enum(presetNames).optional().describe('Look: classic-hatching (default), clean, old-school-blue, print'),
        template: z.enum(['empty', 'test-dungeon']).optional(),
      },
    },
    (a) =>
      guarded(() => {
        const c = service.create(newMap(a), BY);
        return text(`Created map "${c.map.name}" with id ${c.mapId}. The user can watch it live at ${viewer(c.mapId)}`);
      }),
  );

  server.registerTool(
    'get_map',
    { title: 'Get map JSON', description: 'The full map document (delve.map v1) and its rev.', inputSchema: { map: mapId }, annotations: { readOnlyHint: true } },
    (a) => guarded(() => {
      const { rev, map } = store.get(a.map);
      return text(JSON.stringify({ rev, map }));
    }),
  );

  server.registerTool(
    'describe_map',
    {
      title: 'Describe map',
      description: 'Plain-text summary: rooms with sizes, corridors, doors, cutouts. Cheaper than get_map.',
      inputSchema: { map: mapId },
      annotations: { readOnlyHint: true },
    },
    (a) => guarded(() => {
      const { rev, map } = store.get(a.map);
      return text(`${describeMap(map)}\n(rev ${rev})`);
    }),
  );

  server.registerTool(
    'add_room',
    {
      title: 'Add room',
      description: 'Add a room. Give exactly one shape. The label (room number) defaults to the next free number; pass "" for none.',
      inputSchema: {
        map: mapId,
        ...shapeArgs,
        name: z.string().max(200).optional().describe('e.g. "Guard room"'),
        label: z.string().max(20).optional(),
        notes: z.string().max(10_000).optional().describe('GM notes (never drawn)'),
        roughness: z.number().int().min(1).max(10).optional().describe("This room's walls, 1 smooth to 10 extremely rough (a cave); default: the map's"),
        id: z.string().optional().describe('Object id; defaults to the next r<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = oneShape(a);
        const label = a.label ?? nextLabel(map);
        const room: Room = {
          id: a.id ?? nextId(map, 'r'),
          type: 'room',
          shape,
          ...(label ? { label } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.roughness ? { roughness: a.roughness } : {}),
        };
        return addObject(a.map, room, `Added room ${room.id}${a.name ? ` "${a.name}"` : ''}${label ? ` (label ${label})` : ''}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect rooms',
      description:
        'Add a corridor between two rooms. It is routed automatically (straight, or L-shaped) and re-routes when a room moves. ' +
        'doors puts doors across the corridor mouths at its current ends (doors stay put if rooms move later).',
      inputSchema: {
        map: mapId,
        from: z.string().describe('Room id'),
        to: z.string().describe('Room id'),
        width: z.number().positive().optional().describe('Corridor width in squares (default 2)'),
        doors: z.enum(['none', 'from', 'to', 'both']).optional().describe('default none'),
        door_style: z.enum(DOOR_STYLES).optional(),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const { ops, corridor, path, doorIds } = connectOps(map, a.from, a.to, {
          width: a.width,
          doors: a.doors,
          doorStyle: a.door_style,
          id: a.id,
        });
        const len = path.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]), 0);
        return change(
          a.map,
          ops,
          `Added corridor ${corridor.id} from ${a.from} to ${a.to}: ${corridor.width} wide, ${len} squares long, path ${JSON.stringify(path)}${doorIds.length ? `; doors ${doorIds.join(', ')}` : ''}.`,
        );
      }),
  );

  server.registerTool(
    'add_cutout',
    {
      title: 'Add cutout',
      description: 'Remove floor inside a room: pillars, pits, collapsed sections. Give exactly one shape.',
      inputSchema: { map: mapId, ...shapeArgs, name: z.string().max(200).optional().describe('e.g. "Pillar"'), id: z.string().optional() },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = oneShape(a);
        const id = a.id ?? nextId(map, 'p');
        return addObject(a.map, { id, type: 'cutout', shape, ...(a.name ? { name: a.name } : {}) }, `Added cutout ${id}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'add_door',
    {
      title: 'Add door',
      description:
        'Add a door along a wall or across an opening. at is the door\'s start point; along says which way it runs ("x" = horizontal, "y" = vertical).',
      inputSchema: {
        map: mapId,
        at: point,
        along: z.enum(['x', 'y']),
        width: z.number().positive().describe('Length of the door in squares'),
        style: z.enum(DOOR_STYLES).optional().describe('default normal'),
        open: z.boolean().optional(),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'd');
        const door: MapObject = { id, type: 'door', at: a.at, along: a.along, width: a.width, style: a.style ?? 'normal', ...(a.open ? { open: true } : {}) };
        return addObject(a.map, door, `Added ${a.style ?? 'normal'} door ${id} at ${a.at.join(',')} along ${a.along}, ${a.width} wide.`);
      }),
  );

  server.registerTool(
    'add_stairs',
    {
      title: 'Add stairs',
      description: 'Stairs drawn as steps; direction is the way up (n, e, s, w). Give exactly one shape.',
      inputSchema: { map: mapId, ...shapeArgs, direction: z.enum(['n', 'e', 's', 'w']), name: z.string().optional(), id: z.string().optional() },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = oneShape(a);
        const id = a.id ?? nextId(map, 's');
        return addObject(a.map, { id, type: 'stairs', shape, direction: a.direction, ...(a.name ? { name: a.name } : {}) }, `Added stairs ${id}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'add_label',
    {
      title: 'Add label',
      description: 'Free text on the map (shown in both views), centred on at.',
      inputSchema: { map: mapId, text: z.string().min(1).max(200), at: point, size: z.number().positive().optional().describe('Text height in squares'), id: z.string().optional() },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'l');
        return addObject(a.map, { id, type: 'label', text: a.text, at: a.at, ...(a.size ? { size: a.size } : {}) }, `Added label ${id} "${a.text}".`);
      }),
  );

  server.registerTool(
    'add_marker',
    {
      title: 'Add GM marker',
      description:
        'Pin a GM note to a spot, shown only in the GM view as a coloured badge the GM clicks to read: ' +
        'kind "discover" (?, something to find, e.g. a hidden silver coin), "interact" (!, something to use, e.g. the lever for the trapdoor in room 4) or "trap" (skull, e.g. a poison dart trap with a pressure plate). ' +
        'Mark one done with update {"done": true}; the GM view then strikes it through.',
      inputSchema: {
        map: mapId,
        kind: z.enum(MARKER_KINDS),
        at: point.describe('Where the badge sits [x, y], usually a square centre like [3.5, 5.5]'),
        text: z.string().max(2000).describe('The note the GM reads'),
        id: z.string().optional().describe('Defaults to the next m<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'm');
        return addObject(a.map, { id, type: 'marker', kind: a.kind, at: a.at, text: a.text }, `Added ${a.kind} marker ${id} at [${a.at.join(', ')}].`);
      }),
  );

  server.registerTool(
    'list_assets',
    {
      title: 'List props and terrain',
      description: 'The props (furniture, statues, trees, GM symbols…) and terrain tiles you can place, with ids, footprints and what they block.',
      inputSchema: {
        category: z.string().optional().describe(`One of ${CATEGORIES.map((c) => c.id).join(', ')}`),
        search: z.string().optional().describe('Words to match in names and tags, e.g. "bed" or "water"'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guarded(() => {
        const words = (a.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = ASSETS.filter(
          (x) => (!a.category || x.category === a.category) && words.every((w) => x.id.includes(w) || x.name.toLowerCase().includes(w) || x.tags.some((t) => t.includes(w))),
        );
        if (!hits.length) return text('Nothing matches. Try another word, or no filter at all.');
        return text(hits.map(assetLine).join('\n'));
      }),
  );

  server.registerTool(
    'add_prop',
    {
      title: 'Add prop',
      description:
        'Place a prop (see list_assets). at is the centre of its footprint: a 1×1 prop in the square at x 3–4, y 5–6 has at [3.5, 5.5]; a 2×1 prop covering x 3–5 has at [4, 5.5]. ' +
        'At rotation 0 a prop faces south (its back or wall side is north); rotation turns it clockwise in degrees (90, 180, 270).',
      inputSchema: {
        map: mapId,
        asset: z.string().describe('Asset id, e.g. "chest-closed"'),
        at: point.describe('Centre of the footprint [x, y] in squares'),
        rotation: z.number().optional().describe('Degrees clockwise: 0 (faces south), 90 (faces west), 180 (north), 270 (east)'),
        scale: z.number().positive().max(4).optional(),
        name: z.string().max(200).optional(),
        notes: z.string().max(10_000).optional().describe('GM notes, e.g. what is inside a chest'),
        id: z.string().optional().describe('Defaults to the next i<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${a.asset}" is not a prop (use list_assets; terrain goes in add_terrain)`]);
        const map = store.get(a.map).map;
        const prop: MapObject = {
          id: a.id ?? nextId(map, 'i'),
          type: 'prop',
          asset: a.asset,
          at: a.at,
          ...(a.rotation ? { rotation: a.rotation } : {}),
          ...(a.scale && a.scale !== 1 ? { scale: a.scale } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
        };
        const b = propBounds(prop);
        return addObject(a.map, prop, `Added ${info.name} ${prop.id}, covering x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1}.`);
      }),
  );

  server.registerTool(
    'add_props_along',
    {
      title: 'Add props along a path',
      description:
        'Place copies of one prop along a path, like painting with a brush: trees along a road, rocks along a cave wall, pillars down a hall. ' +
        'placement "regular" puts one exactly every `spacing` squares (the first at the path\'s start); "irregular" varies the gaps, strays up to `spread` squares to either side, and turns and sizes each copy a little. ' +
        'Spots within 0.6 × spacing of the same prop already on the map are skipped. One undo step.',
      inputSchema: {
        map: mapId,
        asset: z.string().describe('Prop id, e.g. "tree-oak" (see list_assets)'),
        path: z.array(point).min(1).max(200).describe('Points the brush passes through, [[x, y], ...]'),
        spacing: z.number().min(0.5).max(20).optional().describe('Squares between copies (default 3)'),
        placement: z.enum(['regular', 'irregular']).optional().describe('default regular'),
        spread: z.number().min(0).max(10).optional().describe('Irregular: how far copies stray to the sides, in squares (default a third of the spacing)'),
        rotation: z.number().optional().describe('Regular: the rotation of every copy'),
      },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${a.asset}" is not a prop (use list_assets)`]);
        const map = store.get(a.map).map;
        const avoid = map.objects.flatMap((o) => (o.type === 'prop' && o.asset === a.asset ? [o.at] : []));
        const spots = scatterAlong(a.path, {
          spacing: a.spacing ?? 3,
          placement: a.placement ?? 'regular',
          ...(a.spread !== undefined ? { spread: a.spread } : {}),
          ...(a.rotation ? { rotation: a.rotation } : {}),
          seed: randomInt(1, 2 ** 31),
          avoid,
        }).slice(0, 500);
        if (!spots.length) return text('Nothing placed: every spot along the path already has one nearby.');
        const ops = spots.map((s, k) => ({
          op: 'add' as const,
          object: { id: nextId(map, 'i', k), type: 'prop' as const, asset: a.asset, at: s.at, ...(s.rotation ? { rotation: s.rotation } : {}), ...(s.scale !== 1 ? { scale: s.scale } : {}) },
        }));
        return change(a.map, ops, `Added ${spots.length} × ${info.name} (${ops[0]!.object.id}–${ops.at(-1)!.object.id}) along the path.`);
      }),
  );

  server.registerTool(
    'add_terrain',
    {
      title: 'Add terrain',
      description: 'Fill an area with a terrain tile (water, grass, lava, rubble… see list_assets category terrain). Give exactly one shape; it may cover a whole room or open ground outside rooms.',
      inputSchema: { map: mapId, asset: z.string().describe('Terrain id, e.g. "water-shallow"'), ...shapeArgs, name: z.string().max(200).optional(), id: z.string().optional() },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'terrain') throw new ValidationError([`asset: "${a.asset}" is not a terrain tile (see list_assets with category "terrain")`]);
        const map = store.get(a.map).map;
        const shape = oneShape(a);
        const id = a.id ?? nextId(map, 't');
        return addObject(a.map, { id, type: 'terrain', shape, asset: a.asset, ...(a.name ? { name: a.name } : {}) }, `Added ${info.name} terrain ${id}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'fog',
    {
      title: 'Fog of war',
      description:
        "Fog of war for the players' view: with it on, players see only the revealed rooms and corridors (everything else isn't drawn for them). " +
        'Reveal rooms or corridors by id as the party explores, or an area (e.g. part of a cave), cover things again, reveal everything, or reset. Revealing turns fog on.',
      inputSchema: {
        map: mapId,
        on: z.boolean().optional().describe('Turn fog on or off (off: players see the whole map)'),
        reveal: z.array(z.string()).optional().describe('Room or corridor ids the players can now see, e.g. ["r3", "c2"]'),
        cover: z.array(z.string()).optional().describe('Ids to hide again'),
        reveal_area: shapeArgs.rect.describe('Also show this rectangle [x, y, w, h]'),
        cover_area: shapeArgs.rect.describe('Hide this rectangle again'),
        reveal_all: z.boolean().optional(),
        reset: z.boolean().optional().describe('Hide everything again (fog stays on)'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const fog = updateFog(map, {
          ...(a.on !== undefined ? { on: a.on } : {}),
          ...(a.reveal ? { reveal: a.reveal } : {}),
          ...(a.cover ? { cover: a.cover } : {}),
          ...(a.reveal_area ? { revealArea: { rect: a.reveal_area } } : {}),
          ...(a.cover_area ? { coverArea: { rect: a.cover_area } } : {}),
          ...(a.reveal_all ? { revealAll: true } : {}),
          ...(a.reset ? { reset: true } : {}),
        });
        const c = service.apply(a.map, [{ op: 'update_map', set: { fog } }], { by: BY });
        return text(`${fogSummary(c.map) ?? 'Fog of war: off.'} Players' screen: ${base}/maps/${encodeURIComponent(a.map)}/screen. Map is at rev ${c.rev}.`);
      }),
  );

  server.registerTool(
    'add_level',
    {
      title: 'Add storey',
      description:
        'Add a storey to a multi-storey place: a new empty map in the same group, above or below. The first time, this map becomes a storey too (current_name, default "Ground floor"). ' +
        'Draw the new storey on the same grid, so stairs sit at the same x, y on both floors. Returns the new map id.',
      inputSchema: {
        map: mapId,
        name: z.string().min(1).max(60).describe('e.g. "Cellar", "Upper floor", "Tower top"'),
        position: z.enum(['above', 'below']).optional().describe('default above'),
        current_name: z.string().min(1).max(60).optional().describe('Storey name for this map, if it is not part of a group yet'),
      },
    },
    (a) =>
      guarded(() => {
        const c = addLevel(service, a.map, { name: a.name, position: a.position, currentName: a.current_name, by: BY });
        const all = levelsOf(service, c.mapId).map((l) => `${l.level?.name ?? l.name} (${l.id})`);
        return text(`Added storey "${a.name}" as map ${c.mapId}: ${viewer(c.mapId)}. Storeys, top first: ${all.join(', ')}.`);
      }),
  );

  server.registerTool(
    'move',
    {
      title: 'Move objects',
      description: 'Move objects by dx, dy squares. Auto-routed corridors follow their rooms, and doors on a moved room\'s edges move with it.',
      inputSchema: { map: mapId, ids: z.array(z.string()).min(1), dx: z.number(), dy: z.number() },
    },
    (a) =>
      guarded(() => {
        const ids = withAttachedDoors(store.get(a.map).map, a.ids);
        const extra = ids.filter((id) => !a.ids.includes(id));
        return change(a.map, [{ op: 'move', ids, dx: a.dx, dy: a.dy }], `Moved ${a.ids.join(', ')}${extra.length ? ` (and doors ${extra.join(', ')})` : ''} by ${a.dx},${a.dy}.`);
      }),
  );

  server.registerTool(
    'resize',
    {
      title: 'Resize or reshape',
      description: 'Give a room, cutout, stairs or terrain area a new shape (exactly one of rect, poly, circle).',
      inputSchema: { map: mapId, id: z.string(), ...shapeArgs },
    },
    (a) =>
      guarded(() => {
        const shape = oneShape(a);
        return change(a.map, [{ op: 'update', id: a.id, set: { shape } }], `Reshaped ${a.id}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update object',
      description: 'Set or remove fields of one object, e.g. {"name": "Armoury"} or {"style": "locked"} on a door. id and type can\'t change.',
      inputSchema: { map: mapId, id: z.string(), set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional() },
    },
    (a) => guarded(() => change(a.map, [{ op: 'update', id: a.id, set: a.set, unset: a.unset }], `Updated ${a.id}.`)),
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete objects',
      description: 'Delete objects by id (undo brings them back). A room with corridors attached must lose those corridors first.',
      inputSchema: { map: mapId, ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    (a) => guarded(() => change(a.map, [{ op: 'delete', ids: a.ids }], `Deleted ${a.ids.join(', ')}.`)),
  );

  server.registerTool(
    'set_map',
    {
      title: 'Map settings',
      description: 'Rename the map, change its style preset, style overrides (e.g. {"walls.width": 0.2}; null clears them), its random seed, or its wall roughness (1 smooth to 10 caves; null goes back to the style).',
      inputSchema: {
        map: mapId,
        name: z.string().min(1).max(200).optional(),
        style: z.enum(presetNames).optional(),
        overrides: z.record(z.string(), z.unknown()).nullable().optional(),
        seed: z.number().int().optional().describe('Changes the hatching and wall wobble'),
        roughness: z.number().int().min(1).max(10).nullable().optional().describe('Wall roughness for the whole map: 1 smooth, 10 extremely rough (caves); null resets'),
        level_name: z.string().min(1).max(60).optional().describe('Rename this storey (only for maps that are storeys, see add_level)'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const set: Record<string, unknown> = {};
        if (a.name) set.name = a.name;
        if (a.seed !== undefined) set.seed = a.seed;
        const unset = a.roughness === null ? ['roughness'] : [];
        if (a.roughness) set.roughness = a.roughness;
        if (a.level_name) {
          if (!map.level) throw new ValidationError(['level_name: this map is not a storey; use add_level to make one']);
          set.level = { ...map.level, name: a.level_name };
        }
        if (a.style !== undefined || a.overrides !== undefined) {
          const cur = map.style ?? { preset: 'classic-hatching' };
          const overrides = a.overrides === undefined ? cur.overrides : (a.overrides ?? undefined);
          set.style = { preset: a.style ?? cur.preset, ...(overrides ? { overrides } : {}) };
        }
        if (!Object.keys(set).length && !unset.length) throw new ValidationError(['nothing to change: give name, style, overrides, seed, roughness or level_name']);
        return change(a.map, [{ op: 'update_map', set, ...(unset.length ? { unset } : {}) }], `Updated map settings (${[...Object.keys(set), ...unset].join(', ')}).`);
      }),
  );

  for (const action of ['undo', 'redo'] as const) {
    server.registerTool(
      action,
      { title: action === 'undo' ? 'Undo' : 'Redo', description: action === 'undo' ? 'Undo the last change (any source).' : 'Redo the last undone change.', inputSchema: { map: mapId } },
      (a) =>
        guarded(() => {
          const c = action === 'undo' ? service.undo(a.map, BY) : service.redo(a.map, BY);
          return text(`${action === 'undo' ? 'Undid' : 'Redid'} one change. Map is at rev ${c.rev}.`);
        }),
    );
  }

  server.registerTool(
    'render',
    {
      title: 'Render map',
      description: 'Look at the map: returns a PNG picture. Use this to check your work.',
      inputSchema: {
        map: mapId,
        view: z.enum(['gm', 'players']).optional().describe('default gm'),
        style: z.enum(presetNames).optional().describe('Preview another style without changing the map'),
        ppg: z.number().int().min(8).max(60).optional().describe('Pixels per square (default 24)'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guarded(async () => {
        const { rev, map } = store.get(a.map);
        const out = await render(map, { view: a.view, style: a.style, ppg: String(a.ppg ?? 24) }, 'png');
        return {
          content: [
            { type: 'image', data: (out.body as Buffer).toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `"${map.name}" rev ${rev}, ${a.view ?? 'gm'} view (${out.name}).` },
          ],
        };
      }),
  );

  server.registerTool(
    'export',
    {
      title: 'Export link',
      description:
        'A download link for the user: PNG (default 70 px per square, Roll20\'s grid), SVG, ds (opens in Dungeon Scrawl), ' +
        'or handout: the players\' map drawn by hand on an old parchment sheet, to print or hand out (the link opens a page with print and download buttons).',
      inputSchema: {
        map: mapId,
        format: z.enum(['png', 'svg', 'ds', 'handout']).optional(),
        view: z.enum(['gm', 'players']).optional().describe('default players'),
        style: z.enum(presetNames).optional(),
        ppg: z.number().int().min(10).max(300).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guarded(() => {
        store.get(a.map);
        const view = a.view ?? 'players';
        if (a.format === 'ds') return text(`${base}/api/v1/maps/${encodeURIComponent(a.map)}/export.ds?view=${view}`);
        if (a.format === 'handout') return text(`${base}/maps/${encodeURIComponent(a.map)}/handout`);
        const q = new URLSearchParams({ view, ...(a.style ? { style: a.style } : {}), ...(a.ppg ? { ppg: String(a.ppg) } : {}) });
        return text(`${base}/api/v1/maps/${encodeURIComponent(a.map)}/render.${a.format ?? 'png'}?${q}`);
      }),
  );

  server.registerTool(
    'focus',
    {
      title: 'Show the user',
      description: 'Pan and zoom every open viewer of this map to these objects and highlight them.',
      inputSchema: { map: mapId, ids: z.array(z.string()).min(1) },
    },
    (a) =>
      guarded(() => {
        const n = service.focus(a.map, a.ids, BY);
        return text(n ? `Pointed ${n} open viewer${n === 1 ? '' : 's'} at ${a.ids.join(', ')}.` : `Nobody has the map open right now. Viewer: ${viewer(a.map)}`);
      }),
  );

  server.registerTool(
    'apply_ops',
    {
      title: 'Apply raw ops',
      description: 'Apply delve ops (add, update, move, delete, update_map, batch) as one undoable step. For anything the other tools don\'t cover.',
      inputSchema: { map: mapId, ops: z.array(z.unknown()).min(1), base_rev: z.number().int().optional() },
    },
    (a) => guarded(() => change(a.map, parseOps(a.ops), `Applied ${a.ops.length} op${a.ops.length === 1 ? '' : 's'}.`, a.base_rev)),
  );

  return server;
}

export function registerMcp(
  app: FastifyInstance,
  deps: { service: MapService; token: string | undefined; version: string; chatTokens?: ChatTokens },
): void {
  const tokenOnly = tokenGuard(deps.token);
  // A chat run's short-lived token works too (see chat/tokens.ts).
  const chatGrant = (req: FastifyRequest) => deps.chatTokens?.lookup(bearer(req.headers.authorization)) ?? null;
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (chatGrant(req)) return;
    return tokenOnly(req, reply);
  };

  app.post('/mcp', { preHandler: guard }, async (req: FastifyRequest, reply: FastifyReply) => {
    // Chat runs call in over 127.0.0.1, so their links use the address the user's browser used.
    const base = (chatGrant(req)?.base ?? process.env.DELVE_PUBLIC_URL ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
    const server = buildMcpServer(deps.service, base, deps.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless, use POST' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
