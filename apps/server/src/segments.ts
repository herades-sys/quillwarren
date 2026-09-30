// Segments over REST and MCP: save a piece of a map ("rooms 1–5 as Temple of
// Efferd", "this patch as Mixed Forest"), list, rename and delete saved ones,
// and place a copy on a map or fill an area with one. Placing and filling go
// through MapService, so each is one undo step and shows up live.
import { randomInt } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  collectSegment,
  countsText,
  fillSegmentOps,
  placeSegmentOps,
  regionAround,
  segmentCounts,
  shapeBounds,
  ValidationError,
  type Bounds,
  type MapSegment,
  type Shape,
} from '@delve/core';
import { errorResponse, writeGuard } from './api.ts';
import type { Sessions } from './auth.ts';
import type { MapService } from './service.ts';
import { NotFoundError } from './store.ts';

const NAME_MAX = 100;

const byOf = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : fallback);

function nameOf(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(['name: give the segment a name, e.g. "Temple of Efferd"']);
  const name = v.trim().replace(/\s+/g, ' ');
  if (name.length > NAME_MAX) throw new ValidationError([`name: at most ${NAME_MAX} characters`]);
  return name;
}

function rectOf(v: unknown, field = 'rect'): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)) || !(v[2] > 0 && v[3] > 0)) {
    throw new ValidationError([`${field}: [x, y, width, height] in squares, with a width and height greater than 0`]);
  }
  return v as [number, number, number, number];
}

function pointOf(v: unknown, field: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new ValidationError([`${field}: [x, y] in squares`]);
  return v as [number, number];
}

function numberOf(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ValidationError([`${field}: a number from ${min} to ${max}`]);
  return v;
}

export function segmentNotFound(ref: string): NotFoundError {
  const e = new NotFoundError(ref);
  e.message = `no segment "${ref}" (list them with GET /api/v1/segments or list_segments)`;
  return e;
}

function segmentOf(service: MapService, ref: unknown): MapSegment {
  if (typeof ref !== 'string' || !ref.trim()) throw new ValidationError(['segment: the id (or the exact name) of a saved segment']);
  const s = service.store.segments.find(ref);
  if (!s) throw segmentNotFound(ref);
  return s;
}

const sizeText = (s: readonly [number, number]): string => `${s[0]}×${s[1]} squares`;
const idsText = (ids: readonly string[]): string => (ids.length <= 16 ? ids.join(', ') : `${ids.slice(0, 16).join(', ')} and ${ids.length - 16} more`);
const boundsText = (b: Bounds): string => `x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1}`;

export interface SaveInput {
  name: unknown;
  map: unknown;
  ids?: unknown;
  rect?: unknown;
}

/** Collect a segment from a stored map and save it. */
export function saveSegment(service: MapService, input: SaveInput): MapSegment {
  const name = nameOf(input.name);
  if (typeof input.map !== 'string' || !input.map) throw new ValidationError(['map: the id of the map to save from']);
  const { map } = service.store.get(input.map);
  const hasIds = input.ids !== undefined && input.ids !== null;
  const hasRect = input.rect !== undefined && input.rect !== null;
  if (hasIds === hasRect) throw new ValidationError(['give either ids (the objects to save) or rect ([x, y, width, height]: everything inside it)']);
  let pick: { ids: string[] } | { rect: [number, number, number, number] };
  if (hasIds) {
    if (!Array.isArray(input.ids) || !input.ids.length || !input.ids.every((x) => typeof x === 'string')) throw new ValidationError(['ids: a list of object ids, e.g. ["r1", "r2"]']);
    pick = { ids: input.ids as string[] };
  } else pick = { rect: rectOf(input.rect) };
  return service.store.segments.create(name, collectSegment(map, pick), map.id);
}

export interface Applied {
  rev: number;
  ids: string[];
  summary: string;
}

export interface PlaceInput {
  segment: unknown;
  at: unknown;
  rotation?: unknown;
  baseRev?: number;
  by: string;
}

/** Place a copy of a saved segment on a map, as one undo step. */
export function placeSegment(service: MapService, mapId: string, input: PlaceInput): Applied {
  const seg = segmentOf(service, input.segment);
  const at = pointOf(input.at, 'at');
  const rotation = numberOf(input.rotation, 'rotation', -360, 360) ?? 0;
  const { map } = service.store.get(mapId);
  const plan = placeSegmentOps(map, seg, at, rotation);
  const c = service.apply(mapId, plan.ops, { by: input.by, baseRev: input.baseRev });
  const added = plan.ops.flatMap((o) => (o.op === 'add' ? [o.object] : []));
  const rooms = plan.rooms.map((r) => (r.label ? `${r.id} (room ${r.label})` : r.id));
  const parts = [
    `Placed "${seg.name}" with its top-left corner at ${plan.at.join(',')}${rotation ? `, turned ${((rotation % 360) + 360) % 360}° clockwise` : ''}: ${sizeText(plan.size)}, ${countsText(segmentCounts(added))}.`,
    rooms.length ? `Rooms ${rooms.join(', ')}.` : '',
    `New ids: ${idsText(plan.ids)}.`,
    plan.overlaps.length ? `It overlaps room${plan.overlaps.length === 1 ? '' : 's'} ${plan.overlaps.join(', ')} of the map (rooms that touch merge into one space).` : '',
  ];
  return { rev: c.rev, ids: plan.ids, summary: parts.filter(Boolean).join(' ') };
}

