// What the viewer hands the editor. Kept apart so viewer.ts and editor.ts don't import each other.
import type { DelveMap, Op, Point, View } from '@delve/core';
import type { Shell } from './shell.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * True when a pointer went down on a control floating over the map (the zoom
 * buttons, a picker, a menu, a toast, the snip bar). The stage's handlers leave
 * those alone: a drag or a pointer capture started there takes the click away
 * from the button. (The context strip sits outside the stage, above it.)
 */
export function onControl(e: Event): boolean {
  return (
    e.target instanceof Element &&
    e.target.closest('button, a, input, select, textarea, label, [role="menu"], .ed-zoom, #ctxbar, #flyout, .ed-float-bottom, .snip-bar, .snip-hint') !== null
  );
}

export interface ViewerCtx {
  mapId: string;
  stage: HTMLElement;
  overlay: SVGSVGElement;
  /** The page chrome: toasts, status, layout, drawers and sheets. */
  shell: Shell;
  /** Pointer events the editor consumed; the viewer won't pan for these. */
  handled: WeakSet<Event>;
  map(): DelveMap;
  rev(): number;
  /** This map's storeys, top first (just this map when it has none). */
  storeys(): { id: string; name: string; level?: { group: string; name: string; order: number } }[];
  toMap(clientX: number, clientY: number): Point | null;
  /** Squares per screen pixel at the current zoom. */
  squaresPerPx(): number;
  /** Send ops over the live socket; resolves with the new rev once the server accepted them. */
  send(ops: Op[]): Promise<number>;
  history(action: 'undo' | 'redo'): Promise<void>;
  onRender(cb: () => void): void;
  onView(cb: () => void): void;
  toast(msg: string, kind?: 'error' | 'info'): void;
  /** GM or players' view, and the grid on or off (a viewing choice, kept in this browser). */
  view(): View;
  grid(): boolean;
  toggleGrid(): void;
  /** Open a GM marker's note box (markers.ts), e.g. right after placing one. */
  openMarker?(id: string): void;
  /**
   * Show this background colour while the colour wheel is dragged, without
   * drawing the map again; null ends it (`repaint` false: the change was just
   * sent, so the picture keeps the colour until the map's redraw).
   */
  previewBackground?(hex: string | null, repaint?: boolean): void;
  /** false in the desktop app, which has no Quillwarren Table or players' screen: the hints leave them out. Unset on the web. */
  multiplayer?: false;
}
