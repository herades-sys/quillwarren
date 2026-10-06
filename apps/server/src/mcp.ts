// MCP endpoint (Streamable HTTP, stateless) at /mcp, protected by the API
// token. The tools are thin wrappers over the same ops the REST API uses, so
// every change is one undoable revision and shows up live in open viewers.
import { randomInt } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  allAssets,
  assetInfo,
  CATEGORIES,
  COLOUR_ASSETS,
  COLOUR_CATEGORIES,
  groupVariants,
  modularAt,
  connectOps,
  cropFrame,
  CUTOUT_FILLS,
  computeFloor,
  describeMap,
  doorAngle,
  doorOnWall,
  DOOR_STYLES,
  MARKER_KINDS,
  fogSummary,
  frameQuery,
  IMAGE_LAYERS,
  imageBounds,
  imageFit,
  isTurned,
  nearestAxis,
  nextId,
  nextLabel,
  parseOps,
  placeDoorBetween,
  PRESETS,
  propBounds,
  propHidden,
  shapeBounds,
  updateFog,
  squareUnit,
  ValidationError,
  scatterAlong,
  blockingProps,
  freeSpot,
  keepClear,
  overlapReport,
  withAttachedDoors,
  type AssetInfo,
  type Door,
  type MapObject,
  type Op,
  type Point,
  type Room,
  type Shape,
} from '@delve/core';
import { INSCRIPTION_INKS, INSCRIPTION_MAX, INSCRIPTION_SIZE } from '@delve/core';
import { besideRect, checkObjects, corridorThrough, doorAtEnd, doorOnRoomWall, fillRegion, halfSquares, placeProps, regionCentre, routeAround, sideOf, type ConnectOptions, type ConnectPlan } from '@delve/core';
import { FADE_WIDTH_MAX, FADE_WIDTH_MIN, STACK_MAX, TERRAIN_EDGES, terrainEdgeText } from '@delve/core';
import { backgroundHints, mapBackground, parseBackground, styleBackground, withBackground } from '@delve/core';
import { errorResponse, newMap, tokenGuard } from './api.ts';
import { bearer } from './auth.ts';
import type { ChatTokens } from './chat/tokens.ts';
import type { PropLibrary } from './custom-props.ts';
import type { ImageLibrary } from './images.ts';
import { addLevel, levelsOf } from './levels.ts';
import { renamePlace, setCategory } from './library.ts';
import { presetArg, shapeOrPreset } from './draw-args.ts';
import { registerPropTools } from './prop-tools.ts';
import { render } from './render.ts';
import { registerSegmentTools } from './segments.ts';
import { registerCorridorTools } from './corridor-tools.ts';
import { registerHeightTools } from './height-tools.ts';
import { lengthArg, notesText, placeArg, regionArg, registerCheckTools, regionOf, shapeOrRegion, squaresArg } from './place-tools.ts';
import type { MapService } from './service.ts';
import { labelStairs, labelStairsSummary } from './stair-labels.ts';

const BY = 'claude';

const INSTRUCTIONS = `Delve is a dungeon map editor for tabletop games. You build maps with these tools while the user watches them change live in their browser.
Coordinates are grid squares (1 square = 5 ft unless the map says otherwise): x grows to the right, y grows downward, the origin is top-left, and positions use whole or half squares.
Typical flow: create_map, then add_room (rect [x, y, width, height]) for each room, connect rooms (auto-routed corridors, optional doors at the ends), add_cutout for pillars or pits, add_door / add_stairs / add_label for details.
Place things by meaning and let the tools do the geometry: add_room beside "r2" side "north" (connect true, door "normal"); add_door room "r3" wall "east"; add_prop in "r2" place "north wall" / "ne corner" / "center" / "around i1" (count 4); add_terrain, add_height, add_props_along and add_label take a region ({"edge": "north"}, {"corner": "sw", "size": 8}, {"in": "r5"}, {"around": "r3"}, {"between": ["east", "h1"]}); lengths and heights take units ("5 m", "10 ft"). North is always up (small y).
Each tool call is one undoable step. Building tools end their reply with a short check (inside the room? overlaps? on a wall?); check_map lists every layout problem. Check your work with render (returns a picture) or describe_map (text). Use focus to point the user's viewer at what you just did.
Room labels are room numbers: shown in the GM view, hidden in the players' view, which also draws secret doors as plain wall. Exports default to Roll20's 70 pixels per square.
Furnish with add_prop (see list_assets for the ids; at is the centre of the footprint, fronts face south at rotation 0) and paint ground with add_terrain (water, grass, lava…). GM symbols (category symbols) only show in the GM view.
Colour props (ids c-…: trees, plants, rocks, rugs, trapdoors, hidden traps, ruin walls…) are a second library in full colour, placed the same way; list_assets palette "colour" lists them by category. Floor ones (rugs, trapdoors) lie under the other props, and add_props_along mixes a group's variants (a forest of different oaks).
Trees are tall: they are drawn over every other prop, so whatever stands under a tree is hidden by its crown. Keep boulders, ruins and camps in clearings, off trees: add_props_along skips spots where a copy would stand on a tree, boulder or wall, and add_prop warns with the ids it overlaps and the nearest free spot (avoid true puts it there).
A place with several storeys is several maps in one group: add_level adds a storey above or below. Keep one coordinate grid across storeys so stairs line up.
Floor numbers: a storey's floor is its level order (0 ground level, -1 one floor below ground, 1 the first floor up; set_map floor changes it). label_stairs gives every stair, ladder and trapdoor its GM label, floor number then flight letter (0A, 1A, 2A up one staircase).
Room and cutout shapes: rect, circle, poly, or preset {kind: oval|triangle|hexagon|octagon, box: [x, y, w, h]}. Cutouts with fill "solid" draw as solid pillars or wall blocks.
Doors can sit in walls at any angle: add_door with angle (degrees clockwise from east) for slanted or curved walls, or with near (a spot by the wall) to centre one on the nearest wall and turn it to match.
Open edges: an archway on the floor's outer edge is drawn as an open end (no hatching or shading in front of it). Anywhere else, add_opening marks an open area: no hatching, shading or shadow inside its shape (walls: true leaves out the wall lines there too, for a cave mouth or a ledge).
Exports can be cropped: export with crop [x, y, w, h] or around [ids] (plus margin, default 1 square), e.g. rooms 4 and 11 only.
Fog of war (fog): reveal rooms and corridors by id as the players explore; with fog on, the players' view shows only what's revealed.
Wall roughness: set_map roughness 1 (smooth) to 10 (caves); rooms, corridors and cutouts can have their own (update {"roughness": 9}). Rows of props (trees along a road): add_props_along.
Background colour: set_map background "#1A2540" (night blue, forest green #2F4A33, slate #4A525C…) changes the colour around and between the rooms; "reset" goes back to the style's own. Hatching too dark to see on it is drawn in a lighter ink.
Heights within one map: add_height raises or sinks the ground under a shape (height in the map's units: +10 a ledge, -10 a sunken arena), over rooms or outdoors over terrain; cliff and rock-face edges are crossed only where stairs or a ladder lie across them, slopes and steps are walked over; profile hill rounds an area into a natural hill or ridge, plateau keeps it flat (the default unless the edge is a slope). describe_map lists the heights and how each is reached.
GM markers (add_marker): a clickable note for the GM, "discover" (?), "interact" (!) or "trap" (skull); GM view only, and update {"done": true} strikes one through.
Handout notes (add_inscription): handwritten text on the players' parchment handout ("Here be dragons"), in an old italic hand and a brown, black, faded or red ink; on_map writes it on the normal map too. Players see them; update and delete change them like any object.
GM notes: rooms, corridors and terrain carry notes (a description, monsters, loot) for the GM: add_room notes, or update {"notes": "..."} on any of them. They are never drawn or exported; the GM reads them in the editor and on Delve Table, and describe_map lists them.
Segments: save_segment saves part of a map under a name (rooms 1–5 as "Temple of Efferd", a patch of trees and grass as "Mixed forest"); place_segment adds a renumbered copy anywhere, turned if asked; fill_with_segment tiles one over the land around the rooms, keeping the floor clear. list_segments shows what is saved.
The user's own pictures (uploaded in the editor): list_images gives their src, and add_image places one by src (a table in the middle of room 3, a rug, a mosaic on the floor).
New props: when the GM wants a prop the catalog doesn't have, draw it: prop_rules (how), then create_prop (an SVG in Delve's ink style; it returns a preview picture to check), update_prop to fix it. Custom props (ids my-…) are shared by every GM on this Delve and work like built-in ones.`;

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

