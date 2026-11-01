// The picture of a page with dynamic vision (GET …/pages/:pageId/background.png):
// the Quillwarren map with the table's doors (vision.ts withTableDoors), the map's own
// room fog left out (line of sight decides instead), and for players cut to the
// explored fog with everything else black (core RenderOptions.reveal: one SVG
// clipPath around every layer, so the PNG holds no pixel of what wasn't seen;
// the SVG itself never leaves the server). Rendered in resvg's thread pool when
// it can (png.ts svgToPngAsync), and cached per map rev, door state and
// explored version, so a page is drawn once per change however many players ask.
import { buildScene, cropScene, resolveStyle, sceneToSvg, type DelveMap, type Polygon } from '@delve/core';
import type { Explored, Page } from '@delve/table';
import { assets } from '../assets.ts';
import { svgToPngAsync } from '../png.ts';
import { ROLL20_PPG } from '../render.ts';
import { withTableDoors } from './vision.ts';

const KEEP = 24;

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
  // only what the page shows (core cropScene, as the render route does): on a page a square or two thin,
  // height tones or stairs a few squares off it made resvg panic, which kills the server (docs/API.md, "resvg's layer limit")
  return sceneToSvg(cropScene(scene, scene.bounds), { ppg: i.page.cellPx || ROLL20_PPG });
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
    const made = svgToPngAsync(visionSvg(i));
    made.catch(() => this.cache.delete(key));
    this.cache.set(key, made);
    while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }
}
