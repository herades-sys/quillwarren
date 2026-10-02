// A forgiving JSON parser for tool input that is still streaming in
// (stream-json's input_json_delta pieces). It parses as far as the text goes
// and reports which objects and arrays were still open at the end, so callers
// can use only the parts that are complete. Strings, numbers and literals cut
// off at the end are left out (with their key); open containers are kept with
// their complete members.

export interface PartialJson {
  value: unknown;
  /** Objects and arrays whose closing bracket hasn't arrived yet. */
  open: Set<object>;
}

class Invalid extends Error {}
/** The text ended before this value did. */
const CUT = Symbol('cut');

/** The value so far, or null when the text isn't the start of a JSON value. */
export function parsePartialJson(src: string): PartialJson | null {
  const open = new Set<object>();
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const end = () => i >= src.length;

  function str(): string | typeof CUT {
    i++; // the opening quote
    let out = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = src[i + 1];
        if (e === undefined) return CUT;
        if (e === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (hex.length < 4) return CUT;
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Invalid();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in map)) throw new Invalid();
        out += map[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return CUT;
  }

  function value(): unknown {
    ws();
    if (end()) return CUT;
    const c = src[i]!;
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      open.add(obj);
      for (;;) {
        ws();
        if (end()) return obj;
        if (src[i] === '}') {
          i++;
          open.delete(obj);
          return obj;
        }
        if (src[i] !== '"') throw new Invalid();
        const key = str();
        if (key === CUT) return obj;
        ws();
        if (end()) return obj;
        if (src[i] !== ':') throw new Invalid();
        i++;
        const v = value();
        if (v === CUT) return obj;
        obj[key] = v;
        ws();
        if (end()) return obj;
        if (src[i] === ',') i++;
        else if (src[i] !== '}') throw new Invalid();
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      open.add(arr);
      for (;;) {
        ws();
        if (end()) return arr;
        if (src[i] === ']') {
          i++;
          open.delete(arr);
          return arr;
        }
        const v = value();
        if (v === CUT) return arr;
        arr.push(v);
        ws();
        if (end()) return arr;
        if (src[i] === ',') i++;
        else if (src[i] !== ']') throw new Invalid();
      }
    }
    if (c === '"') return str();
    const rest = src.slice(i);
    if (/^-?\d*(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(rest)) return CUT; // a number at the very end: more digits may follow
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (src.startsWith(word, i)) {
        i += word.length;
        return v;
      }
      if (word.startsWith(src.slice(i))) return CUT;
    }
    throw new Invalid();
  }

  try {
    const v = value();
    if (v === CUT) return src.trim() ? { value: undefined, open } : null;
    return { value: v, open };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}
