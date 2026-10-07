// The desktop app's model files: GGUF files in %LOCALAPPDATA%\Delve\models
// (DELVE_MODELS_DIR), from "import from Ollama", a download (later), or put
// there by hand. Plus the built-in runtime's settings (which model, GPU or
// CPU, context size) in <DELVE_DATA>/runtime.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isGguf } from './ollama.ts';

export interface ModelFile {
  /** The file name, e.g. "qwen3-8b.gguf"; the id everywhere else. */
  file: string;
  size: number;
  modified: string;
  /** Starts like a GGUF file. */
  gguf: boolean;
  /** A hard link (shared with Ollama's copy: deleting it here frees no space while Ollama keeps it). */
  shared: boolean;
}

/** A file name in the models folder, or null for anything that would leave it or isn't a model. */
export function modelFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (!name || name !== basename(name) || name.includes('\\') || name.startsWith('.') || !/\.gguf$/i.test(name) || name.length > 200) return null;
  return name;
}

export class ModelLibrary {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  path(file: string): string {
    const name = modelFileName(file);
    if (!name) throw new Error(`"${String(file)}" is not a model file name`);
    return join(this.dir, name);
  }

  async list(): Promise<ModelFile[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir, { withFileTypes: true })).filter((d) => d.isFile() && /\.gguf$/i.test(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
    const out: ModelFile[] = [];
    for (const file of names.sort((a, b) => a.localeCompare(b))) {
      const p = join(this.dir, file);
      try {
        const s = await stat(p);
        out.push({ file, size: s.size, modified: s.mtime.toISOString(), gguf: await isGguf(p), shared: s.nlink > 1 });
      } catch {
        // gone meanwhile
      }
    }
    return out;
  }

  /** Downloads still in progress (*.gguf.part). */
  async partial(): Promise<{ file: string; size: number }[]> {
    try {
      const names = (await readdir(this.dir)).filter((n) => /\.gguf\.part$/i.test(n));
      return Promise.all(names.map(async (file) => ({ file, size: (await stat(join(this.dir, file))).size })));
    } catch {
      return [];
    }
  }

  async remove(file: string): Promise<void> {
    await rm(this.path(file), { force: false });
  }

  /** What the models take, and what is free on their drive. */
  async disk(): Promise<{ used: number; free?: number }> {
    const used = (await this.list()).reduce((s, m) => s + (m.shared ? 0 : m.size), 0) + (await this.partial()).reduce((s, p) => s + p.size, 0);
    try {
      mkdirSync(this.dir, { recursive: true });
      const fs = await statfs(this.dir);
      return { used, free: fs.bavail * fs.bsize };
    } catch {
      return { used };
    }
  }
}

// ---------- the built-in runtime's settings ----------

export interface RuntimeSettings {
  /** The model file the built-in runtime runs (a name in the models folder). */
  model?: string;
  /** auto: offload to the GPU, falling back to the CPU when that fails; cpu: never use the GPU. */
  gpu: 'auto' | 'cpu';
  /** Tokens of context (the lean chat needs about 10 000). */
  ctxSize: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = { gpu: 'auto', ctxSize: 16384 };

export function parseRuntimeSettings(body: unknown, before: RuntimeSettings): RuntimeSettings | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const next: RuntimeSettings = { ...before };
  if (b.model !== undefined) {
    if (b.model === null || b.model === '') delete next.model;
    else {
      const name = modelFileName(b.model);
      if (!name) return 'model: a .gguf file in the models folder';
      next.model = name;
    }
  }
  if (b.gpu !== undefined) {
    if (b.gpu !== 'auto' && b.gpu !== 'cpu') return 'gpu: auto or cpu';
    next.gpu = b.gpu;
  }
  if (b.ctxSize !== undefined) {
    const n = Number(b.ctxSize);
    if (!Number.isInteger(n) || n < 2048 || n > 131072) return 'ctxSize: a whole number from 2048 to 131072';
    next.ctxSize = n;
  }
  return next;
}

export class RuntimeSettingsStore {
  private value: RuntimeSettings;
  private readonly file: string | undefined;

  constructor(file: string | undefined) {
    this.file = file;
    this.value = { ...DEFAULT_RUNTIME_SETTINGS };
    if (!file) return;
    try {
      const saved = parseRuntimeSettings(JSON.parse(readFileSync(file, 'utf8')), this.value);
      if (typeof saved !== 'string') this.value = saved;
    } catch {
      // none yet
    }
  }

  get(): RuntimeSettings {
    return { ...this.value };
  }

  set(next: RuntimeSettings): void {
    this.value = { ...next };
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.value, null, 2)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}
