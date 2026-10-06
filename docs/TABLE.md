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
- **Out of scope for phase 1:** measuring, drawing, character sheets, handouts, jukebox, voice, scripts. They come in later phases. Line of sight, light and explored fog came later: see "Vision and light".

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
  - A player can't change `layer`, `controlledBy`, `gmNotes`, images, `light` or `sight`, and can't open doors.
- **`viewFor(state, member)`** / **`eventFor(state, member, event)`** strip what the member may not see before anything is sent:
  - `gm`-layer tokens and every token's `gmNotes` (a change of nothing but `gmNotes` sends players nothing at all: the event carries the routing flag `gmOnly`);
  - the GM's notes: the session notebook and room notes (see "GM notes");
  - on a dynamic-vision page, tokens the party doesn't see, and other players' tokens' `sight` and `light` (see "Vision and light");
  - a page's `walls`, `doors`, `doorState` and `lights`;
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

## Vision and light

Roll20-style dynamic lighting: what the players' characters see is revealed, walls and shut doors block sight, torches and lanterns light areas, and what has been seen stays explored (dimmed). The server decides everything; players are never sent what their party can't see.

### The model

- **Per page:** `page.vision = { mode: 'off' | 'dynamic', ambient?: 'dark' | 'dim' | 'bright' }`.
  - `off` (the default, also when `vision` is unset): exactly as before, the Delve map's own room fog.
  - `dynamic`: line of sight decides, and the map's room fog is ignored. Allowed on Delve pages and blank pages; not on picture pages, whose uploaded image goes to the players whole (`page.update` refuses it).
  - `ambient` (default `dark`): `bright` everything is lit; `dim` everything is lit but dimmed (only bright lights, and darkvision, count as bright); `dark` only lights and darkvision show anything.
