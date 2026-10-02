// Operations: the one way to change a map. applyOps is atomic (all ops apply
// and the result validates, or nothing changes) and returns the exact inverse,
// which is how undo works.
import { z } from 'zod';
import { translateShape } from './geometry/shapes.ts';
import { Id, MapObject, type DelveMap, type MapObject as MapObjectT, type Point } from './schema.ts';
import { ValidationError, validateMap } from './validate.ts';

export type Op =
  | { op: 'add'; object: MapObjectT; index?: number }
  | { op: 'update'; id: string; set?: Record<string, unknown>; unset?: string[] }
  | { op: 'move'; ids: string[]; dx: number; dy: number }
  | { op: 'delete'; ids: string[] }
  | { op: 'update_map'; set?: Record<string, unknown>; unset?: string[] }
  | { op: 'batch'; ops: Op[] };

/** Top-level map fields that update_map may change. */
export const MAP_FIELDS = ['name', 'grid', 'style', 'seed', 'level', 'category', 'fog', 'roughness'] as const;

export const OpSchema: z.ZodType<Op> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('add'), object: MapObject, index: z.number().int().nonnegative().optional() }),
    z.strictObject({
      op: z.literal('update'),
      id: Id,
      set: z.record(z.string(), z.unknown()).optional(),
      unset: z.array(z.string()).optional(),
    }),
    z.strictObject({ op: z.literal('move'), ids: z.array(Id).min(1), dx: z.number(), dy: z.number() }),
    z.strictObject({ op: z.literal('delete'), ids: z.array(Id).min(1) }),
    z.strictObject({
      op: z.literal('update_map'),
      set: z.record(z.string(), z.unknown()).optional(),
      unset: z.array(z.string()).optional(),
    }),
    z.strictObject({ op: z.literal('batch'), ops: z.array(OpSchema) }),
  ]),
);

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

/** Validate untrusted ops (REST, WebSocket, MCP input). */
export function parseOps(input: unknown): Op[] {
  const r = z.array(OpSchema).safeParse(input);
  if (!r.success) {
    throw new ValidationError(
      r.error.issues.map((i) => `ops${i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')}: ${i.message}`),
    );
  }
  return r.data;
}

const FIXED_KEYS = new Set(['id', 'type']);
const MAP_KEYS = new Set<string>(MAP_FIELDS);
type Obj = Record<string, unknown> & { id: string; type: string };

/** Apply set/unset to a record; returns the set/unset that undoes it. */
function patch(target: Record<string, unknown>, set: Record<string, unknown> = {}, unset: string[] = []) {
  const keys = [...Object.keys(set), ...unset];
  const prevSet: Record<string, unknown> = {};
  const prevUnset: string[] = [];
  for (const k of keys) {
    if (k in prevSet || prevUnset.includes(k)) continue;
    if (k in target) prevSet[k] = structuredClone(target[k]);
    else prevUnset.push(k);
  }
  for (const k of unset) delete target[k];
  Object.assign(target, structuredClone(set));
  return { set: prevSet, ...(prevUnset.length ? { unset: prevUnset } : {}) };
}

function flatten(ops: readonly Op[]): Exclude<Op, { op: 'batch' }>[] {
  return ops.flatMap((o) => (o.op === 'batch' ? flatten(o.ops) : [o]));
}

function moved(o: MapObjectT, dx: number, dy: number): Record<string, unknown> | null {
  const shift = ([x, y]: Point): Point => [x + dx, y + dy];
  switch (o.type) {
    case 'room':
    case 'cutout':
    case 'stairs':
      return { shape: translateShape(o.shape, dx, dy) };
    case 'terrain':
      return { shape: translateShape(o.shape, dx, dy), ...(o.holes ? { holes: o.holes.map((ring) => ring.map(shift)) } : {}) };
    case 'corridor':
      return o.path ? { path: o.path.map(shift) } : null; // auto-routed corridors follow their rooms
    case 'door':
    case 'label':
    case 'prop':
    case 'marker':
    case 'image':
      return { at: shift(o.at) };
  }
}

export interface ApplyResult {
  map: DelveMap;
  /** Ops that turn the new map back into the input map exactly. */
  inverse: Op[];
}

export function applyOps(map: DelveMap, ops: readonly Op[]): ApplyResult {
  const doc = structuredClone(map);
  const objects = doc.objects as unknown as Obj[];
  const indexOf = (id: string): number => objects.findIndex((o) => o.id === id);
  const undo: Op[][] = [];

  flatten(ops).forEach((op, n) => {
    const fail = (msg: string): never => {
      throw new OpError(`ops[${n}] (${op.op}): ${msg}`);
    };
    switch (op.op) {
      case 'add': {
        const obj = structuredClone(op.object) as unknown as Obj;
        if (indexOf(obj.id) !== -1) fail(`id "${obj.id}" is already in use`);
        const at = op.index === undefined ? objects.length : Math.min(op.index, objects.length);
        objects.splice(at, 0, obj);
        undo.push([{ op: 'delete', ids: [obj.id] }]);
        break;
      }
      case 'update': {
        const i = indexOf(op.id);
        if (i === -1) fail(`no object with id "${op.id}"`);
        const keys = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
        for (const k of keys) if (FIXED_KEYS.has(k)) fail(`"${k}" can't be changed; delete and re-add instead`);
        undo.push([{ op: 'update', id: op.id, ...patch(objects[i]!, op.set, op.unset) }]);
        break;
      }
      case 'update_map': {
        const keys = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
        for (const k of keys) {
          if (!MAP_KEYS.has(k)) fail(`"${k}" can't be changed with update_map (allowed: ${MAP_FIELDS.join(', ')})`);
        }
        undo.push([{ op: 'update_map', ...patch(doc as unknown as Record<string, unknown>, op.set, op.unset) }]);
        break;
      }
      case 'move': {
        const back: Op[] = [];
        for (const id of op.ids) {
          const i = indexOf(id);
          if (i === -1) fail(`no object with id "${id}"`);
          const obj = objects[i]!;
          const changes = moved(obj as unknown as MapObjectT, op.dx, op.dy);
          if (!changes) continue;
          const prev: Record<string, unknown> = {};
          for (const k of Object.keys(changes)) prev[k] = structuredClone(obj[k]);
          Object.assign(obj, changes);
          back.push({ op: 'update', id, set: prev }); // exact, no floating-point drift
        }
        undo.push(back);
        break;
      }
      case 'delete': {
        const found = [...new Set(op.ids)].map((id) => {
          const i = indexOf(id);
          if (i === -1) fail(`no object with id "${id}"`);
          return { i, obj: objects[i]! };
        });
        found.sort((a, b) => a.i - b.i);
        for (const { i } of [...found].reverse()) objects.splice(i, 1);
        // Re-adding in ascending index order puts every object back where it was.
        undo.push(found.map(({ i, obj }) => ({ op: 'add', object: obj as unknown as MapObjectT, index: i })));
        break;
      }
    }
  });

  try {
    validateMap(doc);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new OpError(`the result would be invalid: ${e.problems.join('; ')}`);
    }
    throw e;
  }
  return { map: doc, inverse: undo.reverse().flat() };
}
