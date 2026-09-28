import { describe, expect, it } from 'vitest';
import { validateMap, ValidationError, type DelveMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

function problemsOf(map: unknown): string[] {
  try {
    validateMap(map);
  } catch (e) {
    if (e instanceof ValidationError) return e.problems;
    throw e;
  }
  return [];
}

describe('validateMap', () => {
  it('accepts the test dungeon and returns the same object', () => {
    const map = testMap();
    expect(validateMap(map)).toBe(map);
  });

  it('rejects a duplicate id and names both objects', () => {
    const map = testMap();
    map.objects.push({ ...map.objects[0]!, name: 'Copy' } as DelveMap['objects'][number]);
    const [p] = problemsOf(map);
    expect(p).toMatch(/^r1 \(objects\[\d+\]\): duplicate id, already used by objects\[0\]$/);
  });

  it('rejects an unknown type with the list of known ones', () => {
    const map = testMap() as unknown as { objects: unknown[] };
    map.objects.push({ id: 'x1', type: 'trapdoor', at: [1, 1] });
    const [p] = problemsOf(map);
    expect(p).toContain('x1 (objects[');
    expect(p).toContain('unknown type "trapdoor"');
    expect(p).toContain('room, corridor, cutout, door, stairs, label, prop');
  });

  it('rejects a negative corridor width, naming id and field', () => {
    const map = testMap();
    const c1 = map.objects.find((o) => o.id === 'c1')!;
    (c1 as { width: number }).width = -2;
    expect(problemsOf(map)).toEqual([expect.stringMatching(/^c1 \(objects\[\d+\]\) width: must be greater than 0$/)]);
  });

  it('reports the field inside a shape, not just "invalid input"', () => {
    const map = testMap();
    (map.objects[0] as { shape: unknown }).shape = { rect: [7, 25, -6, 6] };
    expect(problemsOf(map)).toEqual(['r1 (objects[0]) shape.rect[2]: must be greater than 0']);
  });

  it('rejects unknown fields and dangling corridor references', () => {
    const map = testMap();
    (map.objects[0] as Record<string, unknown>).colour = 'red';
    const c2 = map.objects.find((o) => o.id === 'c2') as { to: string };
    c2.to = 'r99';
    const problems = problemsOf(map);
    expect(problems).toContain('r1 (objects[0]): unknown field "colour"');
    // schema errors come first; fix the field and the reference check runs
    delete (map.objects[0] as Record<string, unknown>).colour;
    expect(problemsOf(map)).toEqual([expect.stringContaining('c2 (objects[')]);
    expect(problemsOf(map)[0]).toContain('to: no object with id "r99"');
  });

  it('requires from and to on a corridor without a path', () => {
    const map = testMap();
    map.objects.push({ id: 'c9', type: 'corridor', from: 'r1', width: 1 });
    expect(problemsOf(map)[0]).toContain('c9 (objects[');
    expect(problemsOf(map)[0]).toContain('needs both "from" and "to"');
  });
});
