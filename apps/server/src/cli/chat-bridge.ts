// Entry point of the chat bridge (release/chat-bridge.mjs, run by delve-chat.service as dev).
// Env: PORT (default 8792), HOST (default 127.0.0.1), CLAUDE_BIN (default ~/.local/bin/claude),
// DELVE_CHAT_DIR (default ~/.delve-chat), DELVE_CHAT_MODEL (default sonnet).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../chat/bridge.ts';

const port = Number(process.env.PORT || 8792);
const host = process.env.HOST || '127.0.0.1';
const local = join(homedir(), '.local/bin/claude');
const claudeBin = process.env.CLAUDE_BIN || (existsSync(local) ? local : 'claude');
const dir = process.env.DELVE_CHAT_DIR || join(homedir(), '.delve-chat');

if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.warn(`warning: HOST=${host} makes the bridge reachable from other machines; it should stay on 127.0.0.1`);
}

const server = createBridge({
  claudeBin,
  dir,
  defaultModel: process.env.DELVE_CHAT_MODEL || 'sonnet',
  log: (msg) => console.log(msg),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections(); // running chats end; their Claude processes get SIGTERM from the closed responses
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
server.listen(port, host, () => console.log(`quillwarren chat bridge on http://${host}:${port}, using ${claudeBin}`));
