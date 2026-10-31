#!/usr/bin/env node
// Delve's bridge for Claude Desktop: the server of the Delve extension
// (Delve.mcpb). Claude Desktop starts it with its own built-in Node.js and
// speaks MCP to it over stdin/stdout (one JSON-RPC message per line); the
// bridge passes each message on to the Delve app running on this computer, at
// http://127.0.0.1:<port>/mcp (MCP's Streamable HTTP transport), and passes
// the answers back, whether Delve answers with JSON or with an event stream.
// Pictures (render) are ordinary JSON in those answers and pass unchanged.
//
// Where Delve is: %APPDATA%\Delve\claude-desktop.json, which Delve writes while
// the user has connected it (Help → Connect to Claude Desktop…): the port of
// this launch (null while Delve is closed) and the per-install key the bridge
// sends as "Authorization: Bearer <key>". It is read again for every message,
// so a restarted Delve on another port is found without restarting Claude.
// The key never goes anywhere but 127.0.0.1, and never into a log.
//
// When Delve is closed or not connected, the bridge answers by itself instead
// of failing: the tools are listed from tools.json (built with the bundle from
// Delve's own tool list), and calling one says what to do ("Delve isn't
// running. Open Delve, then try again."). It never starts Delve. Once Delve
// answers again it tells Claude Desktop the tool list may have changed.
//
// Node.js built-ins only: nothing to install.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

/** The MCP versions Delve's server speaks (newest first). */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const SAY = {
  not_running: 'Delve isn’t running. Open Delve, then try again.',
  not_connected: 'Delve isn’t connected to Claude Desktop. Open Delve and choose Help → Connect to Claude Desktop…, then try again.',
  refused: 'Delve refused the connection. In Delve, choose Help → Connect to Claude Desktop… again, then try again.',
};

function connectionFile() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Delve', 'claude-desktop.json');
}

/** Where Delve listens and the key, or why it can't be reached. */
function readConnection() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(connectionFile(), 'utf8'));
  } catch {
    return { problem: 'not_connected' };
  }
  if (!j || typeof j !== 'object' || typeof j.key !== 'string' || !KEY_PATTERN.test(j.key)) return { problem: 'not_connected' };
  if (!Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return { problem: 'not_running' };
  return { port: j.port, key: j.key };
}

/** Delve's tools for when Delve is closed (written into the bundle when it is built). */
function fallback() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools.json'), 'utf8'));
    return { version: String(j.version || '0.0.0'), instructions: String(j.instructions || ''), tools: Array.isArray(j.tools) ? j.tools : [] };
  } catch {
    return { version: '0.0.0', instructions: '', tools: [] };
  }
}

let negotiated = '';
let offlineListServed = false;
let lastState = '';
const inflight = new Map();
const pending = new Set();

function send(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    process.exit(0);
  }
}

function log(text) {
  try {
    process.stderr.write(`[delve-bridge] ${text}\n`);
  } catch {
    // nowhere to say it
  }
}

/** Logs only when the state changes (no line per message). */
function state(s, text) {
  if (s === lastState) return;
  lastState = s;
  log(text);
}

const isRequest = (m) => m && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const idKey = (id) => `${typeof id}:${String(id)}`;

