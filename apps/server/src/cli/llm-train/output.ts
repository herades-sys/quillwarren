// The training files: OpenAI-style chat lines ({"messages", "tools"}, with
// tool_calls and tool messages, as Unsloth / HF apply_chat_template take them
// for Qwen3), LLaMA-Factory's sharegpt lines, a Qwen3 chat-template rendering
// (for the token estimate and the samples), and the estimate itself.
import type { AgentMessage, Json, ToolDef } from '../../chat/local-agent.ts';

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** The tools as the harness sends them (local-agent.ts wireTool): no harness-only fields. */
export function openAiTools(tools: readonly ToolDef[]): OpenAiTool[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * OpenAI chat messages. Tool-call arguments are JSON strings (the OpenAI
 * format; Qwen3's chat template prints a string as it is), which also keeps
 * pyarrow from merging every call's arguments into one struct full of nulls.
 */
export function toOpenAi(messages: readonly AgentMessage[]): Json[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * LLaMA-Factory's sharegpt format with tools: human / gpt / function_call /
 * observation turns, the system prompt and the tools (a JSON string) beside
 * them. Several calls in one reply are one function_call turn holding a JSON
 * list; their results are one observation turn, joined with the
 * </tool_response> <tool_response> tags the Qwen template puts between them,
 * so the rendered text matches the OpenAI lines.
 */
export function toShareGpt(messages: readonly AgentMessage[], tools: readonly ToolDef[]): Json {
  const conv: { from: string; value: string }[] = [];
  let system = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'system') system = m.content;
    else if (m.role === 'user') {
      // two user-side turns in a row (a harness message after the user's) are one human turn
      const prev = conv[conv.length - 1];
      if (prev?.from === 'human') prev.value += `\n\n${m.content}`;
      else conv.push({ from: 'human', value: m.content });
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        const calls = m.toolCalls.map((c) => ({ name: c.name, arguments: c.args }));
        conv.push({ from: 'function_call', value: JSON.stringify(calls.length === 1 ? calls[0] : calls) });
      } else conv.push({ from: 'gpt', value: m.content });
    } else {
      const results = [m.content];
      while (messages[i + 1]?.role === 'tool') results.push((messages[++i] as { content: string }).content);
      conv.push({ from: 'observation', value: results.join('\n</tool_response>\n<tool_response>\n') });
    }
  }
  return { conversations: conv, system, tools: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))) };
}


/** LLaMA-Factory wants human/observation and gpt/function_call turns to alternate; false when a harness message breaks that. */
export function shareGptAlternates(sg: Json): boolean {
  const conv = (sg.conversations ?? []) as { from: string }[];
  return conv.every((t, i) => (i % 2 === 0 ? ['human', 'observation'] : ['gpt', 'function_call']).includes(t.from));
}
/** JSON the way Jinja's tojson (Python json.dumps) writes it: ", " and ": " between items. */
export function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as Json).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}

const TOOLS_HEAD = '\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>';
const TOOLS_TAIL = '\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
export const EMPTY_THINK = '<think>\n\n</think>\n\n';

/**
 * A conversation as Qwen3's chat template renders it with thinking off, close
 * to the Hugging Face template: the system prompt with the tools, user turns,
 * assistant turns with <tool_call> blocks, tool results as <tool_response>
 * blocks in a user turn, and the empty think block in front of each assistant
 * turn (what Ollama's generation prompt holds with think false; train.py does
 * the same). `setup` is the length of the system part, the same in every
 * example.
 */
export function renderQwen3(messages: readonly AgentMessage[], tools: readonly ToolDef[]): { text: string; setup: number } {
  let s = '';
  let setup = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'system') {
      s += `<|im_start|>system\n${m.content}${TOOLS_HEAD}`;
      for (const t of openAiTools(tools)) s += `\n${pyJson(t)}`;
      s += `${TOOLS_TAIL}<|im_end|>\n`;
      setup = s.length;
    } else if (m.role === 'user') s += `<|im_start|>user\n${m.content}<|im_end|>\n`;
    else if (m.role === 'assistant') {
      s += `<|im_start|>assistant\n${EMPTY_THINK}${m.content}`;
      (m.toolCalls ?? []).forEach((c, k) => {
        if (m.content || k > 0) s += '\n';
        s += `<tool_call>\n{"name": ${JSON.stringify(c.name)}, "arguments": ${JSON.stringify(c.args)}}\n</tool_call>`;
      });
      s += '<|im_end|>\n';
    } else {
      s += '<|im_start|>user';
      s += `\n<tool_response>\n${m.content}\n</tool_response>`;
      while (messages[i + 1]?.role === 'tool') s += `\n<tool_response>\n${(messages[++i] as { content: string }).content}\n</tool_response>`;
      s += '<|im_end|>\n';
    }
  }
  return { text: s, setup };
}

/**
 * Characters per token for qwen3's tokenizer, calibrated on the llm-bench run
 * of 2026-10-06 (qwen3:8b, lean setup, Ollama prompt_eval_count of 34 prompts
 * from both runs, least squares; largest error 3.9 %): the system
 * prompt with the tool definitions reads at about SETUP chars per token, the
 * rest (the context block full of numbers, tool calls and results) at about
 * REST. No tokenizer is available offline, so this is an estimate; train.py
 * measures exactly with the real tokenizer.
 */
export const CHARS_PER_TOKEN = { setup: 3.85, rest: 2.39 };

export function estimateTokens(r: { text: string; setup: number }): number {
  return Math.round(r.setup / CHARS_PER_TOKEN.setup + (r.text.length - r.setup) / CHARS_PER_TOKEN.rest);
}
