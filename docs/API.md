# Delve API (v1)

Base URL on the LAN: `http://192.168.1.9:8790/api/v1`. Everything is JSON unless noted. Map and op formats are in [PLAN.md](PLAN.md#file-formats).

## Access

- **Reading needs no token** (LAN only). This covers maps, renders, the text summary, history and subscribing to live changes.
- **Every change needs the API token:** `Authorization: Bearer <token>`. On the WebSocket, use `?token=<token>`, because browsers can't set headers there.
- The live token is `DELVE_API_TOKEN` in `/etc/delve/delve.env` (root only). A server started without a token refuses all changes with `503`.
- Tokens in URLs are masked in the server log.

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
| GET | `/maps` | | `{ maps: [{ id, name, rev, objects, created, updated }] }`, newest first |
| POST | `/maps` | `{ name?, style?, template?: "empty" \| "test-dungeon", by? }`, or `{ map: <full delve.map>, by? }` | `201 { id, rev: 1, map }` |
| GET | `/maps/:id` | | `{ id, rev, map }` |
| DELETE | `/maps/:id` | | `204`. A soft delete: the row stays in the database file, and the id can't be reused |

## Changes

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/maps/:id/ops` | `{ ops: Op[], baseRev?, by? }` | `{ rev }`. The whole batch is one revision and one undo step, applied all or nothing |
| POST | `/maps/:id/undo` | `{ by? }` | `{ rev }`. Undoes the newest change that hasn't been undone yet |
| POST | `/maps/:id/redo` | `{ by? }` | `{ rev }`. Redoes the most recent undo. Any new change ends the redo chain |
| POST | `/maps/:id/focus` | `{ ids: string[], by? }` | `{ viewers }`. Tells open editors to pan to these objects |
| GET | `/maps/:id/history?limit=50` | | `{ history: [{ rev, at, by, kind, ops, state }] }`, where `kind` is create, ops, undo or redo |

- **`by`** says who made a change (`claude`, `editor`, a script's name). It's shown in history and live messages. The default is `api`.
- **Ops:** `add`, `update` (`set`/`unset`), `move` (`ids`, `dx`, `dy`), `delete`, `batch`, plus **`update_map`** (`set`/`unset` of `name`, `grid`, `style`, `seed`).
- **`baseRev`:** send it when you've computed changes from a copy you read earlier. On a mismatch you get `409` with the current `rev`: fetch again and retry.

## Output

| Path | Query | Returns |
|---|---|---|
| `/maps/:id/render.png` | `ppg` (10–300, default **70**, Roll20's grid), `view` (`gm` or `players`), `style` (preset override), `grid=0` | PNG. The filename includes the size in squares, e.g. `crypt_classic-hatching_players_26x38.png` |
| `/maps/:id/render.svg` | same | SVG, scalable, for print |
| `/maps/:id/describe` | | Plain text: rooms, sizes, connections, doors |

The players' view hides room numbers and draws secret doors as solid wall. Styles are `classic-hatching`, `clean`, `old-school-blue` and `print`.

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
| `move`, `resize`, `update`, `delete`, `set_map` (name, style, overrides, seed) | Changes |
| `undo`, `redo` | History |
| `render` (`view?`, `style?`, `ppg?`=24) | Returns a PNG image, so Claude can look at its work |
| `export` (`format?`, `view?`=players, `ppg?`=70) | A download link for the user |
| `focus` (`ids`) | Pans and highlights every open viewer |
| `apply_ops` | Raw ops, one undoable step |

From a shell: `DELVE_API_TOKEN=… npm run mcp -- add_room '{"map":"map_…","rect":[0,0,6,6]}'` (`--list` shows the tools).

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
