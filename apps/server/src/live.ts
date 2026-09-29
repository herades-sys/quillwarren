// Live hub: every open editor or viewer subscribes to one map and gets each
// change as it happens. Players' screens subscribe as "screen": they never get
// map data, only word that something changed (they then fetch their own,
// fog-filtered picture) and where to look.
import type { Bounds } from '@delve/core';
import type { WebSocket } from 'ws';

export type LiveMessage =
  | { type: 'hello'; rev: number; map?: unknown }
  | { type: 'ops'; rev: number; by: string; kind: string; ops: unknown[] }
  | { type: 'focus'; ids: string[]; by: string }
  | { type: 'deleted' }
  /** A storey was added to (or removed from) this map's group: fetch /levels again. */
  | { type: 'levels' }
  | { type: 'ack'; rev: number; ref?: unknown }
  | { type: 'error'; error: string; problems?: string[]; rev?: number; ref?: unknown }
  | { type: 'pong' }
  // players' screens only:
  | { type: 'changed'; rev: number }
  | { type: 'look'; bounds: Bounds };

export type LiveKind = 'full' | 'screen';

export class LiveHub {
  private readonly rooms = new Map<string, Map<WebSocket, LiveKind>>();
  /** What a players' screen gets instead of a message (null: nothing). Set by MapService. */
  forScreen: ((mapId: string, msg: LiveMessage) => LiveMessage | null) | null = null;

  join(mapId: string, socket: WebSocket, kind: LiveKind = 'full'): void {
    let room = this.rooms.get(mapId);
    if (!room) this.rooms.set(mapId, (room = new Map()));
    room.set(socket, kind);
    socket.on('close', () => {
      room.delete(socket);
      if (room.size === 0) this.rooms.delete(mapId);
    });
  }

  count(mapId: string): number {
    return this.rooms.get(mapId)?.size ?? 0;
  }

  broadcast(mapId: string, msg: LiveMessage): void {
    const room = this.rooms.get(mapId);
    if (!room) return;
    const data = JSON.stringify(msg);
    let screenData: string | null | undefined; // worked out once, only if a screen is watching
    for (const [s, kind] of room) {
      if (s.readyState !== s.OPEN) continue;
      if (kind === 'full') s.send(data);
      else {
        if (screenData === undefined) {
          const m = this.forScreen?.(mapId, msg) ?? null;
          screenData = m ? JSON.stringify(m) : null;
        }
        if (screenData) s.send(screenData);
      }
    }
  }

  static send(socket: WebSocket, msg: LiveMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }
}
