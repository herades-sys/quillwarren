// What one grid square stands for: "5 ft", "1.5 m"… A map keeps it as text in
// `grid.unit`; these helpers read and check it, and list the sizes the pages offer.
import { ValidationError } from './validate.ts';

export const METRES_PER_FOOT = 0.3048;

export interface SquareUnit {
  size: number;
  /** "ft" or "m" (older maps may carry another word, which is kept as written). */
  name: string;
}

/** The square sizes offered wherever one is chosen (new maps, imports, tracing, map settings). */
export const SQUARE_SIZES: readonly string[] = ['5 ft', '10 ft', '20 ft', '1 m', '1.5 m', '2 m', '3 m', '5 m'];

/** A map's square size; 5 ft when it has none or it can't be read. */
export function parseSquareUnit(text: string | undefined): SquareUnit {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(text ?? '');
  return m ? { size: Number(m[1]), name: m[2]! } : { size: 5, name: 'ft' };
}

const NAMES: Record<string, 'ft' | 'm'> = {
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  m: 'm',
  metre: 'm',
  metres: 'm',
  meter: 'm',
  meters: 'm',
};

/**
 * A square size as typed ("1.5 m", "10ft", "2 metres") in its stored form
 * ("1.5 m"). Throws a ValidationError for anything else.
 */
export function squareUnit(v: unknown): string {
  const m = typeof v === 'string' ? /^\s*(\d+(?:[.,]\d+)?)\s*([A-Za-z]+)\s*$/.exec(v) : null;
  const name = m ? NAMES[m[2]!.toLowerCase()] : undefined;
  const size = m ? Number(m[1]!.replace(',', '.')) : NaN;
  if (!name || !(size > 0) || size > 1000) {
    throw new ValidationError([`unit: a square size like "5 ft" or "1.5 m" (feet or metres, above 0 and up to 1000), got ${JSON.stringify(v)}`]);
  }
  return `${Math.round(size * 1000) / 1000} ${name}`;
}

/** Metres per square (feet converted; an unknown word counts as feet). */
export function metresPerSquare(u: SquareUnit): number {
  return u.name === 'm' ? u.size : u.size * METRES_PER_FOOT;
}