- **Blockers** (`blockersOf`): `page.walls` plus every shut door.
  - `page.walls` come from the Delve map as the players see it: secret doors are in them as wall, and rough maps use the rough edge as drawn (core `drawnFloor`).
  - `page.doors` (`{id, a, b, style, open?}`) are the map's doors. A door is open by `page.doorState[id]` (the table's own state, which wins), else by the map's `open`. Shut doors block; a portcullis is bars you see through; an archway is always open; a secret door blocks like wall until the GM opens it.
  - Doors at any angle (a door's `angle`, docs/API.md "Doors") block exactly their line `a`–`b`: the wall they sit in is cut along them, with a jamb from the wall to the door's end where a curve or cave wall bows away from it, so no ray slips past a door's end. A turned secret door leaves its wall whole for players (no chord beside a curve). The GM clicks them on the board along their line, as any door.
  - **Door state is table state, not map state:** the GM clicks a door on the 2D board (dynamic pages only) to open or shut it (intent `door.set {pageId, id, open}`, GM only). The Delve map stays as it is. Players don't open doors yet.
- **Lights:**
  - Tokens: `token.light = { bright, dim }` in cells: bright out to `bright`, then dim for `dim` cells more (a torch is 4 and 4). Tokens on every layer give light, the gm layer too (an invisible lamp).
  - Map props become `page.lights` (`{id, x, y, bright, dim, asset}`) by `PROP_LIGHTS` in `packages/table/src/sight.ts`: sconce, brazier and campfire 4/4, lantern and chandelier 6/6, fireplace, cooking fire and forge 3/3, candles and oven 1/1, and the GM's light marker (a GM symbol, never drawn for players) 6/6. A light whose spot is on the wall line (a sconce hung on it) moves onto the floor.
  - Pages from a Delve map follow it: when the map changes, the page takes its new walls, doors and lights (a `page.update`); otherwise only the picture reloads, as before.
- **Sight:** `token.sight = { enabled?, range?, darkvision? }` (cells). Unset `enabled`: a token sees when a player controls it (`controlledBy` has a player or `"all"`). Never on the gm layer.
  - What a token sees = (its visibility polygon among the blockers, cut to `range`) ∩ (lit ∪ its darkvision circle). Under a `bright` or `dim` ambient everything in its visibility polygon is lit.
  - **Party vision is shared:** players get the union of what every seeing token on the page sees. Per-player vision (each player sees only through their own tokens) is a later option.
- **Explored fog:** per page, everything the party has seen, stored in `table.db` (table `explored`, one row per page with a version). It grows when sight changes, by more than a sliver.
- **When it is recomputed:** after any change to a dynamic page's tokens, walls, doors, lights or settings, at most every 120 ms per page, and always once more after the last change (so the final position counts). Visibility polygons are cached per position, so a map's lights cost nothing while tokens move.
- **Light and sight are the GM's:** the token dialog has fields for both (GM only), and the rules refuse `light` and `sight` from players, even on their own tokens.

### The geometry (`packages/table/src/vision.ts`)

- `visibilityPolygon(origin, segments, box)`: rays to every wall end and ± 1e-5 rad either side, each stopping at the nearest wall; walls are sorted into 512 angular buckets so a ray only tests the walls in its direction. A ray through a shared corner hits both walls (no crack), a wall seen edge-on hides nothing, and a viewer standing exactly on a wall is moved 1e-4 off it so it sees one side.
- `circle`, `union`, `intersect`, `difference`, `inflate`, `simplify` (clipper2-ts, 4 decimals), `pointIn`, `rectSamples`.
- **Drawn walls at the edge:** a visibility polygon stops on the wall line, so what clients get (`visible`) and what the picture is cut to also include the strips of the walls and shut doors right at its edge (0.15 cells each side: the far half of the wall stroke, a door leaf). The exact polygon (`raw`) never leaves the server; it decides the tokens.
- 300 walls × 6 viewers with the union take about 7 ms on the container; a full recompute of the test dungeon with 6 torch-bearers in the dark about 4 ms (1 ms when one moved); 719 rough-cave walls × 6 viewers 16 ms.

### What is sent to whom (server only: `apps/server/src/table/vision.ts` and `live.ts`)

- **Tokens:** on a dynamic page a player gets their own tokens, the party's seeing tokens, tokens-layer tokens while their footprint is in sight (sample points 0.2 cells inside its edges, so touching the edge of sight, or poking past a wall, doesn't count), and map-layer tokens (scenery) once their spot is explored. Never the gm layer.
  - Each player connection remembers which tokens of its page it holds. A token that comes into view arrives as a `token.upsert`, one that leaves goes as a `token.remove`, and changes of tokens it can't see (moves, bars, names, a new token in the dark, deleting one it never had) send it nothing at all.
  - Other players' tokens arrive without `sight` and `light`; GM notes never.
  - The turn order shows tokens the player may not see as "Hidden", without their token id; when one comes into view, a fresh `turn` follows.
