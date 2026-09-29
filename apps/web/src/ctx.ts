// What the viewer hands the editor. Kept apart so viewer.ts and editor.ts don't import each other.
import type { DelveMap, Op, Point } from '@delve/core';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ViewerCtx {
  mapId: string;
  stage: HTMLElement;
  overlay: SVGSVGElement;
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
  setEditing(on: boolean): void;
}
