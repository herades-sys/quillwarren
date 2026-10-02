// The picture tracer's worker (/assets/trace-worker.js): keeps the picture (and,
// for painted ones, a smoothed copy), looks at it (colours, grid, kind of map),
// traces it and renders previews, so the page stays responsive while a big
// picture is worked on.
import { analysePicture, buildScene, coloursForMode, kuwahara, paintedSmoothing, resolveStyle, sceneToSvg, traceImage } from '@delve/core';
import type { Crop, FromWorker, ToWorker } from './trace-protocol.ts';

const scope = self as unknown as { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker): void };
let pic: { width: number; height: number; rgba: Uint8ClampedArray } | null = null;
let smoothed: Uint8ClampedArray | null = null;

const smooth = (): Uint8ClampedArray => {
  if (!pic) throw new Error('no picture loaded');
  return (smoothed ??= kuwahara(pic.rgba, pic.width, pic.height, paintedSmoothing(pic.width, pic.height), 2));
};

function cropped(src: Uint8ClampedArray, c: Crop | null): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (!pic) throw new Error('no picture loaded');
  if (!c) return { width: pic.width, height: pic.height, rgba: src };
  const x0 = Math.max(0, Math.floor(c.x0));
  const y0 = Math.max(0, Math.floor(c.y0));
  const width = Math.min(pic.width, Math.ceil(c.x1)) - x0;
  const height = Math.min(pic.height, Math.ceil(c.y1)) - y0;
  if (width < 2 || height < 2) throw new Error('the crop is too small');
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(src.subarray(((y0 + y) * pic.width + x0) * 4, ((y0 + y) * pic.width + x0 + width) * 4), y * width * 4);
  return { width, height, rgba };
}

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const started = performance.now();
      pic = { width: msg.width, height: msg.height, rgba: msg.rgba };
      smoothed = null;
      const a = analysePicture(pic.rgba, pic.width, pic.height);
      if (a.smoothed) smoothed = a.smoothed;
      scope.postMessage({
        type: 'analysed',
        analysis: { mode: a.mode, why: a.why, painted: a.painted, texture: a.texture, grid: a.grid, wallGrid: a.wallGrid, wallScale: a.wallScale, colours: a.colours, roles: a.roles, space: a.space },
        ms: performance.now() - started,
      });
    } else if (msg.type === 'colours') {
      if (!pic) return;
      const c = coloursForMode(pic.rgba, pic.width, pic.height, msg.mode, { k: msg.k, painted: msg.painted, ...(msg.painted ? { smoothed: smooth() } : {}), ...(msg.cell ? { cell: msg.cell } : {}) });
      scope.postMessage({ type: 'colours', ...c });
    } else if (msg.type === 'trace') {
      if (!pic) throw new Error('no picture loaded');
      const started = performance.now();
      const { crop, origin, ...rest } = msg.settings;
      const part = cropped(pic.rgba, crop);
      const result = traceImage({
        ...part,
        ...rest,
        // squares count from the grid's lines, wherever the crop starts
        origin: [origin[0] - Math.max(0, Math.floor(crop?.x0 ?? 0)), origin[1] - Math.max(0, Math.floor(crop?.y0 ?? 0))],
        ...(rest.painted ? { smoothed: cropped(smooth(), crop).rgba } : {}),
      });
      scope.postMessage({ type: 'traced', id: msg.id, result, ms: performance.now() - started });
    } else if (msg.type === 'render') {
      const scene = buildScene(msg.map, { view: 'gm', grid: true }, resolveStyle(msg.map));
      scope.postMessage({ type: 'rendered', id: msg.id, svg: sceneToSvg(scene, { ppg: 20 }) });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', ...('id' in msg ? { id: msg.id } : {}), error: (err as Error).message });
  }
};
