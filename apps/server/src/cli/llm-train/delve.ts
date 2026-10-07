// A throwaway Delve in this process for the training-data generator: an
// in-memory map store and the real MCP server (mcp.ts), reached through the
// MCP SDK's in-memory transport, so every tool result is exactly what the
// model would read from Delve. Nothing listens on a port and nothing is
// written to disk; one instance per conversation, closed afterwards.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FORMAT, FORMAT_VERSION, type DelveMap, type MapObject } from '@delve/core';
import { contentText, type Json, type McpToolInfo } from '../../chat/local-agent.ts';
import { LiveHub } from '../../live.ts';
import { buildMcpServer } from '../../mcp.ts';
import { MapService } from '../../service.ts';
import { MapStore } from '../../store.ts';

export interface ToolRun {
  /** The result text as the model reads it (pictures replaced by a note). */
  text: string;
  isError: boolean;
  /** The map after the call. */
  rev: number;
  map: DelveMap;
  /** Objects the call added, removed or changed (by comparing the map before and after). */
  added: MapObject[];
  removed: string[];
  changed: string[];
}

const BASE = 'http://127.0.0.1:8791';

export class Delve {
  readonly client: Client;
  readonly tools: McpToolInfo[];
  readonly store: MapStore;
  readonly service: MapService;
  private readonly server: { close(): Promise<void> };

  private constructor(client: Client, tools: McpToolInfo[], store: MapStore, service: MapService, server: { close(): Promise<void> }) {
    this.client = client;
    this.tools = tools;
    this.store = store;
    this.service = service;
    this.server = server;
  }

  static async open(): Promise<Delve> {
    const store = new MapStore(':memory:');
    const service = new MapService(store, new LiveHub());
    const server = buildMcpServer(service, BASE, 'llm-train');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'delve-llm-train', version: '1.0.0' });
    await client.connect(b);
    const { tools } = await client.listTools();
    return new Delve(client, tools as McpToolInfo[], store, service, server);
  }

  /** A new map from a document (its id, name, unit, style and seed chosen by the caller, so runs repeat). */
  createMap(o: { id: string; name: string; unit: string; style: string; seed: number; objects?: MapObject[] }): { id: string; rev: number } {
    const doc: DelveMap = {
      format: FORMAT,
      version: FORMAT_VERSION,
      id: o.id,
      name: o.name,
      grid: { type: 'square', unit: o.unit },
      style: { preset: o.style },
      seed: o.seed,
      objects: o.objects ?? [],
    } as DelveMap;
    const c = this.service.create(doc, 'llm-train');
    return { id: c.mapId, rev: c.rev };
  }

  get(id: string): { rev: number; map: DelveMap } {
    return this.store.get(id);
  }

  /** One MCP tool call; the map is compared before and after. */
  async call(mapId: string, name: string, args: Json): Promise<ToolRun> {
    const before = this.store.get(mapId).map;
    const res = (await this.client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const { text } = contentText(res.content ?? []);
    const after = this.store.get(mapId);
    const old = new Map(before.objects.map((o) => [o.id, JSON.stringify(o)]));
    const now = new Set(after.map.objects.map((o) => o.id));
    const added = after.map.objects.filter((o) => !old.has(o.id));
    const removed = before.objects.filter((o) => !now.has(o.id)).map((o) => o.id);
    const changed = after.map.objects.filter((o) => old.has(o.id) && old.get(o.id) !== JSON.stringify(o)).map((o) => o.id);
    return { text, isError: Boolean(res.isError), rev: after.rev, map: after.map, added, removed, changed };
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.server.close();
    this.store.close();
  }
}
