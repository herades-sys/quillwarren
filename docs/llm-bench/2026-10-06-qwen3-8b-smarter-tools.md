# Local models on the Delve map chat: smarter tools

Generated 2026-10-06 21:34 UTC by `npm run llm-bench`. Each task starts from a fresh map (the test dungeon or an empty map) and is checked automatically afterwards.

The same benchmark as `2026-10-06-qwen3-8b-baseline.md`, run again after the MCP tools learnt to place things by meaning (docs/API.md, "Placing things by meaning"): qwen3:8b, lean setup, twice. The pictures and transcripts the links below point to are kept outside the repo, like the baseline's.

- **pass**: every check holds. **partial**: at least one core check holds. **FAIL**: no core check holds.
- **calls**: tool calls the model made; **err**: calls that came back as errors (Delve refused them, unknown tool, unreadable arguments); **malf.**: malformed calls (arguments that needed repair or were not JSON, calls written as text, unknown tool names).
- **tok/s**: generated tokens per second (server-side generation time when the server reports it). Thinking counts as generated text; **think** is its share of all generated characters.
- **prompt tok/s**: prompt tokens per second of prompt time, an effective rate: Ollama reuses the cached start of the conversation, so it is high when most of a prompt was cached. **prompt**: the largest prompt of the run, in tokens (compare with num_ctx).

## Summary

| Model | Tools | Pass | Partial | Fail | Calls | Err | Malf. | Time | tok/s | Prompt tok/s | Prompt | Think |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3:8b | lean (smarter run 1) | 8 | 0 | 0 | 20 | 3 | 0 | 2 min 57 s | 48 | 18769 | 7.2k | 92 % |
| qwen3:8b | lean (smarter run 2) | 6 | 2 | 0 | 20 | 4 | 0 | 4 min 59 s | 57 | 25203 | 7.5k | 96 % |

## Tasks by model

| # | Task | qwen3:8b · lean · smarter run 1 | qwen3:8b · lean · smarter run 2 |
|---|---|---|---|
| 1 | New 6×4 room east of room 1, corridor with a door | **pass** 8/8 | **pass** 8/8 |
| 2 | Rename room 3 "Armoury", lock its door | **pass** 5/5 | **pass** 5/5 |
| 3 | Furnish room 2 as a tavern | **pass** 6/6 | partial 5/6 |
| 4 | Water in room 5 with a bridge across | **pass** 5/5 | **pass** 5/5 |
| 5 | Small forest along the north edge (prop brush) | **pass** 6/6 | **pass** 6/6 |
| 6 | Grass, a +5 m slope hill in the south-west, a dirt path up | **pass** 6/6 | partial 5/6 |
| 7 | A 4-room crypt from scratch, secret door, sarcophagus | **pass** 9/9 | **pass** 9/9 |
| 8 | Question only: doors of room 1 | **pass** 3/3 | **pass** 3/3 |
## Compared with the baseline

Same model, same 8 tasks, same checks (`apps/server/src/cli/llm-bench-lib.ts` unchanged), same lean harness limits and num_ctx; what changed is the tools and the lean prompt: meaning-level options on the MCP tools (rooms `beside` rooms, doors on a named `wall`, props by `place` in a room, `region`s instead of shapes and paths, lengths with units, corridors that route round rooms, a check line at the end of every building tool's reply, `check_map`, `describe_map` with the orientation and each room's place), 17 lean tools instead of 16 (`check_map` added), and `lean-prompt.md` rewritten around them ("place things by meaning, not coordinates", with examples that are not the bench tasks). Baseline: `2026-10-06-qwen3-8b-baseline.md`.

