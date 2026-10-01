import { roll, type RollResult } from '@delve/table';
import { describe, expect, it } from 'vitest';
import {
  canonicalLabels,
  cross,
  diceForRolls,
  dieShape,
  dot,
  faceFrames,
  faceValues,
  insetFace,
  labelsFor,
  labelText,
  MAX_THROWN,
  normalize,
  randomQuat,
  remapLabels,
  rotate,
  seededRandom,
  topSite,
  type DieKind,
  type Quat,
  type Vec3,
} from '../src/table/dice3d-logic.ts';
import { FLAT, MAX_STEPS, simulate, throwDice, type Arena, type Recording } from '../src/table/dice3d-sim.ts';

const KINDS: DieKind[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100t', 'd100u', 'dF'];
const FACES: Record<DieKind, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100t: 10, d100u: 10, dF: 6 };
const arena: Arena = { x0: -14, x1: 14, z0: -9, z1: 9 };

/** An RNG for roll() that returns these faces in turn. */
const seq = (...faces: number[]) => {
  let i = 0;
  return (_sides: number) => faces[i++ % faces.length] ?? 1;
};

/** The rotation that turns unit vector a onto b. */
function quatFromTo(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  const n = Math.hypot(c[0], c[1], c[2], 1 + d);
  return [c[0] / n, c[1] / n, c[2] / n, (1 + d) / n];
}

const finalQuat = (rec: Recording, i: number): Quat => {
  const n = rec.tops.length;
  const o = ((rec.steps - 1) * n + i) * 7;
  const f = (k: number) => rec.frames[o + k] ?? 0;
  return [f(3), f(4), f(5), f(6)];
};

describe('3D dice: which dice a roll throws', () => {
  it('throws one die per rolled die, showing its value', () => {
    expect(diceForRolls([roll('2d6+1d20+3', seq(3, 5, 17))])).toEqual({
      dice: [
        { kind: 'd6', value: 3, dropped: false },
        { kind: 'd6', value: 5, dropped: false },
        { kind: 'd20', value: 17, dropped: false },
      ],
      more: 0,
    });
    const mixed = diceForRolls([roll('1d4+1d8+1d10+1d12', seq(2, 7, 10, 11))]).dice;
    expect(mixed.map((d) => `${d.kind}:${d.value}`)).toEqual(['d4:2', 'd8:7', 'd10:10', 'd12:11']);
  });

  it('marks dropped dice, throws exploded ones, and leaves rerolled ones out', () => {
    expect(diceForRolls([roll('2d20kh1+5', seq(4, 15))]).dice).toEqual([
      { kind: 'd20', value: 4, dropped: true },
      { kind: 'd20', value: 15, dropped: false },
    ]);
    // the 1 is rerolled into a 4: only the 4 and the 6 are thrown
    expect(diceForRolls([roll('2d6r1', seq(1, 4, 6))]).dice.map((d) => d.value)).toEqual([4, 6]);
    expect(diceForRolls([roll('1d6!', seq(6, 2))]).dice.map((d) => d.value)).toEqual([6, 2]);
  });

  it('splits a d100 into a tens and a units die (00 + 0 is 100)', () => {
    const split = (v: number) => diceForRolls([roll('d100', seq(v))]).dice.map((d) => `${d.kind}:${labelText(d.kind, d.value)}`);
    expect(split(57)).toEqual(['d100t:50', 'd100u:7']);
    expect(split(5)).toEqual(['d100t:00', 'd100u:5']);
    expect(split(10)).toEqual(['d100t:10', 'd100u:0']);
    expect(split(100)).toEqual(['d100t:00', 'd100u:0']);
    expect(diceForRolls([roll('2d%kh1', seq(30, 99))]).dice.map((d) => d.dropped)).toEqual([true, true, false, false]);
  });

  it('throws fate dice as dF: +, −, or blank', () => {
    const t = diceForRolls([roll('4dF', seq(1, 2, 3, 3))]).dice;
    expect(t.map((d) => d.kind)).toEqual(['dF', 'dF', 'dF', 'dF']);
    expect(t.map((d) => labelText(d.kind, d.value))).toEqual(['−', '', '+', '+']);
  });

  it('skips sizes that have no die (the chat card shows them)', () => {
    expect(diceForRolls([roll('1d3+1d7+1d6+1d2', seq(2, 5, 4, 1))])).toEqual({ dice: [{ kind: 'd6', value: 4, dropped: false }], more: 0 });
  });

  it('throws at most 20 dice and counts the rest', () => {
    const many = diceForRolls([roll('25d6', seq(3))]);
    expect(many.dice).toHaveLength(MAX_THROWN);
    expect(many.more).toBe(5);
    // a d100 needs two dice, which don't fit after 19
    const tight = diceForRolls([roll('19d6+1d100', seq(3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 42))]);
    expect(tight.dice).toHaveLength(19);
    expect(tight.more).toBe(1);
  });

  it('throws every roll of a message (inline rolls too), and nothing for a hidden GM roll', () => {
    const rolls: RollResult[] = [roll('1d20', seq(12)), roll('2d4', seq(1, 4))];
    expect(diceForRolls(rolls).dice.map((d) => d.kind)).toEqual(['d20', 'd4', 'd4']);
    expect(diceForRolls(undefined)).toEqual({ dice: [], more: 0 });
  });
});