- **Vision messages:** after the `hello` on a dynamic page and whenever it changes, each member gets `{type: 'vision', pageId, vision: {visible, bright, explored?, exploredVersion, ambient, seen?}}` (polygons in cells, `VisionView` in `protocol.ts`). `explored` (polygons or `"all"`) comes only when its version moved; `seen` (the token ids the party sees) only to the GM. A page without dynamic vision gets no vision messages.
- **Page data:** players' pages never carry `walls`, `doors`, `doorState` or `lights` (they outline the whole map); they do carry `vision` (mode and ambient).
- **The picture:** `background.png` for players (and for the GM's "see as players") on a dynamic page is the players' view with the table's doors (an opened secret door is drawn as an open door), cut to the explored fog with everything else black: core `RenderOptions.reveal`, one SVG clipPath around every layer, so the PNG has no pixel of what wasn't seen (the SVG never leaves the server). The GM's own view is the whole map with the table's doors. The picture holds only what the page shows (core `cropScene`): on a page a square or two thin, resvg used to panic on height tones and stairs a few squares off it, which killed the server (docs/API.md, "resvg's layer limit"). Pictures are cached per map rev, door state and explored version, and rendered in resvg's thread pool unless the map has uploaded pictures or the picture needs a bigger canvas (png.ts `svgToPngAsync`). Clients fetch the picture again when the explored version moves, at most about once a second.
- **Switching** a page between off and dynamic gives its players (and the GM looking at it) a fresh `hello`.
- **The 3D view:** `exploredRegion(hub.vision, state, page, {member, view})` in `vision.ts` returns `'all'` (the GM's own view, or a fully revealed page), the explored polygons (a player on their page, or the GM looking as the players), or `null` for a page without dynamic vision (then the map's room fog applies). Lights for a player's 3D view should be only the ones inside what they see.

### GM tools

- **Pages tab**, per Delve or blank page: "Vision: room fog / line of sight", the ambient, and for the explored fog (intent `vision.explored {pageId, action}`, GM only):
  - **Forget explored** (`reset`): the history goes; what the party sees right now stays.
  - **Reveal all** (`reveal`): the whole page counts as explored (tokens still show only while in sight).
  - **Hide everything** (`hide`): nothing is explored or seen until anything on the page next changes (a token moves, a door turns).
- **The board** (dynamic pages): a faint shade over what the party doesn't see, the lights with their bright and dim radii, and the doors (green open, orange shut, purple secret; click to open or shut). The "GM view / Players' view" button shows the players' darkness, picture and tokens exactly.
- **The token dialog:** sight (default, sees, sees nothing), range, darkvision, bright and dim light, and presets (torch, lantern, candle, no light).

### The players' board

Black where the party has never looked, dimmed (55 %) where it looked before, a light veil where only dim light or darkvision reaches, clear in bright light. It is painted on a small canvas (up to 16 px per cell) stretched over the page, which softens its edges. Until the first vision message arrives a dynamic page is all black.

## Heights and movement

A Delve map's height areas (docs/API.md, "Heights within a map": ledges, hills, pits, plateaus) come to the table with its page.

- **The picture:** the page shows the edges (ledge lines, rock faces, slopes) in both views; the height labels only in the GM's.
- **"Respect heights"** (a page option, `page.respectHeights`, **off by default**: it changes play, so the GM turns it on with "Moves: free / Moves: respect heights" in the Pages tab, Delve pages only):
  - A player's token move (`token.move`, or `token.update` with `x` / `y`) that crosses a cliff or rock edge where no stairs or ladder cross it is refused by the server in `can()` (`packages/table/src/movement.ts`), with the reason: "That move goes over a cliff edge (a 10 ft drop): take the stairs or a ladder, or ask the GM". The client puts the token back and shows it.
  - With the option on, walls and shut doors hold moves back too ("That move goes through a wall" / "…a shut door"): the page's `walls` (secret doors shut until the GM opens one) and its doors as the table has them (`doorState`, then the map's `open`); a shut portcullis blocks a move though not sight; archways never block. With the option off, walls are not enforced for moves (as before).
  - The GM is never held back.
  - A move is checked as the straight line from the token's centre to where its centre lands, like dragging it there: a player goes round a corner in two moves, and landing on an edge counts as crossing it. Bigger tokens are checked by their centre too.
  - Slopes and steps are walked over. Hidden height areas aren't enforced (refusing a move would give them away).
