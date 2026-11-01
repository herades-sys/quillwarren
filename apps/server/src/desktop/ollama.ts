// "Import from Ollama": a model the user already pulled with Ollama is a GGUF
// file in Ollama's blob store, so Quillwarren's built-in runtime can use it without
// downloading it again. Ollama keeps
//   <models>/manifests/<registry>/<namespace>/<model>/<tag>   a JSON manifest (OCI style)
//   <models>/blobs/sha256-<hex>                                the layers, named by digest
// where <models> is OLLAMA_MODELS or ~/.ollama/models (%USERPROFILE%\.ollama\models
// on Windows). The manifest's layer with mediaType
// application/vnd.ollama.image.model is the GGUF weights; the others are the
// chat template, parameters, licence and, for vision models, the projector.
// Importing hard-links that blob into Quillwarren's models folder (no extra disk
// space, works without admin rights on the same drive) or copies it when a
// link isn't possible (another drive).
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const OLLAMA_MODEL_LAYER = 'application/vnd.ollama.image.model';
export const DEFAULT_REGISTRY = 'registry.ollama.ai';

export interface OllamaLayer {
  mediaType: string;
  digest: string;
  size: number;
}

export interface OllamaModel {
  /** As `ollama list` shows it: "qwen3:8b", "hf.co/bartowski/Some-GGUF:Q4_K_M", "me/mymodel:latest". */
  name: string;
  manifest: string;
  digest: string;
  /** Size of the weights in bytes, from the manifest. */
  size: number;
  /** Where the weights blob is (or would be). */
  blob: string;
  /** The blob is there and starts like a GGUF file. */
  usable: boolean;
  /** Why not, when it isn't. */
  problem?: string;
  /** A vision model's projector layer is left behind: Quillwarren's chat reads text only. */
  hasProjector: boolean;
}

const DIGEST = /^sha256[:-]([0-9a-f]{64})$/;

/** The model's name the way Ollama prints it, from the manifest's path parts. */
export function ollamaName(registry: string, namespace: string, model: string, tag: string): string {
  const base = registry === DEFAULT_REGISTRY ? (namespace === 'library' ? model : `${namespace}/${model}`) : `${registry}/${namespace}/${model}`;
  return `${base}:${tag}`;
}

