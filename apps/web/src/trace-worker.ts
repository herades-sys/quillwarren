// The picture tracer's worker (/assets/trace-worker.js): keeps the picture,
// finds its main colours, traces it and renders previews, so the page stays
// responsive while a big picture is worked on.
import { buildScene, mainColours, resolveStyle, sceneToSvg, traceImage } from '@delve/core';
import type { Crop, FromWorker, ToWorker } from './trace-protocol.ts';

const scope = self as unknown as { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker): void };
let pic: { width: number; height: number; rgba: Uint8ClampedArray } | null = null;

function cropped(c: Crop | null): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (!pic) throw new Error('no picture loaded');
  if (!c) return pic;
  const x0 = Math.max(0, Math.floor(c.x0));
  const y0 = Math.max(0, Math.floor(c.y0));
  const width = Math.min(pic.width, Math.ceil(c.x1)) - x0;
  const height = Math.min(pic.height, Math.ceil(c.y1)) - y0;
  if (width < 2 || height < 2) throw new Error('the crop is too small');
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(pic.rgba.subarray(((y0 + y) * pic.width + x0) * 4, ((y0 + y) * pic.width + x0 + width) * 4), y * width * 4);
  return { width, height, rgba };
}

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      pic = { width: msg.width, height: msg.height, rgba: msg.rgba };
      scope.postMessage({ type: 'colours', colours: mainColours(pic.rgba, msg.k) });
    } else if (msg.type === 'colours') {
      if (pic) scope.postMessage({ type: 'colours', colours: mainColours(pic.rgba, msg.k) });
    } else if (msg.type === 'trace') {
      const started = performance.now();
      const { crop, ...rest } = msg.settings;
      const result = traceImage({ ...cropped(crop), ...rest });
      scope.postMessage({ type: 'traced', id: msg.id, result, ms: performance.now() - started });
    } else if (msg.type === 'render') {
      const scene = buildScene(msg.map, { view: 'gm', grid: true }, resolveStyle(msg.map));
      scope.postMessage({ type: 'rendered', id: msg.id, svg: sceneToSvg(scene, { ppg: 20 }) });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', ...('id' in msg ? { id: msg.id } : {}), error: (err as Error).message });
  }
};
