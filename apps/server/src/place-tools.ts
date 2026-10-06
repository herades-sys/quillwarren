// Placing things by meaning (core places/): the argument schemas the MCP
// tools share (lengths with units, regions, places), the glue that turns them
// into shapes, and the check_map tool. The tools themselves stay in mcp.ts and
// height-tools.ts, which only add these options to what they already take.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkMapText,
  lengthInSquares,
  lengthInUnits,
  parseSquareUnit,
  resolveRegion,
  ValidationError,
  type DelveMap,
  type Length,
  type Point,
  type Region,
  type RegionSpec,
  type Shape,
} from '@delve/core';
import { errorResponse } from './api.ts';
import type { MapService } from './service.ts';

const point = z.tuple([z.number(), z.number()]);

/** A size, width or distance: squares, or text with a unit. */
export const lengthArg = (what: string) =>
  z.union([z.string().max(40), z.number()]).describe(`${what}. A number of squares, or a length with a unit: "5 m", "10 ft", "3 squares" (converted with the map's square size)`);

/** A height in the map's units, or with a unit. */
export const heightArg = z
  .union([z.string().max(40), z.number().min(-10000).max(10000)])
  .describe('Relative to the floor: a number in the map\'s units (feet, or metres on a metric map: 10 for a 10 ft ledge, -5 for a pit), or with its unit: "5 m", "10 ft", "2 squares". Give it with the unit the user said ("5 m"); don\'t convert it yourself');

export const REGION_HELP =
  'Where, by meaning instead of coordinates. One of: {"edge": "north", "depth": 3} a band along that edge of the map (north is the top, small y; on a map of rooms only, the band lies just outside the rooms), ' +
  '{"corner": "sw", "size": 8} a square in that corner of the map, {"in": "r5"} all of a room or area, {"in": "r2", "edge": "north"} or {"in": "r2", "corner": "ne"} part of one, ' +
  '{"around": "r3", "margin": 2} a ring around something, {"between": ["east", "h1"], "width": 2} a strip from one thing to another (ids, map edges or points [x, y]); a plain {"rect": [x, y, w, h]}, poly or circle works too. Lengths take units ("5 m")';

export const regionArg = z
  .object({
    edge: z.string().max(20).optional().describe('north, south, east or west: a band along that edge of the map (or of the room in in)'),
    depth: lengthArg('How deep the band is (default 3 squares; 2 in a room)').optional(),
    corner: z.string().max(20).optional().describe('ne, nw, se or sw: a square in that corner of the map (or of the room in in)'),
    size: lengthArg('The corner square\'s side (default about a third of the map; up to 3 squares in a room)').optional(),
    in: z.string().max(64).optional().describe('A room or area id: all of it, or with edge or corner, part of it'),
    around: z.string().max(64).optional().describe('An object id: a ring around it'),
    margin: lengthArg('How far the ring reaches out (default 2 squares)').optional(),
    between: z.array(z.union([z.string().max(64), point])).length(2).optional().describe('Two ends: object ids ("h1", "r4"), map edges ("east") or points [x, y]: a strip from the first to the second'),
    width: lengthArg('The strip\'s width (default 2 squares)').optional(),
    outside: z.boolean().optional().describe('Map edges only: true for a band just outside everything on the map, false for inside the map\'s edge'),
    rect: z.array(z.number()).optional().describe('Or a plain area: [x, y, width, height] in squares'),
    poly: z.array(point).optional().describe('Or a plain area: corner points [[x, y], ...]'),
    circle: z.array(z.number()).optional().describe('Or a plain area: [centreX, centreY, radius]'),
  })
  .describe(REGION_HELP);

export type RegionArg = z.infer<typeof regionArg>;

export const placeArg = z
  .string()
  .max(80)
  .describe(
    'Where in the room (with in): "center", "north wall", "south wall", "east wall" or "west wall" (against the inside of that wall, turned to face into the room), "ne corner", "nw corner", "se corner" or "sw corner", ' +
      '"near <id>" (next to that prop) or "around <id>" (spread round it, each facing it: chairs round a table, with count). A free spot is found: inside the room, off other props, doorways kept clear',
  );

/** The map's square size, for lengths with units. */
export const unitOf = (map: DelveMap) => parseSquareUnit(map.grid.unit);

/** A length argument in squares (undefined stays undefined); conversions noted in `notes`. */
export function squaresArg(map: DelveMap, v: Length | undefined, field: string, notes: string[], opts: { min?: number } = {}): number | undefined {
  if (v === undefined) return undefined;
  const { squares, note } = lengthInSquares(v, unitOf(map), field);
  if (note) notes.push(`${field}: ${note}`);
  if (opts.min !== undefined && !(squares >= opts.min)) throw new ValidationError([`${field}: must be at least ${opts.min} squares, got ${JSON.stringify(v)}`]);
  return squares;
}

/** A height argument in the map's units; conversions noted. */
export function heightValue(map: DelveMap, v: Length, notes: string[]): number {
  const { value, note } = lengthInUnits(v, unitOf(map), 'height');
  if (note) notes.push(`height: ${note}`);
  return value;
}

export function regionOf(map: DelveMap, r: RegionArg): Region {
  return resolveRegion(map, r as RegionSpec);
}

/** The shape a tool draws: its own rect/poly/circle (via `own`), or a region. Exactly one. */
export function shapeOrRegion(map: DelveMap, a: { region?: RegionArg }, hasOwn: boolean, own: () => Shape): { shape: Shape; holes: Point[][]; region?: Region } {
  if (a.region && hasOwn) throw new ValidationError(['give a shape (rect, poly, circle) or a region, not both']);
  if (a.region) {
    const region = regionOf(map, a.region);
    return { shape: region.shape, holes: region.holes, region };
  }
  return { shape: own(), holes: [] };
}

/** " (5 m = 3.33 squares)" for the reply, or "". */
export const notesText = (notes: readonly string[]): string => (notes.length ? ` Units: ${notes.join('; ')}.` : '');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

export function registerCheckTools(server: McpServer, service: MapService): void {
  server.registerTool(
    'check_map',
    {
      title: 'Check the map',
      description:
        'List layout problems: rooms that overlap or touch (they merge into one space), corridors running through rooms they don\'t join, doors that aren\'t on a wall, props half outside their room, on top of each other or in a doorway, height areas off the ground. Cheap; call it after building, and fix what it lists.',
      inputSchema: { map: z.string().describe('Map id') },
      annotations: { readOnlyHint: true },
    },
    (a) => {
      try {
        const { rev, map } = service.store.get(a.map);
        return text(`${checkMapText(map)}\n(rev ${rev})`);
      } catch (e) {
        let msg: string;
        try {
          msg = errorResponse(e).body.error;
        } catch {
          msg = `internal error: ${(e as Error).message}`;
        }
        return { isError: true, content: [{ type: 'text', text: msg }] };
      }
    },
  );
}
