// Dynamic vision in the browser, the pure part (no DOM, no Pixi): keeping the
// server's vision messages, how dark each part of the board is drawn for whom,
// which door is under the pointer, and the lights the GM's overlay shows.
// The server decides what players see; nothing here hides anything secret
// (players never get what they shouldn't), it only draws the darkness.
import { doorBlocks, doorIsOpen, isDynamic, lightsOf, type LightSource, type Page, type PageDoor, type Token, type VisionPolygon, type VisionView } from '@delve/table';

/** What the board draws from: the last vision message, with the explored fog it last carried. */
export interface BoardVision {
  pageId: string;
  visible: VisionPolygon[];
  bright: VisionPolygon[];
  explored: VisionPolygon[] | 'all';
  exploredVersion: number;
  ambient: VisionView['ambient'];
  /** GM only: the tokens the party sees. */
  seen: Set<string> | null;
}

/** Fold a vision message into what the board has; explored stays when the message leaves it out. */
export function mergeVision(prev: BoardVision | null, pageId: string, v: VisionView | null): BoardVision | null {
  if (!v) return null;
  const same = prev?.pageId === pageId;
  return {
    pageId,
    visible: v.visible,
    bright: v.bright,
    explored: v.explored ?? (same ? prev!.explored : []),
    exploredVersion: v.exploredVersion,
    ambient: v.ambient,
    seen: v.seen ? new Set(v.seen) : same ? prev!.seen : null,
  };
}

/**
 * How dark the board is drawn (alpha of black): never seen, seen before but not
 * now, and in sight but only dimly lit. Players (and the GM looking as them)
 * get the real darkness; the GM a faint hint of what the party sees.
 */
export function fogAlphas(gm: boolean, seeAs: 'gm' | 'players'): { unexplored: number; explored: number; dim: number } {
  return !gm || seeAs === 'players' ? { unexplored: 1, explored: 0.55, dim: 0.28 } : { unexplored: 0.42, explored: 0.22, dim: 0.08 };
}

/** Is there darkness to draw on this page? */
export const hasFog = (page: Page | null): boolean => Boolean(page && isDynamic(page));

/** Pixels per cell for the darkness mask: sharp enough, at most 2048 px a side. */
export function fogResolution(w: number, h: number): number {
  return Math.max(2, Math.min(16, Math.floor(2048 / Math.max(1, w, h))));
}

/** Distance from a point to a segment. */
export function segDist(x: number, y: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
  return Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
}

/** The door nearest to a world point within `tol` cells (archways have nothing to open). */
export function doorAt(doors: readonly PageDoor[] | undefined, x: number, y: number, tol: number): PageDoor | null {
  let best: PageDoor | null = null;
  let bestD = tol;
  for (const d of doors ?? []) {
    if (d.style === 'archway') continue;
    const dist = segDist(x, y, d.a, d.b);
    if (dist <= bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

/** How the GM's overlay shows a door: open, shut, or a shut secret door; and whether it blocks sight. */
export function doorLook(page: Pick<Page, 'doorState'>, d: PageDoor): { state: 'open' | 'shut' | 'secret'; blocks: boolean } {
  const open = doorIsOpen(page, d);
  return { state: open ? 'open' : d.style === 'secret' ? 'secret' : 'shut', blocks: doorBlocks(page, d) };
}

/** Every light on the page for the GM's overlay: the map's and the tokens'. */
export const overlayLights = (page: Page, tokens: readonly Token[]): LightSource[] => lightsOf(page, tokens);

/**
 * The tokens the GM sees while looking as the players: on a dynamic page those
 * the party sees (and the players' own); elsewhere everything but the gm layer.
 */
export function previewTokens(tokens: readonly Token[], page: Page | null, vision: BoardVision | null): Token[] {
  const shown = tokens.filter((t) => t.layer !== 'gm');
  if (!hasFog(page)) return shown;
  if (!vision?.seen) return shown.filter((t) => t.controlledBy.some((id) => id !== 'gm'));
  return shown.filter((t) => vision.seen!.has(t.id) || t.controlledBy.some((id) => id !== 'gm'));
}

/**
 * When to fetch the page picture again after the explored fog grew: right
 * away if the last fetch was at least `gap` ms ago, else once the gap is over
 * (one fetch for a burst of growth). Returns the delay in ms.
 */
export const reloadDelay = (now: number, last: number, gap: number): number => Math.max(0, last + gap - now);

/**
 * The darkness over a page as polygons for the 3D view: the page box with what
 * the party sees cut out of it, plus the holes in that sight (a pillar's
 * shadow) as dark islands of their own.
 */
export function darknessPolygons(box: { x0: number; y0: number; x1: number; y1: number }, visible: readonly VisionPolygon[]): VisionPolygon[] {
  const page: [number, number][] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  return [{ outer: page, holes: visible.map((v) => v.outer) }, ...visible.flatMap((v) => v.holes.map((h) => ({ outer: h, holes: [] })))];
}
