// Dice: Roll20-style notation (docs/TABLE.md, "Dice notation"), read by a small
// recursive-descent parser and rolled with the RNG the caller passes in (the
// server uses crypto.randomInt, tests a fixed sequence).
//
//   expr    = product (('+' | '-') product)*
//   product = unary (('*' | '/') unary)*
//   unary   = ('-' | '+') unary | primary
//   primary = '(' expr ')' | dice | number
//   dice    = [number] 'd' (number | 'F' | '%') modifier*     (no spaces inside)
//
// Modifiers: kh/kl/dh/dl[N] (bare k = kh, bare d = dl), ! / !N / !>N / !<N,
// r / rN / r>N / r<N (repeatable), ro (once), >N / <N / =N successes, fN / f<N / f>N failures.
// Compare points work as in Roll20: ">N" means N or more, "<N" N or less, "N" or "=N" exactly N.
// Division rounds toward zero (Math.trunc, the same as Math.floor for positive
// results), so every total is a whole number.
import { DiceError } from './errors.ts';
import type { Die, RollResult, RollTerm } from './protocol.ts';

export const MAX_EXPR = 200;
export const MAX_DICE = 1000;
/** Per dice term: at most this many extra dice from explosions, and this many rerolls. */
export const MAX_EXTRA = 100;
export const MAX_SIDES = 1_000_000;
export const MAX_INLINE = 20;
const MAX_NUMBER = 1_000_000_000;

export type Rng = (sides: number) => number;

interface Compare {
  op: '=' | '>' | '<';
  n: number;
}

interface DiceMods {
  keep?: { mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number };
  explode?: Compare;
  reroll: Compare[];
  rerollOnce: Compare[];
  success?: Compare;
  failure?: Compare;
}

type Node =
  | { t: 'num'; value: number }
  | { t: 'dice'; text: string; count: number; sides: number | 'F'; mods: DiceMods }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node }
  | { t: 'unary'; op: '+' | '-'; arg: Node }
  | { t: 'group'; inner: Node };

const isDigit = (c: string): boolean => c >= '0' && c <= '9' && c.length === 1;

