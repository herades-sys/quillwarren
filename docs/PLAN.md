# Delve: plan and file formats

This is draft 1 (2026-09-28). It mirrors https://claude.ai/artifact/X3Ep7LK6fqbYayHsRckUzd. Keep this file current as decisions change.

## Goal

A self-hosted dungeon map editor on a home server. Claude edits maps through an API ("add a 5×5 room west of the entrance", "move the vault one square east") while the user watches live in the browser. The user can edit the same map with the mouse, and every change shows up on every open screen at once.

The key difference from Dungeon Scrawl: Delve stores rooms, corridors and doors as **named objects** and works out the floor and walls when it draws. Dungeon Scrawl only keeps the merged outline. Keeping the objects is what lets an API say "room 3" and mean it.

## Architecture

One Node.js service does everything:

- Serves the web editor (static files).
- REST API under `/api/v1`.
- WebSocket `/api/v1/maps/:id/live`, which pushes every change to every open editor.
- MCP endpoint `/mcp` (Streamable HTTP, bearer token), so Claude Code gets map tools.
- Shared `core` package, used by both browser and server: model, validation, ops and undo, geometry, renderer. The screen, the PNG export and the picture Claude gets back via MCP all come from one renderer.
- SQLite (WAL) stores maps and their full revision history.

| Part | Choice |
|---|---|
| Language | TypeScript throughout |
| Server | Node.js 24 LTS, Fastify, WebSocket plugin |
| Claude access | Official MCP TypeScript SDK, Streamable HTTP |
| Geometry | Clipper2 or polygon-clipping, chosen by a short spike in phase 1. Needs union/difference plus offset (hatching band, shadow) |
| Browser | Vite + Svelte 5, Canvas 2D |
| PNG export | resvg (`@resvg/resvg-js`), SVG to PNG |
| Storage | SQLite |
| Tests | Vitest, plus reference-image render tests |

## File formats

### 1. Map file `.delve.json` (native, source of truth)

Plain JSON with a version number. All positions are in grid squares: origin top left, x right, y down, steps of 0.5. One square is 5 ft unless `grid.unit` says otherwise.

- **Floor** = union of every `room` and `corridor` shape, minus every `cutout`.
- **Walls** follow the floor's edge automatically.
- A **door** sits on a wall or across an opening. Closed doors block line of sight in VTT exports.

See `fixtures/test-map-4p.delve.json` for the test dungeon. The top level looks like this:

```json
{
  "format": "delve.map",
  "version": 1,
  "id": "map_test4p",
  "name": "Test dungeon (4 players)",
  "grid": { "type": "square", "unit": "5 ft", "bounds": [0, 0, 20, 32] },
  "style": { "preset": "classic-hatching" },
  "seed": 4721,
  "objects": [ ... ]
}
```

| Object | Fields | Notes |
|---|---|---|
| `room` | `shape`, `label`, `name`, `notes` | Shapes: `{"rect": [x, y, w, h]}`, `{"poly": [[x, y], ...]}`, `{"circle": [cx, cy, r]}`. Every object may have `name` and `notes`; on rooms, corridors and terrain `notes` are the GM notes (never drawn; see docs/API.md, "GM notes") |
| `corridor` | `from`, `to`, `width`, `path`, `notes` | Without `path`, the server routes it (straight or L-shaped) and re-routes it whenever a connected room moves. `path` is the centerline, and the ends are square |
| `cutout` | `shape`, `name`, `fill` | Removed from the floor: pillars, pits. `fill: "solid"` draws it in the wall colour (solid pillars, wall blocks); the default `"rock"` shows what's around the dungeon |
| `door` | `at`, `along` (`x` or `y`), `width`, `style`, `open` | Styles: normal, double, locked, secret, portcullis, archway. Secret doors render as wall in the players' view |
| `stairs` | `shape`, `direction`, `label` | `label` is the GM stair label: floor number, then flight letter ("0A", "-1C"); ladder, trapdoor and spiral-stair props have it too |
| `label` | `text`, `at`, `size` | Room numbers come from the room's own `label` |
| `prop` | `asset`, `at`, `rotation`, `scale`, `label` | Phase 7 |
| `terrain` | `shape`, `asset`, `holes`, `notes` | An area filled with a repeating tile (water, grass, lava…) |
| `marker` | `kind` (`discover`, `interact`, `trap`), `at`, `text`, `done` | GM note badges ("?", "!", skull), GM view only. Click to read, Shift-click to strike through |
| `image` | `src` (an uploaded file, `<sha256>.<ext>`), `at` (centre), `w`, `h`, `rotation`, `layer` (`floor` or `props`), `opacity`, `gmOnly` | Your own pictures, uploaded through `/api/v1/images` |
| `opening` | `shape`, `walls`, `name` | An open area: no hatching, shading or drop shadow inside the shape (both views); `walls: true` leaves the wall lines there out too. Never drawn itself. Outer archways get the same open end by themselves (docs/API.md, "Open ends and open areas") |

