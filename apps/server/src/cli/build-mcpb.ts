// Builds the Claude Desktop extension for the Windows app (see
// desktop/claude-extension.ts). apps/desktop/scripts/build.sh runs it:
//   node apps/server/src/cli/build-mcpb.ts <out.mcpb> [--version 0.1.0]
import { resolve } from 'node:path';
import { buildMcpb } from '../desktop/claude-extension.ts';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const v = args.indexOf('--version');
const version = v >= 0 ? args[v + 1] : '0.0.0';
if (!out || !version || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) {
  console.error('usage: node apps/server/src/cli/build-mcpb.ts <out.mcpb> --version <semver>');
  process.exit(2);
}
const got = await buildMcpb(resolve(out), { version });
console.log(`wrote ${out}: ${got.tools} tools, ${Math.round(got.bytes / 1024)} KB`);
