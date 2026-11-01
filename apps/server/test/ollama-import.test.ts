// "Import from Ollama" (desktop/ollama.ts), the models folder (desktop/models.ts)
// and the model manager's API, on a fake Ollama store laid out as Ollama keeps
// it: manifests/<registry>/<namespace>/<model>/<tag> and blobs/sha256-<hex>.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerModelManager } from '../src/desktop/models-page.ts';
import { ModelLibrary, modelFileName, parseRuntimeSettings, RuntimeSettingsStore } from '../src/desktop/models.ts';
import { ggufFileName, importOllamaModel, isGguf, listOllamaModels, ollamaName, weightsLayer, OLLAMA_MODEL_LAYER } from '../src/desktop/ollama.ts';
import { LlamaRuntime } from '../src/desktop/runtime.ts';

let root: string;
let ollama: string;
let models: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delve-ollama-'));
  ollama = join(root, '.ollama', 'models');
  models = join(root, 'Quillwarren', 'models');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A blob in the store; returns its digest. */
function blob(content: Buffer | string, name?: string): string {
  const hex = sha(content);
  mkdirSync(join(ollama, 'blobs'), { recursive: true });
  writeFileSync(join(ollama, 'blobs', name ?? `sha256-${hex}`), content);
  return `sha256:${hex}`;
}

function manifest(path: string[], layers: { mediaType: string; digest: string; size: number }[]): void {
  const dir = join(ollama, 'manifests', ...path.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const config = blob('{"model_format":"gguf"}');
  writeFileSync(
    join(dir, path.at(-1)!),
    JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: config, size: 23 }, layers }),
  );
}

const gguf = (n: number) => Buffer.concat([Buffer.from('GGUF'), Buffer.from([3, 0, 0, 0]), Buffer.alloc(n, 7)]);
const layer = (mediaType: string, content: Buffer | string, name?: string) => ({ mediaType, digest: blob(content, name), size: Buffer.byteLength(content) });

/** The store a user might have: qwen3:8b, a Hugging Face pull, one still downloading, one broken, a vision model. */
function fakeStore(): void {
  const template = layer('application/vnd.ollama.image.template', '{{ .Prompt }}');
  manifest(['registry.ollama.ai', 'library', 'qwen3', '8b'], [layer(OLLAMA_MODEL_LAYER, gguf(4000)), template, layer('application/vnd.ollama.image.license', 'Apache-2.0'), layer('application/vnd.ollama.image.params', '{"temperature":0.6}')]);
  manifest(['hf.co', 'bartowski', 'Qwen3-4B-GGUF', 'Q4_K_M'], [layer(OLLAMA_MODEL_LAYER, gguf(1500))]);
  const partial = gguf(3000);
  manifest(['registry.ollama.ai', 'library', 'big', 'latest'], [{ mediaType: OLLAMA_MODEL_LAYER, digest: blob(partial.subarray(0, 1000)).replace(/:.*/, `:${sha(partial)}`), size: partial.length }]);
  manifest(['registry.ollama.ai', 'library', 'notgguf', 'latest'], [layer(OLLAMA_MODEL_LAYER, 'safetensors? no')]);
  manifest(['registry.ollama.ai', 'me', 'eyes', 'v1'], [layer(OLLAMA_MODEL_LAYER, gguf(800)), layer('application/vnd.ollama.image.projector', gguf(100))]);
  mkdirSync(join(ollama, 'manifests', 'registry.ollama.ai', 'library', 'junk'), { recursive: true });
  writeFileSync(join(ollama, 'manifests', 'registry.ollama.ai', 'library', 'junk', 'latest'), 'not json');
}

