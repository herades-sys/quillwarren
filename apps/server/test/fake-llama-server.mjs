// A stand-in for llama.cpp's llama-server in the runtime tests (runtime.test.ts):
// the same command-line options, /health (503 while "loading"), and the
// OpenAI-compatible /v1/models and /v1/chat/completions behind the API key
// from --api-key-file. Behaviour switches come from the environment:
//   FAKE_LLAMA_LOAD_MS        how long "loading the model" takes (default 200)
//   FAKE_LLAMA_GPU_FAIL=1     exit at once when asked for GPU layers (a driver that won't load)
//   FAKE_LLAMA_CRASH_ONCE=<f> crash 300 ms after loading, the first time only (the file marks it)
//   FAKE_LLAMA_ARGS=<f>       write the command line here
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_LLAMA_ARGS) writeFileSync(process.env.FAKE_LLAMA_ARGS, JSON.stringify(argv));
const port = Number(opt('--port'));
const keyFile = opt('--api-key-file');
const key = keyFile ? readFileSync(keyFile, 'utf8').trim() : '';
const layers = Number(opt('--n-gpu-layers') ?? 0);
const alias = opt('--alias') ?? 'model';
console.log(`fake llama-server: model ${opt('--model')}, ${layers} GPU layers, port ${port}`);

if (process.env.FAKE_LLAMA_GPU_FAIL === '1' && layers > 0) {
  console.error('ggml_vulkan: no suitable device found');
  process.exit(1);
}

let loaded = false;
setTimeout(() => {
  loaded = true;
  console.log('model loaded');
  const marker = process.env.FAKE_LLAMA_CRASH_ONCE;
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, 'crashed');
    setTimeout(() => {
      console.error('GGML_ASSERT failed (pretend crash)');
      process.exit(3);
    }, 300);
  }
}, Number(process.env.FAKE_LLAMA_LOAD_MS ?? 200));

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  if (req.url === '/health') return loaded ? json(res, 200, { status: 'ok' }) : json(res, 503, { error: { message: 'Loading model' } });
  if (key && req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: { message: 'Invalid API Key' } });
  if (req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: alias, object: 'model' }] });
  if (req.url === '/v1/chat/completions') {
    req.resume();
    return req.on('end', () => json(res, 200, { choices: [{ message: { role: 'assistant', content: 'Hello from the fake model.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6 } }));
  }
  json(res, 404, { error: { message: 'not found' } });
}).listen(port, '127.0.0.1');
