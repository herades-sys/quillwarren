// MCP for height areas (core heights.ts): add_height raises or sinks the ground
// under a shape, a ledge archers shoot from, a hill, a sunken arena, a mountain's
// plateaus. Changing one is the generic update / resize / delete. The answer
// says how the area is reached (stairs, ladders) the way describe_map does.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeHeights, HEIGHT_EDGES, heightPlan, heightText, nextId, parseSquareUnit, shapeBounds, stairsUphill, type HeightArea, type Shape } from '@delve/core';
import { errorResponse } from './api.ts';
import { presetArg, shapeOrPreset } from './draw-args.ts';
import type { MapService } from './service.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });
function guarded(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (e) {
    let msg: string;
    try {
      msg = errorResponse(e).body.error;
    } catch {
      msg = `internal error: ${(e as Error).message}`;
    }
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}

const point = z.tuple([z.number(), z.number()]);
const where = (shape: Shape): string => {
  const b = shapeBounds(shape);
  return `${b.x1 - b.x0}×${b.y1 - b.y0} squares at ${b.x0},${b.y0}`;
};

export const ADD_HEIGHT_DESCRIPTION =
  'Raise or sink the ground under a shape, on the same map: a ledge archers shoot from (+10), a hill (+5 with a higher crest +10 on top), a sunken arena or a pit (-10), a mountainside of plateaus. ' +
  'height is relative to the map\'s floor in the map\'s units (grid unit: feet, or metres on a metric map). It only changes height where there is floor (rooms, corridors) or terrain already: ' +
  'draw it over a room, or over terrain outdoors (a snowy mountain is add_terrain snow plus add_height areas). Where areas overlap, the one added last wins. ' +
  'edge: "cliff" (a sheer drop drawn as a ledge line with ticks: balconies, ledges, pit rims), "rock" (a cliff drawn as a band of rock face, as wide as the drop: mountainsides), ' +
  '"slope" (a walkable hill or ramp, soft hachures) or "step" (walkable: a low step, rubble). Unset: a drop of a square\'s size or more is a cliff (indoors) or rock face (outdoors), less is a step. ' +
  'Cliffs and rock faces can\'t be walked: put stairs (add_stairs) or a ladder prop across the edge where the way up is; stairs going down into a sunken area work the same. ' +
  'Players see the edges; the GM view adds the height labels. hidden: true keeps it from the players.';

export function registerHeightTools(server: McpServer, service: MapService, by: string): void {
  const { store } = service;
  server.registerTool(
    'add_height',
    {
      title: 'Add height area',
      description: ADD_HEIGHT_DESCRIPTION,
      inputSchema: {
        map: z.string().describe('Map id, e.g. map_1a2b3c4d5e6f (see list_maps)'),
        rect: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional().describe('Rectangle [x, y, width, height] in squares'),
        poly: z.array(point).min(3).optional().describe('Polygon: corner points [[x, y], ...]'),
        circle: z.tuple([z.number(), z.number(), z.number().positive()]).optional().describe('Circle [centreX, centreY, radius]'),
        preset: presetArg,
        height: z.number().min(-10000).max(10000).describe('Relative to the floor, in the map\'s units: 10 for a 10 ft ledge, -5 for a 5 ft pit'),
        edge: z.enum(HEIGHT_EDGES).optional().describe('cliff, rock, slope or step (default: by the drop, see the description)'),
        name: z.string().max(200).optional().describe('e.g. "Archers\' ledge", "Sunken arena"'),
        notes: z.string().max(10000).optional().describe('GM notes, never drawn'),
        hidden: z.boolean().optional().describe('Hidden from players (their view shows flat ground there; Delve Table doesn\'t enforce it)'),
        id: z.string().optional().describe('Defaults to the next h<n>'),
      },
    },
    (a) =>
      guarded(() => {
        const map = store.get(a.map).map;
        const shape = shapeOrPreset(a);
        const id = a.id ?? nextId(map, 'h');
        const area: HeightArea = {
          id,
          type: 'height',
          shape,
          height: a.height,
          ...(a.edge ? { edge: a.edge } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.hidden ? { hidden: true } : {}),
        };
        const c = service.apply(a.map, [{ op: 'add', object: area }], { by });
        const after = store.get(a.map).map;
        const line = describeHeights(after).find((l) => l.trimStart().startsWith(`${id}:`) || l.trimStart().startsWith(`${id} `));
        // stairs whose "up" points the other way than the ground now does
        const plan = heightPlan(after);
        const wrong = after.objects.flatMap((o) => {
          if (o.type !== 'stairs') return [];
          const up = stairsUphill(plan, shapeBounds(o.shape));
          return up && up !== o.direction ? [`${o.id} (up is ${up} now: update {"direction": "${up}"})`] : [];
        });
        const unit = parseSquareUnit(after.grid.unit);
        return text(
          `Added height area ${id}: ${heightText(a.height, unit)}, ${where(shape)}. Map is at rev ${c.rev}.` +
            (line ? `\n${line.trim()}` : '') +
            (wrong.length ? `\nStairs that now run the other way: ${wrong.join(', ')}.` : ''),
        );
      }),
  );
}
