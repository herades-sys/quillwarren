// Phase 0 placeholder: proves the service, port and release flow work.
// The real server (apps/server) replaces it; keep GET /health.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.env.PORT || 8790);
const host = process.env.HOST || '0.0.0.0';
let version = 'dev';
try { version = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim(); } catch {}
const started = new Date().toISOString();

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'delve', version, started }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Delve</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Delve</h1><p>The container and release flow are working. The map editor arrives in phase 4.</p>
<p style="color:#667">Release ${version} · started ${started}</p></body>`);
}).listen(port, host, () => console.log(`delve placeholder ${version} listening on ${host}:${port}`));
