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

## Fog of war

- **Where it's kept:** `map.fog = { on, revealed?: ids, show?: shapes, hide?: shapes }`, changed with `update_map`, so it is live and undoable.
- **Players' view** (2D, `/maps/:id/screen`, 3D): with fog on, the picture is built only from what the players have seen: revealed rooms and corridors plus `show` areas, minus `hide` areas, with 0.3 squares of margin.
  - Hidden rooms, their props, labels, doors and terrain never go into the scene. Walls are the real walls cut to the seen area, and hatching wraps the revealed rooms. Where a corridor carries on unseen, the opening stays open.
  - The players' screen never receives map data: `GET /api/v1/maps/:id/screen` gives `{ rev, frame, hidden, svg }`, and its socket (`/live?screen=1`) sends only `hello {rev}`, `changed {rev}` and `look {bounds}` (GM focus on revealed things only).
- **GM view:** the rest is shaded (`style.fog`).
- **Exports stay whole** unless you add `fog=1` to `render.png` / `render.svg`.
- **Players' screen** (`/maps/:id/screen`): full screen with no controls, following changes live. It frames what's revealed, glides to new reveals, and pans when the GM focuses on revealed things. F toggles full screen.
- **Editor:** the Reveal tool (G) shows or hides a room or corridor with a click, reveals an area with a drag and covers one with Shift-drag. The map panel has the fog switch, Reveal all, Hide all and the players' screen link.
- **Corridors:** revealing two rooms also reveals a corridor between them.
- **MCP:** `fog` (`on`, `reveal`, `cover`, `reveal_area`, `cover_area`, `reveal_all`, `reset`). Core: `updateFog`, `visiblePolygons`, `visibleFloor`, `fogShade`, `revealedBounds`.

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
- **Prop brush:** in the editor's Prop tool, Shift + drag paints copies of the picked prop along the path.
  - **Regular** puts one every N squares, snapped to the grid like a click.
  - **Irregular** varies the gaps and strays up to `spread` squares to the sides, turning each copy at random and sizing it 0.8–1.2×.
  - The dashed stroke and a ghost of every copy show while dragging. No copy lands within 0.6 × spacing of the same prop already on the map, and a stroke is one undo step.
  - Selecting a prop on the map and switching to the Prop tool picks that prop (and its turn).
  - Over MCP: `add_props_along` (`asset`, `path`, `spacing?`=3, `placement?`, `spread?`, `rotation?`), up to 500 per call.
  - Core: `scatterAlong` in `scatter.ts`.
- **Wall roughness** runs from 1 (smooth: straight walls, no hand wobble) to 10 (extremely rough: caves).
  - Set it for the whole map (`roughness` on the map, via `update_map` or MCP `set_map roughness`, `null` resets) and override it per room, corridor or cutout (`roughness` on the object).
  - It reshapes the floor outline itself with smooth noise, so the floor, walls, shading and hatching all follow the rough edge. Each point of the outline takes the level of the nearest object edge.
  - Doors stay on straight wall (no roughness within about a square of a door), and bulges outward are kept smaller than dents inward.
  - Fog of war widens what players see by the largest possible bulge.
  - Unset keeps the style's own look.
  - Exports to Dungeon Scrawl keep the plain outline.
  - Core: `geometry/rough.ts`.
- **Terrain** is `{ type: "terrain", asset, shape }`, drawn over the floor and under the grid, as a tint plus a repeating 2×2-square tile.
- **Drawing order:** decals lie under the walls, props sit on top of walls and doors, and GM symbols come last. GM symbols appear in the GM view only.
- **Recolouring:** every style recolours the three asset inks (`props` in the style preset).
- **GM markers** are `{ type: "marker", kind: "discover" | "interact" | "trap", at, text, done? }`. They are notes pinned to a spot: "?" is something to discover, "!" something to interact with, and a skull a trap.
  - They are drawn last, in the GM view only. The players' view, the players' screen and the players' 3D view never contain them, and neither do Dungeon Scrawl exports. They don't change the picture's size.
  - In the viewer, clicking a marker opens its note in a small box, which editors can edit. Shift-click toggles `done`, which fades the badge and strikes it through, and strikes the note's text through.
  - The editor's Marker tool (M) places them at square centres (Alt for half squares) and opens the box for typing.
  - The SVG tags each badge `data-marker="<id>" data-kind="<kind>"`, plus `data-done` when done. Code: core `markers.ts`, web `markers.ts`.
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

