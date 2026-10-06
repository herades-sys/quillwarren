// What a local model gets in the test harness (local-agent.ts): two setups.
// - "full": today's chat for Claude, unchanged: CHAT_SYSTEM_PROMPT, every MCP
//   tool with its full description, the context block, and Claude Code's task
//   list (TaskCreate / TaskUpdate / TaskList), which the prompt asks for and the
//   harness answers itself.
// - "lean": for small models: 16 tools with short descriptions and only their
//   everyday parameters, the map id filled in by the harness, and the short
//   prompt in lean-prompt.md. Tune both here; `npm run llm-bench` measures it.
import { readFileSync } from 'node:fs';
import { ASSETS, CATEGORIES, DOOR_STYLES } from '@delve/core';
import { CHAT_SYSTEM_PROMPT, chatContext, type ChatContextInput } from './prompt.ts';
import { toToolDefs, type Json, type LocalTool, type McpToolInfo, type ToolDef, type ToolPick } from './local-agent.ts';

export const TOOL_SETS = ['lean', 'full'] as const;
export type ToolSet = (typeof TOOL_SETS)[number];

/** The lean tools, in the order the model sees them, with what it is told about each. */
export const LEAN_TOOLS: Record<string, ToolPick> = {
  describe_map: {
    description: 'The map as text: every room with id, number, name, size and position, the corridors and the doors on them (with styles), and what else is on the map. Call it to check your work.',
    params: [],
  },
  list_assets: {
    description: 'Find prop and terrain ids by a word: search "chair", "tree", "bridge", "water"…',
    params: ['search', 'category'],
    paramDescriptions: { search: 'A word to look for, e.g. "table"', category: 'Optional: a category id, e.g. furniture, trees, terrain' },
  },
  add_room: {
    description: 'Add a room: rect [x, y, width, height] in squares, (x, y) the top-left corner. It gets the next room number.',
    params: ['rect', 'name', 'notes'],
  },
  connect: {
    description: 'Join two rooms with a corridor that routes itself. doors "both" puts a door at each end ("from" or "to": one end); door_style sets their style.',
    params: ['from', 'to', 'doors', 'door_style', 'width'],
    paramDescriptions: { from: 'Room id, e.g. "r1"', to: 'Room id, e.g. "r7"', width: 'Corridor width in squares: 2 (default) or 1' },
  },
  add_door: {
    description: 'Put a door on a wall line: at [x, y] is where the door starts, along "x" on a north or south wall, "y" on a west or east wall; width 1 or 2.',
    params: ['at', 'along', 'width', 'style'],
  },
  add_stairs: {
    description: 'Stairs: rect [x, y, w, h] and direction, the way up (n, e, s or w).',
    params: ['rect', 'direction'],
  },
  add_prop: {
    description: 'Place one prop by asset id (see list_assets). at [x, y] is the centre of the prop; rotation 0 faces south, 90 west, 180 north, 270 east.',
    params: ['asset', 'at', 'rotation', 'notes'],
  },
  add_props_along: {
    description: 'The prop brush: copies of one prop along a path of points, one every spacing squares (forests, rows of pillars, rocks along a wall). A colour tree such as c-oak-a mixes the variants of its group.',
    params: ['asset', 'path', 'spacing', 'placement', 'spread'],
  },
  add_terrain: {
    description: 'Fill an area with terrain (water, grass, dirt, lava…): asset plus rect [x, y, w, h] or poly [[x, y], ...].',
    params: ['asset', 'rect', 'poly'],
  },
  add_height: {
    description: 'Raise or sink the ground in an area: height in the map\'s units (+5 a hill, +10 a ledge, -10 a pit). edge "slope" for a walkable hill, "cliff" for a sheer drop. Only where there is floor or terrain.',
    params: ['rect', 'poly', 'circle', 'height', 'edge', 'name'],
  },
  add_label: { description: 'Text on the map, centred on at [x, y].', params: ['text', 'at', 'size'] },
  update: {
    description: 'Change fields of one object: id plus set, e.g. {"id": "r3", "set": {"name": "Throne room"}} or {"id": "d4", "set": {"style": "locked"}}.',
    params: ['id', 'set', 'unset'],
    paramDescriptions: { id: 'Object id, e.g. "r3" or "d2"', set: 'Fields to set, e.g. {"name": "Throne room"}', unset: 'Fields to remove, e.g. ["notes"]' },
  },
  move: { description: 'Move objects by dx, dy squares; corridors and doors follow their rooms.', params: ['ids', 'dx', 'dy'] },
  delete: { description: 'Delete objects by id.', params: ['ids'] },
  undo: { description: 'Undo the last change.', params: [] },
  apply_ops: {
    description: 'Several changes as one step: ops is a list such as [{"op": "add", "object": {"id": "r9", "type": "room", "shape": {"rect": [2, 2, 6, 4]}, "label": "9"}}, {"op": "update", "id": "d2", "set": {"style": "locked"}}]. The single tools are easier.',
    params: ['ops'],
  },
};