| # | Task | baseline run 1 | baseline run 2 | smarter run 1 | smarter run 2 |
|---|---|---|---|---|---|
| 1 | New 6×4 room east of room 1, corridor with a door | **pass 8/8** | **pass 8/8** | **pass 8/8** | **pass 8/8** |
| 2 | Rename room 3 "Armoury", lock its door | **pass 5/5** | **pass 5/5** | **pass 5/5** | **pass 5/5** |
| 3 | Furnish room 2 as a tavern | partial 4/6 | partial 5/6 | **pass 6/6** | partial 5/6 |
| 4 | Water in room 5 with a bridge across | **pass 5/5** | **pass 5/5** | **pass 5/5** | **pass 5/5** |
| 5 | Small forest along the north edge (prop brush) | partial 5/6 | partial 5/6 | **pass 6/6** | **pass 6/6** |
| 6 | Grass, a +5 m slope hill in the south-west, a dirt path up | partial 4/6 | partial 1/6 | **pass 6/6** | partial 5/6 |
| 7 | A 4-room crypt from scratch, secret door, sarcophagus | partial 7/9 | **pass 9/9** | **pass 9/9** | **pass 9/9** |
| 8 | Question only: doors of room 1 | **pass 3/3** | **pass 3/3** | **pass 3/3** | **pass 3/3** |
| | **Total** | 4 pass, 4 partial; checks 41/48; 30 calls, 0 errors; 5 min 07 s | 5 pass, 3 partial; checks 41/48; 27 calls, 0 errors; 4 min 57 s | **8 pass**; checks 48/48; 20 calls, 3 errors; 2 min 57 s | 6 pass, 2 partial; checks 46/48; 20 calls, 4 errors; 4 min 59 s |

