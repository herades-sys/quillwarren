// The picture of a page with dynamic vision (GET …/pages/:pageId/background.png):
// the Delve map with the table's doors (vision.ts withTableDoors), the map's own
// room fog left out (line of sight decides instead), and for players cut to the
// explored fog with everything else black (core RenderOptions.reveal: one SVG
// clipPath around every layer, so the PNG holds no pixel of what wasn't seen;
// the SVG itself never leaves the server). Rendered in resvg's thread pool when
// the map has no uploaded pictures (those need the blocking path in png.ts), and
// cached per map rev, door state and explored version, so a page is drawn once
// per change however many players ask.
import { buildScene, resolveStyle, sceneToSvg, type DelveMap, type Polygon } from '@delve/core';
import type { Explored, Page } from '@delve/table';
import { assets } from '../assets.ts';
import { FONT_FILES, svgToPng } from '../png.ts';
import { ROLL20_PPG } from '../render.ts';
import { withTableDoors } from './vision.ts';

const KEEP = 24;

type RenderAsync = (svg: string, opts: object) => Promise<{ asPng(): Buffer }>;
let renderAsync: Promise<RenderAsync | null> | undefined;

async function pngOf(svg: string): Promise<Buffer> {
  // uploaded pictures are fetched through resvg's image hooks, which only the blocking renderer has
  if (svg.includes('href="/api/v1/images/')) return svgToPng(svg);
  renderAsync ??= import('@resvg/resvg-js').then(
    (m) => ((m as { renderAsync?: RenderAsync }).renderAsync ?? (m as { default?: { renderAsync?: RenderAsync } }).default?.renderAsync ?? null),
    () => null,
  );
  const r = await renderAsync;
  if (!r) return svgToPng(svg);
  const out = await r(svg, {
    font: { fontFiles: Object.values(FONT_FILES), loadSystemFonts: false, defaultFontFamily: 'IM FELL English' },
    shapeRendering: 2,
    textRendering: 1,
  });
  return out.asPng();
}

export interface VisionPictureInput {
  gameId: string;
  page: Page;
  map: DelveMap;
  mapRev: number;
  view: 'gm' | 'players';
  /** Players: the explored fog the picture is cut to. */
  explored: Explored;
}

/** The SVG of a dynamic page's picture (exported for tests; never send it to players: it holds the whole map). */
export function visionSvg(i: VisionPictureInput): string {
  const map = withTableDoors(i.map, i.page, i.view);
  const [x0, y0] = i.page.origin;
  const frame = { x0, y0, x1: x0 + i.page.width, y1: y0 + i.page.height };
  const reveal: Polygon[] | undefined = i.view === 'players' && !i.explored.all ? i.explored.polys : undefined;
  const scene = buildScene(map, { view: i.view, grid: false, assets: assets.body, frame, ...(reveal ? { reveal } : {}) }, resolveStyle(map));
  return sceneToSvg(scene, { ppg: i.page.cellPx || ROLL20_PPG });
}

export class VisionPictures {
  private readonly cache = new Map<string, Promise<Buffer>>();

  png(i: VisionPictureInput): Promise<Buffer> {
    const p = i.page;
    const key = [
      i.gameId,
      p.id,
      i.view,
      i.map.id,
      i.mapRev,
      i.view === 'players' ? `${i.explored.version}${i.explored.all ? 'a' : ''}` : '',
      JSON.stringify(p.doorState ?? {}),
      p.cellPx,
      p.origin.join(','),
      p.width,
      p.height,
    ].join('|');
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const made = pngOf(visionSvg(i));
    made.catch(() => this.cache.delete(key));
    this.cache.set(key, made);
    while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }
}
