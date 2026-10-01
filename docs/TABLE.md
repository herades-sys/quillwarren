# Delve Table: the private virtual tabletop (phase 1, "the basics")

The plan this follows is the user's doc "Roll20 Feature Map & Private Build Plan"
(claude.ai/artifact/VW21vTRu8ffAZYRiHbeVRN). Phase 1 builds what every later
feature sits on: realtime sync, permissions, and a table you can play a session on.

Delve Table lives inside the Delve monorepo and runs in the same server
process, so a Delve map becomes a playable page directly, and it uses the same
login, database directory and release pipeline.

## Scope of phase 1

- **Games** with one GM, who is Delve's editor login, and players who join through invite links. Players need no account or password; they may log in with Discord (see "Discord login").
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
- **Discord login (optional):** players can log in with Discord instead, so their seat follows them to other devices. Co-GMs listed in `DELVE_GM_DISCORD_IDS` are GM of every game. See "Discord login" below.
- **Who a request is**, in this order: a valid player cookie for the game, then a seat linked to the request's Discord login, then the GM (editor login, API token, or a co-GM's Discord login).
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
  - the invite list and the member list's internal fields;
  - every member's `accountId` (for everyone, the GM included: it never leaves the server).
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
  - `seats(game_id, member_id, nonce)`: what player cookies are signed against.
  - `accounts(id, discord_id, username, name, avatar, avatar_file, created, seen)` and `account_sessions(token_hash, account_id, created, expires)`: Discord logins (see below).
- **Uploaded images:** `${DELVE_DATA}/table-assets/<sha256>.<ext>`. Accepted: PNG, JPEG, WebP or GIF (checked by magic bytes), at most 10 MB, by the GM. They are served to members only at `/api/v1/games/:id/assets/<sha>.<ext>`.

## REST (all under `/api/v1`)

