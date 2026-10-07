// The desktop app's model manager (/models) and its API (/api/v1/runtime):
// the GGUF files in the models folder and the disk they take, Ollama's models
// with "Import", which model the built-in runtime runs (GPU or CPU), the
// runtime's state, and the downloads that come later. Desktop only: the
// desktop gate guards it like every other request.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { htmlDocument, topBar } from '@delve/ui';
import { DOWNLOADS } from './download.ts';
import { parseRuntimeSettings, type ModelLibrary, type RuntimeSettingsStore } from './models.ts';
import { importOllamaModel, listOllamaModels } from './ollama.ts';
import type { LlamaRuntime } from './runtime.ts';

export interface ModelManagerDeps {
  models: ModelLibrary;
  settings: RuntimeSettingsStore;
  runtime: LlamaRuntime;
  /** Ollama's models folder (OLLAMA_MODELS or ~/.ollama/models). */
  ollamaDir: string;
  log?: (msg: string) => void;
}

const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

export function registerModelManager(app: FastifyInstance, d: ModelManagerDeps): void {
  app.get('/api/v1/runtime', async () => {
    const [models, partial, disk, ollama] = await Promise.all([d.models.list(), d.models.partial(), d.models.disk(), listOllamaModels(d.ollamaDir)]);
    return {
      runtime: d.runtime.status(),
      settings: d.settings.get(),
      folder: d.models.dir,
      models,
      partial,
      disk,
      ollama: { folder: d.ollamaDir, models: ollama },
      downloads: DOWNLOADS.map((x) => ({ ...x, available: false, note: 'coming in a later version' })),
    };
  });

  app.put('/api/v1/runtime/settings', async (req, reply) => {
    const next = parseRuntimeSettings(req.body, d.settings.get());
    if (typeof next === 'string') return bad(reply, 400, next);
    if (next.model && !(await d.models.list()).some((m) => m.file === next.model)) return bad(reply, 400, `model: there is no ${next.model} in the models folder`);
    d.settings.set(next);
    d.log?.(`runtime settings: ${next.model ?? 'no model'}, ${next.gpu}, context ${next.ctxSize}`);
    return { settings: next };
  });

  app.post('/api/v1/runtime/import', async (req, reply) => {
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
    const found = (await listOllamaModels(d.ollamaDir)).find((m) => m.name === name);
    if (!found) return bad(reply, 404, `Ollama has no model "${name}"`);
    try {
      const r = await importOllamaModel(found, d.models.dir);
      d.log?.(`imported ${name} from Ollama (${r.method}, ${r.size} bytes)`);
      return { imported: name, file: r.file.split(/[\\/]/).pop(), method: r.method, size: r.size };
    } catch (e) {
      return bad(reply, 409, (e as Error).message);
    }
  });

  app.delete('/api/v1/runtime/models/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    try {
      if (d.settings.get().model === file) {
        await d.runtime.stop();
        const s = d.settings.get();
        delete s.model;
        d.settings.set(s);
      }
      await d.models.remove(file);
      d.log?.(`deleted model ${file}`);
      return { deleted: file };
    } catch (e) {
      return bad(reply, 404, (e as Error).message);
    }
  });

  app.post('/api/v1/runtime/start', async (_req, reply) => {
    const s = d.settings.get();
    if (!s.model) return bad(reply, 400, 'choose a model first');
    try {
      await d.runtime.start({ model: d.models.path(s.model), alias: s.model.replace(/\.gguf$/i, ''), gpu: s.gpu, ctxSize: s.ctxSize });
      return { runtime: d.runtime.status() };
    } catch (e) {
      return bad(reply, 503, (e as Error).message);
    }
  });

  app.post('/api/v1/runtime/stop', async () => {
    await d.runtime.stop();
    return { runtime: d.runtime.status() };
  });

  app.get('/models', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(modelsPage()));
}

