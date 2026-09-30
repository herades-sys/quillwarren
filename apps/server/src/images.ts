// Uploaded pictures for maps (the `image` object): PNG, JPEG, WebP or GIF, told
// apart by their first bytes (never by what the client claims), stored once per
// content as <dir>/<sha256>.<ext> beside index.json (name, pixel size, upload
// time). Without a data directory they go to a temp dir removed on close.
// The routes: upload, list, serve (public, like maps) and delete (refused while
// a map still uses the picture).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { IMAGE_SRC, imageUrl } from '@delve/core';
import { writeGuard } from './api.ts';
import type { Sessions } from './auth.ts';
import { addImageSource } from './png.ts';
import type { MapStore } from './store.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Bigger pictures would take hundreds of MB to decode for a PNG export. */
export const MAX_IMAGE_SIDE = 12_000;
export const MAX_IMAGE_PIXELS = 50_000_000;

export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

export interface ImageInfo {
  src: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  uploaded: string;
}

export class ImageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
  }
}

const starts = (b: Buffer, bytes: readonly number[], at = 0): boolean => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The picture's kind from its magic bytes, or null for anything else (SVG and HTML included). */
export function sniffImage(b: Buffer): ImageExt | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'webp';
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) return 'gif';
  return null;
}

/** Width and height in pixels from the file header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X, GIF screen), or null. */
export function imageDimensions(b: Buffer, ext: ImageExt): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  try {
    switch (ext) {
      case 'png':
        return starts(b, ascii('IHDR'), 12) ? ok(b.readUInt32BE(16), b.readUInt32BE(20)) : null;
      case 'gif':
        return ok(b.readUInt16LE(6), b.readUInt16LE(8));
      case 'webp': {
        const chunk = b.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && starts(b, [0x9d, 0x01, 0x2a], 23)) return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
        if (chunk === 'VP8L' && b[20] === 0x2f) {
          const bits = b.readUInt32LE(21);
          return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        if (chunk === 'VP8X') return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
        return null;
      }
      case 'jpg': {
        // walk the segments to the first frame header (SOF0–SOF15, except DHT C4, JPG C8 and DAC CC)
        let at = 2;
        while (at + 4 <= b.length) {
          if (b[at] !== 0xff) return null;
          const marker = b[at + 1]!;
          if (marker === 0xff) {
            at++; // fill byte
            continue;
          }
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2; // no length
            continue;
          }
          if (marker === 0xd9 || marker === 0xda) return null; // end, or image data before any frame header
          const len = b.readUInt16BE(at + 2);
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return ok(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
          }
          if (len < 2) return null;
          at += 2 + len;
        }
        return null;
      }
    }
  } catch {
    return null; // cut short
  }
}

/** A display name: printable, trimmed, at most 100 characters. */
export function cleanImageName(v: unknown, fallback = 'Picture'): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return s || fallback;
}

export class ImageLibrary {
  private dir: string | null;
  private readonly temporary: boolean;
  private index: Map<string, ImageInfo> | null = null;
  private readonly detach: () => void;

  constructor(dir: string | undefined) {
    this.dir = dir ?? null;
    this.temporary = !dir;
    // PNG exports (png.ts) read the pictures from here
    this.detach = addImageSource((src) => this.read(src));
  }

