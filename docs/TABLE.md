# Delve Table: the private virtual tabletop (phase 1, "the basics")

The plan this follows is the user's doc "Roll20 Feature Map & Private Build Plan"
(claude.ai/artifact/VW21vTRu8ffAZYRiHbeVRN). Phase 1 builds what every later
feature sits on: realtime sync, permissions, and a table you can play a session on.

Delve Table lives inside the Delve monorepo and runs in the same server
process, so a Delve map becomes a playable page directly, and it uses the same
login, database directory and release pipeline.

## Scope of phase 1

- **Games** with one GM, who is Delve's editor login, and players who join through invite links. Players need no account or password.
- **Pages** (scenes) in a game. A page's background is a Delve map (its players' view) or an uploaded image. The GM moves all the players to a page ("player banner").
- **Tokens** on three layers:
  - map (under tokens) and tokens: everyone sees these;
  - gm: never sent to players.
  - A token has an image, a size in cells, rotation, a name plate, up to 3 bars (value/max), `controlledBy` and GM-only notes.
  - Dragging snaps to the grid (Alt moves freely).
- **Chat with dice.**
  - Roll20-style notation, rolled on the server with a crypto RNG. Every die is sent so clients can show the breakdown.
  - Commands: `/r` `/roll`, `/gr` (GM roll), `/w <name>` (whisper), `/em` `/me`, `/ooc`, `/desc` (GM), `/as "Name"` (GM), and inline `[[2d6+3]]` in any line.
- **Turn order:** entries (token or free name) with an initiative value. The GM can sort, go to the next turn (rounds count up), hide the list or clear it.
- **Pings:** ephemeral, never stored.
- **Out of scope for phase 1:** dynamic lighting and vision, measuring, drawing, character sheets, handouts, jukebox, voice, scripts. They come in later phases. Walls from Delve maps are stored on the page (`walls`) so phase 3 can use them, but they aren't drawn or enforced yet.

## Code layout and who owns what

| Part | Where | Notes |
|---|---|---|
| Model, rules, dice | `packages/table` (`@delve/table`) | Pure TS, no Node or DOM APIs, like `@delve/core`. Tests in `packages/table/test` |
| Server | `apps/server/src/table/` | Store, REST, WebSocket, invites, assets. Registered in `apps/server/src/app.ts` with `registerTable(scoped, …)`. Tests in `apps/server/test/table.test.ts` |
| Page shell | `apps/server/src/table/page.ts` | Owned by the client work: the HTML for `/play/:gameId` that loads `/assets/table.js` |
| Client | `apps/web/src/table.ts` (entry) + `apps/web/src/table/` | PixiJS 8. Bundled by `scripts/build-web.sh` into `table.js`, served at `/assets/table.js` |

The message and state types are in `packages/table/src/protocol.ts`, and that file is the contract. You may add optional fields to it, but don't rename or remove anything without updating all three parts.

## Identity and access

- **GM:** anyone with the Delve editor session cookie (`isLoggedIn(auth, req)` in `apps/server/src/login.ts`). The GM's member id is `gm`. In development, `DELVE_INSECURE_OPEN_EDIT=1` makes every browser the GM.
- **Players:**
  - The GM creates an invite with `POST /api/v1/games/:id/invites {name?, hours?}` (default 72 hours). The link is `/play/join/<token>`: an HMAC-signed token with the game id, an invite id and the expiry, keyed from the server's session key (the same secret the sessions use).
  - Opening the link asks for a display name, creates a member (`p1`, `p2`…, role `player`) and sets the cookie `delve_player_<gameId>`, signed and holding the member id, for 30 days. It then redirects to `/play/:gameId`.
  - Removing a member (GM) invalidates their cookie, because the member no longer exists.
- **Every read and write** of a game checks membership. A non-member gets 401/403, and the WebSocket closes with 4401.

## The one permission check and the one filter

- **`can(state, member, intent)`** (in `@delve/table`) decides every write. It returns true, or a reason string.
  - The GM can do everything.
  - A player can:
    - move, rotate and update the bars of tokens they control (`controlledBy` contains their id or `"all"`), on the page they are on, and only on the `tokens` layer;
    - send chat, ping, and end their own turn.
  - A player can't change `layer`, `controlledBy`, `gmNotes` or images.