const ids = (list: readonly { id: string }[]) => list.map((a) => a.id).join(', ');

/** The ink props by category, ids only (GM symbols and cartography left out). */
export function leanPropList(): string {
  return CATEGORIES.filter((c) => !['symbols', 'cartography', 'terrain'].includes(c.id))
    .map((c) => {
      const items = ASSETS.filter((a) => a.category === c.id && a.kind === 'prop');
      return items.length ? `${c.name.toLowerCase()}: ${ids(items)}` : '';
    })
    .filter(Boolean)
    .join('; ');
}

/** The lean system prompt: lean-prompt.md (or another file) with the lists filled in. */
export function leanPrompt(file?: string): string {
  const text = readFileSync(file ?? new URL('./lean-prompt.md', import.meta.url), 'utf8');
  return text
    .replaceAll('{{DOOR_STYLES}}', DOOR_STYLES.join(', '))
    .replaceAll('{{PROPS}}', leanPropList())
    .replaceAll('{{TERRAIN}}', ids(ASSETS.filter((a) => a.kind === 'terrain')))
    .trim();
}

const PLAN_LINE = /^Plan: if this request takes 3 or more steps/;

/** The context block without the task-list reminder (the lean set has no task list). */
export function leanContext(input: ChatContextInput): string {
  return chatContext(input)
    .split('\n')
    .filter((l) => !PLAN_LINE.test(l))
    .join('\n');
}

/** Claude Code's task list as the full prompt describes it, answered by the harness (the chat panel's plan card lives elsewhere). */
export function taskTools(): LocalTool[] {
  const tasks = new Map<string, { subject: string; status: string }>();
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return [
    {
      def: {
        name: 'TaskCreate',
        description: 'Create a task in your task list (one per step of a longer request).',
        parameters: { type: 'object', properties: { subject: { type: 'string', description: 'Short title of the step' }, description: { type: 'string' } }, required: ['subject'] },
      },
      run(a) {
        const subject = str(a.subject).trim();
        if (!subject) throw new Error('subject is required');
        const id = String(tasks.size + 1);
        tasks.set(id, { subject, status: 'pending' });
        return `Task #${id} created successfully: ${subject}`;
      },
    },
    {
      def: {
        name: 'TaskUpdate',
        description: 'Update a task: status pending, in_progress, completed or deleted.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }, subject: { type: 'string' } }, required: ['taskId'] },
      },
      run(a) {
        const id = str(a.taskId).replace(/^#/, '');
        const t = tasks.get(id);
        if (!t) throw new Error(`no task #${id}`);
        if (a.status !== undefined) t.status = str(a.status);
        if (a.subject !== undefined) t.subject = str(a.subject);
        return `Updated task #${id} ${a.status !== undefined ? 'status' : 'subject'}`;
      },
    },
    {
      def: { name: 'TaskList', description: 'List your tasks.', parameters: { type: 'object', properties: {} } },
      run() {
        return [...tasks].map(([id, t]) => `#${id} [${t.status}] ${t.subject}`).join('\n') || 'No tasks.';
      },
    },
  ];
}

export interface Setup {
  kind: ToolSet;
  system: string;
  tools: ToolDef[];
  local: LocalTool[];
  /** The user message: context block, then the request. */
  user(input: ChatContextInput, message: string): string;
}

/** Everything the model gets for one map. */
export function buildSetup(kind: ToolSet, mcpTools: readonly McpToolInfo[], mapId: string, opts: { promptFile?: string } = {}): Setup {
  if (kind === 'full') {
    return {
      kind,
      system: opts.promptFile ? readFileSync(opts.promptFile, 'utf8') : CHAT_SYSTEM_PROMPT,
      tools: toToolDefs(mcpTools),
      local: taskTools(),
      user: (input, message) => `${chatContext(input)}\n\n${message.trim()}`,
    };
  }
  const fixed: Json = { map: mapId };
  return {
    kind,
    system: leanPrompt(opts.promptFile),
    tools: toToolDefs(mcpTools, { only: LEAN_TOOLS, fixed }),
    local: [],
    user: (input, message) => `${leanContext(input)}\n\n${message.trim()}`,
  };
}

/** A rough size of what the model reads before the first reply: characters of prompt, tools and context. */
export function setupSize(s: Setup, user: string): { system: number; tools: number; user: number } {
  const tools = JSON.stringify([...s.tools, ...s.local.map((l) => l.def)].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  return { system: s.system.length, tools: tools.length, user: user.length };
}
