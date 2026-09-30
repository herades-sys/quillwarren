// The table's live connection: one WebSocket to /api/v1/games/:id/live that
// reconnects with backoff. Intents go out with a ref and resolve on the
// server's ack (or reject with its error); everything else is handed to the app.
import type { ClientMessage, Intent, ServerMessage } from '@delve/table';
import { backoff } from './logic.ts';

export type ConnState = 'connecting' | 'live' | 'offline' | 'closed';

export interface ConnHandlers {
  message(msg: ServerMessage): void;
  state(s: ConnState, detail?: string): void;
}

export interface Conn {
  /** Send an intent; resolves with the rev it produced. */
  send(intent: Intent): { ref: number; done: Promise<number> };
  ping(pageId: string, x: number, y: number): void;
  close(): void;
}

// Close codes the server uses when it won't take this browser back (see docs/TABLE.md).
const FINAL: Record<number, string> = {
  4401: 'You are not a member of this game (any more).',
  4403: 'The GM removed you from this game.',
  4404: 'This game no longer exists.',
};

export function connect(gameId: string, h: ConnHandlers): Conn {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let said = false; // a bye already gave the reason
  let nextRef = 1;
  let keepalive: number | undefined;
  const pending = new Map<number, { ok: (rev: number) => void; fail: (e: Error) => void }>();

  const raw = (m: ClientMessage): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  function open(): void {
    if (stopped) return;
    h.state('connecting');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/games/${encodeURIComponent(gameId)}/live`);
    ws = socket;
    socket.onopen = () => {
      clearInterval(keepalive);
      keepalive = window.setInterval(() => raw({ type: 'keepalive' }), 25000);
    };
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        attempt = 0;
        h.state('live');
      }
      h.message(msg);
      if (msg.type === 'ack') {
        pending.get(msg.ref)?.ok(msg.rev);
        pending.delete(msg.ref);
      } else if (msg.type === 'error' && msg.ref !== undefined) {
        pending.get(msg.ref)?.fail(new Error(msg.error));
        pending.delete(msg.ref);
      } else if (msg.type === 'bye') {
        stopped = true;
        said = true;
        h.state('closed', msg.reason);
        socket.close();
      }
    };
    socket.onclose = (ev) => {
      clearInterval(keepalive);
      for (const p of pending.values()) p.fail(new Error('The connection dropped; that change may not have been saved.'));
      pending.clear();
      if (ws === socket) ws = null;
      const final = FINAL[ev.code];
      if (final) stopped = true;
      if (stopped) {
        if (!said) h.state('closed', final);
        return;
      }
      h.state('offline');
      window.setTimeout(open, backoff(attempt++, Math.random()));
    };
  }

  open();
  return {
    send(intent) {
      const ref = nextRef++;
      const done = new Promise<number>((ok, fail) => {
        pending.set(ref, { ok, fail });
        if (!raw({ type: 'intent', ref, intent })) {
          pending.delete(ref);
          fail(new Error('Not connected; wait a moment and try again.'));
        }
      });
      return { ref, done };
    },
    ping(pageId, x, y) {
      raw({ type: 'ping', pageId, x, y });
    },
    close() {
      stopped = true;
      ws?.close();
    },
  };
}
