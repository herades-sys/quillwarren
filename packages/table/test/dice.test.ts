import { describe, expect, it } from 'vitest';
import { DiceError, MAX_DICE, roll, rollInline, TableError, type RollTerm } from '../src/index.ts';
import { seq } from './fixtures.ts';

type DiceTerm = Extract<RollTerm, { kind: 'dice' }>;
const diceOf = (terms: RollTerm[], i = 0): DiceTerm => terms.filter((t): t is DiceTerm => t.kind === 'dice')[i]!;
const values = (t: DiceTerm): number[] => t.dice.map((d) => d.value);
const counted = (t: DiceTerm): number[] => t.dice.filter((d) => !d.dropped).map((d) => d.value);
const ones = (): number => 1;

describe('roll: arithmetic and terms', () => {
  it('rolls NdX plus a number and lists every term in order', () => {
    const r = roll('2d6+3', seq(3, 5));
    expect(r).toEqual({
      expr: '2d6+3',
      total: 11,
      terms: [
        { kind: 'dice', text: '2d6', count: 2, sides: 6, dice: [{ value: 3 }, { value: 5 }], value: 8 },
        { kind: 'op', op: '+' },
        { kind: 'number', value: 3 },
      ],
    });
  });

  it('honours precedence, parentheses and left associativity', () => {
    expect(roll('2+3*4', seq()).total).toBe(14);
    expect(roll('(2+3)*4', seq()).total).toBe(20);
    expect(roll('1-2-3', seq()).total).toBe(-4);
    expect(roll('12/2/3', seq()).total).toBe(2);
    expect(roll('2*(3+(4-1))', seq()).total).toBe(12);
    expect(roll('(2+3)*4', seq()).terms.map((t) => (t.kind === 'op' ? t.op : t.value))).toEqual(['(', 2, '+', 3, ')', '*', 4]);
  });

  it('handles unary minus', () => {
    expect(roll('-3', seq()).total).toBe(-3);
    expect(roll('2*-3', seq()).total).toBe(-6);
    expect(roll('--4', seq()).total).toBe(4);
    const r = roll('-(2d4)', seq(1, 2));
    expect(r.total).toBe(-3);
    expect(r.terms.map((t) => t.kind)).toEqual(['op', 'op', 'dice', 'op']);
  });

  it('divides towards zero, so totals stay whole', () => {
    expect(roll('10/3', seq()).total).toBe(3);
    expect(roll('7/2', seq()).total).toBe(3);
    expect(roll('-7/2', seq()).total).toBe(-3);
    expect(Object.is(roll('-1/2', seq()).total, 0)).toBe(true);
  });

  it('defaults N to 1 and knows d% and fate dice', () => {
    expect(roll('d20', seq(17))).toMatchObject({ total: 17, terms: [{ kind: 'dice', count: 1, sides: 20 }] });
    expect(roll('d%', seq(42))).toMatchObject({ total: 42, terms: [{ sides: 100 }] });
    const fate = roll('4dF', seq(1, 2, 3, 3));
    expect(values(diceOf(fate.terms))).toEqual([-1, 0, 1, 1]);
    expect(fate.total).toBe(1);
    expect(diceOf(fate.terms).sides).toBe('F');
  });

  it('asks the rng with the number of sides (3 for fate dice)', () => {
    const asked: number[] = [];
    roll('1d20 + 2d6 + dF', (s) => (asked.push(s), 1));
    expect(asked).toEqual([20, 6, 6, 3]);
  });

  it('allows spaces between tokens and any letter case', () => {
    expect(roll('  2d6 +  3 ', seq(1, 1))).toMatchObject({ expr: '2d6 +  3', total: 5 });
    expect(roll('2D6KH1', seq(3, 5)).total).toBe(5);
  });

  it('rolls 1000 dice but not 1001', () => {
    expect(roll(`${MAX_DICE}d6`, ones).total).toBe(1000);
    expect(() => roll('1001d6', ones)).toThrow(new DiceError('Too many dice (max 1000)'));
    expect(() => roll('600d6 + 401d6', ones)).toThrow('Too many dice (max 1000)');
  });
});