describe('3D dice: the shapes', () => {
  it('has the right faces, each flat, counter-clockwise and facing out (the d10 is ten kites)', () => {
    for (const kind of KINDS) {
      const s = dieShape(kind);
      expect(s.faces, kind).toHaveLength(FACES[kind]);
      s.faces.forEach((f, fi) => {
        const n = s.normals[fi]!;
        expect(Math.hypot(...n)).toBeCloseTo(1, 9);
        const ps = f.map((i) => s.vertices[i]!);
        const d = dot(n, ps[0]!);
        expect(d, `${kind} face ${fi} faces out`).toBeGreaterThan(0);
        for (const p of ps) expect(dot(n, p)).toBeCloseTo(d, 9);
        for (let k = 0; k < ps.length; k++) {
          const a = ps[k]!;
          const b = ps[(k + 1) % ps.length]!;
          const c = ps[(k + 2) % ps.length]!;
          expect(dot(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - b[0], c[1] - b[1], c[2] - b[2]]), n)).toBeGreaterThan(0);
        }
      });
    }
    const d10 = dieShape('d10');
    expect(d10.vertices).toHaveLength(12);
    expect(d10.faces.every((f) => f.length === 4)).toBe(true);
    expect(faceFrames('d10').frames).toHaveLength(10);
  });

  it('insets each face by the same width all round, in its own plane (the rounded edges)', () => {
    for (const kind of KINDS) {
      const s = dieShape(kind);
      s.faces.forEach((f, fi) => {
        const n = s.normals[fi]!;
        const ps = f.map((i) => s.vertices[i]!);
        const inner = insetFace(kind, fi, 0.08);
        for (let k = 0; k < ps.length; k++) {
          expect(dot(n, inner[k]!)).toBeCloseTo(dot(n, ps[0]!), 9);
          // the inset corner is 0.08 from both edges that meet at the corner
          for (const [a, b] of [
            [ps[k]!, ps[(k + 1) % ps.length]!],
            [ps[(k + ps.length - 1) % ps.length]!, ps[k]!],
          ] as const) {
            const e = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
            const d: Vec3 = [inner[k]![0] - a[0], inner[k]![1] - a[1], inner[k]![2] - a[2]];
            expect(dot(d, cross(n, e)), `${kind} face ${fi} corner ${k}`).toBeCloseTo(0.08, 9);
          }
        }
      });
    }
  });

  it('puts every value on some face, opposite faces adding up like real dice', () => {
    const sums: Partial<Record<DieKind, number>> = { d6: 7, d8: 9, d10: 11, d12: 13, d20: 21, d100t: 90, d100u: 9 };
    for (const kind of KINDS) {
      const labels = canonicalLabels(kind);
      const s = dieShape(kind);
      expect([...labels].sort((a, b) => a - b), kind).toEqual(faceValues(kind).sort((a, b) => a - b));
      if (kind === 'd4') {
        expect(s.sites).toBe('vertices');
        expect(s.opposite.every((j) => j === -1)).toBe(true);
        continue;
      }
      labels.forEach((v, i) => {
        const across = labels[s.opposite[i]!]!;
        if (kind === 'dF') expect(across + v, 'dF: + faces −, blank faces blank').toBe(0);
        else expect(v + across, kind).toBe(sums[kind]);
      });
    }
  });
});

