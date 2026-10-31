// The app's side of the server's key vault (apps/server/src/desktop/vault.ts):
// the server asks over its IPC channel, and this seals and opens API keys with
// Electron's safeStorage (Windows DPAPI: only this Windows user can open them).
//   {type: "vault", id, op: "status"}           → {type: "vault-reply", id, ok: true, available}
//   {type: "vault", id, op: "seal", data: key}  → {…, ok: true, data: base64}
//   {type: "vault", id, op: "open", data: b64}  → {…, ok: true, data: key}
// Anything else from the channel is ignored. Nothing is logged. Electron's
// safeStorage is passed in, so this is tested without Electron.

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

export interface VaultReply {
  type: 'vault-reply';
  id: string;
  ok: boolean;
  data?: string;
  available?: boolean;
  error?: string;
}

/** The answer to one vault request, or null when the message isn't one. */
export function vaultReply(msg: unknown, safe: SafeStorageLike): VaultReply | null {
  const m = (msg && typeof msg === 'object' ? msg : {}) as { type?: unknown; id?: unknown; op?: unknown; data?: unknown };
  if (m.type !== 'vault' || typeof m.id !== 'string' || m.id.length > 100) return null;
  const id = m.id;
  const fail = (error: string): VaultReply => ({ type: 'vault-reply', id, ok: false, error });
  let available = false;
  try {
    available = safe.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (m.op === 'status') return { type: 'vault-reply', id, ok: true, available };
  if (!available) return fail('encryption isn’t available');
  if (typeof m.data !== 'string' || !m.data || m.data.length > 20_000) return fail('nothing to seal or open');
  try {
    if (m.op === 'seal') return { type: 'vault-reply', id, ok: true, data: safe.encryptString(m.data).toString('base64') };
    if (m.op === 'open') return { type: 'vault-reply', id, ok: true, data: safe.decryptString(Buffer.from(m.data, 'base64')) };
  } catch {
    return fail(m.op === 'open' ? 'couldn’t open it (sealed by another Windows user or computer?)' : 'couldn’t seal it');
  }
  return fail('unknown vault request');
}