The players' view hides room numbers and draws secret doors as solid wall. Styles are `classic-hatching`, `clean`, `old-school-blue`, `print` and `parchment`. Parchment is brown ink on old paper, with sketched walls; the handout below puts it on a whole parchment sheet.

### Parchment handout (to print or hand out)

- **What it is:** the players' view of the map, drawn in the parchment style on an aged sheet.
  - **The map:** no room numbers, secret doors shut, and no GM markers or GM symbols. It shows the whole map, unless "only what the players have seen" is on.
  - **The sheet:** paper texture and stains, a torn and burnt edge, and a hand-ruled frame.
  - **Extras:** a title with a flourish, a compass rose and a scale bar in the map's own unit.
- **Page:** `/maps/:id/handout`, with a "Handout" button in the viewer and "Parchment handout" on the start page.
  - It has a live preview on a table and the options.
  - Print or save as PDF: the 200 dpi PNG goes on a page of the right paper size.
  - Downloads: PNG at 200 or 300 dpi, and SVG.
- **Images:** `GET /api/v1/maps/:id/handout.png` and `handout.svg`. The query parameters are:
  - `paper`: `a4` (the default), `a3`, `letter`, or `fit` (the sheet is sized to the map).
  - `orientation`: `auto` (whichever way round draws the map bigger), `portrait` or `landscape`.
  - `title`: missing means the map's name; empty means no title.
  - `compass=0`, `scale=0`, `frame=0`, `stains=0` leave each of those out.
  - `names=1` writes the room names on the map.
  - `revealed=1` draws only what the players have seen.
  - `dpi`: 50–400; PNG defaults to 200, SVG to 96.
  - `download=1` sends the file as an attachment.
- **Response:** the header `x-handout-size: <w>x<h>pt` gives the sheet size, and the PNG corners outside the torn edge are transparent.
- **Big maps:** past 1500 squares of wall (a city), the hatching is left out. It would take seconds and only look busy.
- **Code:** core `render/handout.ts`, server `handout-page.ts`.
- **Don't use `feDisplacementMap`** in anything resvg renders. It panics on uneven region rounding (e.g. A3 at 60 dpi), and the panic aborts the whole server.

### Dungeon Scrawl `.ds`

- **Export** writes the floor (rooms, corridors and cutouts merged into one outline), normal/locked/barred doors, room numbers and labels. Secret doors become an "S" in the GM view and plain wall for players; archways stay open. Stairs and Delve's styles don't carry over (Dungeon Scrawl uses its own).
- **Import:** `POST /maps/import.ds?name=` with the raw file as `application/octet-stream` (token or editor login). Returns `201 { id, rev, map, notes }`. Dungeon Scrawl keeps only the merged outline, so the floor comes in as one polygon room per area (holes become cutouts), door stamps become doors and text becomes labels. `notes` says what came across and what was left out. Bad files get a `400` that says why. The start page has an "Import .ds" button.

### Cities from Watabou's Medieval Fantasy City Generator

- **Where the file comes from:** in the generator, Menu → Export as → JSON. It's version 0.11 or later: metres, with y pointing north.
- **Request:** `POST /maps/import.city?name=&feet=10&style=clean` with the file as `application/json` (token or editor login). Returns `201 { id, rev, map, notes }`. The start page has an "Import city (Watabou JSON)" button with a scale choice.
- **What comes across:**
  - Buildings become rooms, pulled apart by 0.4 m so each keeps its own walls. The keep ("prisms") becomes a Landmark room.
  - Each city or castle wall becomes wall strips, a round tower at every corner, and a gap where a road passes through a corner (a gate). A small gatehouse stands on each side of every gate.
  - Terrain: roads and plazas become cobblestones and flagstones, rivers and water become deep water, fields become dirt, and parks become grass.
  - Trees become tree props and districts become name labels, and a compass rose is added.
