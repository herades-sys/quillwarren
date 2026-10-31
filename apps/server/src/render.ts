// Shared by the preview page and the map API: query -> scene -> SVG or PNG.
import { buildScene, contentFrame, cropScene, handoutSvg, hatchReach, MAX_CROP, renderSizeProblem, resolveStyle, sceneToSvg, wholeSquares, type DelveMap, type HandoutOptions, type Scene, type Style, type View } from '@delve/core';
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
  /** "x0,y0,x1,y1" in squares: draw exactly this part (Delve Table pages, so the GM and players pictures line up). */
  frame?: string;
  /**
   * "content": fit the picture to what is drawn (core contentFrame), not to the
   * page, at quarter squares (the library's map cards). Ignored with frame, and
   * blind to fog; a map with nothing drawn keeps the usual picture.
   */
  fit?: string;
}

export class RenderQueryError extends Error {}
/** A PNG bigger than core's MAX_RENDER_SIDE / MAX_RENDER_PIXELS: answered with 413, before resvg runs. */
export class RenderTooBigError extends RenderQueryError {}

export const asView = (v: unknown): View => (v === 'players' ? 'players' : 'gm');

export function parsePpg(v: string | undefined): number {
  const ppg = v === undefined ? ROLL20_PPG : Number(v);
  if (!Number.isInteger(ppg) || ppg < 10 || ppg > 300) throw new RenderQueryError('ppg must be a whole number from 10 to 300');
  return ppg;
}

/**
 * The frame query as bounds: four numbers, at most 1000 squares each way,
 * widened out to whole squares so the picture's edges fall on grid lines and a
 * VTT's grid lines up with it (a crop of 2.5,0,7.2,4 draws 2,0,8,4).
 */
export function parseFrame(v: string | undefined, what = 'frame'): { x0: number; y0: number; x1: number; y1: number } | undefined {
  if (v === undefined) return undefined;
  const n = v.split(',').map(Number);
  const [x0, y0, x1, y1] = n;
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || Math.abs(x) > 100_000) || x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || x1 <= x0 || y1 <= y0) {
    throw new RenderQueryError(`${what} must be x0,y0,x1,y1 in squares (at most 1000 squares each way)`);
  }
  const f = wholeSquares({ x0, y0, x1, y1 });
  if (f.x1 - f.x0 > MAX_CROP || f.y1 - f.y0 > MAX_CROP) throw new RenderQueryError(`${what} must be x0,y0,x1,y1 in squares (at most 1000 squares each way)`);
  return f;
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
  if (q.fit !== undefined && q.fit !== 'content') throw new RenderQueryError('fit must be content');
  const frame = parseFrame(q.frame) ?? (q.fit === 'content' ? (contentFrame(m, { view, reach: hatchReach(style) }) ?? undefined) : undefined);
  const scene = buildScene(m, { view, grid: q.grid !== '0', background: q.background !== '0', assets: assets.body, ...(fog ? { fog } : {}), ...(q.bounds === 'full' ? { fullBounds: true } : {}), ...(frame ? { frame } : {}) }, style);
  // a cropped picture holds only what it shows: resvg panics on clipped geometry running far past the
  // picture (stairs cut by the frame did it), and that kills the whole server (see cropScene)
  return frame ? cropScene(scene, scene.bounds) : scene;
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
  const ppg = parsePpg(q.ppg);
  if (ext === 'png') {
    const { w, h } = sizeInSquares(scene);
    const problem = renderSizeProblem(w, h, ppg);
    if (problem) throw new RenderTooBigError(`too big: ${problem}. Lower the px per square, or export a smaller area`);
  }
  const svg = sceneToSvg(scene, { ppg });
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
  /** "x0,y0,x1,y1" in squares: only this part of the map on the sheet (whole squares, like the render route's frame). */
  crop?: string;
  /** "1": as an attachment, not shown in the browser. */
  download?: string;
  /** "0": without the handwritten notes (the handout page draws them itself while the GM edits them). */
  inscriptions?: string;
  /** "0": no legend; "1": a legend even of one entry; missing: a legend when it has 2 entries or more. */
  legend?: string;
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
    ...(q.crop !== undefined ? { crop: parseFrame(q.crop, 'crop') } : {}),
    ...(q.inscriptions === '0' ? { inscriptions: false } : {}),
    ...(q.legend === '0' || q.legend === '1' ? { legend: q.legend === '1' } : {}),
  };
}

/** The x-handout-frame header: the sheet size and where the map sits on it (core HandoutFrame), for clicks on the page's preview. */
export function handoutFrameHeader(h: { width: number; height: number; frame: { x: number; y: number; k: number; x0: number; y0: number } }): string {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return JSON.stringify({ w: r(h.width), h: r(h.height), x: r(h.frame.x), y: r(h.frame.y), k: Math.round(h.frame.k * 1e6) / 1e6, x0: h.frame.x0, y0: h.frame.y0 });
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