function parse(src: string): Node {
  let pos = 0;
  let diceTotal = 0;
  const at = (): string => src[pos] ?? '';
  const lower = (): string => at().toLowerCase();

  const unexpected = (): never => {
    if (pos >= src.length) throw new DiceError('Unexpected end of roll');
    throw new DiceError(`Unexpected '${src[pos]}' at ${pos + 1}`);
  };
  const space = (): void => {
    while (pos < src.length && /\s/.test(at())) pos++;
  };

  function number(): number {
    const start = pos;
    while (isDigit(at())) pos++;
    if (pos === start) return unexpected();
    const value = Number(src.slice(start, pos));
    if (value > MAX_NUMBER) throw new DiceError(`Number too large at ${start + 1} (max ${MAX_NUMBER})`);
    return value;
  }

  // A compare point: ">N", "<N", "=N" or a bare "N". After >, < or = the number
  // may be negative (fate dice); a bare "-" is subtraction ("2d6!-1").
  function compare(): Compare | undefined {
    const c = at();
    if (isDigit(c)) return { op: '=', n: number() };
    if (c !== '>' && c !== '<' && c !== '=') return undefined;
    pos++;
    const negative = at() === '-';
    if (negative) pos++;
    const n = number();
    return { op: c, n: negative ? -n : n };
  }

  function modifiers(sides: number | 'F'): DiceMods {
    const mods: DiceMods = { reroll: [], rerollOnce: [] };
    const min = sides === 'F' ? -1 : 1;
    const max = sides === 'F' ? 1 : sides;
    const once = (what: string, taken: unknown, start: number): void => {
      if (taken) throw new DiceError(`Only one ${what} per dice term (at ${start + 1})`);
    };
    for (;;) {
      const start = pos;
      const c = lower();
      if (c === 'k' || c === 'd') {
        pos++;
        const hl = lower();
        let mode: 'kh' | 'kl' | 'dh' | 'dl' = c === 'k' ? 'kh' : 'dl';
        if (hl === 'h' || hl === 'l') {
          pos++;
          mode = `${c}${hl}` as typeof mode;
        }
        once('keep or drop', mods.keep, start);
        mods.keep = { mode, n: isDigit(at()) ? number() : 1 };
      } else if (c === '!') {
        pos++;
        if (at() === '!') return unexpected(); // compounding (!!) isn't supported
        once('explode', mods.explode, start);
        mods.explode = compare() ?? { op: '=', n: max };
      } else if (c === 'r') {
        pos++;
        const isOnce = lower() === 'o';
        if (isOnce) pos++;
        (isOnce ? mods.rerollOnce : mods.reroll).push(compare() ?? { op: '=', n: min });
      } else if (c === '>' || c === '<' || c === '=') {
        once('success check', mods.success, start);
        mods.success = compare();
      } else if (c === 'f') {
        pos++;
        once('failure check', mods.failure, start);
        mods.failure = compare() ?? unexpected();
      } else {
        return mods;
      }
    }
  }

  function primary(): Node {
    space();
    const c = lower();
    if (c === '(') {
      pos++;
      const inner = expr();
      space();
      if (at() !== ')') return unexpected();
      pos++;
      return { t: 'group', inner };
    }
    if (!isDigit(c) && c !== 'd') return unexpected();
    const start = pos;
    const count = isDigit(c) ? number() : 1;
    if (lower() !== 'd') return { t: 'num', value: count };
    pos++;
    let sides: number | 'F';
    const s = lower();
    if (s === 'f') {
      pos++;
      sides = 'F';
    } else if (s === '%') {
      pos++;
      sides = 100;
    } else {
      const sidesAt = pos;
      sides = number();
      if (sides < 1 || sides > MAX_SIDES) throw new DiceError(`Dice need 1 to ${MAX_SIDES} sides (at ${sidesAt + 1})`);
    }
    diceTotal += count;
    if (diceTotal > MAX_DICE) throw new DiceError(`Too many dice (max ${MAX_DICE})`);
    const mods = modifiers(sides);
    return { t: 'dice', text: src.slice(start, pos), count, sides, mods };
  }

  function unary(): Node {
    space();
    const c = at();
    if (c === '-' || c === '+') {
      pos++;
      return { t: 'unary', op: c, arg: unary() };
    }
    return primary();
  }

  function product(): Node {
    let left = unary();
    for (;;) {
      space();
      const c = at();
      if (c !== '*' && c !== '/') return left;
      pos++;
      left = { t: 'bin', op: c, left, right: unary() };
    }
  }

  function expr(): Node {
    let left = product();
    for (;;) {
      space();
      const c = at();
      if (c !== '+' && c !== '-') return left;
      pos++;
      left = { t: 'bin', op: c, left, right: product() };
    }
  }

  space();
  if (pos >= src.length) throw new DiceError('Nothing to roll');
  const node = expr();
  space();
  if (pos < src.length) unexpected();
  return node;
}

function matches(value: number, c: Compare): boolean {
  return c.op === '>' ? value >= c.n : c.op === '<' ? value <= c.n : value === c.n;
}

// -0 would survive into JSON as 0 but trips equality checks; keep plain zeros.
const plain = (n: number): number => (n === 0 ? 0 : n);

