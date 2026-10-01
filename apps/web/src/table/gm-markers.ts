// The GM's markers on a Delve page: the badges are painted into the page's
// picture, and this makes them clickable like in the editor (apps/web/src/markers.ts):
// a click opens the note, Shift-click strikes it through. Changes go to the
// Delve map (gm-map.ts), and the page picture follows a moment later. GM only;
// players never get the map, and the players' preview has no markers.
import type { DelveMap } from '@delve/core';
import type { Page } from '@delve/table';
import { initMarkers, type Markers } from '../markers.ts';
import type { Board } from './board.ts';
import { toast } from './dom.ts';
import type { GmMap } from './gm-map.ts';

export interface TableMarkers {
  /** The page (or what the GM looks at) changed: close a note of another map. */
  pageChanged(page: Page | null): void;
}

export function initTableMarkers(o: { stage: HTMLElement; board: Board; seeAs: () => 'gm' | 'players'; gmMap: GmMap }): TableMarkers {
  const empty = { objects: [] } as unknown as DelveMap;
  let mapId: string | null = null;

  const markers: Markers = initMarkers({
    stage: o.stage,
    handled: new WeakSet<Event>(),
    map: () => o.gmMap.map() ?? empty,
    view: () => (o.gmMap.map() && o.seeAs() === 'gm' ? 'gm' : 'players'),
    toMap: (x, y) => o.board.toWorld(x, y),
    toScreen: ([x, y]) => {
      const [cx, cy] = o.board.toClient(x, y);
      return { x: cx, y: cy };
    },
    squaresPerPx: () => 1 / Math.max(1e-6, o.board.pxPerCell()),
    canEdit: true,
    send: (ops) => o.gmMap.send(ops), // the note box shows the change at once; the picture follows
    toast,
    onRender: (cb) => void o.gmMap.onChange(cb),
    onView: (cb) => o.board.onView(cb),
    editorTool: () => null,
  });

  return {
    pageChanged(page) {
      const id = page?.background.kind === 'delve' ? page.background.mapId : null;
      if (id !== mapId) markers.close();
      mapId = id;
    },
  };
}
