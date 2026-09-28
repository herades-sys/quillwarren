// Live hub: every open editor or viewer subscribes to one map and gets each
// change as it happens.
import type { WebSocket } from 'ws';

export type LiveMessage =
  | { type: 'hello'; rev: number; map: unknown }
  | { type: 'ops'; rev: number; by: string; kind: string; ops: unknown[] }
  | { type: 'focus'; ids: string[]; by: string }
  | { type: 'deleted' }
  | { type: 'ack'; rev: number; ref?: unknown }
  | { type: 'error'; error: string; problems?: string[]; rev?: number; ref?: unknown }
  | { type: 'pong' };

export class LiveHub {
  private readonly rooms = new Map<string, Set<WebSocket>>();

  join(mapId: string, socket: WebSocket): void {
    let room = this.rooms.get(mapId);
    if (!room) this.rooms.set(mapId, (room = new Set()));
    room.add(socket);
    socket.on('close', () => {
      room.delete(socket);
      if (room.size === 0) this.rooms.delete(mapId);
    });
  }

  count(mapId: string): number {
    return this.rooms.get(mapId)?.size ?? 0;
  }

  broadcast(mapId: string, msg: LiveMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.rooms.get(mapId) ?? []) if (s.readyState === s.OPEN) s.send(data);
  }

  static send(socket: WebSocket, msg: LiveMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }
}
