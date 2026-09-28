// Shared by the preview page and the map API: query -> scene -> SVG or PNG.
import { buildScene, resolveStyle, sceneToSvg, type DelveMap, type Scene, type Style, type View } from '@delve/core';
import { svgToPng } from './png.ts';

export const ROLL20_PPG = 70;

export interface RenderQuery {
  view?: string;
  ppg?: string;
  grid?: string;
  style?: string;
}

export class RenderQueryError extends Error {}

export const asView = (v: unknown): View => (v === 'players' ? 'players' : 'gm');

export function parsePpg(v: string | undefined): number {
  const ppg = v === undefined ? ROLL20_PPG : Number(v);
  if (!Number.isInteger(ppg) || ppg < 10 || ppg > 300) throw new RenderQueryError('ppg must be a whole number from 10 to 300');
  return ppg;
}

export function sceneFor(map: DelveMap, q: RenderQuery): Scene {
  const m = q.style ? { ...map, style: { ...map.style, preset: q.style } } : map;
  let style: Style;
  try {
    style = resolveStyle(m);
  } catch (e) {
    throw new RenderQueryError((e as Error).message);
  }
  return buildScene(m, { view: asView(q.view), grid: q.grid !== '0' }, style);
}

export function sizeInSquares(scene: Scene): { w: number; h: number } {
  return { w: scene.bounds.x1 - scene.bounds.x0, h: scene.bounds.y1 - scene.bounds.y0 };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';

/** e.g. test-dungeon-4-players_classic-hatching_players_26x38.png: the size tells you the Roll20 page size. */
export function exportName(map: DelveMap, preset: string, view: View, scene: Scene, ext: string): string {
  const { w, h } = sizeInSquares(scene);
  return `${slug(map.name)}_${preset}_${view}_${w}x${h}.${ext}`;
}

export async function render(map: DelveMap, q: RenderQuery, ext: 'svg' | 'png') {
  const scene = sceneFor(map, q);
  const svg = sceneToSvg(scene, { ppg: parsePpg(q.ppg) });
  const preset = q.style ?? map.style?.preset ?? 'classic-hatching';
  const name = exportName(map, preset, asView(q.view), scene, ext);
  return ext === 'svg'
    ? { type: 'image/svg+xml', name, body: svg as string | Buffer }
    : { type: 'image/png', name, body: (await svgToPng(svg)) as string | Buffer };
}