| Route | Who | Does |
|---|---|---|
| `GET /games` | GM | List games `{id, name, created, players}` |
| `POST /games {name}` | GM | New game with one empty page; returns `{id}` |
| `PATCH /games/:id {requireDiscord}` | GM | Game settings: `requireDiscord: true` makes invites Discord-only (409 without Discord login set up). Returns `{requireDiscord}` |
| `DELETE /games/:id` | GM | Delete the game and its chat |
| `POST /games/:id/invites {name?, hours?}` | GM | `{url, expires}` |
| `GET /play/join/:token` (page) | anyone | The name form, then creates the member and sets the cookie |
| `POST /games/:id/pages/from-map {mapId}` | GM | New page from a Delve map: background `{kind:'delve', mapId}`, with size and origin in cells from the map's players-view render bounds, and walls from `computeWalls` (kept for phase 3) |
| `POST /games/:id/assets` (raw body) | GM | Upload an image, returns `{url}` |
| `GET /games/:id/assets/:file` | members | The image |
| `GET /games/:id/live` (WebSocket) | members | The sync channel |
| `GET /games/:id/pages/:pageId/background.png?view=players\|gm` | members | A Delve page's picture in the page's frame (players: their own page, players' view with fog) |
| `GET /games/:id/pages/:pageId/scene3d.json?view=players\|gm` | members | The 3D view's scene, filtered for the viewer (see "3D table view") |
| `GET /play/:id/3d` (page, not under `/api/v1`) | members | The table in 3D |
| `GET /auth/discord?next=` (page, not under `/api/v1`) | anyone | Start a Discord login; afterwards back to `next` |
| `GET /auth/discord/callback` (page) | Discord | The end of the login |
| `POST /auth/logout {next?}` (page) | anyone | End the Discord login on this device (`GET` shows a button for it) |

Pages from Delve maps draw their background from `/api/v1/maps/:mapId/render.png?view=players&ppg=70&fog=1&grid=0`. Page coordinates are in cells with the same origin as the Delve map, so Delve's walls and rooms line up with tokens. `page.origin` is the render's top-left cell (`scene.bounds.x0/y0`).

## Discord login

Players can log in with Discord, so their seat is tied to their Discord account instead of one browser: a second device (or a cleared browser) needs no new invite. The Delve map editor keeps its own password login.

- **Turning it on:** set `DELVE_DISCORD_CLIENT_ID` and `DELVE_DISCORD_CLIENT_SECRET` (from the Discord developer portal, in `/etc/delve/delve.env`). Without both, nothing changes and no Discord button shows anywhere.
- **Optional settings:**
  - `DELVE_PUBLIC_URL` (e.g. `https://table.example`): the base of the redirect URI, `<DELVE_PUBLIC_URL>/auth/discord/callback`. Without it, the address the browser used (`http://<host>/auth/discord/callback`). With it, a login started on another address first moves over to the public one, so the login cookie lands where Discord sends the browser back.
  - `DELVE_GM_DISCORD_IDS`: comma-separated Discord user ids who are co-GMs: they see the lobby with every game and are GM (member `gm`) in all of them.
  - `DELVE_DISCORD_API` (default `https://discord.com/api`) and `DELVE_DISCORD_CDN` (default `https://cdn.discordapp.com`): for tests and dev servers with a fake Discord. With a custom API, the consent page is `<api>/oauth2/authorize` too.
- **The flow** (OAuth2 authorization code, scope `identify` only):
  1. `GET /auth/discord?next=<path>` makes a random state and keeps it, with `next`, the redirect URI and a 10-minute expiry, in the signed cookie `delve_discord_state` (HttpOnly, SameSite=Lax, Path=/auth/discord). Then it sends the browser to Discord (`prompt=none`: someone who agreed before isn't asked again).
  2. `GET /auth/discord/callback?code&state` checks the state against the cookie (constant-time, unexpired, each state once), posts the code to `<api>/oauth2/token`, reads `<api>/users/@me` with the token, and forgets the token. Discord calls time out after 10 s.
  3. It keeps the user's id, username, display name (`global_name`, else the username) and avatar hash, and fetches the avatar once per change into the table assets. Then it sets `delve_account` (a random token, 30 days, HttpOnly, SameSite=Lax, Path=/, Secure on https; only its SHA-256 is stored) and goes to `next` (only a path on this site: one leading `/`, no `//` or `\`; otherwise `/play`).
  - Declined consent, a stale state and Discord errors get friendly pages with "Try again".
  - The code, tokens, the secret and cookies are never logged (`code=` and `state=` are masked in logged URLs).
- **Seats:**
  - A logged-in player who joins through an invite gets a seat linked to their account (the name starts as their Discord name and can be changed). That seat needs no player cookie: on any device where they're logged in, `/play/:id`, the WebSocket and the images let them in.
  - If the account already has a seat in that game, the invite link goes straight to the table.
  - `/play` lists "Your games" for the login.
  - The member's `avatar` is the stored picture's game asset URL (`/api/v1/games/:id/assets/<sha>.png`), never Discord's CDN, whose URLs contain the Discord user id. Members carry `accountId` on the server only; views never include it.
  - Removing the member ends the seat on every device. Logging out (`POST /auth/logout`) deletes the session on the server.
- **Discord-only invites:** the GM ticks "Players must log in with Discord" in the Players tab (`PATCH /api/v1/games/:id {requireDiscord}`). The invite page then shows only the Discord button, and name-only joins get 403. Players already at the table stay.
- **Adding the public address later:** in the Discord developer portal, under OAuth2 → Redirects, add `https://<public host>/auth/discord/callback` next to `http://192.168.1.9:8790/auth/discord/callback`. Then either set `DELVE_PUBLIC_URL=https://<public host>`, so every login goes through the public address, or leave it unset, so each address uses its own callback (both must be registered). Behind a TLS proxy (Fastify then sees plain http), set `DELVE_PUBLIC_URL`, so the Discord login's cookies still get `Secure`.

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
    - Players: invite link, member list, remove, and (with Discord login set up) "Players must log in with Discord".
  - Members show their Discord picture (when they have one) in the member list and on their chat lines, else their colour dot.
- **3D dice:** every roll a member can see (`/r`, a GM roll's full copy, inline `[[…]]`) is also thrown as three.js dice over the board, in the roller's colour. The roll card stays the source of truth.
  - `apps/web/src/table/dice.ts` (in table.js) holds the "3D dice" switch under the chat (per browser, in localStorage `delve-table-dice3d`; off by default with `prefers-reduced-motion`). On the first roll with the switch on, it imports `/assets/table-dice.js` (three.js + cannon-es 0.20.0, `apps/web/src/table-dice.ts`). Switched off, nothing loads.
  - How a throw shows the server's values: `dice3d-sim.ts` simulates it first (cannon-es, fixed 1/60 s steps, seeded from the message id and time), then `dice3d-logic.ts` reads the face on top of each die and swaps labels so that face carries the rolled value (the opposite face is swapped too, so opposite faces still add up). The overlay (`dice3d.ts`) then replays the recorded motion.
  - d4, d6, d8, d10, d12, d20, d100 (a tens and a units d10) and dF; other sizes get no die. At most 20 dice, then "+N more dice". Dropped dice dim once they land; rerolled ones aren't thrown. Dice rest about 2.5 s, then fade; throws may overlap.
  - Nothing is thrown for a GM roll's hidden copy (it has no rolls), for the backlog in a `hello`, or while the tab is hidden.
  - With a Discord login, the header says "Logged in as <name> · Log out".
- **Theming:** use Delve's viewer tokens (dark and light). Everything works with mouse and touch (pointer events).
- The header's **3D** button opens the same game in 3D (`/play/:gameId/3d`, see below).

## 3D table view (`/play/:gameId/3d`)

The same live game as the 2D table, for the GM and the players, with the page as a model on the table and the tokens as minis. A move in 3D shows on everyone's 2D table at once, and the other way round. The **2D** button goes back.

- **Access:** exactly as `/play/:gameId` (the GM's editor login or co-GM Discord login, a member's player cookie or Discord seat); everyone else gets the same "Not at this table" page. Public mode lets `/play/*` and `/api/v1/games/*` through, so the game's own member check is what keeps both routes closed (tested through the tunnel headers).
- **Code:** server `apps/server/src/table/scene3d.ts` (routes, `revealedRegion`, `delveGeometry`, `scene3d`) and `page3d.ts` (the HTML); client `apps/web/src/table3d.ts` (entry, bundled as `/assets/table3d.js` with three.js, so the 2D table never loads it) and `apps/web/src/table/{app3d,view3d,minis3d,textures3d,scene3d-logic}.ts`. The scene's types are `Scene3D` in `packages/table/src/scene3d.ts`.
- **Same sync code:** the 3D page opens the same WebSocket (`net.ts`), keeps its view with the same `reduce`, optimistic moves and `needsReload` (`logic.ts`), and sends the same intents (`token.move`, `page.view`, `page.activate`). The server can't tell the two apart.

### The scene: `GET /api/v1/games/:id/pages/:pageId/scene3d.json`

- **Who:** members only, by the same page rules as `background.png`: players only the page they're on (any other page id, existing or not, is 403) and always the players' view; the GM may ask for `view=gm` (the default is `players`, as for `background.png`).
- **What:** `{ pageId, view, kind, bounds, floor, walls, doors, stairs, region, focus }` in page cells:
  - Delve pages: `floor` is the members-only `background.png?view=…` URL (the players' one draws only what they've seen); `walls` are segments built the way the 2D picture is (same rough floor, door gaps); `doors` `{a, b, style, open?}`; `stairs` `{box, direction}`.
  - Picture pages: `floor` is the picture and the cells it covers. Blank pages: `floor` is null (the client draws a grid plane).
  - `region` is `'all'` or the polygons the viewer may see; `focus` is what the camera frames first (the page, or the seen part; null when nothing is seen yet).
- **Filtering (server-side, one place):** `revealedRegion(state, page, map, {member, view})` decides what a viewer may see: `'all'` for the GM's own view; the Delve map's fog (revealed rooms and corridors, `show` minus `hide`, the same area the players' picture uses) for players and for the GM looking as them; `'all'` without fog. `delveGeometry` then cuts walls to that region and leaves out doors and stairs outside it, so nothing outside it is sent. Players never get secret doors (they're plain wall: no gap, a wall across), gm-layer tokens (the WebSocket's `viewFor` already strips them) or labels. The state the players get still has no `page.walls`.
- **Following the map:** a page from a Delve map is sent again (`page.upsert`) when the map changes, and the 3D view fetches its scene and picture again, so a revealed room appears in 3D within a second.

### In the browser

- **The model:** the page is a board on the table (`--slab`), the floor picture on top, grid lines when the page shows its grid, walls extruded from the segments (height slider in the View tab, 0 to 2.5 cells, default 0.9), doors as frames with a leaf (shut, or swung open; two for double doors, iron bars for a portcullis, nothing in an archway; the GM sees secret doors as a translucent violet leaf), stairs as steps rising toward their direction.
- **Light:** a hemisphere light plus a sun from the north-west with soft shadows (switch: View tab). Background and board follow the light and dark theme.
- **Camera:** drag to orbit, right-drag or Shift-drag to pan over the table, wheel or pinch to zoom (to the cursor). **Top** looks straight down, **Fit** frames the page (players: what they've seen), **Follow** keeps the selected mini in the middle (or the member's own when nothing is selected; selecting another mini follows that one). Double-click a mini to look at it. Keys: F fit, T top, L follow, arrows move the selected minis, Escape clears the selection. Switching away from a page and back returns to where its camera was (until the page reloads).
- **Minis:** every token is a standee: its picture on an upright card that turns to face the camera, on a round base in the controlling member's colour (light stone for "all", dark stone for GM-only), sized by `w`/`h` (an ellipse for tokens that aren't square). **Flat** lays them down as discs seen from above; looking nearly straight down does that by itself. Map-layer tokens always lie flat on the floor and never catch the pointer. Name plates and bars are HTML over the canvas, as on the 2D table (names with `showName`, hovered or selected; bars when the mini is at least 14 px wide). The GM sees gm-layer tokens translucent.
- **Moving:** drag a mini over the floor. It snaps to cells like the 2D board (`dragTargets`; Alt moves freely), the selection moves together, it's shown at once and snaps back if the server refuses. Players can only grab the minis they control (`canMove`); the server checks anyway. Holding still on the floor for 600 ms pings.
- **Pages:** players follow the page the GM moves them to (a fresh `hello` loads its scene). The GM gets a page picker (★ marks the players' page; it sends `page.view`, so the GM's 2D tab follows too), "Bring them here" when the players are elsewhere, and the **GM view / Players' view** toggle: it fetches the players' scene and hides gm-layer tokens, so the GM sees exactly what the players get. It isn't remembered across loads, like the 2D one.
- **Side panel:** a **Minis** tab (every mini on the page; select, look at, follow) and a **View** tab (walls, flat, shadows; kept per browser in `localStorage` `delve-table3d-*`). On phones it's a bottom sheet, and the camera buttons move above it.
- **No token tools in 3D:** the GM adds characters on the 2D table (Tokens tab); they appear in 3D at once.

### For the next steps (line of sight, notes, Discord)

- **Line of sight and light:** replace the body of `revealedRegion()`; the scene's walls, doors and stairs for players follow it. The floor picture still comes from `background.png`, which follows the map's fog, so an explored-by-sight area also needs its picture masked (or an overlay). The client's `view.lights.setSources([{id, x, y, height?, color?, intensity?, range?, castShadow?}])` places point lights (at most 12, nearest to the view), and `view.lights.setAmbient(0..1)` dims the sun and sky for dark dungeons. `view.overlays.set(name, mesh)` / `view.overlays.polygons(polys, color, opacity)` is the layer just over the floor for darkness or explored areas; `Scene3D.region` carries the seen polygons. Today tokens on the tokens layer are visible to players anywhere on their page (as in 2D), even in unrevealed rooms.
- **Notes:** `startTable3d()` returns a `Table3dCtx` (`state`, `page`, `tokens`, `scene`, `selected`, `act`, `on`, `view`); `ctx.addPanel(id, label)` adds a tab to the side panel and returns its empty panel.
- **Shared:** `apps/server/src/table/page.ts` exports `tablePage(opts: { gameId: string; gameName: string; version: string; me: { id: string; name: string; role: 'gm' | 'player' } }): string`.
