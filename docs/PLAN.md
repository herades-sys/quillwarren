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
| `room` | `shape`, `label`, `name`, `notes` | Shapes: `{"rect": [x, y, w, h]}`, `{"poly": [[x, y], ...]}`, `{"circle": [cx, cy, r]}` |
| `corridor` | `from`, `to`, `width`, `path` | Without `path`, the server routes it (straight or L-shaped) and re-routes it whenever a connected room moves. `path` is the centerline, and the ends are square |
| `cutout` | `shape`, `name` | Removed from the floor: pillars, pits |
| `door` | `at`, `along` (`x` or `y`), `width`, `style`, `open` | Styles: normal, double, locked, secret, portcullis, archway. Secret doors render as wall in the players' view |
| `stairs` | `shape`, `direction` | |
| `label` | `text`, `at`, `size` | Room numbers come from the room's own `label` |
| `prop` | `asset`, `at`, `rotation`, `scale` | Phase 7 |

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
| Import | `.delve.json`, `.ds` | A `.ds` file comes in as one polygon room |
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

0. **Groundwork (S).** The container, service, release flow and placeholder are done. Remaining: workspace scaffold, TypeScript, Vitest, real build into `release/`. *Done when* `npm run release` ships the real server skeleton and `/health` is green.
1. **Core model (M).** Schema and validation, ops with undo, geometry (merge, cutouts, walls, door openings), text summary. *Done when* the test dungeon loads and its outline matches the `.ds` fixture square for square (after the (+9, +2) shift).
2. **Renderer (L).** Floor, grid, walls with roughness, shadow, hatching, doors, labels, four presets, seeded randomness. *Done when* the test dungeon's PNG holds up next to the Dungeon Scrawl version. Expect tuning rounds with the user.
3. **Server and API (M).** Fastify, SQLite, REST, WebSocket, conflicts, token, PNG and SVG export. *Done when* a script builds the test dungeon over HTTP and gets a PNG back.
4. **MCP and live viewer (M), the first real milestone.** MCP tools, plus a read-only live viewer with pan, zoom and `focus`. *Done when* the user asks for a dungeon in one sentence and watches it appear.
5. **Editor (L).** Select, move and resize with snapping; room, polygon, corridor, cutout, door, stairs and label tools; properties panel; undo and redo; map list. Edits from the user and from Claude show up for each other live.
6. **Exports and imports (M).** Roll20 PNG first (70 px per square, players' view, size in filename). Then Universal VTT (Roll20 walls via a Pro mod, if the user has Pro), and `.ds` export and import. Foundry scene JSON is dropped unless that changes.
7. **Extras (later).** Props from our own icons, a dungeon generator, fog of war with a players' screen and reveal-by-API, multiple levels, nightly backup to the NAS, a public subdomain with login, a Dashy tile.

## Decisions

- **Setup:** devbox. Claude Code runs inside the dev container, which also hosts the live app.
- **Code:** GitHub `herades-sys/delve` (private). The CT pushes with its own deploy key, which has access to this one repo only.
- **Virtual tabletop:** Roll20. See section 4.
- **Still open:** LAN only (current) or public later (public needs a login first); whether the user has Roll20 Pro (for walls/doors via a mod); the final name ("Delve" is a working name).

## Notes

- The hatching look is the hardest part. Plan for iterations.
- Dungeon Scrawl's `.ds` format is undocumented, so import and export may break if it changes.
- The LAN version trusts the home network. Going public needs auth first.
