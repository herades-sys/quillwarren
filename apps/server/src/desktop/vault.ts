// The desktop server's SecretBox (chat/api-keys.ts): Electron's safeStorage,
// which only the app's main process can use (it is an Electron API, and this
// server runs on its own node.exe). So the server asks the app over Node's IPC
// channel, the pipe between the two processes that nothing else can reach:
//   server → app   {type: "vault", id, op: "status" | "seal" | "open", data?}
//   app → server   {type: "vault-reply", id, ok, data?, available?, error?}
// The app answers with apps/desktop/src/vault.ts. Without an app on the other
// end (no IPC channel, or no answer) sealing isn't available and keys are kept
// in a user-only file instead (plainBox's way). Nothing here logs a message.
import { randomUUID } from 'node:crypto';
import type { SecretBox } from '../chat/api-keys.ts';

interface Channel {
  send?: (msg: unknown) => boolean;
  connected?: boolean;
  on(event: 'message', fn: (m: unknown) => void): unknown;
  off(event: 'message', fn: (m: unknown) => void): unknown;
}

export function ipcSecretBox(channel: Channel = process as unknown as Channel, timeoutMs = 5000): SecretBox {
  let available: Promise<boolean> | null = null;

  function ask(op: 'status' | 'seal' | 'open', data?: string): Promise<{ data?: string; available?: boolean }> {
    if (!channel.send || channel.connected === false) return Promise.reject(new Error('no app to ask'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        channel.off('message', onMessage);
        fn();
      };
      const onMessage = (m: unknown) => {
        const r = m as { type?: unknown; id?: unknown; ok?: unknown; data?: unknown; available?: unknown; error?: unknown };
        if (!r || r.type !== 'vault-reply' || r.id !== id) return;
        if (r.ok === true) done(() => resolve({ ...(typeof r.data === 'string' ? { data: r.data } : {}), ...(typeof r.available === 'boolean' ? { available: r.available } : {}) }));
        else done(() => reject(new Error(typeof r.error === 'string' ? r.error : 'the app couldn’t do it')));
      };
      const timer = setTimeout(() => done(() => reject(new Error('the app didn’t answer'))), timeoutMs);
      timer.unref?.();
      channel.on('message', onMessage);
      try {
        channel.send!({ type: 'vault', id, op, ...(data !== undefined ? { data } : {}) });
      } catch (e) {
        done(() => reject(e as Error));
      }
    });
  }

  return {
    kind: 'safeStorage',
    available() {
      available ??= ask('status')
        .then((r) => r.available === true)
        .catch(() => false);
      return available;
    },
    async seal(plain) {
      const r = await ask('seal', plain);
      if (typeof r.data !== 'string') throw new Error('the app sealed nothing');
      return r.data;
    },
    async open(sealed) {
      const r = await ask('open', sealed);
      if (typeof r.data !== 'string') throw new Error('the app opened nothing');
      return r.data;
    },
  };
}
