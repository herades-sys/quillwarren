// One path for every change, whether it comes from REST, MCP or the WebSocket:
// store it, then tell everyone watching the map.
import { insidePolygons, objectBounds, visiblePolygons, type Bounds, type Op } from '@delve/core';
import type { LiveHub } from './live.ts';
import type { Change, MapStore } from './store.ts';

/** Does a change set or unset a map's storey (level)? */
const touchesLevel = (ops: readonly Op[]): boolean =>
  ops.some((o) => (o.op === 'batch' ? touchesLevel(o.ops) : o.op === 'update_map' && (Object.hasOwn(o.set ?? {}, 'level') || Boolean(o.unset?.includes('level')))));

export class MapService {
  readonly store: MapStore;
  readonly hub: LiveHub;

  constructor(store: MapStore, hub: LiveHub) {
    this.store = store;
    this.hub = hub;
    // Players' screens hear only that the picture changed, and where to look.
    hub.forScreen = (id, msg) => {
      if (msg.type === 'ops') return { type: 'changed', rev: msg.rev };
      if (msg.type === 'deleted') return msg;
      if (msg.type === 'focus') {
        const bounds = this.playersFocus(id, msg.ids);
        return bounds ? { type: 'look', bounds } : null;
      }
      return null;
    };
  }

  /** Where the players' screen should look for these ids: only the ones the players can see. */
  playersFocus(id: string, ids: readonly string[]): Bounds | null {
    let map;
    try {
      map = this.store.get(id).map;
    } catch {
      return null;
    }
    const seen = map.fog?.on ? visiblePolygons(map) : null;
    const byId = new Map(map.objects.map((o) => [o.id, o]));
    const boxes = ids.flatMap((i) => {
      const o = byId.get(i);
      const b = o ? objectBounds(o, map) : null;
      if (!b) return [];
      return !seen || insidePolygons(seen, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]) ? [b] : [];
    });
    if (!boxes.length) return null;
    return {
      x0: Math.min(...boxes.map((b) => b.x0)),
      y0: Math.min(...boxes.map((b) => b.y0)),
      x1: Math.max(...boxes.map((b) => b.x1)),
      y1: Math.max(...boxes.map((b) => b.y1)),
    };
  }

  private readonly listeners: ((mapId: string) => void)[] = [];

  /** Hear about every change to any map, and deletions (Delve Table redraws the pages drawn from a map). */
  onChange(cb: (mapId: string) => void): void {
    this.listeners.push(cb);
  }

  private publish(c: Change): Change {
    this.hub.broadcast(c.mapId, { type: 'ops', rev: c.rev, by: c.by, kind: c.kind, ops: c.ops });
    for (const l of this.listeners) l(c.mapId);
    // a storey renamed or renumbered: the other storeys' pickers list it again
    const group = c.map.level?.group;
    if (group && touchesLevel(c.ops)) for (const m of this.store.list()) if (m.level?.group === group && m.id !== c.mapId) this.hub.broadcast(m.id, { type: 'levels' });
    return c;
  }

  create(input: unknown, by: string): Change {
    return this.store.create(input, by);
  }

  /** onCommit runs after storing and before broadcasting (the WebSocket acks its sender first). */
  apply(id: string, ops: Op[], opts: { baseRev?: number; by: string; onCommit?: (c: Change) => void }): Change {
    const c = this.store.apply(id, ops, opts);
    opts.onCommit?.(c);
    return this.publish(c);
  }

  undo(id: string, by: string): Change {
    return this.publish(this.store.undo(id, by));
  }

  redo(id: string, by: string): Change {
    return this.publish(this.store.redo(id, by));
  }

  delete(id: string): void {
    const group = this.store.get(id).map.level?.group;
    this.store.delete(id);
    this.hub.broadcast(id, { type: 'deleted' });
    for (const l of this.listeners) l(id);
    // the other storeys' pickers drop this one
    if (group) for (const m of this.store.list()) if (m.level?.group === group) this.hub.broadcast(m.id, { type: 'levels' });
  }

  /** Ask every open viewer to pan to these objects. Returns how many are watching. */
  focus(id: string, ids: string[], by: string): number {
    this.store.get(id);
    this.hub.broadcast(id, { type: 'focus', ids, by });
    return this.hub.count(id);
  }
}