- **Pass rate:** 9 of 16 task runs → 14 of 16; checks 82/96 → 94/96. No task failed outright; no malformed call in either run.
- **The spatial failures of the baseline are gone in both runs:** the forest is north of the rooms (task 5: `region {"edge": "north"}`, 7 and 16 trees, all at y < 0), the bar counter and chairs stand inside room 2, against the wall and round the table without overlapping (task 3 run 1; run 2 below), the hill is 5 m high in the south-west on a 1.5 m map (task 6: `height "5 m"`, `region {"corner": "southwest"}`), and the crypts are four rooms built `beside` each other, never touching, corridors straight between them, the secret door on a corridor mouth (task 7).
- **Fewer calls:** 20 per run instead of 27–30; task 1 is one `add_room` call, the tavern three `add_prop` calls, the forest one `add_props_along`.
- **More errors, all recovered from or harmless:** the new options can be refused with a reason (a region on a still empty map, a bar counter that doesn't fit), and the model reads the reason. Baseline runs had no errors because raw coordinates are never refused, however wrong.
- **Prompt size:** tool definitions 7.8k → 13.6k characters, system prompt 5.4k → 5.3k, first message 2.5k → 2.9k (the context block now says where each room lies); the largest prompt 6.0k → 7.5k tokens of the 16k context.
- **Speed:** generation speed is the same (57–60 tok/s in run 2). Run 1's lower average (48 tok/s; tasks 1–5 at 30–55) is the Ollama server's own generation rate, which Delve doesn't touch; the same tasks ran at 56–59 tok/s in the other runs, so the backup PC was most likely busy for those minutes.
- **Layout check as a control:** `check_map` (core `checkMap`) on the final maps of the baseline lists 13 problems in 6 of its 16 task runs (bar counters half outside room 2 and in corridor c4's doorway, two chairs on the table, an ancient oak across room 1's wall, a hill mostly off the ground, corridor c3 through rooms 1 and 2, the secret door floating inside room 1, bridges half outside room 5); on the 32 final maps of the four runs with the new tools (this pair and the first pair below) it lists none.

### What still goes wrong

- **Run 2, task 3 (no bar counter):** `add_prop` with `place "east wall"` found no spot (corridor mouths sit in the middle of all four walls of room 2, and the round table with its chairs filled the middle), and the reply named the free walls ("the north, south walls have room for it"). The model then asked for the south and north walls but kept passing its own `rotation` (270, 90), which overrides the automatic turn, so the 3×1 counter stood across those walls too, and it gave up honestly. Fix to consider: with a wall `place`, ignore (or retry without) a `rotation` that doesn't fit, and say so.
- **Run 2, task 6 (path not to the hill):** the model drew the path as `region {"edge": "east", "depth": 3, "outside": true}`, a strip along the east edge (outside the grass, even), instead of `{"between": ["east", "h1"]}`. The tool did what was asked; the meaning was wrong.
- **Calls sent in one batch before the map has what they need:** in task 6 the model sends grass, hill and path in one reply; on the still empty map the hill's corner region and the path's `between … "h1"` are refused (they get done right in the next turn). Once (run 1) it also wrote `region {"in": "<map id>", "rect": [...]}`: the map id isn't an object. Fix to consider: `in` with the map's own id means the whole map.
- **It still rarely checks its own work** (no `check_map` or `describe_map` call in either run), but it no longer has to: every building reply ended with a check line, and none of the final maps has a layout problem `check_map` would list.

### Earlier runs during this work

Two earlier passes over the 8 tasks with intermediate versions of the tools (same model and settings; their files are kept with the renders) showed what to fix before the final two runs:

- **Trial (1 run, first version): 6 pass, 2 partial.** Task 7: `add_door {"room": "r2", "wall": "west", "style": "secret"}` was refused because corridor c1's mouth and its door take that whole 4-square wall, and the model then gave up on the secret door (and claimed one in its answer). Since then a refused wall names the door already in it with the `update` that restyles it, and the walls that are free. Task 3: a bar counter on a taken wall was put 1.5 squares off it; the reply now names the walls that have room.
- **First pair (2 runs): 7 pass + 1 fail, then 8 pass.** The fail was task 6 run 1: the model wrote `"region": {"rect": [0, 0, 30, 20]}`, which the region schema silently dropped, so all 9 calls were refused and the run stopped at the error limit. Since then a plain `rect`, `poly` or `circle` is a region too.

So across the four runs on the final two versions of the tools: 29 of 32 task runs passed (baseline: 9 of 16). After the final runs only one more change was made: `check_map` lists a problem seen from two sides once ("c3 runs through r1, r2" instead of three lines); the model called it in none of these runs.

## qwen3:8b · lean · smarter run 1

Ollama 0.35.1 native API at http://192.168.1.40:11434, num_ctx 16384. 17 tools; system prompt 5.3k characters, tool definitions 13.6k, first message 2.9k. Delve llm-bench; 2026-10-06 21:26 to 21:29 UTC; loading the model took 2 s (not counted).

| # | Task | Result | Checks | Calls | Err | Malf. | Time | tok/s | Stop | Answer |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | New 6×4 room east of room 1, corridor with a door | **pass** | 8/8 | 1 | 0 | 0 | 19 s | 48 | answer | Added room r7 (6×4) east of r1, connected by corridor c6 with door d7. |
| 2 | Rename room 3 "Armoury", lock its door | **pass** | 5/5 | 2 | 0 | 0 | 16 s | 43 | answer | Renamed room r3 to "Armoury" and set door d2 to locked. |
| 3 | Furnish room 2 as a tavern | **pass** | 6/6 | 3 | 0 | 0 | 17 s | 55 | answer | Added table-round i1 (center), chairs i2-i5 (around i1), and bar-counter i6 (south wall) in room 2. Final layout: r2 has a round table with 4 chairs and a bar … |
| 4 | Water in room 5 with a bridge across | **pass** | 5/5 | 2 | 0 | 0 | 29 s | 42 | answer | Painted shallow water t1 across room 5 and added bridge i1 at center. |
| 5 | Small forest along the north edge (prop brush) | **pass** | 6/6 | 1 | 0 | 0 | 35 s | 30 | answer | Planted a mixed oak forest along the map's north edge (y -4 to 0), 7 trees (i1-i7) using group c-oak-a (young, ancient, dense, oak). The forest sits outside al… |
| 6 | Grass, a +5 m slope hill in the south-west, a dirt path up | **pass** | 6/6 | 6 | 3 | 0 | 46 s | 59 | answer | Added grass t1 (30×20) at 0,0; hill h1 (+5 m, 10×10 at 0,10); dirt path t2 (25×2) from east edge to h1. Check: all outdoors, no overlaps. |
| 7 | A 4-room crypt from scratch, secret door, sarcophagus | **pass** | 9/9 | 5 | 0 | 0 | 12 s | 60 | answer | Added 4 rooms (r1-r4) connected by corridors c1-c3 with doors d1-d3. Secret door d3 between r3 and r4. Sarcophagus i1 placed against south wall of r4, facing n… |
| 8 | Question only: doors of room 1 | **pass** | 3/3 | 0 | 0 | 0 | 3 s | 59 | answer | Room 1 has 2 doors: d1 (connecting to room 2) and d5 (leading outside). |

- **1. New 6×4 room east of room 1, corridor with a door** (pass) [picture](qwen3-8b-lean-smarter-run-1/t1-room-east.png) · [transcript](qwen3-8b-lean-smarter-run-1/t1-room-east.json)
  - calls: add_room
- **2. Rename room 3 "Armoury", lock its door** (pass) [picture](qwen3-8b-lean-smarter-run-1/t2-rename-lock.png) · [transcript](qwen3-8b-lean-smarter-run-1/t2-rename-lock.json)
  - calls: update update
- **3. Furnish room 2 as a tavern** (pass) [picture](qwen3-8b-lean-smarter-run-1/t3-tavern.png) · [transcript](qwen3-8b-lean-smarter-run-1/t3-tavern.json)
  - calls: add_prop add_prop add_prop
- **4. Water in room 5 with a bridge across** (pass) [picture](qwen3-8b-lean-smarter-run-1/t4-water-bridge.png) · [transcript](qwen3-8b-lean-smarter-run-1/t4-water-bridge.json)
  - calls: add_terrain add_prop
- **5. Small forest along the north edge (prop brush)** (pass) [picture](qwen3-8b-lean-smarter-run-1/t5-forest-north.png) · [transcript](qwen3-8b-lean-smarter-run-1/t5-forest-north.json)
  - calls: add_props_along
- **6. Grass, a +5 m slope hill in the south-west, a dirt path up** (pass) [picture](qwen3-8b-lean-smarter-run-1/t6-hill-path.png) · [transcript](qwen3-8b-lean-smarter-run-1/t6-hill-path.json)
  - calls: add_terrain✗ add_height✗ add_terrain✗ add_terrain add_height add_terrain
- **7. A 4-room crypt from scratch, secret door, sarcophagus** (pass) [picture](qwen3-8b-lean-smarter-run-1/t7-crypt.png) · [transcript](qwen3-8b-lean-smarter-run-1/t7-crypt.json)
  - calls: add_room add_room add_room add_room add_prop
- **8. Question only: doors of room 1** (pass) [picture](qwen3-8b-lean-smarter-run-1/t8-question.png) · [transcript](qwen3-8b-lean-smarter-run-1/t8-question.json)
  - calls: none

## qwen3:8b · lean · smarter run 2

Ollama 0.35.1 native API at http://192.168.1.40:11434, num_ctx 16384. 17 tools; system prompt 5.3k characters, tool definitions 13.6k, first message 2.9k. Delve llm-bench; 2026-10-06 21:29 to 21:34 UTC; loading the model took 4 s (not counted).

| # | Task | Result | Checks | Calls | Err | Malf. | Time | tok/s | Stop | Answer |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | New 6×4 room east of room 1, corridor with a door | **pass** | 8/8 | 1 | 0 | 0 | 13 s | 59 | answer | Added room r7 (6×4) east of r1, connected by corridor c6 with door d7. |
| 2 | Rename room 3 "Armoury", lock its door | **pass** | 5/5 | 2 | 0 | 0 | 11 s | 59 | answer | Renamed room r3 to "Armoury" and set door d2 to locked. |
| 3 | Furnish room 2 as a tavern | partial | 5/6 | 6 | 4 | 0 | 1 min 54 s | 57 | answer | The bar counter cannot fit in room 2 due to space constraints. To resolve this, adjust the bar counter's size or reposition existing props. Alternatively, plac… |
| 4 | Water in room 5 with a bridge across | **pass** | 5/5 | 2 | 0 | 0 | 21 s | 59 | answer | Added shallow water t1 (12×10) in r5, with rope plank bridge i1 at [10,6]. |
| 5 | Small forest along the north edge (prop brush) | **pass** | 6/6 | 1 | 0 | 0 | 1 min 03 s | 56 | answer | Planted a mixed oak forest along the map's north edge (y -10.5 to -0.5), 16 trees (i1-i16) spaced 3 squares apart, using c-oak-a (Oak group). Forest is fully o… |
| 6 | Grass, a +5 m slope hill in the south-west, a dirt path up | partial | 5/6 | 3 | 0 | 0 | 56 s | 59 | answer | Added Dirt terrain t2: 3×20 squares at 30,0, a 3-square-wide path along the east edge of the map (x 30–33, y 0–20). Map is at rev 5. Check: outdoors, outside t… |
| 7 | A 4-room crypt from scratch, secret door, sarcophagus | **pass** | 9/9 | 5 | 0 | 0 | 17 s | 59 | answer | Added 4 rooms (r1-r4) connected by corridors c1-c3 with doors d1-d3 (normal, normal, secret). Placed Carved Sarcophagus i1 center of r4. Check: all rooms clear… |
| 8 | Question only: doors of room 1 | **pass** | 3/3 | 0 | 0 | 0 | 4 s | 58 | answer | Room 1 has 2 doors: d1 (connecting to r2) and d5 (leading outside). |

- **1. New 6×4 room east of room 1, corridor with a door** (pass) [picture](qwen3-8b-lean-smarter-run-2/t1-room-east.png) · [transcript](qwen3-8b-lean-smarter-run-2/t1-room-east.json)
  - calls: add_room
- **2. Rename room 3 "Armoury", lock its door** (pass) [picture](qwen3-8b-lean-smarter-run-2/t2-rename-lock.png) · [transcript](qwen3-8b-lean-smarter-run-2/t2-rename-lock.json)
  - calls: update update
- **3. Furnish room 2 as a tavern** (partial) [picture](qwen3-8b-lean-smarter-run-2/t3-tavern.png) · [transcript](qwen3-8b-lean-smarter-run-2/t3-tavern.json)
  - not met: a bar counter (0)
  - calls: add_prop add_prop add_prop✗ add_prop✗ add_prop✗ add_prop✗
- **4. Water in room 5 with a bridge across** (pass) [picture](qwen3-8b-lean-smarter-run-2/t4-water-bridge.png) · [transcript](qwen3-8b-lean-smarter-run-2/t4-water-bridge.json)
  - calls: add_terrain add_prop
- **5. Small forest along the north edge (prop brush)** (pass) [picture](qwen3-8b-lean-smarter-run-2/t5-forest-north.png) · [transcript](qwen3-8b-lean-smarter-run-2/t5-forest-north.json)
  - calls: add_props_along
- **6. Grass, a +5 m slope hill in the south-west, a dirt path up** (partial) [picture](qwen3-8b-lean-smarter-run-2/t6-hill-path.png) · [transcript](qwen3-8b-lean-smarter-run-2/t6-hill-path.json)
  - not met: a dirt path from the east up to it (t2 dirt [30.5, 0, 3, 20])
  - calls: add_terrain add_height add_terrain
- **7. A 4-room crypt from scratch, secret door, sarcophagus** (pass) [picture](qwen3-8b-lean-smarter-run-2/t7-crypt.png) · [transcript](qwen3-8b-lean-smarter-run-2/t7-crypt.json)
  - calls: add_room add_room add_room add_room add_prop
- **8. Question only: doors of room 1** (pass) [picture](qwen3-8b-lean-smarter-run-2/t8-question.png) · [transcript](qwen3-8b-lean-smarter-run-2/t8-question.json)
  - calls: none
