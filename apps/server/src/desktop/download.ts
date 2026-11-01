// Downloading a model file with resume, for later: the desktop app will
// offer the official Qwen GGUF builds on Hugging Face (DOWNLOADS) for the
// built-in runtime. Nothing calls this yet: the model manager lists the
// downloads as "coming later", and models come from Ollama or a GGUF the user
// puts into the models folder.
//
// The file grows in <name>.part; a new start asks the server for the rest
// (Range: bytes=<size>-) and appends it, or starts over when the server sends
// the whole file again. When it is complete (size, and sha256 when known) it is
// renamed to its real name, so a half file never looks like a model.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export interface ModelDownload {
  id: string;
  label: string;
  /** The Hugging Face repository (the publisher's own). */
  repo: string;
  file: string;
  url: string;
  /** Roughly, for the page and a free-space check; the server's Content-Length decides. */
  approxBytes: number;
  licence: string;
  /** Pinned when the download is switched on (Hugging Face shows each file's sha256). */
  sha256?: string;
}

/**
 * The official GGUF builds from Qwen (Apache-2.0). The file names follow the
 * repositories' naming (<Model>-<quant>.gguf); check them and pin each sha256
 * before switching the download on.
 */
export const DOWNLOADS: readonly ModelDownload[] = [
  {
    id: 'qwen3-8b-q4km',
    label: 'Qwen3 8B · Q4_K_M (recommended, needs about 6 GB of memory)',
    repo: 'Qwen/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    approxBytes: 5_030_000_000,
    licence: 'Apache-2.0',
  },
  {
    id: 'qwen3-4b-q4km',
    label: 'Qwen3 4B · Q4_K_M (smaller and faster, follows requests less well)',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    approxBytes: 2_500_000_000,
    licence: 'Apache-2.0',
  },
];

export interface DownloadProgress {
  /** Bytes on disk so far. */
  done: number;
  /** The whole file, once the server said. */
  total?: number;
  /** This run resumed a .part file. */
  resumed: boolean;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Checked when the file is complete; a mismatch deletes the .part file. */
  sha256?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** Header User-Agent; Hugging Face asks clients to say who they are. */
  userAgent?: string;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function hashFile(file: string, into: ReturnType<typeof createHash>): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (c) => into.update(c))
      .on('error', reject)
      .on('end', () => resolve());
  });
}

/** "bytes 100-199/1000" → 1000. */
export function totalFromContentRange(v: string | null): number | undefined {
  const m = /\/(\d+)\s*$/.exec(v ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Downloads url to dest, resuming dest.part when there is one. Resolves with
 * the final size; rejects (keeping the .part for the next try) when the
 * connection fails or the signal aborts.
 */
export async function downloadWithResume(url: string, dest: string, o: DownloadOptions = {}): Promise<{ size: number; resumed: boolean }> {
  const part = `${dest}.part`;
  const doFetch = o.fetch ?? fetch;
  let have = await sizeOf(part);
  const headers: Record<string, string> = { 'user-agent': o.userAgent ?? 'Quillwarren-desktop' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await doFetch(url, { headers, redirect: 'follow', ...(o.signal ? { signal: o.signal } : {}) });

  let resumed = false;
  let total: number | undefined;
  if (res.status === 416 && have > 0) {
    // asked past the end: the .part may already be the whole file
    total = totalFromContentRange(res.headers.get('content-range')) ?? have;
    if (have !== total) {
      await rm(part, { force: true });
      throw new Error(`the server refused to resume (${have} of ${total} bytes); start again`);
    }
  } else if (res.status === 206 && have > 0) {
    resumed = true;
    total = totalFromContentRange(res.headers.get('content-range'));
  } else if (res.status === 200) {
    have = 0; // the whole file again: start over
    const len = res.headers.get('content-length');
    total = len ? Number(len) : undefined;
  } else {
    throw new Error(`the download answered HTTP ${res.status}`);
  }

  if (res.status !== 416) {
    if (!res.body) throw new Error('the download sent no data');
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    let done = have;
    o.onProgress?.({ done, ...(total !== undefined ? { total } : {}), resumed });
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        done += chunk.length;
        o.onProgress?.({ done, ...(total !== undefined ? { total } : {}), resumed });
      });
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      body.pipe(out);
    });
  }

  const size = await sizeOf(part);
  if (total !== undefined && size !== total) throw new Error(`the download stopped at ${size} of ${total} bytes; it resumes next time`);
  if (o.sha256) {
    const h = createHash('sha256');
    await hashFile(part, h);
    const got = h.digest('hex');
    if (got !== o.sha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new Error(`the downloaded file is damaged (sha256 ${got.slice(0, 12)}…, expected ${o.sha256.slice(0, 12)}…)`);
    }
  }
  await rename(part, dest);
  return { size, resumed };
}
