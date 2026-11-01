# Quillwarren training data for a local model

{{TRAIN}} training and {{VALID}} validation conversations of Quillwarren's map chat, for fine-tuning a small Qwen3 model to drive Quillwarren's **lean** tool set (17 tools, `apps/server/src/chat/lean-prompt.md`) the way `npm run llm-bench` runs it through Ollama.

**Made by a program, not by a language model.** Every conversation was assembled by Quillwarren's own generator (`npm run llm-train-data`, seed {{SEED}}): a procedurally made starting map, a request built from templates, a scripted solution that calls Quillwarren's real MCP tools, and a final answer filled in from the real tool results. No language model wrote, rewrote or graded any of it: no Claude, no Ollama, no chat transcripts, no benchmark runs. No third-party maps or art were used.

## What is in this folder

| File | What |
|---|---|
| `train.jsonl`, `valid.jsonl` | One conversation per line: `{"messages": [...], "tools": [...]}` in the OpenAI chat format (system, user, assistant with `tool_calls`, `tool` results). Works with Hugging Face / Unsloth `apply_chat_template` for Qwen3. |
| `train_sharegpt.jsonl`, `valid_sharegpt.jsonl`, `dataset_info.json` | The same in LLaMA-Factory's sharegpt format (human / gpt / function_call / observation). |
| `stats.md` | Counts per task family, turns and tool calls, what was dropped and why, estimated token lengths. |
| `samples.md` | 10 conversations written out to read. Look at these first. |
| `system_prompt.txt`, `tools.json` | The system prompt and the 17 tool definitions every example carries (as `buildSetup('lean')` made them on the day the data was generated). |
| `examples.meta.jsonl` | Per example: split, family, variant, seeds, estimated tokens, tool calls, the user's requests. |
| `train_unsloth.py` | The training script (Unsloth, LoRA / QLoRA). Written, **not run**. |
| `Modelfile.template` | For loading the result into Ollama. |

## How it was made

- **Exactly what the model sees at inference.** The system prompt and the tool schemas come from `buildSetup('lean')` at generation time, never copied. Each user message is framed with the context block the local harness adds (map name, rev, units, the room list with where each room lies, every object). Tool results are the real replies of Quillwarren's MCP tools, run in process on a throwaway Quillwarren, cut to 4000 characters like the harness does, with the map id left to the harness.
- **Starting maps** are made procedurally: dungeons of 3 to 16 rooms (a few octagons and circles, corridors with doors of every style, pillars, stairs, water and floor textures, some rooms furnished), small maps of one to three rooms, outdoor maps (ground, ponds, rivers, roads, hills, cliffs, forests, a few huts) and empty maps, in feet and in metres. Quillwarren's "test dungeon" template is never used.
- **{{FAMILIES}} task families**, each a request grammar with varied phrasing plus a scripted solution that prefers the meaning-level options (`beside`, `in` + `place`, `region`, `room` + `wall`, lengths with units): rooms beside rooms, corridors, doors on named walls, small layouts from scratch, outdoor maps from scratch, renaming / numbers / notes / door styles, moving, resizing, deleting (asking first before most of the map goes), furnishing by theme, single props by place, props found with `list_assets`, the prop brush (forests, groves, rows), terrain by region, heights with units, labels, explicit coordinates, questions answered without changing the map, follow-ups in a second message ("make it bigger", "move it north", "undo that"), recovery after a real refusal (the wall has no free stretch, no free spot, a prop on a tree) and fixing what `check_map` lists. See `stats.md` for the counts.
- **Checked.** Every conversation was replayed from scratch and kept only if the replay gave the same messages, the family's own checks held (the room is east of room 4, the door is locked…), `check_map` shows no new problem, every tool call fits the lean schema, and no refusal or warning is answered over. {{DROPPED}} drafts failed and were replaced by new ones.
- **The llm-bench tasks are held out.** No request matches one of the 8 benchmark prompts or a paraphrase of one (the same text, similar wording, or all the concepts of a task such as "a tavern in room 2", "water with a bridge", "trees along the north edge", "a hill with a path"), so the benchmark still measures something the model hasn't seen.
- **No thinking.** The assistant turns have no reasoning at all: tool calls straight away, then one or two short sentences with the ids. Qwen3's thinking was 92–96 % of the generated text in the benchmark; this data teaches the model to work without it.

## Run the model with thinking off