function rollDice(node: Extract<Node, { t: 'dice' }>, rng: Rng): Extract<RollTerm, { kind: 'dice' }> {
  const { sides, mods } = node;
  const face = (): number => (sides === 'F' ? rng(3) - 2 : rng(sides));
  const dice: Die[] = [];
  let rerolls = 0;
  let extra = 0;

  // One die, rerolled while it matches (the replaced rolls stay in `dice`, dropped).
  const one = (): Die => {
    let value = face();
    let usedOnce = false;
    while (rerolls < MAX_EXTRA) {
      if (mods.reroll.some((c) => matches(value, c))) {
        // reroll again as long as it matches
      } else if (!usedOnce && mods.rerollOnce.some((c) => matches(value, c))) {
        usedOnce = true;
      } else break;
      dice.push({ value, rerolled: true, dropped: true });
      rerolls++;
      value = face();
    }
    const die: Die = { value };
    dice.push(die);
    return die;
  };

  for (let i = 0; i < node.count; i++) {
    let die = one();
    while (mods.explode && extra < MAX_EXTRA && matches(die.value, mods.explode)) {
      die.exploded = true;
      extra++;
      die = one();
    }
  }

  if (mods.keep) {
    const { mode, n } = mods.keep;
    const live = dice.map((d, i) => ({ d, i })).filter((x) => !x.d.dropped);
    const highFirst = mode === 'kh' || mode === 'dh';
    live.sort((a, b) => (highFirst ? b.d.value - a.d.value : a.d.value - b.d.value) || a.i - b.i);
    // kh/kl keep the first n in this order, dh/dl drop them.
    const keeping = mode === 'kh' || mode === 'kl';
    live.forEach((x, rank) => {
      if (rank < n !== keeping) x.d.dropped = true;
    });
  }

  let value = 0;
  const counting = Boolean(mods.success || mods.failure);
  for (const d of dice) {
    if (d.dropped) continue;
    if (!counting) value += d.value;
    else if (mods.success && matches(d.value, mods.success)) {
      d.success = true;
      value++;
    } else if (mods.failure && matches(d.value, mods.failure)) {
      d.failure = true;
      value--;
    }
  }
  return { kind: 'dice', text: node.text, count: node.count, sides, dice, value: plain(value) };
}

function evaluate(node: Node, rng: Rng, terms: RollTerm[]): number {
  switch (node.t) {
    case 'num':
      terms.push({ kind: 'number', value: node.value });
      return node.value;
    case 'dice': {
      const term = rollDice(node, rng);
      terms.push(term);
      return term.value;
    }
    case 'group': {
      terms.push({ kind: 'op', op: '(' });
      const v = evaluate(node.inner, rng, terms);
      terms.push({ kind: 'op', op: ')' });
      return v;
    }
    case 'unary': {
      terms.push({ kind: 'op', op: node.op });
      const v = evaluate(node.arg, rng, terms);
      return node.op === '-' ? plain(-v) : v;
    }
    case 'bin': {
      const l = evaluate(node.left, rng, terms);
      terms.push({ kind: 'op', op: node.op });
      const r = evaluate(node.right, rng, terms);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return plain(l - r);
        case '*':
          return plain(l * r);
        case '/':
          if (r === 0) throw new DiceError('Division by zero');
          return plain(Math.trunc(l / r));
      }
    }
  }
}

/** Roll one expression, e.g. "4d6kh3 + 2". Throws DiceError with a readable message. */
export function roll(expr: string, rng: Rng): RollResult {
  if (typeof expr !== 'string') throw new DiceError('Nothing to roll');
  const src = expr.trim();
  if (src.length > MAX_EXPR) throw new DiceError(`Roll too long (max ${MAX_EXPR} characters)`);
  const node = parse(src);
  const terms: RollTerm[] = [];
  const total = evaluate(node, rng, terms);
  if (!Number.isSafeInteger(total)) throw new DiceError('The result is too large');
  return { expr: src, total, terms };
}

// A "{{roll:N}}" typed by a person would look like a real roll marker; break it
// up with a zero-width space so only the server's markers point into `rolls`.
const escapeMarkers = (s: string): string => s.replace(/\{\{(?=roll:)/gi, '{​{');

/** Roll every [[expr]] in a line of chat, replacing each with {{roll:N}} (N indexes `rolls`). */
export function rollInline(text: string, rng: Rng): { text: string; rolls: RollResult[] } {
  const rolls: RollResult[] = [];
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('[[', i);
    const close = open === -1 ? -1 : text.indexOf(']]', open + 2);
    if (close === -1) {
      out += escapeMarkers(text.slice(i));
      return { text: out, rolls };
    }
    if (rolls.length >= MAX_INLINE) throw new DiceError(`Too many inline rolls (max ${MAX_INLINE})`);
    out += escapeMarkers(text.slice(i, open));
    rolls.push(roll(text.slice(open + 2, close), rng));
    out += `{{roll:${rolls.length - 1}}}`;
    i = close + 2;
  }
}
