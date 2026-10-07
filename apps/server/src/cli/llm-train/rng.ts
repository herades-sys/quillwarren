// A small seeded random number generator (mulberry32) and seed hashing, so
// the training-data generator gives the same files for the same --seed.

/** FNV-1a over the parts: a 32-bit seed from a label, a number, an index. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = `${part}\u0001`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0 || 1;
}

export class Rng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0 || 1;
    this.state = this.seed;
  }

  /** A float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer from lo to hi, both included. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** A multiple of 0.5 from lo to hi. */
  half(lo: number, hi: number): number {
    return this.int(lo * 2, hi * 2) / 2;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(list: readonly T[]): T {
    if (!list.length) throw new Error('pick from an empty list');
    return list[Math.floor(this.next() * list.length)]!;
  }

  /** One item by weight: [[item, weight], ...]. */
  weighted<T>(list: readonly (readonly [T, number])[]): T {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of list) {
      r -= w;
      if (r < 0) return item;
    }
    return list[list.length - 1]![0];
  }

  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** k different items (fewer if the list is shorter). */
  sample<T>(list: readonly T[], k: number): T[] {
    return this.shuffle(list).slice(0, Math.max(0, k));
  }

  /** An independent generator for a sub-task, so adding draws in one place doesn't shift the others. */
  fork(label: string | number): Rng {
    return new Rng(hashSeed(this.seed, label));
  }
}
