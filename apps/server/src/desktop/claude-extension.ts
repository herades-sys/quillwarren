// The Claude Desktop extension the Windows app ships (resources\Delve.mcpb):
// an MCPB bundle (https://github.com/modelcontextprotocol/mcpb, manifest
// version 0.3) holding
//   manifest.json      what Claude Desktop shows and how it starts the bridge
//   server/index.js    the bridge (apps/desktop/claude-extension/server/index.js:
//                      MCP over stdio to Claude Desktop, HTTP to Delve's /mcp)
//   server/tools.json  Delve's tools and instructions, for when Delve is closed
//   icon.png           Delve's mark, 512 px
// The tool list in the manifest and in tools.json is read from mcp.ts's own
// server when the bundle is built (cli/build-mcpb.ts, run by
// apps/desktop/scripts/build.sh), so it can't drift from the tools Delve has;
// apps/server/test/claude-desktop.test.ts checks that too. Built with
// zip.ts zipFiles: no packaging tool needed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Resvg } from '@resvg/resvg-js';
import { PropLibrary } from '../custom-props.ts';
import { ImageLibrary } from '../images.ts';
import { LiveHub } from '../live.ts';
import { buildMcpServer } from '../mcp.ts';
import { MapService } from '../service.ts';
import { MapStore } from '../store.ts';
import { zipFiles } from '../zip.ts';
import { CLAUDE_DESKTOP_NOTE } from './gate.ts';

export const MANIFEST_VERSION = '0.3';
const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_FILE = join(here, '../../../desktop/claude-extension/server/index.js');
const MARK_FILE = join(here, '../../../../delve-props-design-system/assets/brand/mark.svg');

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** Delve's MCP tools and instructions as the desktop app serves them (with every optional library, as buildApp has them). */
export async function delveTools(version = 'build'): Promise<{ tools: ToolInfo[]; instructions: string }> {
  const store = new MapStore(':memory:');
  const images = new ImageLibrary(undefined);
  const props = new PropLibrary(undefined);
  const server = buildMcpServer(new MapService(store, new LiveHub()), 'http://127.0.0.1', version, images, props, { note: CLAUDE_DESKTOP_NOTE });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'delve-mcpb-build', version });
  try {
    await client.connect(a);
    const { tools } = await client.listTools();
    return {
      tools: tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description ?? '', inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
      instructions: client.getInstructions() ?? '',
    };
  } finally {
    await client.close();
    await server.close();
    images.close();
    props.close();
    store.close();
  }
}

/** A tool's description for the manifest: its first sentence (Claude Desktop lists them; the full text comes from Delve). */
export function shortDescription(d: string | undefined): string {
  const text = (d ?? '').replace(/\s+/g, ' ').trim();
  // a sentence ends at . ! ? before a capital (so "e.g. a cave" and "(5 ft)." inside go on)
  const m = /^(.{8,240}?[.!?])(?=\s+[A-Z"“]|$)/.exec(text);
  return m ? m[1]! : text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text;
}

/** manifest.json (MCPB manifest version 0.3). Author and links are placeholders until the project has a public home. */
export function extensionManifest(o: { version: string; tools: readonly ToolInfo[] }): Record<string, unknown> {
  return {
    manifest_version: MANIFEST_VERSION,
    name: 'delve',
    display_name: 'Delve',
    version: o.version,
    description: 'Build and change dungeon maps in the Delve app on this computer, and watch every change live in its window.',
    long_description: [
      'Connects Claude to **Delve**, the dungeon map editor, running on this computer. Claude builds rooms, corridors, doors, stairs, props and terrain with Delve’s own tools, looks at the result, and you watch every change happen in the Delve window. Each change is one undo step in Delve.',
      '',
      'Before installing: open Delve and choose **Help → Connect to Claude Desktop…**. The extension works only while Delve is open, and only on this computer. Your maps stay in Delve; what Claude reads through the tools is part of your conversation with Claude, on your own Claude plan.',
    ].join('\n'),
    // the user, 2026-10-31: "herades-sys" for now; no link while the repository is private
    author: { name: 'herades-sys' },
    icon: 'icon.png',
    icons: [{ src: 'icon.png', size: '512x512' }],
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: {} },
    },
    tools: o.tools.map((t) => ({ name: t.name, description: shortDescription(t.description) })),
    keywords: ['dungeon', 'map', 'battle map', 'tabletop', 'rpg', 'game master', 'roll20'],
    compatibility: { platforms: ['win32'], runtimes: { node: '>=18.0.0' } },
  };
}

/** Delve's mark as the extension's icon. */
export function extensionIcon(size = 512): Buffer {
  const svg = readFileSync(MARK_FILE, 'utf8');
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng());
}

/** The bundle's files, in the order they go into the zip. */
export async function extensionFiles(o: { version: string }): Promise<{ name: string; data: Buffer }[]> {
  const { tools, instructions } = await delveTools(o.version);
  const manifest = extensionManifest({ version: o.version, tools });
  return [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'server/index.js', data: readFileSync(BRIDGE_FILE) },
    { name: 'server/tools.json', data: Buffer.from(`${JSON.stringify({ version: o.version, instructions, tools })}\n`) },
    { name: 'icon.png', data: extensionIcon() },
  ];
}

/** Writes Delve.mcpb. */
export async function buildMcpb(outFile: string, o: { version: string }): Promise<{ bytes: number; tools: number }> {
  const files = await extensionFiles(o);
  const zip = zipFiles(files);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, zip);
  const tools = (JSON.parse(files[0]!.data.toString('utf8')) as { tools: unknown[] }).tools.length;
  return { bytes: zip.length, tools };
}

/** The bundle unpacked into a folder, as Claude Desktop installs it (the tests run the bridge from there). */
export async function writeExtensionDir(dir: string, o: { version: string }): Promise<void> {
  for (const f of await extensionFiles(o)) {
    const p = join(dir, ...f.name.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data);
  }
}