describe('reading Ollama’s store', () => {
  it('names models the way `ollama list` does, and files them as .gguf', () => {
    expect(ollamaName('registry.ollama.ai', 'library', 'qwen3', '8b')).toBe('qwen3:8b');
    expect(ollamaName('registry.ollama.ai', 'me', 'eyes', 'v1')).toBe('me/eyes:v1');
    expect(ollamaName('hf.co', 'bartowski', 'Qwen3-4B-GGUF', 'Q4_K_M')).toBe('hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M');
    expect(ggufFileName('qwen3:8b')).toBe('qwen3-8b.gguf');
    expect(ggufFileName('hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M')).toBe('hf.co-bartowski-qwen3-4b-gguf-q4_k_m.gguf');
    expect(ggufFileName('../../etc:passwd')).toBe('etc-passwd.gguf');
  });

  it('finds the weights layer in a manifest', () => {
    expect(weightsLayer({})).toMatch(/no layers/);
    expect(weightsLayer({ layers: [{ mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:x' }] })).toMatch(/no model weights/);
    const two = { mediaType: OLLAMA_MODEL_LAYER, digest: `sha256:${'a'.repeat(64)}`, size: 1 };
    expect(weightsLayer({ layers: [two, two] })).toMatch(/several/);
    expect(weightsLayer({ layers: [{ ...two, digest: 'md5:abc' }] })).toMatch(/unknown digest/);
    expect(weightsLayer({ layers: [two] })).toEqual({ layer: two, hasProjector: false });
  });

  it('lists every model, with what is wrong with the ones Quillwarren can’t use', async () => {
    fakeStore();
    const list = await listOllamaModels(ollama);
    const by = Object.fromEntries(list.map((m) => [m.name, m]));
    expect(Object.keys(by)).toEqual(['big:latest', 'hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M', 'junk:latest', 'me/eyes:v1', 'notgguf:latest', 'qwen3:8b']);
    expect(by['qwen3:8b']).toMatchObject({ usable: true, size: 4008, hasProjector: false });
    expect(by['qwen3:8b']!.blob).toBe(join(ollama, 'blobs', `sha256-${sha(gguf(4000))}`));
    expect(by['hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M']).toMatchObject({ usable: true });
    expect(by['big:latest']!.problem).toMatch(/missing/);
    expect(by['notgguf:latest']!.problem).toMatch(/not a GGUF/);
    expect(by['junk:latest']!.problem).toMatch(/not readable JSON/);
    expect(by['me/eyes:v1']).toMatchObject({ usable: true, hasProjector: true });
    expect(await listOllamaModels(join(root, 'nothing-here'))).toEqual([]);
  });

  it('reads old stores whose blobs are named sha256:<hex>', async () => {
    const content = gguf(100);
    manifest(['registry.ollama.ai', 'library', 'old', 'latest'], [{ mediaType: OLLAMA_MODEL_LAYER, digest: `sha256:${sha(content)}`, size: content.length }]);
    blob(content, `sha256:${sha(content)}`);
    const [m] = await listOllamaModels(ollama);
    expect(m).toMatchObject({ name: 'old:latest', usable: true });
    expect(m!.blob.endsWith(`sha256:${sha(content)}`)).toBe(true);
  });
});

describe('importing a model', () => {
  it('hard-links the weights into the models folder (no extra space), and refuses to overwrite', async () => {
    fakeStore();
    const qwen = (await listOllamaModels(ollama)).find((m) => m.name === 'qwen3:8b')!;
    const r = await importOllamaModel(qwen, models);
    expect(r).toEqual({ file: join(models, 'qwen3-8b.gguf'), method: 'link', size: 4008 });
    expect(readFileSync(r.file)).toEqual(gguf(4000));
    expect(statSync(r.file).nlink).toBe(2);
    expect(await isGguf(r.file)).toBe(true);
    await expect(importOllamaModel(qwen, models)).rejects.toThrow(/already/);
    expect((await importOllamaModel(qwen, models, { replace: true })).method).toBe('link');
  });

  it('copies when a link isn’t possible, and never imports an unusable model', async () => {
    fakeStore();
    const list = await listOllamaModels(ollama);
    const hf = list.find((m) => m.name.startsWith('hf.co'))!;
    const r = await importOllamaModel(hf, models, { method: 'copy' });
    expect(r.method).toBe('copy');
    expect(statSync(r.file).nlink).toBe(1);
    expect(readFileSync(r.file)).toEqual(gguf(1500));
    await expect(importOllamaModel(list.find((m) => m.name === 'big:latest')!, models)).rejects.toThrow(/can’t be imported/);
  });

  it('lists the models folder with sizes, shared files and disk use', async () => {
    fakeStore();
    for (const m of (await listOllamaModels(ollama)).filter((x) => x.usable && !x.hasProjector)) await importOllamaModel(m, models, m.name.startsWith('hf') ? { method: 'copy' } : {});
    writeFileSync(join(models, 'notes.txt'), 'not a model');
    writeFileSync(join(models, 'broken.gguf'), 'nope');
    writeFileSync(join(models, 'next.gguf.part'), Buffer.alloc(50));
    const lib = new ModelLibrary(models);
    const list = await lib.list();
    expect(list.map((m) => [m.file, m.size, m.gguf, m.shared])).toEqual([
      ['broken.gguf', 4, false, false],
      ['hf.co-bartowski-qwen3-4b-gguf-q4_k_m.gguf', 1508, true, false],
      ['qwen3-8b.gguf', 4008, true, true],
    ]);
    expect(await lib.partial()).toEqual([{ file: 'next.gguf.part', size: 50 }]);
    const disk = await lib.disk();
    expect(disk.used).toBe(4 + 1508 + 50); // the linked one takes no space of its own
    expect(disk.free).toBeGreaterThan(0);
    expect(() => lib.path('../x.gguf')).toThrow();
    expect(() => lib.path('x.txt')).toThrow();
    expect(modelFileName('a\\b.gguf')).toBeNull();
    await lib.remove('broken.gguf');
    expect((await lib.list()).map((m) => m.file)).not.toContain('broken.gguf');
  });

  it('keeps the runtime settings checked', () => {
    const s = new RuntimeSettingsStore(join(root, 'runtime.json'));
    expect(s.get()).toEqual({ gpu: 'auto', ctxSize: 16384 });
    expect(parseRuntimeSettings({ gpu: 'cuda' }, s.get())).toMatch(/gpu/);
    expect(parseRuntimeSettings({ ctxSize: 10 }, s.get())).toMatch(/ctxSize/);
    expect(parseRuntimeSettings({ model: '../../x.gguf' }, s.get())).toMatch(/model/);
    const next = parseRuntimeSettings({ model: 'qwen3-8b.gguf', gpu: 'cpu' }, s.get());
    expect(next).toEqual({ model: 'qwen3-8b.gguf', gpu: 'cpu', ctxSize: 16384 });
    s.set(next as Exclude<typeof next, string>);
    expect(new RuntimeSettingsStore(join(root, 'runtime.json')).get()).toEqual(next);
  });
});

describe('the model manager API', () => {
  it('lists, imports, chooses and deletes models', async () => {
    fakeStore();
    const app = Fastify();
    const settings = new RuntimeSettingsStore(undefined);
    registerModelManager(app, { models: new ModelLibrary(models), settings, runtime: new LlamaRuntime({}), ollamaDir: ollama });
    await app.ready();
    const state = async () => (await app.inject({ method: 'GET', url: '/api/v1/runtime' })).json();
    const first = await state();
    expect(first.runtime).toMatchObject({ state: 'unavailable', bundled: false });
    expect(first.models).toEqual([]);
    expect(first.ollama.models.map((m: { name: string }) => m.name)).toContain('qwen3:8b');
    expect(first.downloads.map((d: { repo: string; available: boolean }) => [d.repo, d.available])).toEqual([
      ['Qwen/Qwen3-8B-GGUF', false],
      ['Qwen/Qwen3-4B-GGUF', false],
    ]);

    const imp = await app.inject({ method: 'POST', url: '/api/v1/runtime/import', payload: { name: 'qwen3:8b' } });
    expect(imp.json()).toMatchObject({ imported: 'qwen3:8b', file: 'qwen3-8b.gguf', method: 'link', selected: true });
    expect(settings.get().model).toBe('qwen3-8b.gguf');
    expect((await app.inject({ method: 'POST', url: '/api/v1/runtime/import', payload: { name: 'nope:1b' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/runtime/settings', payload: { model: 'missing.gguf' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/runtime/settings', payload: { model: 'qwen3-8b.gguf' } })).json()).toEqual({ settings: { model: 'qwen3-8b.gguf', gpu: 'auto', ctxSize: 16384 } });
    // no binary in this build: starting says so
    const start = await app.inject({ method: 'POST', url: '/api/v1/runtime/start' });
    expect(start.statusCode).toBe(503);
    expect(start.json().error).toMatch(/no built-in model runtime/);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/runtime/models/qwen3-8b.gguf' })).json()).toEqual({ deleted: 'qwen3-8b.gguf' });
    expect(settings.get().model).toBeUndefined();
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/runtime/models/..%2F..%2Fx.gguf' })).statusCode).toBe(404);
    // Ollama's own file is untouched
    expect(readFileSync(join(ollama, 'blobs', `sha256-${sha(gguf(4000))}`))).toEqual(gguf(4000));
    const page = await app.inject({ method: 'GET', url: '/models' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Import from Ollama');
    await app.close();
  });

  it('selects an imported model when none is chosen, so Start right after an import runs it', async () => {
    fakeStore();
    const app = Fastify();
    const settings = new RuntimeSettingsStore(undefined);
    registerModelManager(app, { models: new ModelLibrary(models), settings, runtime: new LlamaRuntime({}), ollamaDir: ollama });
    await app.ready();
    // nothing chosen: Start has nothing to run
    const before = await app.inject({ method: 'POST', url: '/api/v1/runtime/start' });
    expect(before.statusCode).toBe(400);
    expect(before.json().error).toBe('choose a model first');
    expect((await app.inject({ method: 'POST', url: '/api/v1/runtime/import', payload: { name: 'qwen3:8b' } })).json()).toMatchObject({ file: 'qwen3-8b.gguf', selected: true });
    // this build has no runtime binary, so Start now fails for that reason, not for want of a model
    const start = await app.inject({ method: 'POST', url: '/api/v1/runtime/start' });
    expect(start.statusCode).toBe(503);
    expect(start.json().error).toMatch(/no built-in model runtime/);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runtime' })).json().settings.model).toBe('qwen3-8b.gguf');
    // a model chosen on purpose stays chosen, whatever is imported next
    writeFileSync(join(models, 'mine.gguf'), gguf(4000));
    expect((await app.inject({ method: 'PUT', url: '/api/v1/runtime/settings', payload: { model: 'mine.gguf' } })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/v1/runtime/import', payload: { name: 'hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M' } });
    expect(again.json().selected).toBe(false);
    expect(settings.get().model).toBe('mine.gguf');
    await app.close();
  });
});