/** One catalog line for Claude: id, name, footprint, what it blocks; for colour props also where they lie and their group. */
export function assetLine(a: AssetInfo): string {
  if (a.kind === 'terrain') return `${a.id} — ${a.name} (terrain${a.palette === 'colour' ? `, colour texture ${a.w}×${a.h}${a.group ? `, group ${a.group}` : ''}` : ''}${a.difficult ? ', difficult' : ''})`;
  const blocks = a.blocks === 'none' ? 'walk over' : a.blocks === 'movement' ? 'blocks movement' : 'blocks sight';
  const colour = a.palette === 'colour' ? `, colour${a.layer === 'floor' ? ', on the floor' : ''}${a.group ? `, group ${a.group}` : ''}${a.modular ? ', modular' : ''}` : '';
  return `${a.id} — ${a.name}, ${a.w}×${a.h}, ${blocks}, ${a.category}${colour}${a.hidden ? ', hidden from players' : ''}${a.custom ? ', custom (drawn for this Delve)' : ''}`;
}

/** The colour props in a few lines: each category with its count and first ids, for when they aren't listed one by one. */
export function colourSummary(): string {
  return COLOUR_CATEGORIES.map((c) => {
    const items = COLOUR_ASSETS.filter((a) => a.category === c.id);
    const tex = items.filter((a) => a.kind === 'terrain').length;
    const count = tex === items.length ? `${tex} terrain textures` : tex ? `${items.length - tex} props, ${tex} terrain textures` : String(items.length);
    return `- ${c.name} (${c.id}, ${count}): ${items.slice(0, 4).map((a) => a.id).join(', ')}${items.length > 4 ? ', …' : ''}`;
  }).join('\n');
}

/** The ids of the props a list of ops adds (batches included). */
function addedProps(ops: readonly Op[]): string[] {
  return ops.flatMap((o) => (o.op === 'batch' ? addedProps(o.ops) : o.op === 'add' && o.object.type === 'prop' ? [o.object.id] : []));
}

/** The ids of the objects of these types a list of ops adds (batches included). */
function addedIds(ops: readonly Op[], types: readonly MapObject['type'][]): string[] {
  return ops.flatMap((o) => (o.op === 'batch' ? addedIds(o.ops, types) : o.op === 'add' && types.includes(o.object.type) ? [o.object.id] : []));
}

/** At most this many lines from list_assets; narrower filters list the rest. */
const LIST_MAX = 200;

function where(shape: Shape): string {
  const b = shapeBounds(shape);
  return `${b.x1 - b.x0}×${b.y1 - b.y0} squares at ${b.x0},${b.y0}`;
}

/**
 * connect's ops, with a route that keeps out of the rooms it doesn't join: when
 * the usual route (straight, L or Z between the two rooms) runs through another
 * room, the corridor gets a path round them (core routeAround) and its doors
 * move to that path's mouths. `note` says so, or warns when there is no way round.
 */
export function connectAvoiding(map: Parameters<typeof connectOps>[0], from: string, to: string, opts: ConnectOptions): ConnectPlan & { note: string } {
  const plan = connectOps(map, from, to, opts);
  const width = plan.corridor.width;
  const hits = corridorThrough(map, plan.path, width, [from, to]);
  if (!hits.length) return { ...plan, note: '' };
  const alt = routeAround(map, from, to, width);
  if (!alt) return { ...plan, note: ` Warning: it runs through ${hits.join(', ')} and there is no clear way round; move a room, or give the corridor a path by hand (apply_ops).` };
  const corridor = { ...plan.corridor, path: alt };
  const ops: Op[] = [{ op: 'add', object: corridor }];
  const ends = opts.doors === 'both' ? (['start', 'end'] as const) : opts.doors === 'from' ? (['start'] as const) : opts.doors === 'to' ? (['end'] as const) : [];
  ends.forEach((end, i) => ops.push({ op: 'add', object: { id: plan.doorIds[i]!, type: 'door', ...doorAtEnd(alt, end, width), width, style: opts.doorStyle ?? 'normal' } }));
  return {
    ops,
    corridor,
    path: alt,
    doorIds: plan.doorIds,
    note: ` The direct route ran through ${hits.join(', ')}, so it goes round them instead; it keeps this path (it won't follow if the rooms move; reroute makes it follow them again).`,
  };
}

const pathLen = (path: readonly Point[]) => Math.round(path.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]), 0) * 100) / 100;

