// MCP for corridors between rooms of any shape: `reroute` redoes corridors
// with the routing to the rooms' real outlines (core rerouteOps), as one undo
// step through MapService, so open viewers follow live.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rerouteOps } from '@delve/core';
import { errorResponse } from './api.ts';
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

const mapId = z.string().describe('Map id, e.g. map_1a2b3c4d5e6f (see list_maps)');

export function registerCorridorTools(server: McpServer, service: MapService, by: string): void {
  server.registerTool(
    'reroute',
    {
      title: 'Re-route corridors',
      description:
        'Redo corridors with the routing that meets rooms at their real outlines (hexagons, octagons, circles, freehand shapes): ' +
        'no gaps or notches where a corridor meets a slanted or curved wall, a short stub square off a slanted wall, 45° runs between diagonal walls. ' +
        'Corridors made by connect already route this way; older ones keep their old route until rerouted. ' +
        'A corridor with its own path goes back to following its rooms (found from its ends if it has no from/to), and doors across its old ends move to the new mouths. ' +
        'ids: corridor ids (default: every corridor on the map). One undo step.',
      inputSchema: {
        map: mapId,
        ids: z.array(z.string()).max(500).optional().describe('Corridor ids, e.g. ["c1", "c4"]; default all'),
      },
    },
    (a) =>
      guarded(() => {
        const map = service.store.get(a.map).map;
        const plan = rerouteOps(map, a.ids);
        const done = plan.rerouted.map((r) => `${r.id} (${r.from} → ${r.to}): path ${JSON.stringify(r.path)}${r.doors.length ? `; moved doors ${r.doors.join(', ')}` : ''}`);
        const skipped = plan.skipped.map((s) => `${s.id}: ${s.reason}`);
        const tail = skipped.length ? ` Skipped ${skipped.join('; ')}.` : '';
        if (!plan.ops.length) return text(`${done.length ? `Nothing to change: ${plan.rerouted.map((r) => r.id).join(', ')} already route to the room outlines.` : 'No corridors to re-route.'}${tail}`);
        const c = service.apply(a.map, plan.ops, { by });
        return text(`Re-routed ${done.join('; ')}.${tail} Map is at rev ${c.rev}.`);
      }),
  );
}