  private folder(): string {
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'delve-images-'));
    else mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /** index.json, plus any picture file it doesn't know about (a lost or older index). */
  private entries(): Map<string, ImageInfo> {
    if (this.index) return this.index;
    const index = new Map<string, ImageInfo>();
    if (this.dir && existsSync(this.dir)) {
      let saved: Record<string, Partial<ImageInfo>> = {};
      try {
        saved = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as Record<string, Partial<ImageInfo>>;
      } catch {
        saved = {};
      }
      for (const file of readdirSync(this.dir)) {
        const m = IMAGE_SRC.exec(file);
        if (!m) continue;
        const known = saved[file];
        let { width, height } = known ?? {};
        if (!(Number(width) > 0 && Number(height) > 0)) {
          const size = imageDimensions(readFileSync(join(this.dir, file)), m[1] as ImageExt);
          width = size?.width ?? 0;
          height = size?.height ?? 0;
        }
        const stat = statSync(join(this.dir, file));
        index.set(file, {
          src: file,
          name: cleanImageName(known?.name, file),
          width: Number(width),
          height: Number(height),
          bytes: stat.size,
          uploaded: typeof known?.uploaded === 'string' ? known.uploaded : stat.mtime.toISOString(),
        });
      }
    }
    this.index = index;
    return index;
  }

  private save(): void {
    const dir = this.folder();
    const tmp = join(dir, `.index.${process.pid}.tmp`);
    const out = Object.fromEntries([...this.entries()].map(([src, { name, width, height, uploaded }]) => [src, { name, width, height, uploaded }]));
    writeFileSync(tmp, JSON.stringify(out, null, 1));
    renameSync(tmp, join(dir, 'index.json'));
  }

  /** Store a picture (once per content). Throws ImageError for anything that isn't a sane PNG, JPEG, WebP or GIF. */
  add(bytes: Buffer, name?: unknown): { info: ImageInfo; created: boolean } {
    if (!bytes.length) throw new ImageError(400, 'send the picture as the request body (PNG, JPEG, WebP or GIF)');
    if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError(413, `the picture is too big: at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    const ext = sniffImage(bytes);
    if (!ext) throw new ImageError(400, 'that is not a PNG, JPEG, WebP or GIF picture');
    const size = imageDimensions(bytes, ext);
    if (!size) throw new ImageError(400, `the ${ext.toUpperCase()} file is damaged: its size can't be read`);
    if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE || size.width * size.height > MAX_IMAGE_PIXELS) {
      throw new ImageError(413, `the picture is too large (${size.width}×${size.height} px): at most ${MAX_IMAGE_SIDE} px a side and ${MAX_IMAGE_PIXELS / 1e6} megapixels`);
    }
    const src = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const index = this.entries();
    const known = index.get(src);
    if (known) return { info: known, created: false };
    const dir = this.folder();
    const tmp = join(dir, `.${src}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(dir, src));
    const info: ImageInfo = { src, name: cleanImageName(name), ...size, bytes: bytes.length, uploaded: new Date().toISOString() };
    index.set(src, info);
    this.save();
    return { info, created: true };
  }

  /** Newest first. */
  list(): ImageInfo[] {
    return [...this.entries().values()].sort((a, b) => b.uploaded.localeCompare(a.uploaded) || a.src.localeCompare(b.src));
  }

  get(src: string): ImageInfo | undefined {
    return IMAGE_SRC.test(src) ? this.entries().get(src) : undefined;
  }

  /** The file's bytes, or null. Only names matching IMAGE_SRC ever reach the file system. */
  read(src: string): Buffer | null {
    if (!IMAGE_SRC.test(src) || !this.dir) return null;
    const file = join(this.dir, src);
    return existsSync(file) ? readFileSync(file) : null;
  }

  remove(src: string): boolean {
    if (!this.get(src) || !this.dir) return false;
    rmSync(join(this.dir, src), { force: true });
    this.entries().delete(src);
    this.save();
    return true;
  }

  close(): void {
    this.detach();
    if (this.temporary && this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The maps (not deleted) that place this picture. */
export function mapsUsing(store: MapStore, src: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const m of store.list()) {
    try {
      if (store.get(m.id).map.objects.some((o) => o.type === 'image' && o.src === src)) out.push({ id: m.id, name: m.name });
    } catch {
      // gone in the meantime
    }
  }
  return out;
}

const withUrl = (i: ImageInfo) => ({ ...i, url: imageUrl(i.src) });

export interface ImageDeps {
  images: ImageLibrary;
  store: MapStore;
  token: string | undefined;
  sessions: Sessions;
}

export function registerImages(app: FastifyInstance, { images, store, token, sessions }: ImageDeps): void {
  const writer = writeGuard(token, sessions);
  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ImageError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  void app.register(async (s) => {
    // Uploads may say image/* (application/octet-stream is parsed app-wide already); the bytes decide what it is.
    s.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

    s.get('/api/v1/images', async () => ({ images: images.list().map(withUrl) }));

    // the login is checked before the body is read, so nobody can make the server swallow 10 MB for nothing
    s.post('/api/v1/images', { onRequest: writer, bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) {
        return reply.code(415).send({ error: 'send the picture itself as the body, with content-type image/png, image/jpeg, image/webp, image/gif or application/octet-stream' });
      }
      try {
        const { info, created } = images.add(req.body, (req.query as { name?: unknown }).name);
        const { src, name, width, height } = info;
        return reply.code(created ? 201 : 200).send({ src, url: imageUrl(src), width, height, name });
      } catch (e) {
        return refuse(reply, e);
      }
    });

    s.get('/api/v1/images/:src', async (req, reply) => {
      const { src } = req.params as { src: string };
      const m = IMAGE_SRC.exec(src);
      const bytes = m ? images.read(src) : null;
      if (!m || !bytes) return reply.code(404).send({ error: 'no such image' });
      // the type comes from the magic bytes checked at upload (it's in the name), never from the uploader
      return reply
        .type(IMAGE_TYPES[m[1] as ImageExt])
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(bytes);
    });

    s.delete('/api/v1/images/:src', { preHandler: writer }, async (req, reply) => {
      const { src } = req.params as { src: string };
      if (!images.get(src)) return reply.code(404).send({ error: 'no such image' });
      const maps = mapsUsing(store, src);
      if (maps.length) {
        return reply.code(409).send({ error: `still used on ${maps.length === 1 ? 'the map' : `${maps.length} maps:`} ${maps.map((m) => `"${m.name}"`).join(', ')}; remove it there first`, maps });
      }
      images.remove(src);
      return reply.code(204).send();
    });
  });
}
