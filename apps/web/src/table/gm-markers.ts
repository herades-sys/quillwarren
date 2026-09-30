// The GM's markers on a Delve page: the badges are painted into the page's
// picture, and this makes them clickable like in the editor (apps/web/src/markers.ts):
// a click opens the note, Shift-click strikes it through. Changes go to the
// Delve map, and the page picture follows a moment later. GM only; players never
// get the map, and the players' preview has no markers.
import type { DelveMap, Op } from '@delve/core';
import type { Page } from '@delve/table';
import { initMarkers, type Markers } from '../markers.ts';
import type { Board } from './board.ts';
import { toast } from './dom.ts';

export interface TableMarkers {
  /** The page (or what the GM looks at) changed: fetch its Delve map again. */
  pageChanged(page: Page | null): void;
}

export function initTableMarkers(o: { stage: HTMLElement; board: Board; seeAs: () => 'gm' | 'players' }): TableMarkers {
  const empty = { objects: [] } as unknown as DelveMap;
  let mapId: string | null = null;
  let map: DelveMap | null = null;
  let serial = 0;
  const renderHooks: (() => void)[] = [];

  async function load(id: string): Promise<void> {
    const mine = ++serial;
    try {
      const res = await fetch(`/api/v1/maps/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`the map answered ${res.status}`);
      const body = (await res.json()) as { map: DelveMap };
      if (mine !== serial) return;
      map = body.map;
    } catch {
      if (mine === serial) map = null; // no markers rather than stale ones
    }
    renderHooks.forEach((f) => f());
  }

  const markers: Markers = initMarkers({
    stage: o.stage,
    handled: new WeakSet<Event>(),
    map: () => map ?? empty,
    view: () => (map && o.seeAs() === 'gm' ? 'gm' : 'players'),
    toMap: (x, y) => o.board.toWorld(x, y),
    toScreen: ([x, y]) => {
      const [cx, cy] = o.board.toClient(x, y);
      return { x: cx, y: cy };
    },
    squaresPerPx: () => 1 / Math.max(1e-6, o.board.pxPerCell()),
    canEdit: true,
    async send(ops: Op[]) {
      if (!mapId) throw new Error('no Delve map on this page');
      const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, by: 'table' }),
      });
      const body = (await res.json().catch(() => ({}))) as { rev?: number; error?: string };
      if (!res.ok) throw new Error(res.status === 401 ? 'Log in to Delve as the GM to change markers.' : (body.error ?? `saving failed (${res.status})`));
      await load(mapId); // the note box shows the change at once; the picture follows
      return body.rev ?? 0;
    },
    toast,
    onRender: (cb) => renderHooks.push(cb),
    onView: (cb) => o.board.onView(cb),
    editorTool: () => null,
  });

  return {
    pageChanged(page) {
      const id = page?.background.kind === 'delve' ? page.background.mapId : null;
      if (id !== mapId) markers.close();
      mapId = id;
      if (id) void load(id);
      else {
        map = null;
        renderHooks.forEach((f) => f());
      }
    },
  };
}