### 2. Operations (the only way to change a map)

REST, WebSocket, MCP and the editor all send the same ops. One request is applied all-or-nothing and counts as one undo step.

```
POST /api/v1/maps/map_test4p/ops
{
  "baseRev": 42,
  "ops": [
    { "op": "add",    "object": { "id": "r7", "type": "room", "shape": { "rect": [0, 25, 5, 5] }, "label": "7", "name": "Flooded cellar" } },
    { "op": "add",    "object": { "id": "c6", "type": "corridor", "from": "r1", "to": "r7", "width": 1 } },
    { "op": "update", "id": "d6", "set": { "style": "normal" } },
    { "op": "move",   "ids": ["p1", "p2", "p3", "p4"], "dx": 0, "dy": 1 },
    { "op": "delete", "ids": ["d5"] }
  ]
}
-> 200 { "rev": 43 }
-> 409 { "error": "stale", "rev": 45 }   (someone changed the map first)

WebSocket messages to editors:
{ "type": "ops",   "rev": 43, "by": "claude", "ops": [ ... ] }
{ "type": "focus", "ids": ["r7"] }        (pan and zoom the viewer to these objects)
```

### 3. Style preset `.delve-style.json`

Sizes are in squares, so a map looks the same at any export resolution. The planned presets are classic hatching, clean, old-school blue, and black-and-white print.

```json
{
  "format": "delve.style", "version": 1, "name": "Classic hatching",
  "floor":    { "color": "#F0ECE0" },
  "walls":    { "color": "#000000", "width": 0.14, "roughness": 1 },
  "hatching": { "width": 0.9, "density": 1.0, "strokesPerCluster": 3, "color": "#000000" },
  "shadow":   { "offset": [0.33, 0.25], "color": "#8C867D" },
  "grid":     { "style": "lines", "color": "#555555", "opacity": 0.35 },
  "labels":   { "font": "IM Fell English", "size": 0.9 }
}
```

Fonts must be open-licence (OFL) and bundled, so the browser and resvg render identically.

### 4. Exports and imports

**The user plays on Roll20, so Roll20 comes first.** Roll20's default grid is 70 px per square. The first export is therefore a PNG at 70 px per square, grid off (Roll20 draws its own), in a players' view. The size in squares goes in the filename, e.g. `test-dungeon_20x32.png`, so the Roll20 page size is easy to set. Roll20 imports only the image. Getting walls and doors into its Dynamic Lighting needs a mod (API) script that reads Universal VTT files, and mods need a Roll20 Pro subscription. Check with the user before building that.

| Format | For | Contents |
|---|---|---|
| PNG | Roll20 (first), Discord, TV, print | Pixels per square 70 (Roll20 default)/100/140/256, grid on or off, GM or players' view |
| SVG | Printing at any size | Same renderer |
| Universal VTT `.dd2vtt` | Foundry (Universal Battlemap Importer), Fantasy Grounds Unity and others | PNG plus walls, doors and lights in grid units |
| Foundry scene JSON | Foundry, direct | Only if the user plays on Foundry |
| Dungeon Scrawl `.ds` | Opening in Dungeon Scrawl | Floor outline. See the `.ds` notes in CLAUDE.md |
| Import | `.delve.json`, `.ds` | A `.ds` file comes in as one polygon room per area, plus cutouts, doors and labels |
| Text summary | Session notes, Claude | `GET .../describe`: rooms, sizes, exits, door types |

## API

REST under `/api/v1`: `GET/POST /maps`, `GET /maps/:id`, `POST /maps/:id/ops`, `/undo`, `/redo`, `/render.png?ppg=100&grid=1&view=players`, `/export/{svg|uvtt|ds|json}`, `/describe`, and WebSocket `/maps/:id/live`. API and MCP calls need the bearer token.

MCP tools (thin wrappers over ops):

