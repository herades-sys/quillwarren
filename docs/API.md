# Delve API (v1)

Base URL on the LAN: `http://192.168.1.9:8790/api/v1`. Everything is JSON unless noted. Map and op formats are in [PLAN.md](PLAN.md#file-formats).

## Access

- **Reading needs no token** (LAN only). This covers maps, renders, the text summary, history and subscribing to live changes.
- **Every change needs the API token:** `Authorization: Bearer <token>`. On the WebSocket, use `?token=<token>`, because browsers can't set headers there.
- The live token is `DELVE_API_TOKEN` in `/etc/delve/delve.env` (root only). A server started without a token refuses all changes with `503`.
- Tokens in URLs are masked in the server log.

### Browser editor login

- **Password:** `sudo delve-passwd` on the container sets the editor password. Only its scrypt hash goes into `/etc/delve/delve.env`, and Delve restarts.
- **Login:** `/login` exchanges the password for a 30-day session cookie `delve_session` (HttpOnly, SameSite=Strict, signed with a key derived from the API token, so rotating the token logs everyone out). `/logout` ends it.
- **What the cookie allows:** the same writes as the token, over REST and the WebSocket, but only from Delve's own origin.
- **Brute force:** after 5 wrong passwords in a minute, an address is blocked for a minute.
- **Session check:** `GET /api/v1/session` → `{ loggedIn, passwordSet }`.
- **Development only:** `DELVE_INSECURE_OPEN_EDIT=1` makes every browser count as logged in. Never use it on the live server.

## Errors

Errors come back as `{ "error": "…", "problems"?: ["…"], "rev"?: n }`.

| Status | When |
|---|---|
| 400 | Malformed ops, or a result that wouldn't validate. `problems` lists every issue, e.g. `c1 (objects[6]) width: must be greater than 0` |
| 401 / 503 | Missing or wrong token / no token configured |
| 404 | No such map |
| 409 | `baseRev` is stale (`rev` holds the current one), the id is taken, or there's nothing to undo or redo |

## Maps

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/maps` | | `{ maps: [{ id, name, rev, objects, created, updated, level? }] }`, newest first |
| POST | `/maps` | `{ name?, style?, template?: "empty" \| "test-dungeon", by? }`, or `{ map: <full delve.map>, by? }` | `201 { id, rev: 1, map }` |
| GET | `/maps/:id` | | `{ id, rev, map }` |
| DELETE | `/maps/:id` | | `204`. A soft delete: the row stays in the database file, and the id can't be reused. The start page and the editor's map panel have Delete buttons |
| GET | `/maps/:id/levels` | | `{ levels: [{ id, name, level }] }`: this map's storeys, top first (just the map itself when it has none) |
| POST | `/maps/:id/levels` | `{ name, position?: "above" \| "below", currentName?, by? }` | `201 { id, rev, map }`: a new empty storey in the same group. The first time, this map joins the group as `currentName` (default "Ground floor") |

**Storeys:** a place with several storeys is several maps that share `level: { group, name, order }` (higher `order` is further up). Each storey has its own undo history and exports as its own Roll20 page, and all of them share one grid, so stairs line up. The editor shows a storey picker at the top and the floor of the storey below as a dashed outline. Open viewers get `{ type: "levels" }` when a storey is added or deleted.

## 3D view: `/maps/:id/3d`

All storeys of a place stacked like a cutaway model: the **3D** button on the map page.

- **What it shows:**
  - Each floor is the storey's own map, from `render.png?background=0` (transparent around the drawing), on a stone slab.
  - Walls stand up from the same wall lines as the 2D map. In the players' view secret doors stay shut.
  - Each storey has its name next to it.
- **Stairs:** stairs, spiral stairs, ladders and trapdoors that overlap on neighbouring storeys get an amber shaft between them (`stairLinks` in core). Ones that meet nothing get a red ring and a note in the side panel. The stairs-up/down GM symbols count as notes, not connections.
- **Controls:**
  - Spread and wall-height sliders, storey checkboxes to see inside, and GM/players' view.
  - Drag to turn, right-drag or Shift-drag to pan, scroll to zoom. Double-click a floor to edit that storey, and use Save picture for a PNG.
- **Live:** changes stream in from every storey's WebSocket, so you can watch Claude build a storey in 3D.
- **Script:** `apps/web/src/stack.ts` (three.js), bundled as `/assets/stack.js`, so the normal editor never loads three.js.

## Props and terrain

| Path | Returns |
|---|---|
| `GET /api/v1/assets` | `{ categories, assets: [{ id, name, category, kind: prop \| terrain, w, h, tags, blocks, tint?, difficult?, available }] }` |
| `GET /assets/props/<id>.svg` | The cleaned SVG in its original inks (thumbnails; the viewer loads art from here) |
| `GET /assets/icons/<name>.svg`, `/assets/brand/<name>.svg`, `/favicon.svg` | Editor icons and the Delve logo |

- **Props** are `{ type: "prop", asset, at, rotation?, scale? }`. `at` is the centre of the footprint. At rotation 0 a prop faces south, and rotation turns it clockwise in degrees.
- **Terrain** is `{ type: "terrain", asset, shape }`, drawn over the floor and under the grid, as a tint plus a repeating 2×2-square tile.
- **Drawing order:** decals lie under the walls, props sit on top of walls and doors, and GM symbols come last. GM symbols appear in the GM view only.
- **Recolouring:** every style recolours the three asset inks (`props` in the style preset).
- **Where the art comes from:** `delve-props-design-system/assets`. `npm run assets` rebuilds `packages/core/src/assets/catalog.json` and the full `manifest.json` from the batch generators' metadata, and reports files that are listed but missing. Every SVG goes through a whitelist (`parseAssetSvg`) before it reaches a page or a PNG.

## Changes

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/maps/:id/ops` | `{ ops: Op[], baseRev?, by? }` | `{ rev }`. The whole batch is one revision and one undo step, applied all or nothing |
| POST | `/maps/:id/undo` | `{ by? }` | `{ rev }`. Undoes the newest change that hasn't been undone yet |
| POST | `/maps/:id/redo` | `{ by? }` | `{ rev }`. Redoes the most recent undo. Any new change ends the redo chain |
| POST | `/maps/:id/focus` | `{ ids: string[], by? }` | `{ viewers }`. Tells open editors to pan to these objects |
| GET | `/maps/:id/history?limit=50` | | `{ history: [{ rev, at, by, kind, ops, state }] }`, where `kind` is create, ops, undo or redo |

- **`by`** says who made a change (`claude`, `editor`, a script's name). It's shown in history and live messages. The default is `api`.
- **Ops:** `add`, `update` (`set`/`unset`), `move` (`ids`, `dx`, `dy`), `delete`, `batch`, plus **`update_map`** (`set`/`unset` of `name`, `grid`, `style`, `seed`, `level`).
- **`baseRev`:** send it when you've computed changes from a copy you read earlier. On a mismatch you get `409` with the current `rev`: fetch again and retry.

## Output

| Path | Query | Returns |
|---|---|---|
| `/maps/:id/render.png` | `ppg` (10–300, default **70**, Roll20's grid), `view` (`gm` or `players`), `style` (preset override), `grid=0` | PNG. The filename includes the size in squares, e.g. `crypt_classic-hatching_players_26x38.png` |
| `/maps/:id/render.svg` | same | SVG, scalable, for print |
| `/maps/:id/describe` | | Plain text: rooms, sizes, connections, doors |
| `/maps/:id/export.ds` | `view` (`gm` or `players`) | A Dungeon Scrawl save file, e.g. `crypt.ds` or `crypt_players.ds`. Open it in Dungeon Scrawl with File → Open save file |

The players' view hides room numbers and draws secret doors as solid wall. Styles are `classic-hatching`, `clean`, `old-school-blue` and `print`.

### Dungeon Scrawl `.ds`

- **Export** writes the floor (rooms, corridors and cutouts merged into one outline), normal/locked/barred doors, room numbers and labels. Secret doors become an "S" in the GM view and plain wall for players; archways stay open. Stairs and Delve's styles don't carry over (Dungeon Scrawl uses its own).
- **Import:** `POST /maps/import.ds?name=` with the raw file as `application/octet-stream` (token or editor login). Returns `201 { id, rev, map, notes }`. Dungeon Scrawl keeps only the merged outline, so the floor comes in as one polygon room per area (holes become cutouts), door stamps become doors and text becomes labels. `notes` says what came across and what was left out. Bad files get a `400` that says why. The start page has an "Import .ds" button.

## Live: WebSocket `/maps/:id/live`

1. On connect the server sends `{ "type": "hello", "rev", "map" }`.
2. After that, every change arrives as `{ "type": "ops", "rev", "by", "kind", "ops" }`. `ops` turn `rev - 1` into `rev`; for an undo they're the inverse that was applied. Apply them with `applyOps` from `@delve/core`, or re-fetch.
3. Other messages: `{ type: "focus", ids, by }`, `{ type: "deleted" }` and `{ type: "pong" }` (the reply to `{ type: "ping" }`).
4. With `?token=` the socket can also write: send `{ type: "ops", ops, baseRev?, by?, ref? }`. You get `{ type: "ack", rev, ref }` or `{ type: "error", error, problems?, rev?, ref? }`, and everyone, you included, gets the usual `ops` message.

## MCP: `/mcp` (for Claude Code)

- **Transport:** Streamable HTTP, stateless (every POST stands alone) and JSON responses. Needs `Authorization: Bearer <token>`; GET and DELETE return 405.
- **Registering it** (once, on the machine that runs Claude Code): `claude mcp add --transport http --scope user delve http://192.168.1.9:8790/mcp --header "Authorization: Bearer <token>"`.
- **Attribution:** every change made through MCP is recorded with `by: "claude"`.
- **Server instructions** tell the model the coordinate rules (squares, y down, top-left origin) and the usual workflow.

| Tool | Does |
|---|---|
| `list_maps`, `create_map` (`name`, `style?`, `template?`) | Find or start maps. Returns the viewer link |
| `get_map`, `describe_map` | Full JSON / plain-text summary |
| `add_room` (`rect` \| `poly` \| `circle`, `name?`, `label?`, `notes?`) | The room number defaults to the next free one |
| `connect` (`from`, `to`, `width?`=2, `doors?` none/from/to/both, `door_style?`) | Auto-routed corridor that follows its rooms, with doors across its mouths |
| `add_cutout`, `add_door`, `add_stairs`, `add_label` | Details |
| `list_assets` (`category?`, `search?`), `add_prop` (`asset`, `at`, `rotation?`, `scale?`, `notes?`), `add_terrain` (`asset`, one shape) | Furnishing and ground |
| `add_level` (`name`, `position?` above/below, `current_name?`) | Adds a storey (a new map in the same group) |
| `move`, `resize`, `update`, `delete`, `set_map` (name, style, overrides, seed, level_name) | Changes |
| `undo`, `redo` | History |
| `render` (`view?`, `style?`, `ppg?`=24) | Returns a PNG image, so Claude can look at its work |
| `export` (`format?` png/svg/ds, `view?`=players, `ppg?`=70) | A download link for the user |
| `focus` (`ids`) | Pans and highlights every open viewer |
| `apply_ops` | Raw ops, one undoable step |

From a shell: `DELVE_API_TOKEN=… npm run mcp -- add_room '{"map":"map_…","rect":[0,0,6,6]}'` (`--list` shows the tools).

## Chat: talking to Claude from the editor

The map page has a **Claude** button for logged-in editors. It opens a chat panel, and Claude edits the map with the MCP tools while you watch.

- **Where Claude runs:** it runs as Claude Code under the user's own subscription, through the **chat bridge** (`delve-chat.service`). The bridge runs as `dev`, the user Claude Code is logged in as, and listens only on `127.0.0.1:8792`. `DELVE_CHAT_URL=http://127.0.0.1:8792` in `/etc/delve/delve.env` switches the chat on.
- **What Claude can use:** the bridge starts `claude -p` with Delve's tools only. There are no built-in tools (no shell or files), no other MCP servers, and no user or project settings, hooks or CLAUDE.md.
- **Tokens:** every message gets its own short-lived MCP token (`chat/tokens.ts`), so the bridge never sees the live API token.
- **What Claude is told:**
  - The system prompt (`apps/server/src/chat/prompt.ts`) explains coordinates, walls and doors, every tool, the `apply_ops` format, styles, exports and dungeon design.
  - Each message starts with a context block: the map, the selection, the visible area and the exact objects.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/v1/chat` | | `{ enabled, ok, claude, models, model }`, or `{ enabled: false }` when the chat isn't set up |
| POST | `/api/v1/maps/:id/chat` | `{ message, session?, selection?: ids, view?: {x0,y0,x1,y1}, model?: sonnet \| opus \| haiku }` | A stream of JSON lines (`application/x-ndjson`) |

**Stream events:**

| Event | Meaning |
|---|---|
| `start {session, model}` | Keep `session` and send it back to continue the conversation |
| `text {text}` | A piece of the reply; append it |
| `tool {id, name, input}` | Claude called a tool |
| `tool_done {id, ok, text}` | That tool finished |
| `usage {fiveHour, sevenDay}` | Subscription use, 0 to 1 of each window |
| `done {ok, turns, ms, error?}` | The reply is complete |
| `error {error, code?}` | Something failed. `code` `no_session` means start a new conversation |

- **Closing the request stops Claude.** Changes it already made stay, and undo removes them.
- **Limits:** a run stops after 5 minutes, and at most 2 run at once (`429` otherwise).
- **Bridge health:** `curl http://127.0.0.1:8792/health` on the CT.

## Live viewer: `/maps/:id`

A read-only page:
- **First paint:** rendered on the server, so the map shows before the script loads.
- **Live changes:** the browser bundle `/assets/viewer.js` (built from `apps/web` by esbuild) redraws with `@delve/core` on every change and briefly highlights what changed.
- **Controls:** drag to pan; wheel, `+` and `-` to zoom; double-click or `F` to fit. It follows `focus` with a short animation and an orange highlight.
- **Options:** GM or players' view, style preview, a Roll20 PNG button.
- **Connection:** it reconnects by itself (for example across a release) and resyncs if it missed a revision.

## Example

```sh
T=$(cat token.txt)   # the API token; never paste it into a URL you share
curl -s -X POST localhost:8790/api/v1/maps -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"Crypt"}'
curl -s -X POST localhost:8790/api/v1/maps/<id>/ops -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"ops":[{"op":"add","object":{"id":"r1","type":"room","shape":{"rect":[0,0,6,6]},"label":"1"}}]}'
curl -s "localhost:8790/api/v1/maps/<id>/render.png?view=players" -o crypt.png
```

`npm run demo -- out.png` does the whole test dungeon this way (with `DELVE_URL` and `DELVE_API_TOKEN` set).
