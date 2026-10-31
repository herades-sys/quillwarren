// The user's own API keys for the desktop app's chat (Anthropic, OpenAI):
// kept in <DELVE_DATA>/chat-keys.json, sealed by a SecretBox. In the Windows
// app the box is Electron's safeStorage (Windows DPAPI: only this Windows user
// can open it), reached over the server's IPC channel to the app
// (desktop/vault.ts); without it (tests, a build without the app) the key is
// kept as it is, in a file only this user can read (mode 0600; %APPDATA% is the
// user's own on Windows). The page never gets a key back: only whether one is
// saved and its last four characters. Nothing here logs a key.
//
// Only the desktop app's chat (chat/api-chat.ts, via desktop/main.ts) uses this.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const KEY_PROVIDERS = ['anthropic', 'openai'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** Seals and opens secrets; the app's safeStorage, or nothing (the key kept as it is). */
export interface SecretBox {
  /** What seals the keys: "safeStorage" (Electron, DPAPI on Windows) or "none". */
  readonly kind: string;
  /** Whether sealing works now (safeStorage needs the app). */
  available(): Promise<boolean>;
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

/** No sealing: the key is stored as it is, in a user-only file. */
export const plainBox: SecretBox = {
  kind: 'none',
  available: async () => false,
  seal: async (s) => s,
  open: async (s) => s,
};

interface StoredKey {
  /** The sealed key (box "none": the key itself). */
  sealed: string;
  /** What sealed it: "safeStorage" or "none". */
  box: string;
  last4: string;
  saved: string;
}

/** The last four characters, for the settings ("…a1B2"). */
export const keyHint = (last4: string): string => `…${last4}`;

/** A key as typed (trimmed), or what is wrong with it. Never echoes the key. */
export function checkKey(provider: KeyProvider, v: unknown): { key: string } | { error: string } {
  if (typeof v !== 'string') return { error: 'the API key is missing' };
  const key = v.trim();
  if (!key) return { error: 'the API key is empty' };
  if (key.length < 20 || key.length > 400 || !/^[\x21-\x7e]+$/.test(key)) return { error: 'that doesn’t look like an API key (no spaces, 20 to 400 characters)' };
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) return { error: 'that doesn’t look like an Anthropic API key: they start with sk-ant-' };
  if (provider === 'anthropic' && key.startsWith('sk-ant-admin')) return { error: 'that is an Anthropic Admin key: use a normal API key from the Console' };
  if (provider === 'openai' && !key.startsWith('sk-')) return { error: 'that doesn’t look like an OpenAI API key: they start with sk-' };
  return { key };
}

/** The keys file, read once and kept in step; opened keys are kept in memory for this run. */
export class KeyStore {
  private readonly file: string | undefined;
  private readonly box: SecretBox;
  private stored: Partial<Record<KeyProvider, StoredKey>> = {};
  private opened = new Map<KeyProvider, string>();

  constructor(file: string | undefined, box: SecretBox) {
    this.file = file;
    this.box = box;
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { keys?: Record<string, unknown> };
      for (const p of KEY_PROVIDERS) {
        const k = j.keys?.[p] as Partial<StoredKey> | undefined;
        if (k && typeof k.sealed === 'string' && typeof k.box === 'string' && typeof k.last4 === 'string') {
          this.stored[p] = { sealed: k.sealed, box: k.box, last4: k.last4, saved: String(k.saved ?? '') };
        }
      }
    } catch {
      // none yet, or unreadable: no keys
    }
  }

  /** What the settings may show: never the key. */
  info(p: KeyProvider): { set: boolean; hint?: string; storage?: 'encrypted' | 'file' } {
    const k = this.stored[p];
    return k ? { set: true, hint: keyHint(k.last4), storage: k.box === 'none' ? 'file' : 'encrypted' } : { set: false };
  }

  has(p: KeyProvider): boolean {
    return Boolean(this.stored[p]);
  }

  /** Seals and saves a key (checked with checkKey first). */
  async set(p: KeyProvider, key: string): Promise<void> {
    const sealedByBox = await this.box.available().catch(() => false);
    const sealed = sealedByBox ? await this.box.seal(key) : key;
    this.stored[p] = { sealed, box: sealedByBox ? this.box.kind : 'none', last4: key.slice(-4), saved: new Date().toISOString() };
    this.opened.set(p, key);
    this.write();
  }

  remove(p: KeyProvider): void {
    delete this.stored[p];
    this.opened.delete(p);
    this.write();
  }

  /** The key itself, for a request to its provider; throws a plain message when it can't be opened. */
  async get(p: KeyProvider): Promise<string> {
    const cached = this.opened.get(p);
    if (cached) return cached;
    const k = this.stored[p];
    if (!k) throw new Error('no API key is saved');
    let key: string;
    if (k.box === 'none') key = k.sealed;
    else {
      if (k.box !== this.box.kind || !(await this.box.available().catch(() => false))) throw new Error('the saved API key can’t be opened here: enter it again in the chat settings');
      try {
        key = await this.box.open(k.sealed);
      } catch {
        throw new Error('the saved API key can’t be opened (it was saved by another Windows user or computer): enter it again in the chat settings');
      }
    }
    this.opened.set(p, key);
    return key;
  }

  private write(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    if (!Object.keys(this.stored).length) {
      rmSync(this.file, { force: true });
      return;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, keys: this.stored }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