describe('roll: modifiers', () => {
  it('keeps and drops the highest or lowest (ties go by position)', () => {
    const kh = diceOf(roll('4d6kh3', seq(2, 6, 2, 5)).terms);
    expect(kh.value).toBe(13);
    expect(kh.dice).toEqual([{ value: 2 }, { value: 6 }, { value: 2, dropped: true }, { value: 5 }]);
    expect(roll('2d20kh', seq(4, 15)).total).toBe(15);
    expect(roll('2d20kl1', seq(4, 15)).total).toBe(4);
    expect(roll('4d6k2', seq(2, 6, 2, 5)).total).toBe(11);
    const dl = diceOf(roll('4d6dl1', seq(2, 6, 2, 5)).terms);
    expect(dl.dice.map((d) => Boolean(d.dropped))).toEqual([true, false, false, false]);
    expect(dl.value).toBe(13);
    expect(roll('4d6d1', seq(2, 6, 2, 5)).total).toBe(13);
    expect(roll('4d6dh1', seq(2, 6, 2, 5)).total).toBe(9);
    expect(roll('2d6kh5', seq(2, 3)).total).toBe(5);
  });

  it('explodes on the maximum, or on a compare point', () => {
    const t = diceOf(roll('3d6!', seq(6, 4, 2, 6, 1)).terms);
    expect(t.dice).toEqual([{ value: 6, exploded: true }, { value: 4 }, { value: 2 }, { value: 6, exploded: true }, { value: 1 }]);
    expect(t.value).toBe(19);
    expect(roll('2d6!>5', seq(5, 1, 3)).total).toBe(9);
    expect(roll('1d6!=3', seq(3, 3, 2)).total).toBe(8);
    expect(roll('1d6!2', seq(2, 6)).total).toBe(8);
    // a bare minus after ! is subtraction, not a compare point
    expect(roll('2d6!-1', seq(3, 4)).total).toBe(6);
  });

  it('caps explosions at 100 extra dice', () => {
    const t = diceOf(roll('1d1!', ones).terms);
    expect(t.dice).toHaveLength(101);
    expect(t.value).toBe(101);
    expect(t.dice.at(-1)).toEqual({ value: 1 });
  });

  it('rerolls while a die matches, keeping the replaced rolls as dropped', () => {
    const t = diceOf(roll('2d6r', seq(1, 1, 4, 5)).terms);
    expect(t.dice).toEqual([
      { value: 1, rerolled: true, dropped: true },
      { value: 1, rerolled: true, dropped: true },
      { value: 4 },
      { value: 5 },
    ]);
    expect(t.value).toBe(9);
    expect(roll('2d6r<2', seq(2, 6, 1, 3)).total).toBe(9);
    expect(roll('1d6r>5', seq(6, 5, 2)).total).toBe(2);
    expect(roll('1d6r3r5', seq(3, 5, 3, 4)).total).toBe(4);
  });

  it('rerolls once with ro', () => {
    const t = diceOf(roll('1d6ro', seq(1, 1)).terms);
    expect(t.dice).toEqual([{ value: 1, rerolled: true, dropped: true }, { value: 1 }]);
    expect(roll('1d6ro<3', seq(2, 1)).total).toBe(1);
  });

  it('caps rerolls at 100', () => {
    const t = diceOf(roll('1d6r<6', () => 3).terms);
    expect(t.dice).toHaveLength(101);
    expect(counted(t)).toEqual([3]);
  });

  it('counts successes and failures instead of summing', () => {
    const t = diceOf(roll('5d10>8', seq(9, 3, 10, 8, 1)).terms);
    expect(t.value).toBe(3);
    expect(t.dice.map((d) => Boolean(d.success))).toEqual([true, false, true, true, false]);
    expect(roll('3d6<2', seq(1, 2, 3)).total).toBe(2);
    expect(roll('3d6=2', seq(1, 2, 3)).total).toBe(1);
    const sf = diceOf(roll('5d10>8f1', seq(9, 3, 10, 1, 1)).terms);
    expect(sf.value).toBe(0);
    expect(sf.dice.filter((d) => d.failure)).toHaveLength(2);
    expect(roll('4d6f<2', seq(1, 2, 5, 6)).total).toBe(-2);
    expect(roll('3d6>4 + 1', seq(5, 4, 1)).total).toBe(3);
    expect(roll('4dF>1', seq(3, 3, 1, 2)).total).toBe(2);
    expect(roll('4dF<-1', seq(1, 1, 3, 2)).total).toBe(2);
  });

  it('counts only kept dice', () => {
    expect(roll('4d6kh3>5', seq(2, 6, 2, 5)).total).toBe(2);
  });

  it('combines reroll, explode and keep', () => {
    // 1 is rerolled to 6, which explodes into 3; then the highest two of 6, 3, 2 are kept.
    const t = diceOf(roll('2d6r1!kh2', seq(1, 6, 3, 2)).terms);
    expect(t.dice).toEqual([
      { value: 1, rerolled: true, dropped: true },
      { value: 6, exploded: true },
      { value: 3 },
      { value: 2, dropped: true },
    ]);
    expect(t.value).toBe(9);
  });
});