/** One message to Delve. JSON answers resolve with their body; an event stream's messages go to onMessage as they arrive. */
function post(conn, message, onMessage, signal) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(message));
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${conn.key}`,
      'content-length': String(data.length),
    };
    if (negotiated) headers['mcp-protocol-version'] = negotiated;
    const req = http.request({ host: '127.0.0.1', port: conn.port, path: '/mcp', method: 'POST', headers, signal, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '');
      res.on('error', reject);
      if (status >= 200 && status < 300 && type.includes('text/event-stream')) {
        res.setEncoding('utf8'); // characters split across chunks are decoded whole
        let buf = '';
        let lines = [];
        const dispatch = () => {
          if (!lines.length) return;
          const text = lines.join('\n');
          lines = [];
          try {
            onMessage(JSON.parse(text));
          } catch {
            // not a JSON-RPC message: skipped
          }
        };
        const line = (l) => {
          if (l === '') return dispatch();
          if (l.startsWith(':')) return;
          const at = l.indexOf(':');
          const field = at < 0 ? l : l.slice(0, at);
          const value = at < 0 ? '' : l.slice(at + 1).replace(/^ /, '');
          if (field === 'data') lines.push(value);
        };
        res.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
            if (buf[nl] === '\r' && nl === buf.length - 1) break;
            const l = buf.slice(0, nl);
            buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
            line(l);
          }
        });
        res.on('end', () => {
          if (buf) line(buf);
          dispatch();
          resolve({ status, stream: true, body: '' });
        });
      } else {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status, stream: false, body: Buffer.concat(chunks).toString('utf8') }));
      }
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Delve took too long to answer'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

/** Delve answered: pass it to Claude Desktop (and note the protocol version an initialize settled on). */
function relay(m, original) {
  if (!m || typeof m !== 'object') return;
  if (original && original.method === 'initialize' && m.id === original.id && m.result && typeof m.result.protocolVersion === 'string') negotiated = m.result.protocolVersion;
  send(m);
}

/** Answers without Delve: the tools from tools.json, and calls that say what to do. Notifications are dropped. */
function answerOffline(msg, problem) {
  if (!isRequest(msg)) return;
  const fb = fallback();
  if (msg.method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion;
    negotiated = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'delve', title: 'Delve map editor', version: fb.version },
        instructions: `${fb.instructions}\n${SAY[problem]}`.trim(),
      },
    });
  }
  if (msg.method === 'tools/list') {
    offlineListServed = true;
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: fb.tools } });
  }
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: SAY[problem] }], isError: true } });
  return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: SAY[problem] } });
}

function answerError(msg, text) {
  if (!isRequest(msg)) return;
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: text } });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return; // a response to a request Delve never sends
  if (msg.method === 'notifications/cancelled') {
    const ctrl = msg.params && inflight.get(idKey(msg.params.requestId));
    if (ctrl) ctrl.abort(); // a stateless server keeps nothing to cancel: stopping the request is enough
    return;
  }
  if (isRequest(msg) && msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  const conn = readConnection();
  if (conn.problem) {
    state(conn.problem, conn.problem === 'not_running' ? 'Delve is closed' : `Delve isn't connected (no usable ${connectionFile()})`);
    return answerOffline(msg, conn.problem);
  }
  const ctrl = new AbortController();
  if (isRequest(msg)) inflight.set(idKey(msg.id), ctrl);
  try {
    const got = await post(conn, msg, (m) => relay(m, msg), ctrl.signal);
    if (got.status === 401 || got.status === 403) {
      state('refused', `Delve refused the bridge (HTTP ${got.status})`);
      return answerOffline(msg, /isn’t connected/.test(got.body) ? 'not_connected' : 'refused');
    }
    state('ok', `talking to Delve on 127.0.0.1:${conn.port}`);
    if (offlineListServed) {
      offlineListServed = false;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    if (got.stream) return;
    const body = got.body.trim();
    if (got.status >= 200 && got.status < 300) {
      if (!body) return; // 202 for a notification
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return answerError(msg, 'Delve sent an answer the bridge couldn’t read.');
      }
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) relay(m, msg);
      return;
    }
    // an error: Delve's own JSON-RPC error when it sent one, else the status in words
    try {
      const e = JSON.parse(body);
      if (e && e.error && isRequest(msg)) return send({ jsonrpc: '2.0', id: msg.id, error: e.error });
    } catch {
      // not JSON
    }
    return answerError(msg, `Delve answered HTTP ${got.status}.`);
  } catch (e) {
    if (ctrl.signal.aborted) return; // cancelled by Claude Desktop: no answer is wanted
    const code = e && e.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'EHOSTUNREACH') {
      state('not_running', 'Delve is closed (connection refused)');
      return answerOffline(msg, 'not_running');
    }
    state('error', `couldn't reach Delve (${code || 'error'})`);
    return answerError(msg, `Delve didn’t answer (${e && e.message ? e.message : 'unknown error'}). Is Delve open?`);
  } finally {
    if (isRequest(msg)) inflight.delete(idKey(msg.id));
  }
}

function start() {
  process.stdout.on('error', () => process.exit(0)); // Claude Desktop went away
  log(`started (Node ${process.version}); Delve's connection file: ${connectionFile()}`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = handle(m).catch((e) => log(`unexpected: ${e && e.message ? e.message : e}`));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', () => {
    void Promise.allSettled([...pending]).then(() => process.exit(0));
  });
}

start();
