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

// ---------- lengths with units ("5 m", "10 ft", "3 squares") ----------
// The MCP tools take sizes, widths, distances and heights either as plain
// numbers (squares; heights in the map's own unit, as always) or as text with
// a unit, converted with the map's grid.unit. So add_height {"height": "5 m"}
// stores 5 on a 1.5 m map and 16.4 on a 5 ft one, and nobody has to divide.

/** A length as a tool takes it: a number, or text with a unit. */
export type Length = number | string;

const LENGTH_UNITS: Record<string, 'ft' | 'm' | 'sq'> = {
  ...NAMES,
  "'": 'ft',
  sq: 'sq',
  sqs: 'sq',
  square: 'sq',
  squares: 'sq',
  cell: 'sq',
  cells: 'sq',
  tile: 'sq',
  tiles: 'sq',
};

/** A length typed as text: its number and unit (null: a bare number). Throws a ValidationError naming `field`. */
export function parseLength(v: Length, field = 'length'): { n: number; unit: 'ft' | 'm' | 'sq' | null } {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ValidationError([`${field}: must be a finite number, got ${v}`]);
    return { n: v, unit: null };
  }
  const m = /^\s*([+\-−]?)\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*([A-Za-z']+(?:\s+squares?)?)?\s*$/.exec(String(v));
  const word = m?.[3]?.toLowerCase().replace(/^grid\s+/, '');
  const unit = word === undefined ? null : LENGTH_UNITS[word];
  if (!m || unit === undefined) {
    throw new ValidationError([`${field}: a number, or a length with a unit like "5 m", "10 ft" or "3 squares", got ${JSON.stringify(v)}`]);
  }
  const n = Number(m[2]!.replace(',', '.')) * (m[1] === '-' || m[1] === '−' ? -1 : 1);
  return { n, unit };
}

const fmtLen = (v: number): string => String(Math.round(v * 100) / 100);

/** How long one of `unit` is in squares on this map. */
function squaresPer(unit: 'ft' | 'm', u: SquareUnit): number {
  const name = u.name === 'm' ? 'm' : 'ft';
  if (unit === name) return 1 / u.size;
  return unit === 'm' ? 1 / metresPerSquare(u) : METRES_PER_FOOT / metresPerSquare(u);
}

/**
 * A size, width or distance in squares. Numbers are squares already; "5 m" and
 * "10 ft" are converted with the map's square size, "3 squares" is 3. `note`
 * says what was converted ("" for a plain number), for the tool's reply.
 */
export function lengthInSquares(v: Length, u: SquareUnit, field = 'length'): { squares: number; note: string } {
  const { n, unit } = parseLength(v, field);
  if (unit === null || unit === 'sq') return { squares: n, note: unit === 'sq' ? `${fmtLen(n)} squares` : '' };
  const squares = n * squaresPer(unit, u);
  return { squares, note: `${fmtLen(n)} ${unit} = ${fmtLen(squares)} squares (1 square = ${fmtLen(u.size)} ${u.name})` };
}

/**
 * A height in the map's own unit (what a height area stores). Numbers are that
 * unit already; "5 m" and "10 ft" are converted, "2 squares" is two squares' size.
 */
export function lengthInUnits(v: Length, u: SquareUnit, field = 'height'): { value: number; note: string } {
  const { n, unit } = parseLength(v, field);
  if (unit === null) return { value: n, note: '' };
  const value = unit === 'sq' ? n * u.size : n * squaresPer(unit, u) * u.size;
  const r = Math.round(value * 100) / 100;
  return { value: r, note: `${fmtLen(n)} ${unit === 'sq' ? 'squares' : unit} = ${fmtLen(r)} ${u.name}` };
}

/** To the nearest half square (at least half a square): room sizes, gaps, door and corridor widths. */
export const halfSquares = (v: number): number => Math.max(0.5, Math.round(v * 2) / 2);
