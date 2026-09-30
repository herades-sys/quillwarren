// Uploaded table images: PNG, JPEG, WebP or GIF (told apart by their first
// bytes, never by what the client claims), stored once per content at
// <dir>/<sha256>.<ext>. Without a data directory they go to a temp dir that
// is removed when the server closes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

export const ASSET_FILE = /^([0-9a-f]{64})\.(png|jpg|webp|gif)$/;

const starts = (b: Buffer, bytes: number[], at = 0): boolean => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The image kind from its magic bytes, or null for anything else. */
export function sniffImage(b: Buffer): ImageExt | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'webp';
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) return 'gif';
  return null;
}

export class TableAssets {
  private dir: string | null;
  private readonly temporary: boolean;

  constructor(dir: string | undefined) {
    this.dir = dir ?? null;
    this.temporary = !dir;
  }

  private folder(): string {
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'delve-table-assets-'));
    else mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /** Store the bytes (if new) and return the file name "<sha>.<ext>". */
  put(bytes: Buffer, ext: ImageExt): string {
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const dir = this.folder();
    const file = join(dir, name);
    if (!existsSync(file)) {
      const tmp = join(dir, `.${name}.${process.pid}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    return name;
  }

  /** The bytes and type of a stored file, or null. `name` must already match ASSET_FILE. */
  get(name: string): { bytes: Buffer; type: string } | null {
    const m = ASSET_FILE.exec(name);
    if (!m || !this.dir) return null;
    const file = join(this.dir, name);
    if (!existsSync(file)) return null;
    return { bytes: readFileSync(file), type: IMAGE_TYPES[m[2] as ImageExt] };
  }

  close(): void {
    if (this.temporary && this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
