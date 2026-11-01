// "Where you can go" on the 2D board, for the GM (Quillwarren pages, the GM's own view):
// the same overlay as the editor's Shift K (movement-overlay.ts), drawn from the
// page's Quillwarren map (gm-map.ts) in an SVG over the board. K or the "Heights"
// button in the top bar turns it on and off; it is remembered per browser like
// the editor's. Players never get it (they never get the map).
import { walkableMap, type DelveMap, type Walkable } from '@delve/core';
import type { Page } from '@delve/table';
import type { Board } from './board.ts';
import type { GmMap } from './gm-map.ts';
import { drawMovement, loadMovement, saveMovement } from '../movement-overlay.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface MovementView {
  on(): boolean;
  toggle(): void;
  /** The page, the GM's view or the map changed. */
  update(): void;
  /** Is there anything to show on this page (a Quillwarren map with height areas)? */
  available(): boolean;
}

export function initMovementView(o: { stage: HTMLElement; board: Board; gmMap: GmMap; page: () => Page | null; seeAs: () => 'gm' | 'players' }): MovementView {
  let shown = loadMovement();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'move-overlay');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:2';
  const g = document.createElementNS(SVG_NS, 'g');
  svg.append(g);
  o.stage.append(svg);
  let cache: { map: DelveMap; walk: Walkable } | null = null;
  let drawnAt = 0;

  const map = (): DelveMap | null => {
    const p = o.page();
    const m = o.gmMap.map();
    return p?.background.kind === 'delve' && m && m.objects.some((x) => x.type === 'height') ? m : null;
  };

  /** World cells to the stage's pixels: the board's camera. */
  function place(): void {
    const r = o.stage.getBoundingClientRect();
    const [x0, y0] = o.board.toClient(0, 0);
    const s = o.board.pxPerCell();
    g.setAttribute('transform', `matrix(${s} 0 0 ${s} ${x0 - r.left} ${y0 - r.top})`);
    // labels are sized in pixels: redraw them when the zoom changed a lot
    if (cache && Math.abs(Math.log(s / (drawnAt || s))) > 0.25) draw();
  }

  function draw(): void {
    g.replaceChildren();
    const m = map();
    const visible = shown && o.seeAs() === 'gm' && m !== null;
    svg.style.display = visible ? '' : 'none';
    if (!visible || !m) return;
    if (!cache || cache.map !== m) cache = { map: m, walk: walkableMap(m) };
    const s = o.board.pxPerCell();
    drawnAt = s;
    drawMovement(g, m, { view: 'gm', px: 1 / s, walk: cache.walk });
  }

  o.board.onView(place);
  o.gmMap.onChange(() => {
    draw();
    place();
  });
  draw();
  place();

  return {
    on: () => shown,
    toggle() {
      shown = !shown;
      saveMovement(shown);
      draw();
      place();
    },
    update() {
      draw();
      place();
    },
    available: () => map() !== null,
  };
}