export interface FillInput {
  segment: unknown;
  rect?: unknown;
  around?: unknown;
  margin?: unknown;
  vary?: unknown;
  seed?: unknown;
  baseRev?: number;
  by: string;
}

/** Fill an area (a rect, or the land around the rooms) with a saved segment's props and terrain, as one undo step. */
export function fillWithSegment(service: MapService, mapId: string, input: FillInput): Applied & { props: number; terrain: number; skipped: number } {
  const seg = segmentOf(service, input.segment);
  const { rev, map } = service.store.get(mapId);
  const hasRect = input.rect !== undefined && input.rect !== null;
  if (hasRect && input.around !== undefined && input.around !== null) throw new ValidationError(['give rect (the area to fill) or around (squares around the rooms), not both']);
  const around = numberOf(input.around, 'around', 0, 100) ?? 5;
  const region: Shape | null = hasRect ? { rect: rectOf(input.rect) } : regionAround(map, around);
  if (!region) throw new ValidationError(['the map is empty, so there are no rooms to fill around: give rect, the area to fill']);
  if (input.vary !== undefined && typeof input.vary !== 'boolean') throw new ValidationError(['vary: true or false']);
  const margin = numberOf(input.margin, 'margin', 0, 20);
  const seed = numberOf(input.seed, 'seed', 0, 2 ** 31) ?? randomInt(1, 2 ** 31);
  const fill = fillSegmentOps(map, seg, region, { ...(margin !== undefined ? { margin } : {}), ...(typeof input.vary === 'boolean' ? { vary: input.vary } : {}), seed });
  const where = hasRect ? boundsText(shapeBounds(region)) : `the land around the rooms (${around} squares out: ${boundsText(shapeBounds(region))})`;
  const left = fill.left.length ? ` A fill repeats only props and terrain, so the segment's ${fill.left.join(', ')} ${fill.left.length === 1 ? 'was' : 'were'} not copied (place_segment does those).` : '';
  if (!fill.ops.length) {
    return { rev, ids: [], props: 0, terrain: 0, skipped: fill.skipped, summary: `Nothing fits in ${where}: every spot is on or next to the floor, on another prop or outside the area. The map is unchanged.${left}` };
  }
  const c = service.apply(mapId, fill.ops, { by: input.by, baseRev: input.baseRev });
  const summary =
    `Filled ${where} with "${seg.name}" (${fill.tiles} cop${fill.tiles === 1 ? 'y' : 'ies'} side by side): ${fill.props} prop${fill.props === 1 ? '' : 's'} and ${fill.terrain} terrain area${fill.terrain === 1 ? '' : 's'}; the rooms and corridors stay clear.` +
    (fill.skipped ? ` Left out ${fill.skipped} prop${fill.skipped === 1 ? '' : 's'} that would have stood on or next to the floor, on another prop or other terrain, or outside the area.` : '') +
    left;
  return { rev: c.rev, ids: fill.ids, props: fill.props, terrain: fill.terrain, skipped: fill.skipped, summary };
}

// ---------- REST ----------