The fine-tuned model must run with thinking **off**: `--think off` for `npm run llm-bench` and `npm run local-llm`, or `"think": false` in Ollama's `/api/chat`. With thinking on it would be asked for a reasoning block it was never trained to write.

## How long the examples are, and what fits on the RTX 5060 (8 GB)

Every example starts with the same system prompt and 17 tool definitions: about **{{SETUP_TOKENS}} tokens** before the user has said anything. Whole conversations (estimated: there is no tokenizer offline; `train_unsloth.py --dry-run` counts exactly): median **{{TOK_MEDIAN}}**, 95th percentile **{{TOK_P95}}**, longest **{{TOK_MAX}}** tokens. Over 7168 tokens: {{OVER_7K}}; over 8192: {{OVER_8K}}; over 12288: {{OVER_12K}}. About {{TRAIN_MTOK}} M tokens per epoch, of which the model learns from only the assistant turns (a few percent): the long prompt is context it has to read every time, and that is where the compute goes.

- **Qwen3-4B, QLoRA (4-bit), on the RTX 5060: the realistic local option.** The 4-bit weights take about 3 GB, and Unsloth's gradient checkpointing (activations offloaded to the 32 GB of system RAM) leaves room for one sequence of about 8k tokens. Settings: `--max-seq-len 8192 --batch 1 --grad-accum 16`, LoRA rank 16, one epoch. This is an estimate from Unsloth's published memory figures, not a measurement: if it runs out of memory, try `--max-seq-len 7168` (drops the {{OVER_7K}} longest), close everything else on the GPU (stop Ollama: it keeps models in VRAM), and if it still doesn't fit, rent.
- **Qwen3-8B does not fit 8 GB with these sequences.** Its 4-bit weights alone take 5.5–6 GB; what is left holds a sequence of perhaps 2–3k tokens, less than the system prompt plus tools. Rent a GPU with 24 GB (RTX 4090 / 3090, L4, A5000) or 48 GB (A6000, L40S): QLoRA at 8k–16k tokens fits there comfortably.
- **Time.** A rough estimate, not measured: on the 5060, Qwen3-4B needs something like 15–25 seconds per example at these lengths, so a full epoch is about a day. Start with `--max-examples 1500` (a long evening) to see whether it helps at all. A rented RTX 4090 is roughly 3–4 times faster, an H100 roughly 8–10 times; for the 8B model or for several tries, renting for a few hours costs a few dollars to a few tens of dollars (check current prices). The script prints the time per step after the first steps, so you can see where your run is heading.

## Your steps (downloads and installs)

Nothing was downloaded or installed for this; these are yours to do:

1. **A Python environment.** WSL2 with Ubuntu is the smoothest path on Windows 11 (Unsloth also runs natively on Windows with more setup). The RTX 5060 is a Blackwell card: it needs a PyTorch build for CUDA 12.8 or newer (`cu128` wheels or later).
2. **Python packages:** `pip install unsloth` (it brings `transformers`, `trl`, `peft`, `accelerate`, `bitsandbytes`, `datasets`), plus the CUDA build of PyTorch from pytorch.org. Follow Unsloth's install guide for your system.
3. **Base model weights** from Hugging Face: the script fetches them on first use (`unsloth/Qwen3-4B`, about 3–8 GB depending on the variant; `unsloth/Qwen3-8B` for the rented GPU).
4. **llama.cpp** for the GGUF export: Unsloth fetches and builds it the first time you export (or build it yourself).

## Training

```
python train_unsloth.py --dry-run                     # renders every example, counts real tokens, writes rendered_example.txt
python train_unsloth.py --max-examples 1500           # a first run on the 5060 (Qwen3-4B, QLoRA)
python train_unsloth.py                               # everything, one epoch
python train_unsloth.py --model unsloth/Qwen3-8B      # on a rented 24 GB+ GPU
```

What the script does, and why (every setting is a flag with a comment in the script):

