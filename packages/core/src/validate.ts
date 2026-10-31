// validateMap: schema check plus cross-object rules, with messages that name
// the object id and field, e.g. `r7 (objects[3]) shape.rect[2]: must be greater than 0`.
import type { z } from 'zod';
import { styleOverrideProblems } from './render/style.ts';
import { MapDoc, OBJECT_TYPES, type DelveMap } from './schema.ts';

export class ValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems:\n- ${problems.join('\n- ')}`);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

type Issue = z.core.$ZodIssue;

function formatPath(path: PropertyKey[], input: unknown): string {
  const parts: string[] = [];
  let i = 0;
  if (path[0] === 'objects' && typeof path[1] === 'number') {
    const obj = (input as { objects?: unknown[] })?.objects?.[path[1]] as { id?: unknown } | undefined;
    const id = typeof obj?.id === 'string' ? obj.id : undefined;
    parts.push(id ? `${id} (objects[${path[1]}])` : `objects[${path[1]}]`);
    i = 2;
  }
  let rest = '';
  for (; i < path.length; i++) {
    const p = path[i];
    rest += typeof p === 'number' ? `[${p}]` : `${rest ? '.' : ''}${String(p)}`;
  }
  if (rest) parts.push(rest);
  return parts.join(' ') || '(map)';
}

// For a union, report the branch that got furthest (fewest issues) instead of
// "invalid input": {"rect": [1, 2, -3, 4]} should say rect[2] must be > 0.
function flatten(issue: Issue): Issue[] {
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const best = [...issue.errors].sort((a, b) => a.length - b.length)[0]!;
    return best.flatMap((sub) => flatten({ ...sub, path: [...issue.path, ...sub.path] } as Issue));
  }
  return [issue];
}

function describeIssue(issue: Issue, input: unknown): string {
  const where = formatPath(issue.path, input);
  // After flatten(), the only union issue left is the object list's
  // discriminator finding no match: an unknown or missing "type".
  if (issue.code === 'invalid_union') {
    const t = pick(input, issue.path)?.type ?? pick(input, issue.path.slice(0, -1))?.type;
    return `${where}: unknown type ${JSON.stringify(t ?? null)} (expected ${OBJECT_TYPES.join(', ')})`;
  }
  if (issue.code === 'unrecognized_keys') {
    return `${where}: unknown field${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map((k) => JSON.stringify(k)).join(', ')}`;
  }
  return `${where}: ${issue.message}`;
}

function pick(input: unknown, path: PropertyKey[]): Record<string, unknown> | undefined {
  let cur: unknown = input;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  return cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}

/**
 * Style overrides: only known settings, with values the renderers can draw
 * (styleOverrideProblems). Those an edit left as they were are not checked
 * again, so a map saved before the check stays editable.
 */
function checkStyle(map: DelveMap, was?: Pick<DelveMap, 'style'>): string[] {
  const o = map.style?.overrides;
  if (!o) return [];
  return styleOverrideProblems(o, was?.style?.overrides);
}

/** Cross-object rules the schema can't express. */
function checkReferences(map: DelveMap): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const types = new Map<string, string>();
  map.objects.forEach((o, i) => {
    const first = seen.get(o.id);
    if (first !== undefined) problems.push(`${o.id} (objects[${i}]): duplicate id, already used by objects[${first}]`);
    else seen.set(o.id, i);
    types.set(o.id, o.type);
  });
  map.objects.forEach((o, i) => {
    if (o.type !== 'corridor') return;
    for (const end of ['from', 'to'] as const) {
      const ref = o[end];
      if (ref === undefined) continue;
      const t = types.get(ref);
      if (t === undefined) problems.push(`${o.id} (objects[${i}]) ${end}: no object with id "${ref}"`);
      else if (t !== 'room') problems.push(`${o.id} (objects[${i}]) ${end}: "${ref}" is a ${t}, not a room`);
    }
    if (!o.path && (!o.from || !o.to)) {
      problems.push(`${o.id} (objects[${i}]): a corridor without "path" needs both "from" and "to"`);
    }
    if (o.from !== undefined && o.from === o.to) {
      problems.push(`${o.id} (objects[${i}]): "from" and "to" are the same room`);
    }
  });
  return problems;
}

/**
 * Returns the map unchanged if valid, otherwise throws ValidationError listing every problem.
 * `was`: the map before an edit (applyOps), whose style settings the edit left alone aren't checked again.
 */
export function validateMap(input: unknown, was?: Pick<DelveMap, 'style'>): DelveMap {
  const parsed = MapDoc.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap(flatten).map((iss) => describeIssue(iss, input));
    throw new ValidationError([...new Set(problems)]);
  }
  const problems = [...checkStyle(parsed.data, was), ...checkReferences(parsed.data)];
  if (problems.length) throw new ValidationError(problems);
  // Return the caller's object, not zod's copy, so identity and key order are kept.
  return input as DelveMap;
}
