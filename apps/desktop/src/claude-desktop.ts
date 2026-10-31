// "Connect to Claude Desktop…": the connection file the Delve extension's
// bridge reads (apps/desktop/claude-extension/server/index.js),
// %APPDATA%\Delve\claude-desktop.json:
//   {"app": "Delve", "version": 1, "port": 51234 | null, "key": "<43 chars>", "updated": "…"}
// Its key is the per-install Claude Desktop key: made at the first connect
// (32 random bytes, base64url), kept while connected, gone with the file on
// "Disconnect Claude Desktop" (the next connect makes a new one). It is
// never the window's launch secret. The port is this launch's, written once
// the server listens, and null while Delve is closed, so the bridge never
// sends the key to whatever else may be listening on that port later. The
// file is the only place the key is kept: it doubles as "connected". Pure
// Node (no Electron), so it is tested on its own.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CLAUDE_DESKTOP_FILE = 'claude-desktop.json';
export const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
/** Where Claude Desktop is, for people who don't have it. */
export const CLAUDE_DOWNLOAD_URL = 'https://claude.ai/download';

interface Connection {
  app: 'Delve';
  version: 1;
  port: number | null;
  key: string;
  updated: string;
}

export class ClaudeDesktopLink {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Connection | null {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Connection>;
      if (j && typeof j.key === 'string' && KEY_PATTERN.test(j.key)) return { app: 'Delve', version: 1, port: Number.isInteger(j.port) ? (j.port as number) : null, key: j.key, updated: String(j.updated ?? '') };
    } catch {
      // none, or unreadable: not connected
    }
    return null;
  }

  private write(c: Connection): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The key while connected. */
  key(): string | null {
    return this.read()?.key ?? null;
  }

  connected(): boolean {
    return this.read() !== null;
  }

  /** Turns access on: keeps the key there is, or makes one. Returns it (for the server, never for a log). */
  connect(port: number | null): string {
    const key = this.read()?.key ?? randomBytes(32).toString('base64url');
    this.write({ app: 'Delve', version: 1, port, key, updated: new Date().toISOString() });
    return key;
  }

  /** Where the server listens now (null: Delve is closing). Nothing happens while not connected. */
  setPort(port: number | null): void {
    const c = this.read();
    if (!c || c.port === port) return;
    this.write({ ...c, port, updated: new Date().toISOString() });
  }

  /** Revokes the key: the file goes. */
  disconnect(): void {
    rmSync(this.file, { force: true });
    rmSync(`${this.file}.tmp`, { force: true });
  }
}