export function buildMcpServer(service: MapService, base: string, version: string, images?: ImageLibrary, props?: PropLibrary): McpServer {
  const server = new McpServer({ name: 'delve', title: 'Delve map editor', version }, { instructions: INSTRUCTIONS });
  const { store } = service;
  const viewer = (id: string) => `${base}/maps/${encodeURIComponent(id)}`;
  const change = (id: string, ops: Op[], summary: string, baseRev?: number) => {
    const c = service.apply(id, ops, { by: BY, baseRev });
    return text(`${summary} Map is at rev ${c.rev}.`);
  };
  const addObject = (id: string, object: MapObject, summary: string) => change(id, [{ op: 'add', object }], summary);
  /** A change whose reply ends with a short check of the objects it made (core checkObjects). */
  const changeChecked = (id: string, ops: Op[], summary: string, ids: readonly string[]) => {
    const c = service.apply(id, ops, { by: BY });
    const check = ids.length ? checkObjects(c.map, ids) : '';
    return text(`${summary} Map is at rev ${c.rev}.${check ? `\n${check}` : ''}`);
  };
  const addChecked = (id: string, object: MapObject, summary: string) => changeChecked(id, [{ op: 'add', object }], summary, [object.id]);

  server.registerTool(
    'list_maps',
    { title: 'List maps', description: 'All saved maps, newest first, with ids and viewer links.', inputSchema: {}, annotations: { readOnlyHint: true } },
    () =>
      guarded(() => {
        const maps = store.list();
        if (!maps.length) return text('No maps yet. Use create_map.');
        const storey = (m: (typeof maps)[number]) => (m.level ? ` · storey "${m.level.name}" (order ${m.level.order}) of group ${m.level.group}` : '');
        return text(maps.map((m) => `${m.id} · "${m.name}"${storey(m)}${m.category ? ` · category "${m.category}"` : ''} · rev ${m.rev} · ${m.objects} objects · updated ${m.updated} · ${viewer(m.id)}`).join('\n'));
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
        unit: z.string().max(20).optional().describe('What one square stands for, in feet or metres: "5 ft" (default), "10 ft", "1.5 m", "2 m"…'),
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
      description: 'Plain-text summary: which way is north, rooms with sizes and where each lies ("north-west part of the map"), corridors, doors, cutouts. Cheaper than get_map.',
      inputSchema: { map: mapId },
      annotations: { readOnlyHint: true },
    },
    (a) => guarded(() => {
      const { rev, map } = store.get(a.map);
      return text(`${describeMap(map, { where: true })}\n(rev ${rev})`);
    }),
  );

  server.registerTool(
    'add_room',
    {
      title: 'Add room',
      description:
        'Add a room. Give exactly one shape: rect, poly, circle, or preset (an oval, triangle, hexagon or octagon filling a box). The label (room number) defaults to the next free number; pass "" for none. ' +
        'Or place it by meaning: beside (a room id) with side (north, south, east or west; north is up) and size [width, height]: it goes on that side, gap squares away (default 2), lined up with that room and clear of every other room and corridor; ' +
        'connect true joins the two with a corridor, and door (a door style) puts a door where it enters the new room. The reply ends with a check (overlaps, rooms touching).',
      inputSchema: {
        map: mapId,
        ...shapeArgs,
        preset: presetArg,
        beside: z.string().max(64).optional().describe('Instead of a shape: put the new room beside this room, e.g. "r2" (with side and size)'),
        side: z.string().max(20).optional().describe('With beside: north, south, east or west of it (north is up, small y)'),
        size: z.tuple([lengthArg('Width'), lengthArg('Height')]).optional().describe('With beside: [width, height] of the new room in squares (default [6, 6]); units like "30 ft" work too'),
        gap: lengthArg('With beside: squares between the two rooms (default 2)').optional(),
        connect: z.boolean().optional().describe('With beside: join the new room to that room with a corridor (2 wide)'),
        door: z.enum(DOOR_STYLES).optional().describe('With connect: a door of this style where the corridor enters the new room'),
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
        const notes: string[] = [];
        let placedText = '';
        let shape: Shape;
        if (a.beside !== undefined) {
          if (a.rect || a.poly || a.circle || a.preset) throw new ValidationError(['give a shape (rect, poly, circle, preset) or beside, not both']);
          const side = sideOf(a.side ?? '');
          if (!side) throw new ValidationError([`side: north, south, east or west of ${a.beside}, got ${JSON.stringify(a.side ?? null)}`]);
          const w = a.size ? halfSquares(squaresArg(map, a.size[0], 'size', notes, { min: 0.5 })!) : 6;
          const h = a.size ? halfSquares(squaresArg(map, a.size[1], 'size', notes, { min: 0.5 })!) : 6;
          const gap = a.gap !== undefined ? Math.max(0, Math.round(squaresArg(map, a.gap, 'gap', notes)! * 2) / 2) : 2;
          const spot = besideRect(map, { beside: a.beside, side, w, h, gap, corridorWidth: a.connect ? 2 : 0 });
          shape = { rect: spot.rect };
          placedText = ` It lies ${spot.text}.`;
        } else {
          if (a.connect || a.door) throw new ValidationError(['connect and door go with beside; to join two rooms that already exist use connect']);
          shape = shapeOrPreset(a);
        }
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
        const head = `Added room ${room.id}${a.name ? ` "${a.name}"` : ''}${label ? ` (label ${label})` : ''}: ${where(shape)}.${placedText}`;
        if (a.beside === undefined || !a.connect) return changeChecked(a.map, [{ op: 'add', object: room }], `${head}${notesText(notes)}`, [room.id]);
        // joined to the room it stands beside, with a door into the new one if asked
        const withRoom = { ...map, objects: [...map.objects, room] };
        const plan = connectAvoiding(withRoom, a.beside, room.id, { doors: a.door ? 'to' : 'none', doorStyle: a.door });
        const joined = ` Joined to ${a.beside} by corridor ${plan.corridor.id} (${plan.corridor.width} wide, ${pathLen(plan.path)} squares long)${plan.doorIds.length ? ` with a ${a.door} door ${plan.doorIds[0]} where it enters ${room.id}` : ''}.${plan.note}`;
        return changeChecked(a.map, [{ op: 'add', object: room }, ...plan.ops], `${head}${joined}${notesText(notes)}`, [room.id, plan.corridor.id, ...plan.doorIds]);
      }),
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect rooms',
      description:
        'Add a corridor between two rooms. It is routed automatically (straight, L or Z, meeting hexagons, circles and other shapes at their real outlines) and re-routes when a room moves. ' +
        'If that route would run through another room, it goes round the rooms instead (and then keeps that path). ' +
        'doors puts doors across the corridor mouths at its current ends (doors stay put if rooms move later). The reply ends with a check.',
      inputSchema: {
        map: mapId,
        from: z.string().describe('Room id'),
        to: z.string().describe('Room id'),
        width: lengthArg('Corridor width (default 2 squares)').optional(),
        doors: z.enum(['none', 'from', 'to', 'both']).optional().describe('default none'),
        door_style: z.enum(DOOR_STYLES).optional(),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const notes: string[] = [];
        const width = a.width !== undefined ? halfSquares(squaresArg(map, a.width, 'width', notes, { min: 0.5 })!) : undefined;
        const { ops, corridor, path, doorIds, note } = connectAvoiding(map, a.from, a.to, {
          width,
          doors: a.doors,
          doorStyle: a.door_style,
          id: a.id,
        });
        return changeChecked(
          a.map,
          ops,
          `Added corridor ${corridor.id} from ${a.from} to ${a.to}: ${corridor.width} wide, ${pathLen(path)} squares long, path ${JSON.stringify(path)}${doorIds.length ? `; doors ${doorIds.join(', ')}` : ''}.${note}${notesText(notes)}`,
          [corridor.id, ...doorIds],
        );
      }),
  );

  server.registerTool(
    'add_cutout',
    {
      title: 'Add cutout',
      description:
        'Remove floor inside a room: pillars, pits, collapsed sections. Give exactly one shape (rect, poly, circle or preset). ' +
        'fill "solid" draws it filled with the wall colour (solid pillars, thick wall blocks, standing stones); the default "rock" shows what lies around the dungeon.',
      inputSchema: {
        map: mapId,
        ...shapeArgs,
        preset: presetArg,
        fill: z.enum(CUTOUT_FILLS).optional().describe('solid or rock (default)'),
        name: z.string().max(200).optional().describe('e.g. "Pillar"'),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = shapeOrPreset(a);
        const id = a.id ?? nextId(map, 'p');
        const fill = a.fill === 'solid' ? { fill: 'solid' as const } : {};
        return addObject(a.map, { id, type: 'cutout', shape, ...fill, ...(a.name ? { name: a.name } : {}) }, `Added ${a.fill === 'solid' ? 'solid ' : ''}cutout ${id}: ${where(shape)}.`);
      }),
  );

  server.registerTool(
    'add_opening',
    {
      title: 'Add open area',
      description:
        'Mark an area where the map stays open: inside the shape there is no hatching, no shading and no drop shadow outside the walls, so an edge reads as a way out instead of solid rock ' +
        '(e.g. no hatching at the top of a corridor that leads out of the dungeon: a rect over its end, reaching a square or two outwards). ' +
        'walls true also leaves out the wall lines inside the shape: a cave mouth, a ledge that drops away, a room edge that is simply open. ' +
        'It shows in both views and is never drawn itself. Give exactly one shape (rect, poly, circle or preset); update {"walls": true} or delete changes it later. ' +
        'An archway on the outer edge already gets an open end by itself.',
      inputSchema: {
        map: mapId,
        ...shapeArgs,
        preset: presetArg,
        walls: z.boolean().optional().describe('Also leave out the wall lines inside the shape (default false: only the hatching and shading go)'),
        name: z.string().max(200).optional().describe('e.g. "Cave mouth"'),
        id: z.string().optional().describe('Defaults to the next o<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = shapeOrPreset(a);
        const id = a.id ?? nextId(map, 'o');
        const opening: MapObject = { id, type: 'opening', shape, ...(a.walls ? { walls: true } : {}), ...(a.name ? { name: a.name } : {}) };
        return addObject(a.map, opening, `Added open area ${id}: ${where(shape)}, no hatching or shading inside${a.walls ? ', and no walls' : ''}.`);
      }),
  );

  server.registerTool(
    'add_door',
    {
      title: 'Add door',
      description:
        'Add a door along a wall or across an opening. Doors can sit in walls at any angle. at is the door\'s start point; along says which way it runs ("x" = horizontal, "y" = vertical), ' +
        'or angle turns it any way, in degrees clockwise from east (0 = along x, 90 = along y, 45 runs down to the right, 135 down to the left): for slanted walls (octagons, hexagons, polygons) and curved ones (circles, caves). ' +
        'Easiest in such walls: give near (a spot on or by the wall) instead of at, and the door goes on the nearest wall within a square, centred on the wall line and turned to the wall there. ' +
        'Easiest of all: room (a room id) and wall (north, south, east or west): the door goes in the middle of that wall, or on the free stretch of it nearest the middle. The reply ends with a check (is it on a wall, where it leads).',
      inputSchema: {
        map: mapId,
        room: z.string().max(64).optional().describe('With wall: the room whose wall gets the door, e.g. "r3"'),
        wall: z.string().max(20).optional().describe('With room: north, south, east or west (north is up, small y)'),
        at: point.optional().describe('The door\'s start point, [x, y] in squares (or give near, or room and wall)'),
        near: point.optional().describe('Instead of at: a spot on or by a wall; the door is centred on the nearest wall there and turned to match it'),
        along: z.enum(['x', 'y']).optional().describe('"x" = horizontal (default), "y" = vertical'),
        angle: z.number().gt(-3600).lt(3600).optional().describe('Degrees clockwise from east; turns the door any way (wins over along)'),
        width: lengthArg('Length of the door (default 1 square; 2 for a wide or double door)').optional(),
        style: z.enum(DOOR_STYLES).optional().describe('default normal'),
        open: z.boolean().optional(),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'd');
        const notes: string[] = [];
        let width = a.width !== undefined ? squaresArg(map, a.width, 'width', notes, { min: 0.1 })! : 1;
        let line: Pick<Door, 'at' | 'along' | 'angle'>;
        let where = '';
        if (a.room !== undefined || a.wall !== undefined) {
          if (a.at || a.near) throw new ValidationError(['give room and wall, or at, or near: one of them']);
          if (a.room === undefined) throw new ValidationError(['room: which room\'s wall, e.g. "r3"']);
          const side = sideOf(a.wall ?? '');
          if (!side) throw new ValidationError([`wall: north, south, east or west, got ${JSON.stringify(a.wall ?? null)}`]);
          const placed = doorOnRoomWall(map, a.room, side, halfSquares(width));
          line = placed.line;
          width = placed.width;
          where = ` ${placed.text},`;
        } else if (a.near) {
          const floor = computeFloor(map);
          const ends = doorOnWall(floor, a.near, width);
          if (!ends) throw new ValidationError([`near: no wall within a square of [${a.near.join(', ')}]; give at with along or angle instead`]);
          line = placeDoorBetween(floor, ends[0], ends[1]);
          where = ' on the wall';
        } else if (a.at) {
          line = a.angle !== undefined ? { at: a.at, along: nearestAxis(a.angle), angle: a.angle } : { at: a.at, along: a.along ?? 'x' };
        } else throw new ValidationError(['give room and wall (e.g. {"room": "r3", "wall": "east"}), at (the door\'s start point) or near (a spot by a wall)']);
        const door: Door = { id, type: 'door', ...line, width, style: a.style ?? 'normal', ...(a.open ? { open: true } : {}) };
        const runs = isTurned(door) ? `turned ${Math.round(doorAngle(door) * 100) / 100}°` : `along ${door.along}`;
        return addChecked(a.map, door, `Added ${a.style ?? 'normal'} door ${id}${where} at ${door.at.join(',')} ${runs}, ${width} wide.${notesText(notes)}`);
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
      description: 'Free text on the map (shown in both views), centred on at, or in the middle of a region (e.g. {"edge": "north"} or {"in": "r3"}).',
      inputSchema: {
        map: mapId,
        text: z.string().min(1).max(200),
        at: point.optional().describe('The middle of the text [x, y] (or give region)'),
        region: regionArg.optional(),
        size: lengthArg('Text height (about 0.6 squares by default)').optional(),
        id: z.string().optional(),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'l');
        const notes: string[] = [];
        if (a.at && a.region) throw new ValidationError(['give at or region, not both']);
        if (!a.at && !a.region) throw new ValidationError(['give at [x, y] or a region, e.g. {"in": "r3"}']);
        const region = a.region ? regionOf(map, a.region) : null;
        const at = region ? regionCentre(region) : a.at!;
        const size = squaresArg(map, a.size, 'size', notes, { min: 0.05 });
        return addChecked(a.map, { id, type: 'label', text: a.text, at, ...(size ? { size } : {}) }, `Added label ${id} "${a.text}"${region ? ` at [${at.join(', ')}], the middle of ${region.text}` : ''}.${notesText(notes)}`);
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

  // Handwritten notes on the players' parchment handout (core inscriptions.ts).
  server.registerTool(
    'add_inscription',
    {
      title: 'Add handout note',
      description:
        "Write a note by hand on the players' parchment handout (/maps/<id>/handout), in IM FELL English Italic: \"Here be dragons\" at the edge of the map, \"Beware!\" over the crypt door, a rhyme in the margin. " +
        'The text is centred on at; line breaks (\\n) start new lines. Only on the handout unless on_map, which also writes it on the normal map renders. Players see it, whatever the fog. ' +
        'update (e.g. {"text": "...", "ink": "red", "onMap": true}) and delete change it later.',
      inputSchema: {
        map: mapId,
        text: z.string().min(1).max(INSCRIPTION_MAX).describe(`Up to ${INSCRIPTION_MAX} characters; \\n for a new line`),
        at: point.describe('The middle of the text [x, y] in squares; it may lie outside the rooms, in the margin of the sheet'),
        size: z.number().positive().max(20).optional().describe(`Text height in squares (default ${INSCRIPTION_SIZE})`),
        rotation: z.number().min(-180).max(180).optional().describe('Tilt in degrees clockwise; a few degrees (-5 to 5) looks hand-made'),
        ink: z.enum(INSCRIPTION_INKS).optional().describe('brown (default), black, faded or red'),
        on_map: z.boolean().optional().describe('Also write it on the normal map (both views); default false: the handout only'),
        id: z.string().optional().describe('Defaults to the next w<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const id = a.id ?? nextId(map, 'w');
        const note: MapObject = {
          id,
          type: 'inscription',
          text: a.text.replace(/\r\n?/g, '\n'),
          at: a.at,
          ...(a.size !== undefined ? { size: a.size } : {}),
          ...(a.rotation ? { rotation: a.rotation } : {}),
          ...(a.ink && a.ink !== 'brown' ? { ink: a.ink } : {}),
          ...(a.on_map ? { onMap: true } : {}),
        };
        const first = a.text.split('\n')[0]!.slice(0, 60);
        return addObject(a.map, note, `Added handout note ${id} "${first}${first.length < a.text.length ? '…' : ''}" at [${a.at.join(', ')}]${a.on_map ? ', also on the map' : ''}. See it on ${base}/maps/${encodeURIComponent(a.map)}/handout.`);
      }),
  );

  server.registerTool(
    'list_assets',
    {
      title: 'List props and terrain',
      description:
        'The props (furniture, statues, trees, GM symbols…) and terrain tiles you can place, with ids, footprints and what they block, including the custom props drawn for this Delve (ids my-…). ' +
        'Without filters: the ink props and terrain, plus a summary of the colour props (ids c-…, in the Delve palette); list those by palette "colour" with a category or search.',
      inputSchema: {
        category: z.string().optional().describe(`One of ${CATEGORIES.map((c) => c.id).join(', ')}; colour props: ${COLOUR_CATEGORIES.map((c) => c.id).join(', ')}; or custom (every custom prop)`),
        palette: z.enum(['ink', 'colour', 'all']).optional().describe('ink (black-and-white props, the default without category or search), colour (colour props, ids c-…) or all'),
        search: z.string().optional().describe('Words to match in names, tags and groups, e.g. "bed", "water" or "oak"'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guarded(() => {
        const words = (a.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const palette = a.palette ?? (a.category || words.length ? 'all' : 'ink');
        const hits = allAssets().filter(
          (x) =>
            (palette === 'all' || (palette === 'colour') === (x.palette === 'colour')) &&
            (!a.category || x.category === a.category || (a.category === 'custom' && x.custom)) &&
            words.every((w) => x.id.includes(w) || x.name.toLowerCase().includes(w) || x.tags.some((t) => t.includes(w)) || Boolean(x.group?.includes(w))),
        );
        const colourHint = `Colour props and terrain textures (palette "colour", ids c-…; floor props lie under other props, groups mix with add_props_along, textures go in add_terrain):\n${colourSummary()}\nList one category with list_assets palette "colour" and category, or search.`;
        // the colour props on their own, unfiltered: by category, not one by one
        if (palette === 'colour' && !a.category && !words.length) return text(colourHint);
        if (!hits.length) return text('Nothing matches. Try another word, or no filter at all.');
        const lines = hits.slice(0, LIST_MAX).map(assetLine);
        if (hits.length > LIST_MAX) lines.push(`… and ${hits.length - LIST_MAX} more: narrow it with category, palette or search.`);
        if (!a.palette && !a.category && !words.length) lines.push('', colourHint);
        return text(lines.join('\n'));
      }),
  );

  server.registerTool(
    'add_prop',
    {
      title: 'Add prop',
      description:
        'Place a prop (see list_assets). at is the centre of its footprint: a 1×1 prop in the square at x 3–4, y 5–6 has at [3.5, 5.5]; a 2×1 prop covering x 3–5 has at [4, 5.5]. ' +
        'At rotation 0 a prop faces south (its back or wall side is north); rotation turns it clockwise in degrees (90, 180, 270). ' +
        'A tree, or a prop that blocks movement or sight, placed on a tree, boulder, wall or other blocking prop is still added, but the reply names what it overlaps and the nearest free spot; avoid true puts it there instead. ' +
        'Easier: place it by meaning instead of at: in (a room id) and place ("center", "north wall", "ne corner", "near i3", "around i1"…): the tool finds a free spot inside the room, against the wall and turned to face into the room for walls, ' +
        'off other props and out of doorways, and says where it put it; count adds several (4 chairs around a table). The reply ends with a check (inside the room? overlaps? doorways?).',
      inputSchema: {
        map: mapId,
        asset: z.string().describe('Asset id, e.g. "chest-closed"'),
        at: point.optional().describe('Centre of the footprint [x, y] in squares (or give in and place)'),
        in: z.string().max(64).optional().describe('Place it by meaning in this room or area, e.g. "r2" (with place; default "center")'),
        place: placeArg.optional(),
        count: z.number().int().min(1).max(50).optional().describe('With place: how many (default 1; for "around": 4)'),
        rotation: z.number().optional().describe('Degrees clockwise: 0 (faces south), 90 (faces west), 180 (north), 270 (east). With place: leave it out to face into the room'),
        scale: z.number().positive().max(4).optional(),
        name: z.string().max(200).optional(),
        notes: z.string().max(10_000).optional().describe('GM notes, e.g. what is inside a chest'),
        hidden: z
          .boolean()
          .optional()
          .describe('Hidden from players (GM view only), e.g. a trap they have not found. Default: pressure plates, spike traps, floor runes and the colour props marked hidden (hidden traps) are hidden, everything else is shown; false shows a hidden trap'),
        avoid: z
          .boolean()
          .optional()
          .describe('If it would stand on a tree, boulder, wall or other prop that blocks movement or sight, put it at the nearest free spot instead (within 6 squares). Default false: placed where asked, and the reply names what it overlaps'),
        id: z.string().optional().describe('Defaults to the next i<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${a.asset}" is not a prop (use list_assets; terrain goes in add_terrain)`]);
        const map = store.get(a.map).map;
        const extras = {
          ...(a.scale && a.scale !== 1 ? { scale: a.scale } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.hidden !== undefined ? { gmOnly: a.hidden } : {}),
        };
        if (a.in !== undefined || a.place !== undefined || a.count !== undefined) {
          // by meaning: the code finds the spot
          if (a.at) throw new ValidationError(['give at, or in and place: not both']);
          const r = placeProps(map, { asset: a.asset, in: a.in, place: a.place, count: a.count, rotation: a.rotation, scale: a.scale });
          if (!r.placed.length) throw new ValidationError(r.notes.length ? r.notes : ['no free spot there']);
          const ops: Op[] = r.placed.map((p, k) => ({
            op: 'add',
            object: { id: k === 0 && a.id ? a.id : nextId(map, 'i', k), type: 'prop', asset: p.asset, at: p.at, ...(p.rotation ? { rotation: p.rotation } : {}), ...extras },
          }));
          const ids = ops.map((o) => (o as { object: MapObject }).object.id);
          const lines = r.placed.map((p, k) => {
            const b = propBounds({ asset: p.asset, at: p.at, rotation: p.rotation, scale: a.scale });
            return `${ids[k]} at [${p.at.join(', ')}]${p.rotation ? ` turned ${p.rotation}°` : ''} ${p.where} (covers x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1})`;
          });
          const head = r.placed.length === 1 ? `Added ${info.name} ${lines[0]}.` : `Added ${r.placed.length} × ${info.name}: ${lines.join('; ')}.`;
          return changeChecked(a.map, ops, `${head}${r.notes.length ? ` ${r.notes.join(' ')}` : ''}`, ids);
        }
        if (!a.at) throw new ValidationError(['give at [x, y], or in (a room id) and place (e.g. "north wall", "center", "around i1")']);
        const id = a.id ?? nextId(map, 'i');
        // modular pieces (ruin walls, seamless textures) go onto whole squares, so they meet the next piece
        const snappedAt = modularAt({ asset: a.asset, at: a.at, rotation: a.rotation, scale: a.scale });
        // standing on a tree, boulder or wall: said in the reply with the nearest free spot, or moved there with avoid
        const asked = { id, asset: a.asset, at: snappedAt, rotation: a.rotation, scale: a.scale };
        const on = blockingProps(map.objects, asked);
        const free = on.length ? freeSpot(map.objects, asked) : null;
        const at = a.avoid && free ? free : snappedAt;
        const names = on.map((o) => `${o.id} (${assetInfo(o.asset)?.name ?? o.asset})`).join(', ');
        const overlapNote = !on.length
          ? ''
          : a.avoid && free
          ? ` Moved to [${free.join(', ')}], the nearest free spot: at [${snappedAt.join(', ')}] it would overlap ${names}.`
          : ` Warning: it overlaps ${names}, so they are drawn over each other. ${free ? `The nearest free spot is [${free.join(', ')}]: move it there, or add it with avoid true.` : 'There is no free spot within 6 squares.'}`;
        const prop: MapObject = {
          id,
          type: 'prop',
          asset: a.asset,
          at,
          ...(a.rotation ? { rotation: a.rotation } : {}),
          ...(a.scale && a.scale !== 1 ? { scale: a.scale } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.hidden !== undefined ? { gmOnly: a.hidden } : {}),
        };
        const b = propBounds(prop);
        const hidden = propHidden(prop as { asset: string; gmOnly?: boolean }) ? ' It is hidden from players (GM view only).' : '';
        const snapped = snappedAt[0] !== a.at[0] || snappedAt[1] !== a.at[1] ? ` Moved onto whole squares (at [${snappedAt.join(', ')}]) so it meets the next piece.` : '';
        return addChecked(a.map, prop, `Added ${info.name} ${prop.id}, covering x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1}.${hidden}${snapped}${overlapNote}`);
      }),
  );

  server.registerTool(
    'add_props_along',
    {
      title: 'Add props along a path',
      description:
        'Place copies of one prop along a path, like painting with a brush: trees along a road, rocks along a cave wall, pillars down a hall. ' +
        'placement "regular" puts one exactly every `spacing` squares (the first at the path\'s start); "irregular" varies the gaps, strays up to `spread` squares to either side, and turns and sizes each copy a little. ' +
        'A colour prop with a group (oaks, pines, boulders…) mixes the group\'s variants at random unless mix is false, so a forest is not one tree repeated. ' +
        'Spots within 0.6 × spacing of the same prop (or its group) already on the map are skipped, and so are spots where a copy would stand on a tree, boulder, wall or other blocking prop, or on an earlier copy (footprints may touch, overlapping up to a quarter square; props you walk over, like ferns and rugs, go anywhere); the reply says how many. overlap true allows that, for a dense thicket. One undo step. ' +
        'Instead of a path, give a region to fill it: rows of copies over the whole area, spacing apart (default: the prop\'s size, or its group\'s on average; placement irregular nudges, turns and sizes each a little):{"edge": "north", "depth": 4} a forest along the north edge, {"in": "r3"} rubble all over room 3, {"around": "r2"} trees round a house. ' +
        'Copies keep their middle inside the region; in a room (in) they stay on its floor and out of the doorways, elsewhere they keep off rooms and corridors.',
      inputSchema: {
        map: mapId,
        asset: z.string().describe('Prop id, e.g. "tree" or "c-oak-a" (see list_assets)'),
        path: z.array(point).min(1).max(200).optional().describe('Points the brush passes through, [[x, y], ...] (or give region)'),
        region: regionArg.optional(),
        spacing: lengthArg('Squares between copies (default 3; filling a region: the prop\'s size)').optional(),
        placement: z.enum(['regular', 'irregular']).optional().describe('default regular (filling a region: irregular)'),
        spread: lengthArg('Irregular: how far copies stray to the sides (default a third of the spacing)').optional(),
        rotation: z.number().optional().describe('Regular: the rotation of every copy'),
        mix: z.boolean().optional().describe("Mix the variants of the prop's group (default true when it has one, see list_assets)"),
        overlap: z.boolean().optional().describe('true: copies may stand on blocking props and on each other (a dense thicket). Default false: those spots are skipped'),
        seed: z.number().int().min(1).optional().describe('The same seed, path and map give the same copies (default random)'),
      },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${a.asset}" is not a prop (use list_assets)`]);
        const map = store.get(a.map).map;
        const notes: string[] = [];
        const spacingSq = squaresArg(map, a.spacing, 'spacing', notes, { min: 0.5 });
        const spreadSq = squaresArg(map, a.spread, 'spread', notes, { min: 0 });
        if (spacingSq !== undefined && spacingSq > 20) throw new ValidationError(['spacing: at most 20 squares']);
        if (a.region) {
          if (a.path) throw new ValidationError(['give a path or a region, not both']);
          const region = regionOf(map, a.region);
          const fill = fillRegion(map, region, {
            asset: a.asset,
            ...(spacingSq !== undefined ? { spacing: spacingSq } : {}),
            placement: a.placement ?? 'irregular',
            ...(spreadSq !== undefined ? { spread: spreadSq } : {}),
            ...(a.rotation ? { rotation: a.rotation } : {}),
            seed: a.seed ?? randomInt(1, 2 ** 31),
            ...(a.mix === false ? { mix: false } : {}),
            ...(a.overlap ? { overlap: true } : {}),
          });
          const copies = fill.copies.slice(0, 500);
          const s = fill.skipped;
          const left = [
            s.blocked ? `${s.blocked} on trees, boulders, walls or other copies` : '',
            s.floor ? `${s.floor} on rooms or corridors (outdoor things keep off them; region in puts them inside a room)` : '',
            s.outside ? `${s.outside} outside the room or in its doorways` : '',
          ].filter(Boolean);
          const skippedNote = left.length ? ` Spots skipped: ${left.join(', ')}.` : '';
          if (!copies.length) return text(`Nothing placed in ${region.text}.${skippedNote || ' The region is too small for this prop.'}${notesText([...notes, ...region.notes])}`);
          const ops = copies.map((c, k) => ({
            op: 'add' as const,
            object: { id: nextId(map, 'i', k), type: 'prop' as const, asset: c.asset, at: c.at, ...(c.rotation ? { rotation: c.rotation } : {}), ...(c.scale !== 1 ? { scale: c.scale } : {}) },
          }));
          const used = [...new Set(ops.map((o) => o.object.asset))];
          const what = used.length > 1 ? `props of group ${info.group} (${used.map((u) => assetInfo(u)?.name ?? u).join('; ')})` : info.name;
          return changeChecked(
            a.map,
            ops,
            `Added ${copies.length} × ${what} (${ops[0]!.object.id}–${ops.at(-1)!.object.id}) filling ${region.text}, rows ${fill.spacing} squares apart.${skippedNote}${notesText([...notes, ...region.notes])}`,
            ops.map((o) => o.object.id),
          );
        }
        if (!a.path) throw new ValidationError(['give a path [[x, y], ...] or a region, e.g. {"edge": "north"}']);
        const variants = a.mix === false ? [a.asset] : groupVariants(a.asset);
        const kin = new Set(variants);
        const avoid = map.objects.flatMap((o) => (o.type === 'prop' && kin.has(o.asset) ? [o.at] : []));
        const spots = scatterAlong(a.path, {
          spacing: spacingSq ?? 3,
          placement: a.placement ?? 'regular',
          ...(spreadSq !== undefined ? { spread: spreadSq } : {}),
          ...(a.rotation ? { rotation: a.rotation } : {}),
          seed: a.seed ?? randomInt(1, 2 ** 31),
          avoid,
          ...(variants.length > 1 ? { variants } : {}),
        });
        const placed = spots.map((s) => {
          const asset = s.asset ?? a.asset;
          return { asset, at: modularAt({ asset, at: s.at, rotation: s.rotation, scale: s.scale }), rotation: s.rotation, scale: s.scale };
        });
        // copies that would stand on a tree, boulder or wall (or on an earlier copy) are skipped unless overlap is asked for
        const { kept, skipped } = a.overlap ? { kept: placed, skipped: 0 } : keepClear(map.objects, placed);
        const copies = kept.slice(0, 500);
        const skippedNote = skipped ? `${skipped} spot${skipped === 1 ? ' was' : 's were'} skipped where a copy would have stood on a tree, boulder, wall or other blocking prop, or on another copy (overlap true allows that).` : '';
        if (!copies.length) return text(spots.length ? `Nothing placed: ${skippedNote}` : 'Nothing placed: every spot along the path already has one nearby.');
        const ops = copies.map((s, k) => ({
          op: 'add' as const,
          object: { id: nextId(map, 'i', k), type: 'prop' as const, asset: s.asset, at: s.at, ...(s.rotation ? { rotation: s.rotation } : {}), ...(s.scale !== 1 ? { scale: s.scale } : {}) },
        }));
        const used = [...new Set(ops.map((o) => o.object.asset))];
        const what = used.length > 1 ? `props of group ${info.group} (${used.map((u) => assetInfo(u)?.name ?? u).join('; ')})` : info.name;
        return changeChecked(
          a.map,
          ops,
          `Added ${copies.length} × ${what} (${ops[0]!.object.id}–${ops.at(-1)!.object.id}) along the path.${skippedNote ? ` ${skippedNote}` : ''}${notesText(notes)}`,
          ops.map((o) => o.object.id),
        );
      }),
  );

  server.registerTool(
    'add_terrain',
    {
      title: 'Add terrain',
      description:
        'Fill an area with a terrain tile (water, grass, lava, rubble… see list_assets category terrain) or a colour terrain texture (ids c-…: floorboards, flagstones, grass, sand, water… see list_assets palette colour, categories floors, ground and water). ' +
        'Give exactly one shape, or a region by meaning ({"in": "r5"} all of room 5, {"edge": "north", "depth": 3}, {"corner": "sw"}, {"between": ["east", "h1"], "width": 2} a path to a hill, {"around": "t2"} a shore round a pond); it may cover a whole room or open ground outside rooms. Tiles repeat on the map grid, so neighbouring areas of one texture join without a seam. ' +
        'Areas fade into each other instead of meeting at straight edges: natural ground and water fade (deep water → shallows → sand → grass, in that order), indoor floors stay crisp, and against bare floor or the background an edge is at most ragged. A later area still covers an earlier one where they overlap (a pond over a field). ' +
        'edge, fade_width, edge_details and stack change that per area.',
      inputSchema: {
        map: mapId,
        asset: z.string().describe('Terrain id, e.g. "water-shallow" or "c-floor-planks-oak"'),
        ...shapeArgs,
        region: regionArg.optional(),
        name: z.string().max(200).optional(),
        id: z.string().optional(),
        edge: z
          .enum(TERRAIN_EDGES)
          .optional()
          .describe('Its outline: "hard" exactly as drawn, "ragged" a natural wobble, "fade" fades into the terrain under it in patches and tongues. Default by material (natural ground and water fade, indoor floors are hard). One set here wins over a neighbour\'s default'),
        fade_width: z.number().min(FADE_WIDTH_MIN).max(FADE_WIDTH_MAX).optional().describe('How wide its fades are, in squares: default 0.75; up to 5 for a long, gradual change (grass slowly turning into sand)'),
        edge_details: z.boolean().optional().describe('false: no details along its soft edges (a wet shoreline with foam and pebbles, grass tufts over a road, a few patches)'),
        stack: z
          .number()
          .int()
          .min(0)
          .max(STACK_MAX)
          .optional()
          .describe('Which of two areas lies on top where they fade into each other: the higher forms the patches. Default by material: deep water 0, water 1, shallows 2, sand and mud 3, dirt and gravel 4, grass 5, snow 6, floors 7'),
      },
    },
    (a) =>
      guarded(() => {
        const info = assetInfo(a.asset);
        if (!info || info.kind !== 'terrain') throw new ValidationError([`asset: "${a.asset}" is not a terrain tile (see list_assets with category "terrain")`]);
        const map = store.get(a.map).map;
        const { shape, holes, region } = shapeOrRegion(map, a, Boolean(a.rect || a.poly || a.circle), () => oneShape(a));
        const id = a.id ?? nextId(map, 't');
        const t = {
          id,
          type: 'terrain' as const,
          shape,
          ...(holes.length ? { holes } : {}),
          asset: a.asset,
          ...(a.name ? { name: a.name } : {}),
          ...(a.edge ? { edge: a.edge } : {}),
          ...(a.fade_width !== undefined ? { fadeWidth: a.fade_width } : {}),
          ...(a.edge_details === false ? { edgeDetails: false } : {}),
          ...(a.stack !== undefined ? { stack: a.stack } : {}),
        };
        return addChecked(a.map, t, `Added ${info.name} terrain ${id}: ${where(shape)}${region ? `, ${region.text}` : ''}; ${terrainEdgeText(t)}.${notesText(region?.notes ?? [])}`);
      }),
  );

  server.registerTool(
    'list_images',
    {
      title: 'List uploaded images',
      description: "The user's own pictures, uploaded in the editor (Image tool), newest first: the src to pass to add_image, the name, the size in pixels and the default size in squares.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(() => {
        const list = images?.list() ?? [];
        if (!list.length) return text('No pictures uploaded yet. The user uploads them in the editor with the Image tool (I).');
        return text(
          list
            .map((i) => {
              const fit = imageFit(i.width, i.height);
              return `${i.src} — "${i.name}", ${i.width}×${i.height} px, default ${fit.w}×${fit.h} squares`;
            })
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'add_image',
    {
      title: 'Add image',
      description:
        "Place one of the user's uploaded pictures (see list_images) on the map, e.g. their table in the middle of room 3. at is the centre of the picture. " +
        'w and h are its size in squares: give one and the other follows the picture\'s proportions; give neither and its longer side is 2 squares. rotation turns it clockwise in degrees. ' +
        'layer "props" (default) stands on top of walls like a prop; "floor" lies on the floor under the grid and walls (rugs, mosaics, floor art). gm_only keeps it out of the players\' view.',
      inputSchema: {
        map: mapId,
        src: z.string().describe('The picture\'s src from list_images, "<sha256>.png"'),
        at: point.describe('Centre of the picture [x, y] in squares'),
        w: z.number().positive().max(1000).optional().describe('Width in squares'),
        h: z.number().positive().max(1000).optional().describe('Height in squares'),
        rotation: z.number().optional().describe('Degrees clockwise'),
        layer: z.enum(IMAGE_LAYERS).optional().describe('props (default: on top of walls) or floor (under grid and walls)'),
        opacity: z.number().min(0).max(1).optional().describe('0 (invisible) to 1 (default)'),
        gm_only: z.boolean().optional().describe('Only in the GM view'),
        name: z.string().max(200).optional().describe("Defaults to the picture's name"),
        notes: z.string().max(10_000).optional().describe('GM notes (never drawn)'),
        id: z.string().optional().describe('Defaults to the next img<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const info = images?.get(a.src);
        if (!info) throw new ValidationError([`src: there is no uploaded picture "${a.src}" (see list_images)`]);
        const map = store.get(a.map).map;
        const ratio = info.width > 0 && info.height > 0 ? info.height / info.width : 1;
        const r2 = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
        const size = a.w !== undefined && a.h !== undefined ? { w: a.w, h: a.h } : a.w !== undefined ? { w: a.w, h: r2(a.w * ratio) } : a.h !== undefined ? { w: r2(a.h / ratio), h: a.h } : imageFit(info.width, info.height);
        const name = a.name ?? (info.name !== info.src ? info.name : undefined);
        const image: MapObject = {
          id: a.id ?? nextId(map, 'img'),
          type: 'image',
          src: a.src,
          at: a.at,
          ...size,
          ...(a.rotation ? { rotation: a.rotation } : {}),
          ...(a.layer === 'floor' ? { layer: 'floor' as const } : {}),
          ...(a.opacity !== undefined && a.opacity !== 1 ? { opacity: a.opacity } : {}),
          ...(a.gm_only ? { gmOnly: true } : {}),
          ...(name ? { name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
        };
        const b = imageBounds({ at: a.at, ...size, rotation: a.rotation });
        const f = (v: number) => String(Math.round(v * 100) / 100);
        return addObject(
          a.map,
          image,
          `Added image ${image.id}${name ? ` "${name}"` : ''}, ${f(size.w)}×${f(size.h)} squares${a.layer === 'floor' ? ' on the floor' : ''}${a.gm_only ? ' (GM only)' : ''}, covering x ${f(b.x0)}–${f(b.x1)}, y ${f(b.y0)}–${f(b.y1)}.`,
        );
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
        const all = levelsOf(service, c.mapId).map((l) => `${l.level?.name ?? l.name} (${l.id}, floor ${l.level?.order ?? 0})`);
        return text(`Added storey "${a.name}" as map ${c.mapId}: ${viewer(c.mapId)}. Storeys, top first: ${all.join(', ')}.`);
      }),
  );

  server.registerTool(
    'label_stairs',
    {
      title: 'Number the stairs',
      description:
        'Give every stair, ladder, spiral stair and trapdoor on all storeys of this map\'s place (or on this map alone, as floor 0) its GM label: the floor number, then a letter per flight. ' +
        'Stairs that line up on neighbouring storeys share the letter: a staircase from the ground to the 2nd floor is 0A, 1A, 2A, and a ladder from the 2nd to the 3rd floor then 2B, 3B. ' +
        'Labels show in the GM view only. Run it after adding or moving stairs or changing floor numbers; update {"label": "..."} sets one by hand.',
      inputSchema: { map: mapId },
    },
    (a) =>
      guarded(() => {
        const r = labelStairs(service, a.map, BY);
        const per = r.storeys.filter((s) => s.stairs).map((s) => `${s.name} (floor ${s.floor}): ${s.stairs}${s.changed ? `, ${s.changed} changed, rev ${s.rev}` : ''}`);
        return text(`${labelStairsSummary(r)}${per.length ? ` ${per.join('; ')}.` : ''}`);
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
        return changeChecked(a.map, [{ op: 'move', ids, dx: a.dx, dy: a.dy }], `Moved ${a.ids.join(', ')}${extra.length ? ` (and doors ${extra.join(', ')})` : ''} by ${a.dx},${a.dy}.`, a.ids.slice(0, 20));
      }),
  );

  server.registerTool(
    'resize',
    {
      title: 'Resize or reshape',
      description: 'Give a room, cutout, stairs, terrain area or open area (add_opening) a new shape (exactly one of rect, poly, circle or preset).',
      inputSchema: { map: mapId, id: z.string(), ...shapeArgs, preset: presetArg },
    },
    (a) =>
      guarded(() => {
        const shape = shapeOrPreset(a);
        return changeChecked(a.map, [{ op: 'update', id: a.id, set: { shape } }], `Reshaped ${a.id}: ${where(shape)}.`, [a.id]);
      }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update object',
      description: 'Set or remove fields of one object, e.g. {"name": "Armoury"}, {"style": "locked"} or {"angle": 30} on a door (turns it about its start point at; unset ["angle"] makes it run along x or y again), {"walls": true} on an open area, {"edge": "ragged"}, {"fadeWidth": 3}, {"edgeDetails": false} or {"stack": 6} on terrain (see add_terrain; unset ["edge"] goes back to the material\'s default), or {"notes": "Two ogres; a chest with 40 gp"} on a room, corridor or terrain (GM notes: never drawn, only the GM sees them; unset ["notes"] removes them). id and type can\'t change.',
      inputSchema: { map: mapId, id: z.string(), set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional() },
    },
    (a) =>
      guarded(() => {
        // fields small models reach for that don't exist: say what does
        const wrong = Object.keys(a.set ?? {}).find((k) => ['position', 'pos', 'location', 'center', 'centre', 'coords', 'x', 'y', 'place'].includes(k));
        if (wrong) throw new ValidationError([`set: there is no field "${wrong}". Props, labels and markers sit at {"at": [x, y]} (their centre); rooms, terrain and other areas have a shape ({"shape": {"rect": [x, y, w, h]}}); move shifts objects by dx, dy; add_prop with in and place puts a new prop by meaning`]);
        return change(a.map, [{ op: 'update', id: a.id, set: a.set, unset: a.unset }], `Updated ${a.id}.`);
      }),
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
      description: 'Rename the map, change its style preset, its background colour (background: "#RRGGBB", or "reset" for the style\'s own), style overrides (e.g. {"walls.width": 0.2}; null clears them), its random seed, its wall roughness (1 smooth to 10 caves; null goes back to the style), or its library category (the shelf on the start page; a storey files its whole place). For a storey: its name (level_name) and floor number (floor).',
      inputSchema: {
        map: mapId,
        name: z.string().min(1).max(200).optional(),
        style: z.enum(presetNames).optional(),
        background: z
          .string()
          .max(20)
          .optional()
          .describe('The colour the map is drawn on, around and between the rooms: "#RRGGBB" (e.g. "#1A2540" night blue, "#2F4A33" forest green, "#4A525C" slate), or "reset" for the style\'s own. Shows in the editor, the exports, the players\' screen and Delve Table; the parchment handout keeps its paper'),
        overrides: z.record(z.string(), z.unknown()).nullable().optional(),
        seed: z.number().int().optional().describe('Changes the hatching and wall wobble'),
        roughness: z.number().int().min(1).max(10).nullable().optional().describe('Wall roughness for the whole map: 1 smooth, 10 extremely rough (caves); null resets'),
        level_name: z.string().min(1).max(60).optional().describe('Rename this storey (only for maps that are storeys, see add_level)'),
        floor: z.number().int().optional().describe("This storey's floor number: 0 ground level, -1 one floor below ground, 1 the first floor up (only for storeys)"),
        unit: z.string().max(20).optional().describe('What one square stands for: "5 ft", "10 ft", "1.5 m", "2 m"… (only the label and scale bars change; the map keeps its squares)'),
        category: z
          .string()
          .max(60)
          .nullable()
          .optional()
          .describe('The library category the start page files the map under, e.g. "Dungeons" or "Cities"; every storey of a place gets it; null or "" takes it off its shelf'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        let filed = '';
        if (a.category !== undefined) {
          const r = setCategory(service, a.map, a.category, BY);
          const all = r.changed.length > 1 ? ` (all ${r.changed.length} storeys)` : '';
          filed = r.category === null ? `Took the map off its library shelf${all}.` : `Filed under "${r.category}"${all}.`;
        }
        // a storey's map name is its place's name: renaming one renames them all
        if (a.name && map.level) {
          const r = renamePlace(service, a.map, a.name, BY);
          filed += `${filed ? ' ' : ''}Renamed the place to "${r.name}" (${r.changed.length} of its storeys changed).`;
        }
        const others = ['style', 'background', 'overrides', 'seed', 'roughness', 'level_name', 'floor', 'unit', ...(map.level ? [] : ['name' as const])] as const;
        if (filed && others.every((k) => a[k] === undefined)) return text(filed);
        const set: Record<string, unknown> = {};
        let note = '';
        if (a.floor !== undefined) {
          if (!map.level) throw new ValidationError(['floor: this map is not a storey (a single map is floor 0); use add_level to make one']);
          set.level = { ...map.level, order: a.floor };
          const clash = levelsOf(service, a.map).find((l) => l.id !== a.map && l.level?.order === a.floor);
          if (clash) note = ` Note: storey "${clash.level?.name ?? clash.name}" (${clash.id}) is floor ${a.floor} too; give each storey its own number.`;
          note += ' Run label_stairs to renumber the stairs.';
        }
        if (a.name && !map.level) set.name = a.name;
        if (a.unit !== undefined) set.grid = { ...map.grid, unit: squareUnit(a.unit) };
        if (a.seed !== undefined) set.seed = a.seed;
        const unset = a.roughness === null ? ['roughness'] : [];
        if (a.roughness) set.roughness = a.roughness;
        if (a.level_name) {
          if (!map.level) throw new ValidationError(['level_name: this map is not a storey; use add_level to make one']);
          set.level = { ...map.level, ...(set.level as object | undefined), name: a.level_name };
        }
        if (a.style !== undefined || a.overrides !== undefined || a.background !== undefined) {
          const cur = map.style ?? { preset: 'classic-hatching' };
          const overrides = a.overrides === undefined ? cur.overrides : (a.overrides ?? undefined);
          let style: NonNullable<typeof map.style> = { preset: a.style ?? cur.preset, ...(overrides ? { overrides } : {}) };
          // the background goes in with the other overrides (it outlasts a style change and "overrides": null clears it too)
          if (a.background !== undefined) {
            let bg: string | null;
            try {
              bg = parseBackground(a.background);
            } catch (e) {
              throw new ValidationError([(e as Error).message]);
            }
            style = withBackground({ style }, bg);
            const now = mapBackground({ style });
            note += now ? ` Background ${now}.` : ` Background: the style's own (${styleBackground(style.preset)}).`;
            const hints = backgroundHints({ style });
            if (hints.length) note += ` ${hints.join(' ')}`;
          }
          set.style = style;
        }
        if (!Object.keys(set).length && !unset.length) throw new ValidationError(['nothing to change: give name, style, background, overrides, seed, roughness, level_name, floor, unit or category']);
        return change(a.map, [{ op: 'update_map', set, ...(unset.length ? { unset } : {}) }], `${filed ? `${filed} ` : ''}Updated map settings (${[...Object.keys(set), ...unset].join(', ')}).${note}`);
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
        'or handout: the players\' map drawn by hand on an old parchment sheet, to print or hand out (the link opens a page with print and download buttons), with a legend of what is drawn on it in a free corner (legend false leaves it out). ' +
        'PNG, SVG and handout can be cropped to part of the map: crop [x, y, width, height] in squares, and/or around: object ids (e.g. ["r4", "r11"] for rooms 4 and 11 only) ' +
        'with margin squares around them (default 1). Both together cover both. The crop is widened to whole squares, so a VTT grid lines up.',
      inputSchema: {
        map: mapId,
        format: z.enum(['png', 'svg', 'ds', 'handout']).optional(),
        view: z.enum(['gm', 'players']).optional().describe('default players'),
        style: z.enum(presetNames).optional(),
        ppg: z.number().int().min(10).max(300).optional(),
        crop: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional().describe('Only this rectangle [x, y, width, height] in squares'),
        around: z.array(z.string()).min(1).optional().describe('Only the part around these objects (their bounds plus margin)'),
        margin: z.number().min(0).max(100).optional().describe('Squares around the around objects (default 1)'),
        legend: z.boolean().optional().describe('handout only: the legend (map key) in a free corner of the sheet; default: when 2 or more kinds of things are drawn. false leaves it out, true keeps even a single entry'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guarded(() => {
        const { map } = store.get(a.map);
        const view = a.view ?? 'players';
        const cropped = a.crop || a.around ? cropFrame(map, { crop: a.crop, around: a.around, margin: a.margin }) : null;
        if (a.format === 'ds') {
          if (cropped) throw new ValidationError(['crop and around work for png, svg and handout; a .ds file is always the whole map']);
          return text(`${base}/api/v1/maps/${encodeURIComponent(a.map)}/export.ds?view=${view}`);
        }
        const note = cropped ? `\nCropped to x ${cropped.x0}–${cropped.x1}, y ${cropped.y0}–${cropped.y1} (${cropped.x1 - cropped.x0}×${cropped.y1 - cropped.y0} squares).` : '';
        if (a.format === 'handout') {
          const hq = [...(cropped ? [`crop=${frameQuery(cropped)}`] : []), ...(a.legend !== undefined ? [`legend=${a.legend ? 1 : 0}`] : [])];
          return text(`${base}/maps/${encodeURIComponent(a.map)}/handout${hq.length ? `?${hq.join('&')}` : ''}${note}`);
        }
        const q = new URLSearchParams({ view, ...(a.style ? { style: a.style } : {}), ...(a.ppg ? { ppg: String(a.ppg) } : {}) });
        // the frame by hand: URLSearchParams would write its commas as %2C
        return text(`${base}/api/v1/maps/${encodeURIComponent(a.map)}/render.${a.format ?? 'png'}?${q}${cropped ? `&frame=${frameQuery(cropped)}` : ''}${note}`);
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

  // ---------- plan: Claude's step list in the editor's chat panel ----------
  // The panel shows it as a checklist with a progress bar and a time estimate.
  // The chat bridge reads the plan from this call's input while it streams in
  // (chat/events.ts turns it into `plan` events); the tool itself only says
  // "ok" and touches no map. Why a Delve tool and not Claude Code's TodoWrite:
  // the bridge runs Claude with Delve's MCP tools only (`--tools ''`,
  // `--allowedTools mcp__delve`), and that list should stay that tight.
  // Statuses: keep in step with PLAN_STATUSES in chat/events.ts.
  server.registerTool(
    'plan',
    {
      title: 'Show your plan',
      description:
        'ALWAYS call this first for any request that takes 3 or more steps, before any other tool. It shows the GM your plan in the editor\'s chat panel: a checklist with a progress bar and a time estimate. ' +
        'For requests with 3 or more steps: call it first with every step (short titles in the user\'s language, the first "active", the rest "pending"), ' +
        'then again after each step with the whole list (that step "done", the next "active"). Each call replaces the plan. ' +
        'It changes nothing on the map and is not an undo step. Outside the chat panel it shows nowhere.',
      inputSchema: {
        steps: z
          .array(
            z.object({
              title: z.string().min(1).max(120).describe('Short and concrete, e.g. "Make room 3 an octagon", "Place 6 chairs"'),
              status: z.enum(['pending', 'active', 'done', 'skipped']),
            }),
          )
          .min(1)
          .max(30),
        note: z.string().max(300).optional().describe('Optional one-line note under the plan'),
      },
      annotations: { readOnlyHint: true },
    },
    () => text('ok'),
  );
  // ---------- end plan ----------

  server.registerTool(
    'apply_ops',
    {
      title: 'Apply raw ops',
      description: 'Apply delve ops (add, update, move, delete, update_map, batch) as one undoable step. For anything the other tools don\'t cover.',
      inputSchema: { map: mapId, ops: z.array(z.unknown()).min(1), base_rev: z.number().int().optional() },
    },
    (a) =>
      guarded(() => {
        const ops = parseOps(a.ops);
        const c = service.apply(a.map, ops, { by: BY, baseRev: a.base_rev });
        // added props that stand on trees, boulders or walls: named, so they can be moved (add_prop's avoid finds a free spot)
        const report = overlapReport(store.get(a.map).map.objects, addedProps(ops));
        const lines = report.slice(0, 8).map((r) => `${r.id} overlaps ${r.on.join(', ')}`);
        const warning = report.length
          ? ` Warning: ${report.length === 1 ? 'a new prop stands' : `${report.length} new props stand`} on trees or other props in the way, so they are drawn over each other: ${lines.join('; ')}${report.length > 8 ? `; and ${report.length - 8} more` : ''}. Move them clear unless that is meant.`
          : '';
        // new rooms, corridors and doors that overlap, run through rooms or float off a wall: said too (a clean batch reads as before)
        const built = addedIds(ops, ['room', 'corridor', 'door']).slice(0, 200);
        const layout = built.length ? checkObjects(c.map, built) : '';
        return text(`Applied ${a.ops.length} op${a.ops.length === 1 ? '' : 's'}. Map is at rev ${c.rev}.${warning}${layout.startsWith('Check: WARNING') ? `\n${layout}` : ''}`);
      }),
  );

  registerSegmentTools(server, service, BY);
  registerCorridorTools(server, service, BY);
  if (props) registerPropTools(server, props, store, base, BY);
  registerHeightTools(server, service, BY);
  registerCheckTools(server, service);
  return server;
}

export function registerMcp(
  app: FastifyInstance,
  deps: { service: MapService; token: string | undefined; version: string; chatTokens?: ChatTokens; images?: ImageLibrary; props?: PropLibrary },
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
    const server = buildMcpServer(deps.service, base, deps.version, deps.images, deps.props);
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