- **Crop and scale:** the map is cropped to the city (buildings, walls, plazas and 30 m around), not the generator's whole landscape. Default scale is 10 ft per square, and `feet=5` gives true scale. The style defaults to clean, because hatching around hundreds of houses is slow and busy.
- **Streets:** the export has no street shapes inside the walls; the streets are the gaps between buildings.
- **Dungeon Scrawl:** the result exports to `.ds` like any map, one outline per house.
- **Code:** core `fromWatabou`.

### Tracing a map picture (PNG, JPG)

- **Page:** `/import/image`, linked from the start page as "Trace a map picture". The picture never leaves the browser: `/assets/trace.js` runs the page, and `/assets/trace-worker.js` does the tracing, so the page stays responsive. Only the finished map goes to the server, through `POST /api/v1/maps` with `{ map }`, which needs the editor login.
- **Steps:**
  1. Load the picture (choose, drop or paste). Pictures bigger than 2000 px are shrunk first.
  2. Delve finds the main colours (4–12, default 7) and guesses a role for each. Roles: ignore, building/room, wall, water, road, grass, field, sand.
  3. Set the scale:
     - the picture's width in feet, or
     - Measure: click both ends of a scale bar and enter its length in m or ft.
     - The page shows the squares over the picture, so you can check the scale.
  4. Optionally crop to the part you want.
  5. Check the outlines over the picture, or the finished map, then Create map. It opens in the editor.
- **What comes across:**
  - Buildings become rooms. Courtyards stay holes (cutouts). Small holes, like printed text, are filled.
  - Walls become rooms named "Wall". A shape with a hole, like a ring wall, is split into solid pieces that overlap by a pixel.
  - The other roles become terrain.
- **Clean-up:**
  - A printed grid is removed. This means straight lines up to 3 px thick that cross at least 12% of the picture; short lines such as house outlines stay.
  - Each role skips parts thinner than a set width in squares. Walls default to 0.5 and water to 1, which drops text, outlines and house shadows in those colours.
  - Pieces under 0.3 squares are dropped.
  - Touching buildings can be joined into blocks. They stay separate by default.
- **Command line:** `npm run trace -- picture.png out.delve.json --width-ft 1684 [--feet 10] [--roles ignore,building,water,wall,...] [--min water=1.5] [--join] [--render out.png]`. It prints the colours with the guessed roles, and reads PNG only (decoded with `node:zlib`).
- **Code:** core `trace/raster.ts` (colours, masks, outlines) and `trace/trace.ts` (`traceImage`, `guessRoles`, `tracedMap`).

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
| `list_assets` (`category?`, `search?`), `add_prop` (`asset`, `at`, `rotation?`, `scale?`, `notes?`), `add_props_along` (`asset`, `path`, `spacing?`, `placement?`, `spread?`), `add_terrain` (`asset`, one shape) | Furnishing and ground |
| `add_marker` (`kind` discover/interact/trap, `at`, `text`) | A GM note badge (GM view only); `update` with `{"done": true}` strikes it through |
| `add_level` (`name`, `position?` above/below, `current_name?`) | Adds a storey (a new map in the same group) |
| `move`, `resize`, `update`, `delete`, `set_map` (name, style, overrides, seed, roughness 1–10, level_name) | Changes; `add_room` also takes `roughness` |
| `undo`, `redo` | History |
| `render` (`view?`, `style?`, `ppg?`=24) | Returns a PNG image, so Claude can look at its work |
| `export` (`format?` png/svg/ds/handout, `view?`=players, `ppg?`=70) | A download link for the user; `handout` links the parchment handout page |
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