- **`viewFor(state, member)`** / **`eventFor(state, member, event)`** strip what the member may not see before anything is sent:
  - `gm`-layer tokens and every token's `gmNotes`;
  - pages other than the player's current one;
  - whispers not addressed to them;
  - GM rolls (the roller sees that they rolled, not the result, if they aren't the GM);
  - hidden turn order;
  - the invite list and the member list's internal fields.
- **Never rely on the client to hide anything.**

## Sync

- **The server is authoritative.** A client sends an `intent`, and the server runs `can()`, then `applyIntent()`. That gives the new state and a list of `events`. The server bumps `rev`, sends each member their filtered events, and replies `ack {ref, rev}` or `error {ref, error}` to the sender.
- **Optimistic moves:** the client may move a token locally before the ack. It snaps back if an error arrives, and it takes whatever the server's event says.
- **`hello`:** on connect (and after a page switch), the member gets `hello` with their full filtered view.
- **Pings** are relayed straight to the members on that page and never stored. Keep them to about 20 per second per member.

## Dice notation (phase 1)

`NdX` (N defaults to 1; X a number, or `F` for fate dice), `+ - * /`, parentheses,
and whole numbers. Modifiers after a dice term:

- `khN` / `klN` / `dhN` / `dlN`: keep or drop the highest or lowest (a bare `kh` means 1).
- `!`: explode on the maximum (or `!>N`, `!=N`), capped at 100 extra dice.
- `rN` / `r<N` / `r>N`: reroll while the die matches (cap 100); `roN`: reroll once.
- `>N` / `<N`: count successes instead of summing; `fN` / `f<N` counts failures.

The result is `{ expr, total, terms }`: each dice term lists every die `{value, dropped?, exploded?, rerolled?, success?, failure?}`. The limits are at most 1000 dice per roll and expressions of 200 characters; beyond them the roll fails with a readable error. The RNG is passed in, so tests can use a fixed sequence and the server uses `crypto.randomInt`.

## Storage

- **Database:** a separate SQLite file, `${DELVE_DATA}/table.db`, via `node:sqlite` as `store.ts` does.
  - `games(id, name, created, rev, state JSON)`: the whole game state, written after each change (debounced about 300 ms, and always on shutdown).
  - `chat(game_id, seq, at, json)`: the message log (the last 200 go into `hello`).
- **Uploaded images:** `${DELVE_DATA}/table-assets/<sha256>.<ext>`. Accepted: PNG, JPEG, WebP or GIF (checked by magic bytes), at most 10 MB, by the GM. They are served to members only at `/api/v1/games/:id/assets/<sha>.<ext>`.

## REST (all under `/api/v1`)

| Route | Who | Does |
|---|---|---|
| `GET /games` | GM | List games `{id, name, created, players}` |
| `POST /games {name}` | GM | New game with one empty page; returns `{id}` |
| `DELETE /games/:id` | GM | Delete the game and its chat |
| `POST /games/:id/invites {name?, hours?}` | GM | `{url, expires}` |
| `GET /play/join/:token` (page) | anyone | The name form, then creates the member and sets the cookie |
| `POST /games/:id/pages/from-map {mapId}` | GM | New page from a Delve map: background `{kind:'delve', mapId}`, with size and origin in cells from the map's players-view render bounds, and walls from `computeWalls` (kept for phase 3) |
| `POST /games/:id/assets` (raw body) | GM | Upload an image, returns `{url}` |
| `GET /games/:id/assets/:file` | members | The image |
| `GET /games/:id/live` (WebSocket) | members | The sync channel |

Pages from Delve maps draw their background from `/api/v1/maps/:mapId/render.png?view=players&ppg=70&fog=1&grid=0`. Page coordinates are in cells with the same origin as the Delve map, so Delve's walls and rooms line up with tokens. `page.origin` is the render's top-left cell (`scene.bounds.x0/y0`).

## Client (`/play/:gameId`)

- **The table:** a full-window PixiJS canvas.
  - Pan by dragging empty space or with the middle button; the wheel zooms at the cursor.
  - Draw order: background, then map-layer tokens, grid lines (optional), tokens, gm layer (GM only, drawn at 50% opacity), and pings.
  - Click selects a token (an outline shows); Shift-click adds to the selection. Dragging moves it, snapped to cell corners by its size (Alt moves freely).
  - Delete removes tokens (GM). Double-click opens the token's settings. Holding still for 600 ms pings.
- **Sidebar tabs:**
  - Chat: roll cards with a hover breakdown, and input history on ↑.
  - Turn order.
  - For the GM:
    - Pages: switch, "move players here", new page from a Delve map, rename, delete.
    - Tokens: upload an image, add it to the page, pick a Delve prop as a token.
    - Players: invite link, member list, remove.
- **Theming:** use Delve's viewer tokens (dark and light). Everything works with mouse and touch (pointer events).
- **Shared:** `apps/server/src/table/page.ts` exports `tablePage(opts: { gameId: string; gameName: string; version: string; me: { id: string; name: string; role: 'gm' | 'player' } }): string`.