- Loads the JSONL with plain `json` (not `datasets.load_dataset("json")`, whose pyarrow schema would merge the tool definitions into one struct and put `null`s into the prompt), renders each conversation with the model's own chat template (`apply_chat_template(messages, tools=tools)`), and drops anything longer than `--max-seq-len`, saying how many.
- For hybrid Qwen3 models (Qwen3-4B, Qwen3-8B), every assistant turn starts after an empty `<think>\n\n</think>\n\n` block: that is how Ollama starts each reply with thinking off, while the Hugging Face template only puts it on the last turn. Non-thinking models (Qwen3-4B-Instruct-2507) get no think tags at all.
- Trains only the assistant turns (Unsloth's `train_on_responses_only`): the system prompt, the tools, the user messages with their context block and the tool results are masked out of the loss.
- QLoRA on all attention and MLP projections, rank 16, alpha 16, no dropout, learning rate 1e-4 with a cosine schedule, AdamW 8-bit, batch 1 × 16 accumulation steps, one epoch, no packing.
- Saves the LoRA adapter to `quillwarren-qwen3-lora/`. `--eval-steps N` evaluates on `valid.jsonl` along the way.

LLaMA-Factory works too: put `train_sharegpt.jsonl`, `valid_sharegpt.jsonl` and `dataset_info.json` in its `data/` folder and use the datasets `quillwarren_train` / `quillwarren_valid` with a Qwen3 template that switches thinking off (`qwen3_nothink` in recent versions).

## Into Ollama

```
python train_unsloth.py --export-gguf q4_k_m --adapter quillwarren-qwen3-lora   # merges the adapter, writes a GGUF
ollama show qwen3:4b --modelfile > Modelfile                               # the base model's template and settings
# edit Modelfile: FROM ./quillwarren-qwen3-lora-gguf/<the .gguf file>
ollama create quillwarren-qwen3-4b -f Modelfile
```

Copy the GGUF and the Modelfile to the PC that runs Ollama (the backup PC) and run `ollama create` there. Starting from the base model's own Modelfile keeps its chat template, which is what lets Ollama pass the tools and switch thinking off; `Modelfile.template` is the same with comments, if you'd rather write it by hand. q4_k_m keeps the 4B model at about 2.5 GB; q5_k_m or q8_0 are a little better and bigger.

## Testing it against the baseline

The 8 llm-bench tasks were kept out of the data, so they are a fair test. From the Quillwarren repo on the dev container, with thinking off for both, twice each (the runs vary):

```
npm run llm-bench -- --base-url http://192.168.1.40:11434/v1 --model qwen3:4b --think off --name base-4b
npm run llm-bench -- --base-url http://192.168.1.40:11434/v1 --model quillwarren-qwen3-4b --think off --name quillwarren-4b
```

`llm-bench/report.md` then shows both side by side: pass / partial / fail per task, checks, tool calls, errors, malformed calls and time. For reference, `docs/llm-bench/2026-10-06-qwen3-8b-smarter-tools.md`: qwen3:8b with thinking passed 14 of 16 task runs, about 4 minutes per 8 tasks, 92–96 % of its output thinking. The hope for the fine-tuned model is that pass rate or close to it without the thinking, so it answers in seconds. Also try a few requests of your own with `npm run local-llm -- --model quillwarren-qwen3-4b --think off "…"`.

## Making the data again

This data was made from Quillwarren {{SOURCE}}, with these harness hooks wired in: {{HOOKS}}. In the Quillwarren repo: `npm run llm-train-data -- --count {{COUNT}} --seed {{SEED}} --out ~/llm-train` (same code and seed, same files; about 10 minutes on the dev container). The system prompt, the tool schemas and every tool result come from the code as it is then, so after a change to the tools, `lean-prompt.md` or the harness, generate again and retrain: a model trained on the old wording expects the old wording. What the harness adds on its own (a line in the context block comes from `buildSetup` by itself; notes on held-back calls in a batch, the repeat note and the final check before an answer is accepted go through `apps/server/src/cli/llm-train/harness-hooks.ts`) must be wired in there before generating; see docs/API.md, "Training data for a local model".

## Limits

- The requests come from templates: varied, but tidier than real users and in English only. The maps are generated, not drawn by people.
- Each conversation is one task (some with a follow-up or two). Long sessions with many unrelated requests aren't in the data.
- The answers are short and follow a few patterns, on purpose.
- `apply_ops` is never used (the prompt says the single tools are easier), and `undo` only in follow-ups.
- The local harness repeats the map id in the tool calls of its history (`"map": "map_…"`), which the training data leaves out (the model never writes it). Harmless, but the harness could drop it.
- Token counts are estimates (calibrated on the benchmark's own prompts, largest error about 4 %); the training script counts exactly.
- The training script has not been run here (no GPU, no Python packages on the dev container): expect to adjust a version detail or two.
- The conversations match the harness of Quillwarren {{SOURCE}}. If the harness has changed since (helping steps such as an extra context line, held-back calls in a batch or a final check, or a new prompt or tools), generate the data again before training.