describe('roll: errors', () => {
  const cases: [string, string][] = [
    ['2d6x', "Unexpected 'x' at 4"],
    ['', 'Nothing to roll'],
    ['   ', 'Nothing to roll'],
    ['2d', 'Unexpected end of roll'],
    ['(1+2', 'Unexpected end of roll'],
    ['1+2)', "Unexpected ')' at 4"],
    ['1.5', "Unexpected '.' at 2"],
    ['2 d6', "Unexpected 'd' at 3"],
    ['d6!!', "Unexpected '!' at 4"],
    ['1/0', 'Division by zero'],
    ['2d0', 'Dice need 1 to 1000000 sides (at 3)'],
    ['1d1000001', 'Dice need 1 to 1000000 sides (at 3)'],
    ['2d6kh1kl1', 'Only one keep or drop per dice term (at 7)'],
    ['2d6>3>4', 'Only one success check per dice term (at 6)'],
    ['2d6f', 'Unexpected end of roll'],
    ['99999999999', 'Number too large at 1 (max 1000000000)'],
    ['hello', "Unexpected 'h' at 1"],
  ];
  for (const [expr, message] of cases) {
    it(`"${expr}" fails with "${message}"`, () => {
      expect(() => roll(expr, ones)).toThrow(new DiceError(message));
    });
  }

  it('limits expressions to 200 characters', () => {
    const long = `${'1+'.repeat(100)}1`;
    expect(() => roll(long, ones)).toThrow('Roll too long (max 200 characters)');
    expect(roll(long.slice(2), ones).total).toBe(100);
  });

  it('throws DiceError, which is a TableError', () => {
    try {
      roll('2d6x', ones);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DiceError);
      expect(e).toBeInstanceOf(TableError);
    }
  });
});

describe('rollInline', () => {
  it('replaces each [[expr]] with a marker into rolls', () => {
    const r = rollInline('I hit for [[2d6+1]] and [[1d4]]!', seq(3, 4, 2));
    expect(r.text).toBe('I hit for {{roll:0}} and {{roll:1}}!');
    expect(r.rolls.map((x) => [x.expr, x.total])).toEqual([
      ['2d6+1', 8],
      ['1d4', 2],
    ]);
  });

  it('leaves text without complete brackets alone', () => {
    expect(rollInline('no rolls [[2d6 here', ones)).toEqual({ text: 'no rolls [[2d6 here', rolls: [] });
  });

  it('breaks up markers people type themselves', () => {
    const r = rollInline('fake {{roll:0}} and [[1]]', ones);
    expect(r.text).toBe('fake {​{roll:0}} and {{roll:0}}');
    expect(r.text.match(/\{\{roll:\d+\}\}/g)).toEqual(['{{roll:0}}']);
  });

  it('fails the whole line on a bad roll or too many rolls', () => {
    expect(() => rollInline('ok [[2d6x]]', ones)).toThrow("Unexpected 'x' at 4");
    expect(() => rollInline('[[1]]'.repeat(21), ones)).toThrow('Too many inline rolls (max 20)');
    expect(rollInline('[[1]]'.repeat(20), ones).rolls).toHaveLength(20);
  });
});