const CSS = `
  .mm { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; display: flex; flex-direction: column; gap: 22px; }
  .mm h1 { margin: 0; font-size: 22px; }
  .mm h2 { margin: 0 0 10px; font-size: 15px; }
  .mm .card { padding: 16px 18px; }
  .mm-row { display: flex; gap: 12px; align-items: center; padding: 9px 0; box-shadow: inset 0 -1px 0 var(--color-divider); }
  .mm-row:last-child { box-shadow: none; }
  .mm-row .spacer { flex: 1; min-width: 0; }
  .mm-name { font-weight: 600; overflow-wrap: anywhere; }
  .mm-sub { display: block; font-size: 12.5px; color: var(--color-text-muted); }
  .mm-note { font-size: 13px; color: var(--color-text-muted); line-height: 1.5; margin: 0; }
  .mm-bad { color: var(--color-danger); }
  .mm-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .mm code { font-size: 12px; overflow-wrap: anywhere; }
`;

/** The page; its script fills it from /api/v1/runtime. */
export function modelsPage(): string {
  const body = `${topBar({ crumbs: [{ href: '/', text: 'Library' }], title: 'Models' })}
<main class="mm">
  <div><h1>Models for the chat</h1>
  <p class="mm-note">The chat can use a model server you already run (Ollama, LM Studio, llama-server: choose it in the editor’s chat settings), or Delve’s own built-in runtime with a model file from this page.</p></div>
  <section class="card" id="rt"><h2>Built-in runtime</h2><p class="mm-note">Loading…</p></section>
  <section class="card" id="mine"><h2>Model files</h2><p class="mm-note">Loading…</p></section>
  <section class="card" id="ollama"><h2>Import from Ollama</h2><p class="mm-note">Loading…</p></section>
  <section class="card" id="dl"><h2>Download</h2><p class="mm-note">Loading…</p></section>
  <p class="mm-note" id="msg" role="status"></p>
</main>
<style>${CSS}</style>
<script type="module">${SCRIPT}</script>`;
  return htmlDocument({ title: 'Models', body });
}

