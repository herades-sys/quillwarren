// Shared by the preview page and the map API: query -> scene -> SVG or PNG.
import { buildScene, handoutSvg, resolveStyle, sceneToSvg, type DelveMap, type HandoutOptions, type Scene, type Style, type View } from '@delve/core';
import { assets } from './assets.ts';
import { svgToPng } from './png.ts';

export const ROLL20_PPG = 70;

export interface RenderQuery {
  view?: string;
  ppg?: string;
  grid?: string;
  style?: string;
  /** "0": transparent background (the 3D view's floor textures). */
  background?: string;
  /** "1": apply fog of war (players' view: only what's revealed; GM view: the rest shaded). */
  fog?: string;
  /** "full": with fog, keep the picture at the unfogged size (Delve Table page backgrounds). */
  bounds?: string;
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
  const view = asView(q.view);
  const fog = q.fog === '1' ? (view === 'players' ? 'hide' : 'dim') : undefined;
  return buildScene(m, { view, grid: q.grid !== '0', background: q.background !== '0', assets: assets.body, ...(fog ? { fog } : {}), ...(q.bounds === 'full' ? { fullBounds: true } : {}) }, style);
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

export interface HandoutQuery {
  paper?: string;
  orientation?: string;
  /** "1": only what the players have seen. */
  revealed?: string;
  /** "1": room names on the map. */
  names?: string;
  /** The title; missing means the map's name, empty means none. */
  title?: string;
  /** "0" leaves each of these out. */
  compass?: string;
  scale?: string;
  frame?: string;
  stains?: string;
  /** PNG pixels per inch, 50–400 (default 200, good for printing). */
  dpi?: string;
  /** "1": as an attachment, not shown in the browser. */
  download?: string;
}

export function handoutOptions(q: HandoutQuery, ext: 'svg' | 'png'): HandoutOptions {
  const paper = q.paper ?? 'a4';
  if (!['a4', 'a3', 'letter', 'fit'].includes(paper)) throw new RenderQueryError('paper must be a4, a3, letter or fit');
  const orientation = q.orientation ?? 'auto';
  if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw new RenderQueryError('orientation must be auto, portrait or landscape');
  const dpi = q.dpi === undefined ? (ext === 'png' ? 200 : 96) : Number(q.dpi);
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 400) throw new RenderQueryError('dpi must be a whole number from 50 to 400');
  if (q.title !== undefined && q.title.length > 120) throw new RenderQueryError('title: at most 120 characters');
  return {
    paper: paper as HandoutOptions['paper'],
    orientation: orientation as HandoutOptions['orientation'],
    revealedOnly: q.revealed === '1',
    names: q.names === '1',
    ...(q.title !== undefined ? { title: q.title } : {}),
    compass: q.compass !== '0',
    scaleBar: q.scale !== '0',
    frame: q.frame !== '0',
    stains: q.stains !== '0',
    dpi,
    assets: assets.body,
  };
}

/** The players' parchment handout as SVG or PNG, e.g. crypt_handout_a4.png. */
export async function renderHandout(map: DelveMap, q: HandoutQuery, ext: 'svg' | 'png') {
  const opts = handoutOptions(q, ext);
  const h = handoutSvg(map, opts);
  const name = `${slug(map.name)}_handout_${h.paper}${h.paper === 'fit' ? '' : h.landscape ? '-landscape' : ''}.${ext}`;
  return ext === 'svg'
    ? { type: 'image/svg+xml', name, body: h.svg as string | Buffer, handout: h }
    : { type: 'image/png', name, body: (await svgToPng(h.svg)) as string | Buffer, handout: h };
}
