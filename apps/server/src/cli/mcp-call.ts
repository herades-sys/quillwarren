// Call one Quillwarren MCP tool from the command line, the way Claude Code would.
//   DELVE_URL=http://127.0.0.1:8790 DELVE_API_TOKEN=... npm run mcp -- <tool> '<json args>' [--out picture.png]
//   npm run mcp -- --list
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, list: { type: 'boolean', default: false } },
});
const base = (process.env.DELVE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
const token = process.env.DELVE_API_TOKEN;
if (!token) {
  console.error('set DELVE_API_TOKEN');
  process.exit(2);
}

const client = new Client({ name: 'delve-cli', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
try {
  if (values.list || !positionals[0]) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name.padEnd(14)} ${t.description ?? ''}`);
  } else {
    const args = positionals[1] ? (JSON.parse(positionals[1]) as Record<string, unknown>) : {};
    const res = (await client.callTool({ name: positionals[0], arguments: args })) as {
      content: { type: string; text?: string; data?: string }[];
      isError?: boolean;
    };
    for (const c of res.content) {
      if (c.type === 'text') console.log(c.text);
      else if (c.type === 'image' && c.data) {
        const file = values.out ?? 'mcp-render.png';
        writeFileSync(file, Buffer.from(c.data, 'base64'));
        console.log(`(image saved to ${file})`);
      }
    }
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