/** A file name for Quillwarren's models folder: "qwen3:8b" → "qwen3-8b.gguf". */
export function ggufFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${slug.slice(0, 120) || 'model'}.gguf`;
}

/** The weights layer of a manifest, or what's wrong with it. */
export function weightsLayer(manifest: unknown): { layer: OllamaLayer; hasProjector: boolean } | string {
  const m = (manifest ?? {}) as { layers?: unknown };
  if (!Array.isArray(m.layers)) return 'not an Ollama manifest (no layers)';
  const layers = m.layers.filter((l): l is OllamaLayer => Boolean(l) && typeof (l as OllamaLayer).mediaType === 'string' && typeof (l as OllamaLayer).digest === 'string');
  const weights = layers.filter((l) => l.mediaType === OLLAMA_MODEL_LAYER);
  if (!weights.length) return 'the manifest has no model weights';
  if (weights.length > 1) return 'the model is split into several weight files, which Quillwarren can’t use yet';
  const layer = weights[0]!;
  if (!DIGEST.test(layer.digest)) return `the weights have an unknown digest "${layer.digest}"`;
  return { layer: { ...layer, size: Number(layer.size) || 0 }, hasProjector: layers.some((l) => l.mediaType === 'application/vnd.ollama.image.projector') };
}

/** blobs/sha256-<hex> (Ollama's name on every system since 2024), else the old sha256:<hex> where that exists. */
export async function blobPath(modelsDir: string, digest: string): Promise<string> {
  const hex = DIGEST.exec(digest)![1]!;
  const dash = join(modelsDir, 'blobs', `sha256-${hex}`);
  try {
    await stat(dash);
    return dash;
  } catch {
    const colon = join(modelsDir, 'blobs', `sha256:${hex}`);
    try {
      await stat(colon);
      return colon;
    } catch {
      return dash;
    }
  }
}

/** The first four bytes are "GGUF". */
export async function isGguf(file: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.toString('latin1') === 'GGUF';
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Every model in an Ollama store, usable or not (with the reason). An empty list when there is no store. */
export async function listOllamaModels(modelsDir: string): Promise<OllamaModel[]> {
  const out: OllamaModel[] = [];
  const root = join(modelsDir, 'manifests');
  for (const registry of await dirs(root)) {
    for (const namespace of await dirs(join(root, registry))) {
      for (const model of await dirs(join(root, registry, namespace))) {
        let tags: string[] = [];
        try {
          tags = (await readdir(join(root, registry, namespace, model), { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
        } catch {
          continue;
        }
        for (const tag of tags) {
          const manifest = join(root, registry, namespace, model, tag);
          const name = ollamaName(registry, namespace, model, tag);
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(manifest, 'utf8'));
          } catch {
            out.push({ name, manifest, digest: '', size: 0, blob: '', usable: false, problem: 'the manifest is not readable JSON', hasProjector: false });
            continue;
          }
          const w = weightsLayer(parsed);
          if (typeof w === 'string') {
            out.push({ name, manifest, digest: '', size: 0, blob: '', usable: false, problem: w, hasProjector: false });
            continue;
          }
          const blob = await blobPath(modelsDir, w.layer.digest);
          let problem: string | undefined;
          try {
            const s = await stat(blob);
            if (w.layer.size && s.size !== w.layer.size) problem = `the weights file is ${s.size} bytes, the manifest says ${w.layer.size} (still downloading?)`;
            else if (!(await isGguf(blob))) problem = 'the weights are not a GGUF file';
          } catch {
            problem = 'the weights file is missing from Ollama’s blobs folder';
          }
          out.push({ name, manifest, digest: w.layer.digest, size: w.layer.size, blob, usable: !problem, ...(problem ? { problem } : {}), hasProjector: w.hasProjector });
        }
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ImportResult {
  file: string;
  /** link: a hard link to Ollama's blob (no extra space); copy: a copy. */
  method: 'link' | 'copy';
  size: number;
}

/**
 * Brings an Ollama model into Quillwarren's models folder as <name>.gguf: a hard
 * link where the file system allows it, else a copy (written to .part first,
 * so a cancelled copy never looks like a model). An existing file of that
 * name is replaced only with `replace`.
 */
export async function importOllamaModel(model: OllamaModel, intoDir: string, o: { replace?: boolean; method?: 'auto' | 'copy' } = {}): Promise<ImportResult> {
  if (!model.usable) throw new Error(`${model.name} can’t be imported: ${model.problem ?? 'not usable'}`);
  await mkdir(intoDir, { recursive: true });
  const file = join(intoDir, ggufFileName(model.name));
  if (basename(file) !== ggufFileName(model.name)) throw new Error('bad file name');
  let exists = false;
  try {
    await lstat(file);
    exists = true;
  } catch {
    // free
  }
  if (exists && !o.replace) throw new Error(`${basename(file)} is already in the models folder`);
  if (exists) await rm(file, { force: true });
  if (o.method !== 'copy') {
    try {
      await link(model.blob, file);
      return { file, method: 'link', size: (await stat(file)).size };
    } catch {
      // another drive (EXDEV), or a file system without hard links: copy instead
    }
  }
  const part = `${file}.part`;
  await copyFile(model.blob, part, constants.COPYFILE_FICLONE);
  const size = (await stat(part)).size;
  if (model.size && size !== model.size) {
    await rm(part, { force: true });
    throw new Error(`the copy of ${model.name} is ${size} bytes, expected ${model.size}`);
  }
  await rename(part, file);
  return { file, method: 'copy', size };
}

/** sha256 of a file, for checking a blob against its digest (slow on 5 GB: the model page doesn't do it by default). */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