describe('3D dice: the top face and the labels', () => {
  it('finds the face (the d4: the corner) that is turned up', () => {
    for (const kind of KINDS) {
      dieShape(kind).siteDirs.forEach((dir, i) => {
        const t = topSite(kind, quatFromTo(dir, [0, 1, 0]));
        expect(t.site, `${kind} site ${i}`).toBe(i);
        expect(t.up).toBeCloseTo(1, 9);
      });
    }
  });

  it('rotates vectors like a quaternion should', () => {
    const q = quatFromTo([1, 0, 0], [0, 0, 1]);
    const v = rotate(q, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[2]).toBeCloseTo(1, 9);
  });

  it('remaps the labels so any face shows any value, keeping the opposite faces paired', () => {
    for (const kind of KINDS) {
      const s = dieShape(kind);
      const canon = canonicalLabels(kind);
      const sum = s.opposite[0]! >= 0 ? canon[0]! + canon[s.opposite[0]!]! : 0;
      for (let top = 0; top < canon.length; top++) {
        for (const value of new Set(faceValues(kind))) {
          const labels = remapLabels(canon, s.opposite, top, value);
          expect(labels[top], `${kind} top ${top} shows ${value}`).toBe(value);
          expect([...labels].sort((a, b) => a - b)).toEqual([...canon].sort((a, b) => a - b));
          labels.forEach((v, i) => {
            const j = s.opposite[i]!;
            if (j < 0) return;
            if (kind === 'dF') expect(labels[j]! + v).toBe(0);
            else expect(v + labels[j]!).toBe(sum);
          });
        }
      }
    }
  });

  it('shows the value on top whatever way the die came to rest', () => {
    const rand = seededRandom('rotations');
    for (const kind of KINDS) {
      for (let k = 0; k < 40; k++) {
        const q = randomQuat(rand);
        for (const value of new Set(faceValues(kind))) expect(labelsFor(kind, q, value)[topSite(kind, q).site]).toBe(value);
      }
    }
  });
});

describe('3D dice: the throw', () => {
  it('is the same for the same seed, and different for another', () => {
    const kinds: DieKind[] = ['d20', 'd6', 'd10', 'd4'];
    const a = throwDice(kinds, 'm12:1790000000000', arena);
    const b = throwDice(kinds, 'm12:1790000000000', arena);
    expect(b.steps).toBe(a.steps);
    expect(b.tops).toEqual(a.tops);
    expect(Array.from(b.frames)).toEqual(Array.from(a.frames));
    const c = simulate(kinds, seededRandom('m13:1790000000001'), arena);
    expect(Array.from(c.frames.slice(0, 28))).not.toEqual(Array.from(a.frames.slice(0, 28)));
  });

  it('brings every die type to rest, flat, inside the walls, within the time limit', () => {
    for (const kind of KINDS) {
      for (let seed = 0; seed < 4; seed++) {
        const rec = throwDice([kind], `${kind}-${seed}`, arena);
        expect(rec.rested, `${kind} seed ${seed} rests`).toBe(true);
        expect(rec.steps).toBeLessThanOrEqual(MAX_STEPS + 1);
        expect(rec.tilt[0], `${kind} seed ${seed} lies flat`).toBeGreaterThanOrEqual(FLAT);
      }
    }
    const kinds: DieKind[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100t', 'd100u', 'dF', 'd20', 'd6', 'd6', 'd6', 'd6', 'd8', 'd10', 'd12', 'd4', 'd20', 'd20'];
    const rec = throwDice(kinds, 'twenty', arena);
    expect(rec.rested).toBe(true);
    const last = (rec.steps - 1) * kinds.length * 7;
    for (let i = 0; i < kinds.length; i++) {
      const x = rec.frames[last + i * 7]!;
      const y = rec.frames[last + i * 7 + 1]!;
      const z = rec.frames[last + i * 7 + 2]!;
      expect(x).toBeGreaterThan(arena.x0);
      expect(x).toBeLessThan(arena.x1);
      expect(z).toBeGreaterThan(arena.z0);
      expect(z).toBeLessThan(arena.z1);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(4);
    }
  });

  it('ends with each die showing the rolled value on top', () => {
    const { dice } = diceForRolls([roll('2d20kh1+4d6+d100+4dF+1d4+1d8+1d10+1d12', seq(20, 1, 6, 3, 2, 3, 77, 1, 2, 3, 2, 4, 8, 10, 12))]);
    const rec = throwDice(
      dice.map((d) => d.kind),
      'm99:1',
      arena,
    );
    dice.forEach((d, i) => {
      const q = finalQuat(rec, i);
      const labels = labelsFor(d.kind, q, d.value);
      expect(labels[topSite(d.kind, q).site], `${d.kind} shows ${d.value}`).toBe(d.value);
      expect(topSite(d.kind, q).site).toBe(rec.tops[i]);
    });
  });
});