| Tool | Does |
|---|---|
| `list_maps`, `create_map`, `open_map` | Find, start, or pick the current map |
| `describe_map` | Rooms, ids, sizes and connections as text |
| `add_room`, `add_cutout`, `add_stairs`, `add_label` | Draw things |
| `connect` | Corridor between two rooms, optionally with doors |
| `add_door` | Door on a wall or across an opening |
| `move`, `resize`, `update`, `delete` | Change anything by id |
| `set_style` | Preset or individual settings |
| `undo`, `redo` | History |
| `render` | Returns the map as a PNG image to Claude, which is how Claude checks its own work |
| `export` | PNG, SVG, Universal VTT or `.ds`, as a download link |
| `focus` | Pans the user's open editor to objects |
| `apply_ops` | Raw batch |

## Build order

Sizes are rough (S, M, L) and show relative effort only.

0. **Groundwork (S), done 2026-09-28.** Container, service, release flow, npm workspaces (`packages/core`, `apps/server`), TypeScript, Vitest, and a Fastify server bundled by esbuild into `release/main.mjs`.
1. **Core model (M), done 2026-09-28.** zod schema and validation with id-and-field messages, ops with exact inverses, geometry (floor, corridors with auto-routing, walls with door gaps), `describeMap`. The test dungeon's floor matches the `.ds` fixture exactly (XOR area 0).
2. **Renderer (L), first version 2026-09-28.** `buildScene` in core turns a map into drawing layers: background, shading band, hatching, shadow, floor, grid, stairs, walls (slightly rough), doors, labels. `sceneToSvg` writes SVG, and the server's `svgToPng` (resvg) makes PNGs. Four presets: `classic-hatching`, `clean`, `old-school-blue`, `print`. The GM and players' views differ in room numbers and secret doors. Hatching clusters sit on a lattice seeded by (map seed, cell), so edits only change nearby hatching. `npm run render -- <map> <out.png> [--ppg 70] [--view players] [--style clean]`. *Done when* the user is happy with the look. Still to tune: hatch density and stroke length, and the label font (IM FELL's old-style "1" reads like an "I").
3. **Server and API (M), done 2026-09-28.** Fastify, storage on Node's built-in `node:sqlite` (no native module), REST under `/api/v1`, a live WebSocket per map, `baseRev` conflicts, linear undo/redo per map, a bearer token for writes, PNG/SVG/text output. See [API.md](API.md). The start page lists saved maps with downloads. `npm run demo` builds the test dungeon over HTTP and saves the PNG.
4. **MCP and live viewer (M), the first real milestone, built 2026-09-29.** A stateless Streamable HTTP MCP server at `/mcp` (20 tools, token-protected) and a live viewer at `/maps/:id`. The viewer is vanilla TypeScript in `apps/web`, bundled by esbuild: pan and zoom, live ops, change highlights, animated `focus`, reconnect. Verified live: MCP `add_room` + `connect` + `focus` showed up in an open viewer within the second. *Done when* the user asks for a dungeon in one sentence and watches it appear. That's waiting only on registering `/mcp` in the user's Claude Code.
5. **Editor (L), built 2026-09-29.** Logging in to the viewer page reveals the editor.
   - **Tools:** Select (click, Shift-click, drag to move, 8 resize handles, arrow keys), Room, Polygon, Corridor (click two rooms), Door (drag along a wall), Pillar, Stairs and Label, with 1 or ½ square snapping.
   - **Panel and keys:** a properties panel per object type plus map settings. Delete takes attached corridors along, and Ctrl+Z / Ctrl+Y undo and redo.
   - **Moving:** doors on a moved room's edges travel with it, in the editor and in MCP `move` alike.
   - **Live:** edits go over the live WebSocket, so the user's and Claude's changes show up for each other.
   - **Login:** a password set with `sudo delve-passwd` (only a scrypt hash is stored) gives a 30-day HttpOnly SameSite=Strict session cookie, and cookie writes must be same-origin. There's a "New map" form on the start page.
   - **Tested:** all tools in a real browser against a dev server with `DELVE_INSECURE_OPEN_EDIT=1`.
6. **Exports and imports (M), `.ds` done 2026-09-29.** Roll20 PNG is done (70 px per square, players' view, size in filename).
   - **`.ds` export and import:** `packages/core/src/interop/dungeonscrawl.ts` builds and reads the document, and `apps/server/src/zip.ts` writes and reads the ZIP. `GET /maps/:id/export.ds`, `POST /maps/import.ds`, an MCP `export` format, and an "Import .ds" button on the start page.
   - **Tested:** importing the real Dungeon Scrawl fixture gives the test dungeon exactly (floor XOR 0 after the (+9, +2) shift, all 5 doors). Our export opened in the real Dungeon Scrawl with floor, pillars, doors, numbers and labels.
   - **Node shapes:** Dungeon Scrawl crashes when a node lacks a field it expects (the first export missed `GRID.roughOptions`). A test now checks that every exported node type has exactly the fixture's fields.
   - **Still to do:** Universal VTT (Roll20 walls via a Pro mod), only if the user has Pro. Foundry scene JSON is dropped unless that changes.
6b. **Chat in the editor (M), live 2026-09-29.**
   - A Claude panel on the map page for logged-in editors. It runs Claude Code on the user's subscription through the chat bridge on the CT, with Delve's MCP tools only.
   - It streams replies with tool chips, has a model picker (Sonnet, Opus, Haiku), shows subscription usage, and keeps the conversation per map. Each message carries the map, the selection and the view.
   - See [API.md](API.md#chat-talking-to-claude-from-the-editor).
   - Props art comes from Claude Design using the prompts in [ASSETS.md](ASSETS.md).
7. **Props, terrain and storeys (L), built 2026-09-29.** 146 props and tiles from the Claude Design art (see [ASSETS.md](ASSETS.md)), placed from the editor, MCP and the chat. Storeys are linked maps with a picker. Maps can be deleted from the UI. See [API.md](API.md#props-and-terrain).
8. **Extras (later).** A dungeon generator, fog of war with a players' screen and reveal-by-API, lights and walls for Universal VTT, nightly backup to the NAS, a public subdomain with login, a Dashy tile.

## Decisions

- **Setup:** devbox. Claude Code runs inside the dev container, which also hosts the live app.
- **Code:** GitHub `herades-sys/delve` (private). The CT pushes with its own deploy key, which has access to this one repo only.
- **Virtual tabletop:** Roll20. See section 4.
- **Geometry library:** `clipper2-ts` 2.0.1-18 (Boost licence), a TypeScript port of Clipper2 with union, difference, xor and offset. In the spike, the test dungeon's floor XORed against the Dungeon Scrawl original gave area 0 once DS's 0.01 px vertex insets were rounded off. Pinned exactly, because its npm `latest` tag carries a prerelease number. Rejected: `clipper2-js` (unmaintained since 2024), `js-angusj-clipper` (Clipper1 WASM, 2023), `polygon-clipping` (no offset).
- **TypeScript 7** (the native compiler) works with our settings (`tsconfig.base.json`).
- **Storage:** `node:sqlite` in `DELVE_DATA/delve.db` (WAL). The `maps` table holds each current document; `revisions` holds the ops and exact inverse for each rev. Deletes are soft. Map-level fields change through the `update_map` op, so a style or name change is undoable too.
- **Viewer tech:** the phase 4 viewer is plain TypeScript, with no framework. The phase 5 editor may bring in Svelte and reuse `apps/web/src/logic.ts`. The bundle is about 550 KB minified, mostly zod and Clipper.
- **Access:** reads are open on the LAN; writes need `Authorization: Bearer <DELVE_API_TOKEN>` (or `?token=` on the WebSocket). With no token configured, the server is read-only.
- **Revisions live in the server**, not in the map file. `applyOps(map, ops)` returns the new map plus the exact inverse ops, and the server stores `rev` and undo history.
- **Auto-routed corridors** snap their edges to whole squares.
- **Label font:** IM FELL English (OFL) from `@expo-google-fonts/im-fell-english`, which ships TTF files. resvg loads only that file, so PNGs never depend on system fonts. The web editor will load the same file.
- **Image bounds** cover `grid.bounds` and the floor, plus hatching reach and a 1-square margin, snapped to whole squares so a VTT grid lines up.
- **Doors vs walls:** walls are the floor's edge. A door that lies on that edge (like d5, the entrance to outside) cuts a gap in the wall. A door across an opening (a corridor mouth, like d1–d4 and d6) doesn't change the walls. For line of sight, closed doors are portals.
- **Still open:** LAN only (current) or public later (public needs a login first); whether the user has Roll20 Pro (for walls/doors via a mod); the final name ("Delve" is a working name).

## Notes

- The hatching look is the hardest part. Plan for iterations.
- Dungeon Scrawl's `.ds` format is undocumented, so import and export may break if it changes.
- The LAN version trusts the home network. Going public needs auth first.