// The page's script: plain DOM, no bundle (it is small and only here).
const SCRIPT = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gb = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB';
const say = (t, bad) => { $('msg').textContent = t; $('msg').className = 'mm-note' + (bad ? ' mm-bad' : ''); };
async function call(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}
async function load() {
  const s = await call('GET', '/api/v1/runtime');
  const rt = s.runtime;
  const state = { unavailable: 'not in this build', stopped: 'stopped', starting: 'starting…', ready: 'running', crashed: 'stopped after an error' }[rt.state] || rt.state;
  $('rt').innerHTML = '<h2>Built-in runtime</h2>' +
    (rt.bundled ? '' : '<p class="mm-note">This build of Delve doesn’t include the runtime (llama.cpp’s llama-server) yet. Until it does, run a model server yourself and choose it in the editor’s chat settings. You can already prepare a model file below.</p>') +
    '<div class="mm-row"><span class="spacer"><span class="mm-name">State: ' + esc(state) + '</span><span class="mm-sub">' +
    (rt.model ? esc(rt.model) + ' on the ' + (rt.device === 'gpu' ? 'GPU' : 'CPU') + (rt.fellBack ? ' (the GPU didn’t work)' : '') + ', port ' + rt.port : 'no model loaded') +
    (rt.lastError ? ' · <span class="mm-bad">' + esc(rt.lastError) + '</span>' : '') + '</span></span>' +
    (rt.bundled ? '<span class="mm-actions"><button class="btn btn-primary btn-sm" data-act="use">Use it for the chat</button><button class="btn btn-secondary btn-sm" data-act="start">Start</button><button class="btn btn-plain btn-sm" data-act="stop">Stop</button></span>' : '') + '</div>' +
    '<div class="mm-row"><span class="spacer"><span class="mm-name">Graphics card</span><span class="mm-sub">Automatic uses the GPU and falls back to the CPU when that fails.</span></span>' +
    '<select class="input" id="gpu" style="width:auto"><option value="auto"' + (s.settings.gpu === 'auto' ? ' selected' : '') + '>Automatic</option><option value="cpu"' + (s.settings.gpu === 'cpu' ? ' selected' : '') + '>CPU only</option></select></div>';
  $('mine').innerHTML = '<h2>Model files</h2><p class="mm-note">In <code>' + esc(s.folder) + '</code> · ' + gb(s.disk.used) + ' used' + (s.disk.free !== undefined ? ', ' + gb(s.disk.free) + ' free on this drive' : '') + '</p>' +
    (s.models.length ? s.models.map((m) => '<div class="mm-row"><input type="radio" name="model" value="' + esc(m.file) + '"' + (s.settings.model === m.file ? ' checked' : '') + (m.gguf ? '' : ' disabled') + ' aria-label="Use ' + esc(m.file) + '">' +
      '<span class="spacer"><span class="mm-name">' + esc(m.file) + '</span><span class="mm-sub">' + gb(m.size) + (m.shared ? ' · shared with Ollama (no extra space)' : '') + (m.gguf ? '' : ' · <span class="mm-bad">not a GGUF file</span>') + '</span></span>' +
      '<button class="btn btn-plain btn-sm" data-del="' + esc(m.file) + '">Delete</button></div>').join('') : '<p class="mm-note">No model files yet. Import one from Ollama, or copy a .gguf file into the folder above.</p>');
  const om = s.ollama.models;
  $('ollama').innerHTML = '<h2>Import from Ollama</h2><p class="mm-note">Ollama’s models in <code>' + esc(s.ollama.folder) + '</code>. Importing links the file (no extra space on the same drive) or copies it.</p>' +
    (om.length ? om.map((m) => '<div class="mm-row"><span class="spacer"><span class="mm-name">' + esc(m.name) + '</span><span class="mm-sub">' + (m.size ? gb(m.size) : '') + (m.problem ? ' · <span class="mm-bad">' + esc(m.problem) + '</span>' : '') + (m.hasProjector ? ' · its picture part is left out' : '') + '</span></span>' +
      (m.usable ? '<button class="btn btn-secondary btn-sm" data-import="' + esc(m.name) + '">Import</button>' : '') + '</div>').join('') : '<p class="mm-note">No Ollama models found on this computer.</p>');
  $('dl').innerHTML = '<h2>Download</h2>' + s.downloads.map((x) => '<div class="mm-row"><span class="spacer"><span class="mm-name">' + esc(x.label) + '</span><span class="mm-sub">' + esc(x.repo) + ' · about ' + gb(x.approxBytes) + ' · ' + esc(x.licence) + '</span></span><button class="btn btn-secondary btn-sm" disabled title="' + esc(x.note) + '">Coming later</button></div>').join('');
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.import) { t.disabled = true; say('Importing ' + t.dataset.import + '…'); const r = await call('POST', '/api/v1/runtime/import', { name: t.dataset.import }); say('Imported as ' + r.file + (r.method === 'link' ? ' (linked)' : ' (copied)') + '.'); }
    else if (t.dataset.del) { if (!confirm('Delete ' + t.dataset.del + '?')) return; await call('DELETE', '/api/v1/runtime/models/' + encodeURIComponent(t.dataset.del)); say('Deleted.'); }
    else if (t.dataset.act === 'start') { say('Starting the model…'); await call('POST', '/api/v1/runtime/start'); say('Running.'); }
    else if (t.dataset.act === 'stop') { await call('POST', '/api/v1/runtime/stop'); say('Stopped.'); }
    else if (t.dataset.act === 'use') { await call('PUT', '/api/v1/chat/settings', { backend: 'local', local: { source: 'builtin' } }); say('The chat now uses the built-in runtime.'); }
    else return;
    await load();
  } catch (err) { say(err.message, true); await load().catch(() => {}); }
});
document.addEventListener('change', async (e) => {
  try {
    if (e.target.name === 'model') { await call('PUT', '/api/v1/runtime/settings', { model: e.target.value }); say('The built-in runtime will use ' + e.target.value + '.'); }
    else if (e.target.id === 'gpu') { await call('PUT', '/api/v1/runtime/settings', { gpu: e.target.value }); say('Saved.'); }
  } catch (err) { say(err.message, true); }
});
load().catch((err) => say('Couldn’t load: ' + err.message, true));
`;
