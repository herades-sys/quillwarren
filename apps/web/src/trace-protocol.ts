// Messages between the picture tracer page (trace.ts) and its worker (trace-worker.ts).
import type { DelveMap, RGB, TraceResult, TraceRole } from '@delve/core';

/** A crop of the picture, in picture pixels. */
export interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TraceSettings {
  colours: RGB[];
  roles: TraceRole[];
  pxPerSquare: number;
  crop: Crop | null;
  minArea: number;
  minWidth: Partial<Record<TraceRole, number>>;
  fillHoles: number;
  join: boolean;
  grid: boolean;
}

export type ToWorker =
  | { type: 'load'; width: number; height: number; rgba: Uint8ClampedArray; k: number }
  | { type: 'colours'; k: number }
  | { type: 'trace'; id: number; settings: TraceSettings }
  | { type: 'render'; id: number; map: DelveMap };

export type FromWorker =
  | { type: 'colours'; colours: { colour: RGB; share: number }[] }
  | { type: 'traced'; id: number; result: TraceResult; ms: number }
  | { type: 'rendered'; id: number; svg: string }
  | { type: 'error'; id?: number; error: string };
