// The Delve map behind the page the GM looks at, for what only the GM sees on top
// of the picture: the markers' notes and the GM notes of rooms, corridors and
// terrain. GM only: players never get a map (their pages carry no map id). It is
// read through the map API and changed with map ops under the editor login, so
// the editor, Claude and every GM tab share the same notes. The table's live
// channel says "map.notes" when nothing but notes changed, and sends the page
// again when more did; the app then calls reload().
import type { DelveMap, Op } from '@delve/core';
import type { Page } from '@delve/table';

export interface GmMap {
  /** The map of the page the GM looks at, or null (not a Delve page, not loaded yet, or it failed). */
  map(): DelveMap | null;
  mapId(): string | null;
  /** The page changed: fetch its map when it is another one, or when `again` (the map changed). */
  setPage(page: Page | null, again?: boolean): void;
  reload(): Promise<void>;
  /** Apply ops to the map (one undo step in the editor), then fetch it again. Rejects with a message for people. */
  send(ops: Op[]): Promise<number>;
  /** May this browser change the map (an editor login)? null until known. */
  canEdit(): boolean | null;
  /** After every (re)load, and when the page's map goes away. */
  onChange(cb: () => void): () => void;
}

export const LOGIN_TO_EDIT = 'Log in to Delve (the map editor) as the GM to change notes on the map.';

export function createGmMap(): GmMap {
  let id: string | null = null;
  let map: DelveMap | null = null;
  let serial = 0;
  let editable: boolean | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const f of [...listeners]) f();
  };

  async function load(): Promise<void> {
    const want = id;
    const mine = ++serial;
    if (!want) {
      map = null;
      return changed();
    }
    try {
      const res = await fetch(`/api/v1/maps/${encodeURIComponent(want)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`the map answered ${res.status}`);
      const body = (await res.json()) as { map: DelveMap };
      if (mine !== serial) return;
      map = body.map;
    } catch {
      if (mine !== serial) return;
      map = null; // no notes rather than stale ones
    }
    changed();
  }

  // whether this browser has the editor login (a co-GM through Discord may not)
  void fetch('/api/v1/session', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ loggedIn?: boolean }>) : null))
    .then((s) => {
      editable = Boolean(s?.loggedIn);
      changed();
    })
    .catch(() => {
      editable = false;
    });

  return {
    map: () => map,
    mapId: () => id,
    setPage(page, again = false) {
      const next = page?.background.kind === 'delve' && page.background.mapId ? page.background.mapId : null;
      if (next === id && !again) return;
      if (next !== id) map = null;
      id = next;
      void load();
    },
    reload: load,
    async send(ops) {
      const target = id;
      if (!target) throw new Error('This page has no Delve map.');
      const res = await fetch(`/api/v1/maps/${encodeURIComponent(target)}/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, by: 'table' }),
      });
      const body = (await res.json().catch(() => ({}))) as { rev?: number; error?: string };
      if (!res.ok) {
        if (res.status === 401) editable = false;
        throw new Error(res.status === 401 ? LOGIN_TO_EDIT : (body.error ?? `saving failed (${res.status})`));
      }
      editable = true;
      if (id === target) await load(); // show the change at once; the picture (if any changed) follows
      return body.rev ?? 0;
    },
    canEdit: () => editable,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
