// The handout page's Notes tool, the parts without a DOM: where a point on the
// sheet is on the map, the default pen, and the ops a note change becomes.
import { INSCRIPTION_MAX, INSCRIPTION_SIZE, nextId, type DelveMap, type Inscription, type InscriptionInk, type Op, type Point } from '@delve/core';

/**
 * The x-handout-frame header: the sheet (w × h points) and where the map sits
 * on it: the square (x0, y0) is at (x, y) points, and a square is k points.
 */
export interface SheetFrame {
  w: number;
  h: number;
  x: number;
  y: number;
  k: number;
  x0: number;
  y0: number;
}

/** The frame from the header, or null if it is missing or wrong. */
export function parseFrame(header: string | null): SheetFrame | null {
  if (!header) return null;
  try {
    const f = JSON.parse(header) as Record<string, unknown>;
    const keys = ['w', 'h', 'x', 'y', 'k', 'x0', 'y0'] as const;
    if (!keys.every((k) => typeof f[k] === 'number' && Number.isFinite(f[k]))) return null;
    if (!((f.k as number) > 0 && (f.w as number) > 0 && (f.h as number) > 0)) return null;
    return Object.fromEntries(keys.map((k) => [k, f[k]])) as unknown as SheetFrame;
  } catch {
    return null;
  }
}

const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

/** A point on the sheet (points) as map squares, to two decimals. */
export function sheetToSquares(f: SheetFrame, X: number, Y: number): Point {
  return [round2(f.x0 + (X - f.x) / f.k), round2(f.y0 + (Y - f.y) / f.k)];
}

/** Map squares as a point on the sheet. */
export function squaresToSheet(f: SheetFrame, p: Point): [number, number] {
  return [f.x + (p[0] - f.x0) * f.k, f.y + (p[1] - f.y0) * f.k];
}

/** A note's text height in points on this sheet. */
export const sizeInPoints = (f: SheetFrame, size: number | undefined): number => Math.round((size ?? INSCRIPTION_SIZE) * f.k);

/** Points on the sheet back to squares, for the size slider (at least 0.05, at most 20). */
export function pointsToSize(f: SheetFrame, pt: number): number {
  return Math.min(20, Math.max(0.05, Math.round((pt / f.k) * 100) / 100));
}

/** What a new note gets: brown, handout only, and the default 0.8 squares, unless that is too small or big to read on this sheet (a city, a single room): then 14 pt. */
export interface Pen {
  size: number;
  ink: InscriptionInk;
  onMap: boolean;
}

export function defaultPen(f: SheetFrame | null): Pen {
  const pt = f ? INSCRIPTION_SIZE * f.k : 14;
  return { size: f && (pt < 9 || pt > 24) ? pointsToSize(f, 14) : INSCRIPTION_SIZE, ink: 'brown', onMap: false };
}

/** The text as typed, tidied: one kind of line break, no blank lines or spaces at the ends, at most INSCRIPTION_MAX characters. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '')
    .slice(0, INSCRIPTION_MAX);
}

/** A slight tilt for a new note, -3° to 3°, from a number in [0, 1): handwriting is never quite level. */
export const slightTilt = (r: number): number => Math.floor(Math.min(0.9999, Math.max(0, r)) * 7) - 3;

/** A new note at `at` with the pen's settings; fields at their defaults are left out. */
export function newNote(map: DelveMap, text: string, at: Point, pen: Pen, tilt: number, taken: readonly string[] = []): Inscription {
  // ids of notes still on their way to the server are taken too
  let id = nextId(map, 'w');
  for (let k = 1; taken.includes(id); k++) id = nextId(map, 'w', k);
  return {
    id,
    type: 'inscription',
    text,
    at,
    ...(pen.size !== INSCRIPTION_SIZE ? { size: pen.size } : {}),
    ...(tilt ? { rotation: tilt } : {}),
    ...(pen.ink !== 'brown' ? { ink: pen.ink } : {}),
    ...(pen.onMap ? { onMap: true } : {}),
  };
}

/** The update op that gives note `o` these fields; undefined or a default value unsets the field. */
export function noteUpdate(o: Inscription, fields: Partial<Pick<Inscription, 'text' | 'at' | 'size' | 'rotation' | 'ink' | 'onMap'>>): Op | null {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(fields) as [keyof Inscription, unknown][]) {
    const dflt = (k === 'size' && v === INSCRIPTION_SIZE) || (k === 'rotation' && v === 0) || (k === 'ink' && v === 'brown') || (k === 'onMap' && v === false);
    if (v === undefined || dflt) {
      if (k in o) unset.push(k);
    } else if (JSON.stringify(o[k]) !== JSON.stringify(v)) set[k] = v;
  }
  if (!Object.keys(set).length && !unset.length) return null;
  return { op: 'update', id: o.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}

/** Apply an update op's fields to a copy of the note (to show a change before the server confirms it). */
export function withUpdate(o: Inscription, op: Op): Inscription {
  if (op.op !== 'update') return o;
  const out = { ...o, ...(op.set ?? {}) } as Record<string, unknown>;
  for (const k of op.unset ?? []) delete out[k];
  return out as Inscription;
}