export function registerSegments(app: FastifyInstance, deps: { service: MapService; token: string | undefined; sessions: Sessions }): void {
  const { service } = deps;
  const segments = service.store.segments;
  const writer = writeGuard(deps.token, deps.sessions);
  const fail = (reply: FastifyReply, e: unknown) => {
    const { status, body } = errorResponse(e);
    return reply.code(status).send(body);
  };
  const full = (s: MapSegment) => ({ ...s, counts: segmentCounts(s.objects) });

  app.get('/api/v1/segments', async () => ({ segments: segments.list() }));

  app.get('/api/v1/segments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = segments.get(id);
    return s ? { segment: full(s) } : fail(reply, segmentNotFound(id));
  });

  app.post('/api/v1/segments', { preHandler: writer }, async (req, reply) => {
    try {
      const s = saveSegment(service, (req.body ?? {}) as SaveInput);
      return reply.code(201).send({ segment: full(s) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch('/api/v1/segments/:id', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const name = nameOf((req.body as { name?: unknown } | undefined)?.name);
      if (!segments.rename(id, name)) throw segmentNotFound(id);
      return { segment: segments.summaryOf(id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/v1/segments/:id', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return segments.delete(id) ? reply.code(204).send() : fail(reply, segmentNotFound(id));
  });

  const baseRevOf = (v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v)) throw new ValidationError(['baseRev must be a whole number']);
    return v as number;
  };

  app.post('/api/v1/maps/:id/segments/place', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return placeSegment(service, id, { segment: body.segment, at: body.at, rotation: body.rotation, baseRev: baseRevOf(body.baseRev), by: byOf(body.by, 'api') });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/maps/:id/segments/fill', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return fillWithSegment(service, id, { ...body, segment: body.segment, baseRev: baseRevOf(body.baseRev), by: byOf(body.by, 'api') });
    } catch (e) {
      return fail(reply, e);
    }
  });
}

// ---------- MCP ----------

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
const segmentRef = z.string().describe('Segment id (seg_…) or its exact name (see list_segments)');
const rect = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

export function registerSegmentTools(server: McpServer, service: MapService, by: string): void {
  const segments = service.store.segments;

  server.registerTool(
    'list_segments',
    {
      title: 'List saved segments',
      description: 'Saved segments (pieces of maps saved to be placed again or tiled over an area), with ids, sizes and what they hold.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(() => {
        const list = segments.list();
        if (!list.length) return text('No segments saved yet. save_segment saves part of a map.');
        return text(list.map((s) => `${s.id} · "${s.name}" · ${sizeText(s.size)} · ${countsText(s.counts)}${s.source ? ` · saved from ${s.source}` : ''}`).join('\n'));
      }),
  );

  server.registerTool(
    'save_segment',
    {
      title: 'Save a segment',
      description:
        'Save part of a map under a name, to place again (place_segment) or to tile over an area (fill_with_segment). ' +
        'ids: objects to save; rooms bring their doors, everything standing inside them (props, terrain, labels, markers, cutouts, stairs) and the corridors between them. ' +
        'Or rect [x, y, w, h]: everything that lies inside it, terrain cut to it (good for a patch of forest). Give exactly one of ids or rect.',
      inputSchema: {
        map: mapId,
        name: z.string().min(1).max(NAME_MAX).describe('e.g. "Temple of Efferd", "Antechamber", "Mixed forest"'),
        ids: z.array(z.string()).min(1).optional().describe('Object ids, e.g. ["r1", "r2", "r3"]'),
        rect: rect.optional().describe('Area [x, y, width, height] in squares'),
      },
    },
    (a) =>
      guarded(() => {
        const s = saveSegment(service, a);
        return text(`Saved segment ${s.id} "${s.name}": ${sizeText(s.size)} with ${countsText(segmentCounts(s.objects))}. Place it with place_segment or tile it over an area with fill_with_segment.`);
      }),
  );

  server.registerTool(
    'place_segment',
    {
      title: 'Place a segment',
      description:
        "Add a copy of a saved segment to a map, with its top-left corner at `at` (whole squares), turned clockwise by rotation. " +
        "Every object gets a fresh id, room numbers carry on from the map's, and corridors join the copies of their rooms. One undo step.",
      inputSchema: {
        map: mapId,
        segment: segmentRef,
        at: z.tuple([z.number(), z.number()]).describe("Top-left corner [x, y] in squares; the segment's size is in list_segments"),
        rotation: z.number().int().optional().describe('Degrees clockwise: 0 (default), 90, 180 or 270'),
      },
    },
    (a) => guarded(() => {
      const r = placeSegment(service, a.map, { segment: a.segment, at: a.at, rotation: a.rotation, by });
      return text(`${r.summary} Map is at rev ${r.rev}.`);
    }),
  );

  server.registerTool(
    'fill_with_segment',
    {
      title: 'Fill an area with a segment',
      description:
        "Tile a saved segment's props and terrain over an area, e.g. fill the land around a dungeon with a saved forest. " +
        'Copies go side by side; the rooms and corridors stay clear (nothing within margin squares of the floor), props skip spots taken by other props or other terrain (no trees in the river), ' +
        'and with vary each copy is nudged and nature props turned a little so it does not look stamped. ' +
        'rect [x, y, w, h] is the area; without it, the area is the map\'s rooms and corridors grown by `around` squares (default 5). One undo step.',
      inputSchema: {
        map: mapId,
        segment: segmentRef,
        rect: rect.optional().describe('Area to fill [x, y, width, height] in squares'),
        around: z.number().min(0).max(100).optional().describe('Without rect: how many squares around the rooms to fill (default 5)'),
        margin: z.number().min(0).max(20).optional().describe('Squares to keep clear around rooms and corridors (default 0.5)'),
        vary: z.boolean().optional().describe('default true'),
      },
    },
    (a) => guarded(() => {
      const r = fillWithSegment(service, a.map, { segment: a.segment, rect: a.rect, around: a.around, margin: a.margin, vary: a.vary, by });
      return text(`${r.summary}${r.ids.length ? ` Map is at rev ${r.rev}.` : ''}`);
    }),
  );
}
