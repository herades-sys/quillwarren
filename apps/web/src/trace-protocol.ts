// Messages between the picture tracer page (trace.ts) and its worker (trace-worker.ts).
import type { ColourSpace, DelveMap, GridFit, RGB, TraceMode, TraceResult, TraceRole } from '@delve/core';

/** A crop of the picture, in picture pixels. */
export interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TraceSettings {
  mode: TraceMode;
  painted: boolean;
  colours: RGB[];
  space: ColourSpace;
  roles: TraceRole[];
  pxPerSquare: number;
  /** The picture pixel where square (0, 0) is (a grid line crossing), in the whole picture. */
  origin: [number, number];
  /** The picture has a printed grid at this scale (dungeon floors must show it). */
  printedGrid: boolean;
  crop: Crop | null;
  minArea: number;
  minWidth: Partial<Record<TraceRole, number>>;
  fillHoles: number;
  join: boolean;
  grid: boolean;
  split: boolean;
  snap: number;
  regular: boolean;
}

/** What the worker found on loading a picture. */
export interface Analysis {
  mode: TraceMode;
  why: string;
  painted: boolean;
  texture: number;
  grid: GridFit | null;
  /** Without a printed grid: the lattice the walls stand on. */
  wallGrid: GridFit | null;
  /** Without a grid: px per square if the walls are of a usual thickness. */
  wallScale: number | null;
  colours: { colour: RGB; share: number }[];
  roles: TraceRole[];
  space: ColourSpace;
}

export type ToWorker =
  | { type: 'load'; width: number; height: number; rgba: Uint8ClampedArray }
  | { type: 'colours'; k: number; mode: TraceMode; painted: boolean; cell?: number }
  | { type: 'trace'; id: number; settings: TraceSettings }
  | { type: 'render'; id: number; map: DelveMap };

export type FromWorker =
  | { type: 'analysed'; analysis: Analysis; ms: number }
  | { type: 'colours'; colours: { colour: RGB; share: number }[]; roles: TraceRole[]; space: ColourSpace }
  | { type: 'traced'; id: number; result: TraceResult; ms: number }
  | { type: 'rendered'; id: number; svg: string }
  | { type: 'error'; id?: number; error: string };