- **Page data:** `page.cliffs: [{ a: [x, y], b: [x, y], drop }]` in cells, the blocking edge pieces (core `blockingEdges`), GM only like `walls` and `doors` (`pageForPlayer` strips them). They follow the map like the walls (`followMap`). `respectHeights` reaches players too (it is no secret).
- **Where you can go, for the GM:** the top bar's **Heights** button (or **K**) on a Delve page with height areas, in the GM view: the same overlay as the editor's Shift K, drawn from the page's map (`apps/web/src/table/movement-view.ts`): ground tinted by height, red dashes on edges nobody can walk over, green crossings. Kept per browser like the editor's.
- **Line of sight:** cliffs don't block sight, and height doesn't change it: a token on a ledge sees what it would see on the floor (walls and shut doors still block). Seeing over low obstacles from higher ground is not modelled.
- **3D** (`/play/:id/3d`): `scene3d.json` carries `heights` (core `heightScene`, in cells: the draped ground as `pieces`, flat or with a grid of heights where hills and ramps vary, `base` the rest of the page at 0, the plan's `bands` and `edges`, the rock tone), cut to what the viewer may see: the pieces are cut to the region and grid posts beyond it are blanked; hidden areas never reach players. The board drapes the floor picture over the ground (hills rounded, ramps, plateaus) with rock faces where it drops sheer (docs/API.md, "Heights within a map", 3D). Walls and doors stand on the ground beside them; stairs climb from the ground at their foot to the ground at their head; minis stand on the ground under their centre. Picking, dragging, pings and holding still to ping use the ground's height (a ray marched down to it: `surfaceHit` in `heights3d-logic.ts`), and so do Follow, looking at a mini or a spot, and the note pins (`project`). The grid lines and overlays (the dimmed seen-before areas) are laid over the ground, broken at sheer drops.

## Storage

- **Database:** a separate SQLite file, `${DELVE_DATA}/table.db`, via `node:sqlite` as `store.ts` does.
  - `games(id, name, created, rev, state JSON)`: the whole game state, written after each change (debounced about 300 ms, and always on shutdown).
  - `chat(game_id, seq, at, json)`: the message log (the last 200 go into `hello`).
  - `seats(game_id, member_id, nonce)`: what player cookies are signed against.
  - `explored(game_id, page_id, version, data)`: a dynamic-vision page's explored fog (`data` is `{polys}` or `{all: true}`), written with the game state's debounced flush.
  - `notebook(game_id, id, title, text, created, updated)`: the GM's session notebook (see "GM notes"), written at once, apart from the game state.
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
| `POST /games/:id/pages/from-map {mapId}` | GM | New page from a Delve map: background `{kind:'delve', mapId}`, with size and origin in cells from the map's players-view render bounds, plus `walls`, `doors` and `lights` for vision (see "Vision and light") |
| `GET /games/:id/pages/:pageId/background.png?view=` | members | A Delve page's picture in its exact frame. Players: their own page only, players' view. In dynamic vision it is cut to the explored fog, black elsewhere |
| `POST /games/:id/assets` (raw body) | GM | Upload an image, returns `{url}` |
| `GET /games/:id/assets/:file` | members | The image |
| `GET /games/:id/live` (WebSocket) | members | The sync channel |
| `GET /games/:id/pages/:pageId/background.png?view=players\|gm` | members | A Delve page's picture in the page's frame (players: their own page, players' view with fog) |
| `GET /games/:id/pages/:pageId/scene3d.json?view=players\|gm` | members | The 3D view's scene, filtered for the viewer (see "3D table view") |
| `GET /games/:id/notebook` | GM | The session notebook `{entries: [{id, title, text, created, updated}]}`, the latest change first (see "GM notes") |
| `POST /games/:id/notebook {title?, text?}` | GM | A new entry, `201 {entry}` |
| `PATCH /games/:id/notebook/:entryId {title?, text?}` | GM | Change an entry, `{entry}` |
| `DELETE /games/:id/notebook/:entryId` | GM | `204` |
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
    - Notes: room notes, notes on characters and NPCs, and the session notebook (see "GM notes"). The page banner has the Notes mode button, and rooms with notes a pin.
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
- **Side panel:** a **Minis** tab (every mini on the page; select, look at, follow), a **View** tab (walls, flat, shadows; kept per browser in `localStorage` `delve-table3d-*`) and, for the GM, a **Notes** tab (see "GM notes"). On phones it's a bottom sheet, and the camera buttons move above it.
- **No token tools in 3D:** the GM adds characters on the 2D table (Tokens tab); they appear in 3D at once.

### With dynamic vision (line of sight)

- On a page with `vision.mode: 'dynamic'`, `revealedRegion()` asks `exploredRegion()` (`apps/server/src/table/vision.ts`): players (and the GM's Players' view) get the walls, doors and stairs of what the party has explored, with the table's door state (`withTableDoors`), and the floor is `background.png`, which is cut to the same explored fog. Tokens the party doesn't see never reach players (the live hub filters them, as on the 2D table).
- The 3D client keeps the `vision` messages (`vision-view.ts` `mergeVision`): when the explored fog grows it fetches the scene again (at most about once a second), and it dims what the party saw before but doesn't see now (`darknessPolygons` on `view.overlays`). The GM's Players' view shows only the tokens the party sees (`previewTokens`).
- Not yet: point lights in 3D. `view.lights.setSources([{id, x, y, height?, color?, intensity?, range?, castShadow?}])` (at most 12) and `view.lights.setAmbient(0..1)` are ready; give players only lights inside `visible`, because map light positions would give away rooms nobody has seen.

### For the next steps (Discord)

- **Panels:** `startTable3d()` returns a `Table3dCtx` (`state`, `page`, `tokens`, `scene`, `selected`, `act`, `on`, `onMessage`, `seeAs`, `view`); `ctx.addPanel(id, label)` adds a tab to the side panel and returns its empty panel, `ctx.showPanel(id)` opens it, `ctx.onBanner(fn)` adds controls to the page banner. The view has `onFloorClick`, `project` and `onFrame` for HTML over the scene (the notes' pins use them).
- **Shared:** `apps/server/src/table/page.ts` exports `tablePage(opts: { gameId: string; gameName: string; version: string; me: { id: string; name: string; role: 'gm' | 'player' } }): string`.

## GM notes

Step 3 of the 3D GM view request: the GM keeps notes apart from the players, in three kinds. All of it is the GM's alone; players never load the code, and the server never sends them a byte of it.

### Notes on rooms, corridors and terrain (prep that travels with the map)

- **Where they live:** the Delve map's own `notes` field on rooms, corridors and terrain (docs/API.md, "GM notes"), so the editor, Claude (`describe_map`, MCP `update {"notes"}`) and every GM tab share them. Markers keep their `text`.
- **Never to players:** notes are never drawn, so no picture, 3D scene, players' screen or export has them, and players' pages carry no map id. The GM's client reads them from `GET /api/v1/maps/:id` (`apps/web/src/table/gm-map.ts`, shared with the GM markers) and writes them as map ops (`POST /api/v1/maps/:id/ops`, `by: "table"`) with the editor login. Without it (a co-GM through Discord) they are read only, with a note saying so; from the internet the map API needs the editor login anyway.
- **Which area a click picks** (core `noteAreasAt`): the rooms whose shape holds the point, the topmost (the last in the map) first, then corridors (path and width, butt ends, square corners), then terrain (minus its holes). The note box lists the others under the same spot ("Also here"), so a room inside a room, a pool in a hall, or a corridor mouth is one click away.
- **The pins:** a small note pin (`note-pins.ts`) sits beside the room number of every room with notes (corridors half way along, terrain in its middle), in the GM's own view only: never in the "Players' view". Zoomed far out they shrink. A click on a pin opens the notes.
- **On the 2D board** (`room-notes.ts`): the GM's note box, like the markers' one. Two ways in, so it never fights token selection:
  - click a pin;
  - **Notes mode** (the "Notes" button in the page banner, or N; Esc or N again stops): a click on a room's floor opens its notes. Tokens, markers and doors keep their clicks, and dragging still pans.
  - The box saves a moment (0.7 s) after typing stops and on leaving the field; blank notes are removed. On phones it sits at the bottom.
- **In 3D** (`notes3d.ts`): the **Notes** tab of the side panel. A click on a room's floor while the tab is showing (or on a pin, any time) opens that room's notes there; the banner's **Notes** button opens the tab. Clicking a room in the tab's list points the camera at it.
- **Map changes don't wake the players:** a change of nothing but notes (core `notesOnly`) sends no `page.upsert` (so no player picture or 3D scene is fetched again) and no players' screen `changed`; the GM's connections get `{type: 'map.notes', mapId}` instead and fetch the map for its notes (`TableHub.toGms`). Any other change in the same 0.8 s wait still follows the map as before.

### The session notebook (per game)

- **Entries** `{id, title, text, created, updated}` (`NotebookEntry` in `protocol.ts`; limits in `packages/table/src/notebook.ts`: title 120 characters on one line, blank becomes "Untitled"; text 100 000 characters, plain with line breaks; 500 entries per game). Stored in `table.db` (table `notebook`), deleted with the game.
- **Over REST, not intents** (`apps/server/src/table/notebook.ts`): the notebook isn't game state, so it isn't saved with every change of it, isn't in any `hello`, and has nothing to filter per member; a long session log is fetched once instead of on every reconnect. Only the GM may call it (`memberOf(...).role === 'gm'`: a player gets 403, the GM testing as a player too, anyone else 401; writes with the cookie need the page's own origin). After every write the GM's live connections get `{type: 'notebook', entry}` or `{type: 'notebook', removed}`, so another tab (the 3D view, a second screen) follows; players' connections never do. There are no notebook intents: a `notebook.*` intent is refused as unknown.
- **The tab** (2D sidebar and 3D panel, Notebook section): search (every word, title and text), New, open an entry to rename it or write, autosave while typing (0.8 s), "Insert time stamp" (`[Thu 1 Oct 21:04]` on a line of its own at the cursor), and Delete with a confirmation. The last open entry is remembered per browser. Typing is never overwritten by what another tab saves; the last save wins.

### Notes on characters and NPCs

- **The field:** the token's `gmNotes` (at most 5000 characters), as before never sent to players (`tokenForPlayer`). A change of nothing but `gmNotes` sends players nothing at all, not even a token update (`gmOnly` on the event; the live hub skips it for players before the dynamic-vision bookkeeping, so it can't take a token away from them either).
- **The tab's Characters section:** the selected token's (or mini's) notes, saved through `token.update` (so `can()` and the filters apply as for the token dialog, which edits them too), and a list of every token on the page with notes (click: select it, and look at it).

### Code

- Core: `packages/core/src/notes.ts` (picking, titles, pins' spots, `notesOnly`, `notesOps`), `describe.ts` (the "GM notes" section).
- Table package: `protocol.ts` (`NotebookEntry`, the `map.notes` and `notebook` messages, `gmOnly`), `notebook.ts`, `rules.ts` / `views.ts` (`gmOnly`).
- Server: `apps/server/src/table/notebook.ts` (REST), `store.ts` (table `notebook`), `live.ts` (`toGms`, `gmOnly`), `routes.ts` (notes-only map changes), `notes-css.ts` (both pages); `apps/server/src/service.ts` (`onChange` says `notesOnly`; screens aren't woken).
- Client: `apps/web/src/table/{gm-map,area-note,room-notes,note-pins,notes-panel,notes-logic,notes3d}.ts`; the editor's inspector has the GM notes box for rooms, corridors and terrain.
- Tests: `apps/server/test/notes.test.ts` (nothing reaches players: pictures byte for byte, 3D scenes, the live channel, the players' screen and its socket, `.ds`, handout; the notebook's access and GM-only messages; `gmNotes`), `packages/core/test/notes.test.ts`, `apps/web/test/notes-logic.test.ts`, `packages/table/test/views.test.ts`.
