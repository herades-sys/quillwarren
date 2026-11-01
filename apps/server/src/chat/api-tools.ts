// Quillwarren's MCP tools for the cloud models of the desktop app's chat (Claude
// through the Anthropic API, OpenAI): the same names, descriptions and input
// schemas as mcp.ts, converted for each API. These are strong models, so they
// get the full schemas, not the small-model cut of local-agent.ts
// simplifySchema. What changes:
// - "$schema" goes (neither API wants it);
// - draft-07 tuples ("items": [..], "additionalItems": false), which neither
//   API takes reliably, become arrays of one item type with minItems = maxItems
//   and the count said in the description ("[x, y, width, height]" stays in
//   the description, as in mcp.ts);
// - OpenAI also loses "propertyNames" and "format", which its function
//   schemas refuse or ignore.
// The MCP server checks every call against the real schema anyway, so a
// dropped constraint is refused with a message, never run.
import type { Json, McpToolInfo } from './local-agent.ts';

export type ApiFlavour = 'anthropic' | 'openai';

const DROP: Record<ApiFlavour, Set<string>> = {
  anthropic: new Set(['$schema', 'additionalItems']),
  openai: new Set(['$schema', 'additionalItems', 'propertyNames', 'format']),
};

/** One schema, converted for an API (see the top of this file). */
export function apiSchema(s: unknown, flavour: ApiFlavour): Json {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  const x = s as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(x)) {
    if (DROP[flavour].has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v as Json).map(([p, ps]) => [p, apiSchema(ps, flavour)]));
    else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) out[k] = v.map((b) => apiSchema(b, flavour));
    else if (k === 'items' && Array.isArray(v)) {
      // a tuple: one item type, the count in minItems / maxItems and the description
      const kinds = v.map((i) => apiSchema(i, flavour));
      const types = new Set(kinds.map((i) => i.type));
      const first = kinds[0]?.type;
      out.items = types.size === 1 && typeof first === 'string' ? { type: first } : {};
      out.minItems = v.length;
      out.maxItems = v.length;
      const what = first === 'number' || first === 'integer' ? 'numbers' : 'items';
      const d = typeof x.description === 'string' ? `${x.description} ` : '';
      out.description = `${d}(exactly ${v.length} ${what})`;
    } else if ((k === 'items' || k === 'additionalProperties' || k === 'not') && v && typeof v === 'object') out[k] = apiSchema(v, flavour);
    else if (k === 'description' && out.description !== undefined) continue; // a tuple's description already has it
    else out[k] = v;
  }
  return out;
}

/** The top of a tool's input schema: always an object. */
function inputSchema(t: McpToolInfo, flavour: ApiFlavour): Json {
  const s = apiSchema(t.inputSchema ?? {}, flavour);
  return { ...s, type: 'object', properties: (s.properties as Json | undefined) ?? {} };
}

/** Tools as the Anthropic Messages API takes them; the last one carries the cache breakpoint for the tool list. */
export function anthropicTools(tools: readonly McpToolInfo[], o: { eager?: boolean; cache?: boolean } = {}): Json[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: inputSchema(t, 'anthropic'),
    ...(o.eager ? { eager_input_streaming: true } : {}),
    ...(o.cache && i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

/** Tools as OpenAI's Chat Completions API takes them (function tools). */
export function openAiTools(tools: readonly McpToolInfo[]): Json[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: inputSchema(t, 'openai') } }));
}
