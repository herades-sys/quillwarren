import { describe, expect, it } from 'vitest';
import { applyOps, OpError, parseOps, ValidationError, type Op } from '../src/index.ts';
import { testMap } from './fixtures.ts';

describe('applyOps', () => {
  const batches: [string, Op[]][] = [
    ['add a room', [{ op: 'add', object: { id: 'r7', type: 'room', shape: { rect: [0, 25, 5, 5] }, label: '7', name: 'Flooded cellar' } }]],
    ['move the pillars', [{ op: 'move', ids: ['p1', 'p2', 'p3', 'p4'], dx: 0, dy: 1 }]],
    ['update a door', [{ op: 'update', id: 'd6', set: { style: 'normal', open: true } }]],
    ['delete doors', [{ op: 'delete', ids: ['d5', 'd2'] }]],
    ['unset a field', [{ op: 'update', id: 'r5', unset: ['notes'] }]],
    [
      'a mixed batch',
      [
        { op: 'add', object: { id: 'r7', type: 'room', shape: { rect: [0, 25, 5, 5] } }, index: 0 },
        { op: 'add', object: { id: 'c6', type: 'corridor', from: 'r1', to: 'r7', width: 1 } },
        { op: 'batch', ops: [{ op: 'move', ids: ['r6', 'c5', 'd6'], dx: 0.5, dy: -1 }] },
        { op: 'delete', ids: ['d1'] },
        { op: 'update', id: 'r7', set: { name: 'Cellar' } },
      ],
    ],
  ];

  for (const [name, ops] of batches) {
    it(`undoes "${name}" exactly`, () => {
      const original = testMap();
      const { map, inverse } = applyOps(original, ops);
      expect(map).not.toEqual(original);
      expect(applyOps(map, inverse).map).toEqual(original);
    });
  }

  it('never changes the input map', () => {
    const original = testMap();
    const snapshot = structuredClone(original);
    applyOps(original, [{ op: 'move', ids: ['r1'], dx: 1, dy: 1 }]);
    expect(original).toEqual(snapshot);
  });

  it('is atomic: a failing op leaves nothing half-applied', () => {
    const original = testMap();
    expect(() =>
      applyOps(original, [
        { op: 'move', ids: ['r1'], dx: 3, dy: 0 },
        { op: 'delete', ids: ['nope'] },
      ]),
    ).toThrow(new OpError('ops[1] (delete): no object with id "nope"'));
    expect(original).toEqual(testMap());
  });

  it('rejects results that would not validate', () => {
    // deleting a room that corridors point at leaves dangling references
    expect(() => applyOps(testMap(), [{ op: 'delete', ids: ['r3'] }])).toThrow(/c2 .*from|c2 .*to/);
    expect(() => applyOps(testMap(), [{ op: 'update', id: 'c1', set: { width: 0 } }])).toThrow(/width: must be greater than 0/);
  });

  it('refuses to change id or type', () => {
    expect(() => applyOps(testMap(), [{ op: 'update', id: 'r1', set: { id: 'r100' } }])).toThrow(/"id" can't be changed/);
  });

  it('refuses duplicate ids on add', () => {
    expect(() =>
      applyOps(testMap(), [{ op: 'add', object: { id: 'r1', type: 'label', text: 'x', at: [0, 0] } }]),
    ).toThrow(/id "r1" is already in use/);
  });
});

describe('parseOps', () => {
  it('accepts well-formed ops including nested batches', () => {
    const ops = parseOps([{ op: 'batch', ops: [{ op: 'move', ids: ['r1'], dx: 1, dy: 0 }] }]);
    expect(ops).toHaveLength(1);
  });

  it('rejects malformed ops with a path', () => {
    expect(() => parseOps([{ op: 'move', ids: [], dx: 1, dy: 0 }])).toThrow(ValidationError);
    expect(() => parseOps([{ op: 'teleport' }])).toThrow(/ops\[0\]/);
  });
});
