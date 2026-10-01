# Delve API (v1)

Base URL on the LAN: `http://192.168.1.9:8790/api/v1`. Everything is JSON unless noted. Map and op formats are in [PLAN.md](PLAN.md#file-formats).

## Access

- **Reading needs no token** (LAN only). This covers maps, renders, the text summary, history and subscribing to live changes.
- **Every change needs the API token:** `Authorization: Bearer <token>`. On the WebSocket, use `?token=<token>`, because browsers can't set headers there.
- The live token is `DELVE_API_TOKEN` in `/etc/delve/delve.env` (root only). A server started without a token refuses all changes with `503`.
- Tokens in URLs are masked in the server log.

### Browser editor login: admin and GM accounts

The browser editor has two kinds of account, **admin** and **GM**. Both can edit maps, make REST and WebSocket changes, and are the GM at Delve Table. Only admins can open `/admin`. Every login needs a name, a password and a code from an authenticator app (TOTP), except for GM accounts the admin made **password only** (see below). The code lives in `apps/server/src/accounts/`, and the data in `${DELVE_DATA}/accounts.db` (in memory without `DELVE_DATA`).

**Getting started (bootstrap).**
- Until the first admin account exists, the old shared password works as before. `sudo delve-passwd` on the container sets it, and only its scrypt hash goes into `/etc/delve/delve.env`. `/login` then gives a signed 30-day cookie.
- An editor logged in that way sees "Secure your login: create your admin account" on the start page. It leads to `/account/setup`:
  1. Choose a name and a password (twice, at least 12 characters).
  2. Scan the QR code with an authenticator app. The key is also shown as text for typing in by hand.
  3. Type a code to confirm.
  4. Save the 10 recovery codes, which are shown once.
- From then on the shared password is switched off for good (a flag in `accounts.db`). Its cookies stop counting, and `/login` asks for name, password and code.

**Admin page `/admin` (admins only).**
- List the accounts, with their role, status and last login.
- **Add account:** a name and a role (GM or admin). This gives a one-time **setup link** (`/account/setup?token=…`), valid for 72 hours and shown only once. The admin passes it on, and the new person chooses their own password and sets up their authenticator with it. A new link replaces the old one.
- **Password only** (a checkbox when adding a GM): the account logs in with name and password alone, from home and through the tunnel alike. Its setup link only asks for the password (at least 12 characters), which finishes the setup and logs in. It has no recovery codes. Lockouts work as for every account. Admin accounts can't be password only, and a password-only account can't be made admin. The admin list tags these accounts "password only".
- **Reset login:** locks the account (password, authenticator, recovery codes and sessions all go) and makes a new setup link. The account keeps its mode. For accounts not yet set up, the same button just makes a new link.
- **Require authenticator** (password-only accounts): resets the login, and the new setup link asks for a password and an authenticator.
- Make admin / make GM, remove an account, and see and end sessions ("Log out everywhere" per account, or "Log out everyone except me").
- The last active admin can't be removed, demoted or reset. Admins can't remove, demote or reset themselves here (their own login is on `/account`).

**Account page `/account`.**
- Change your password (needs the current password and a code; your other devices are logged out).
- Make 10 new recovery codes (needs a code; the old ones stop working).
- Set up a new authenticator for a new phone (needs the password and a code or recovery code; the old one keeps working until the new one is confirmed).
- See where you are logged in and end those sessions.
- Password-only accounts change their password with the current one alone. Instead of recovery codes they get "Set up an authenticator" (needs the password), which turns the code on for good and gives 10 recovery codes.

**Codes.**
- TOTP per RFC 6238: HMAC-SHA1, 30-second steps, 6 digits, one step of clock drift either way.
- A code is refused if it (or an older one) was used already.
- The otpauth URI uses the issuer "Delve" and the account name.
- Each recovery code (`XXXX-XXXX-XXXX-XXXX`, 80 random bits) works once and is stored only as a hash.

**Sessions.**
- The cookie is `delve_session=a1.<token>` (HttpOnly, SameSite=Strict, and Secure over https or behind a proxy that sends `X-Forwarded-Proto: https`). The server keeps only a SHA-256 hash of the token.
- A session ends after 12 idle hours, and 30 days after login in any case.
- "Keep me logged in on this device" makes the cookie outlast the browser, and stretches the idle limit to 7 days.
- `/logout` ends the session on the server, so a copied cookie stops working too.
- Cookie writes must come from Delve's own origin (the same rule as before).

**Brute force.**
- After 5 failed logins within 15 minutes, the address and the account name are each locked for 15 minutes. Account names are locked whether or not they exist.
- Error messages don't say which part was wrong.
- Behind the Cloudflare tunnel the address is taken from `CF-Connecting-IP`.
- The same lockout covers the shared password during bootstrap, and password or code checks on `/account`.

**Secrets at rest.**
- Passwords are scrypt hashes.
- Authenticator secrets are sealed with AES-256-GCM, using a key derived from `DELVE_API_TOKEN` (stored plain on a server without a token).
- **Rotating the API token makes every stored authenticator unreadable.** Each person then logs in with a recovery code and uses "Set up a new authenticator" on `/account`.

**If nobody can log in any more** (every admin lost their phone and recovery codes):
- As root on the container, run `delve-passwd --reset-accounts`.
- It moves `accounts.db` aside as `accounts.db.reset-<time>` (maps and games are untouched), asks for a new shared password, and restarts Delve.
- Log in with that password and create a new admin account from the start page. GMs then need new setup links.

**Other endpoints.**
- **Session check:** `GET /api/v1/session` → `{ loggedIn, passwordSet }`. `passwordSet` is true when anyone can log in (an admin account exists, or the shared password is set).
- **Development only:** `DELVE_INSECURE_OPEN_EDIT=1` makes every browser count as logged in (as an editor, not as an admin). Never use it on the live server.

### Delve Table players: Discord login

- With `DELVE_DISCORD_CLIENT_ID` and `DELVE_DISCORD_CLIENT_SECRET` set, table players can log in with Discord (`/auth/discord`, scope `identify`). The cookie `delve_account` (30 days, HttpOnly, SameSite=Lax) then lets them into every game where their account has a seat: pages, the WebSocket and images, with no player cookie or new invite.
- Discord accounts listed in `DELVE_GM_DISCORD_IDS` are GM at the table (every game), with the same-origin rule for writes. They get no editor rights.
- The details are in [TABLE.md](TABLE.md#discord-login).

### From the internet (the Cloudflare tunnel)

`https://delve.example.com` reaches Delve through the tunnel "delve". cloudflared runs on the container (`cloudflared-delve.service`) and connects from loopback. Code: `apps/server/src/public.ts`.
- **How a tunnel request is recognised:** the host of `DELVE_PUBLIC_URL`, or Cloudflare's `CF-Connecting-IP` or `CF-Ray` header. Claiming either only ever takes rights away.
- **Home only:** `/mcp` answers 404 and the API token (`Authorization` or `?token=`) gets 403. The one exception is a GM's setup link, `/account/setup?token=`.
- **Open without a login:** `/play/*`, `/api/v1/games/*` (the table's own membership checks), `/auth/*`, `/login`, `/logout`, `/account/setup`, `/api/v1/session`, `/health`, and static files (`/assets/*`, `/fonts/*`, `/favicon.svg`).
  - **Everything else needs an editor login** (admin or GM account). Pages redirect to `/login?next=…`; the API answers 401.
  - **Players' map pictures** come from `GET /api/v1/games/:id/pages/:pageId/background.png?view=players|gm`. It is for members only: players get only their own page in the players' view, and only the GM may ask for `view=gm`.
  - **The 3D table** (`/play/:id/3d`) and its scene, `GET /api/v1/games/:id/pages/:pageId/scene3d.json?view=players|gm`, follow the same rules; the players' scene holds only the walls, doors and stairs they have seen (docs/TABLE.md, "3D table view").
- **Proxy headers:** Fastify trusts `X-Forwarded-*` from loopback only (`trustProxy`), so links and cookies are https. The login lockout uses `CF-Connecting-IP` only from loopback.
- **Live connections:** the map and table WebSockets check the login again for every change, so a login that ended (logout, "log out everywhere") can't keep writing.

## Errors

Errors come back as `{ "error": "…", "problems"?: ["…"], "rev"?: n }`.

| Status | When |
|---|---|
| 400 | Malformed ops, or a result that wouldn't validate. `problems` lists every issue, e.g. `c1 (objects[6]) width: must be greater than 0` |
| 401 / 503 | Missing or wrong token / no token configured |
| 404 | No such map (or segment) |
| 409 | `baseRev` is stale (`rev` holds the current one), the id is taken, or there's nothing to undo or redo |

## Maps

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/maps` | | `{ maps: [{ id, name, rev, objects, created, updated, level? }] }`, newest first |
| POST | `/maps` | `{ name?, style?, template?: "empty" \| "test-dungeon", by? }`, or `{ map: <full delve.map>, by? }` | `201 { id, rev: 1, map }` |
| GET | `/maps/:id` | | `{ id, rev, map }` |
| DELETE | `/maps/:id` | | `204`. A soft delete: the row stays in the database file, and the id can't be reused. The start page and the editor's map panel have Delete buttons |
| GET | `/maps/:id/levels` | | `{ levels: [{ id, name, level }] }`: this map's storeys, top first (just the map itself when it has none) |
| POST | `/maps/:id/levels` | `{ name, position?: "above" \| "below", currentName?, by? }` | `201 { id, rev, map }`: a new empty storey in the same group. The first time, this map joins the group as `currentName` (default "Ground floor"). The stairs are then numbered again (below) |
| POST | `/maps/:id/levels/label-stairs` | `{ by? }` | `{ storeys: [{ id, name, floor, stairs, changed, rev }], summary }`, top first: labels every stair of the map's storeys (a single map counts as floor 0). One undo step per map whose labels changed; maps already right are left alone |

**Storeys:** a place with several storeys is several maps that share `level: { group, name, order }` (higher `order` is further up). Each storey has its own undo history and exports as its own Roll20 page, and all of them share one grid, so stairs line up. The editor shows a storey picker at the top and the floor of the storey below as a dashed outline. Open viewers get `{ type: "levels" }` when a storey is added, deleted, renamed or renumbered.

**Floor numbers:** a storey's floor number is its `level.order`: 0 is ground level, -1 one floor below ground, -2 two below, 1 the first floor, 2 the second. `addLevel` numbers new storeys that way (below: lowest − 1, above: highest + 1). A map that isn't a storey is floor 0 and shows no number.
- The viewer shows the number as a big badge in the stage's top-left corner (with a real minus sign, "−1"), in both views. The storey picker reads "2 · Wizard's floor", "0 · Ground floor", "−1 · Cellar", top floor first.
- GM renders of a storey draw the number big and faded in the picture's top-left corner (layer `floor-number`). Not in the players' view, the handout, or the 3D view's transparent floor textures (`background=0`). `buildScene` option `floorNumber: false` leaves it out (the viewer does, because of its badge).
- Editor: the map panel's Storeys section has a "Floor number" field; it warns when another storey already has that number. MCP: `set_map floor`. `describe_map` says "Floor −1 (Cellar) of <group>".

**Stair labels:** every stair and every ladder, spiral stair or trapdoor prop (what `connectorsOf` counts) gets a GM label: the floor number, then a letter per flight, stored as `label` on the object (at most 8 characters, e.g. `"0A"`, `"-1C"`).
- Connectors that `stairLinks` joins across neighbouring storeys form one flight and share the letter; a connector that meets nothing is a flight of its own. Letters go by the flight's lowest floor, then top to bottom and left to right: a staircase from the ground to the 2nd floor is 0A, 1A, 2A, and a ladder from the 2nd to the 3rd floor then 2B, 3B.
- Set them with the editor's "Number the stairs" button (Storeys section, single maps too), MCP `label_stairs`, or the endpoint above; `addLevel` runs it too. Edit one by hand with the Label field of a stairs or ladder, or `update {"label": "…"}`.
- Drawn in the GM view only (layer `stair-labels`, kind `tags`): a small dark rounded tag, half a square tall, on the connector's centre. When some connectors on a map have a label, the others show "?". Never in the players' view, the handout or Dungeon Scrawl exports.
- Core: `floors.ts` (`stairLabels`, `stairLabelOps`, `stairTags`, `floorText`, `storeyTitle`); server: `stair-labels.ts`.

## Room shapes and solid cutouts

- **Shapes:** the Room (R) and Pillar (P) tools have a Shape choice: rectangle, circle, oval, triangle, hexagon, octagon or freehand. Drag a box to draw one; Shift keeps width and height equal (a circle always is). A ghost shows the exact shape while dragging.
  - Circles are `{circle}`; the others become `{poly}` with points rounded to 0.01 squares (an oval has 40 points, a hexagon has a flat top and bottom, a triangle points up).
  - Freehand: hold the button and draw the outline. On release it closes, is simplified (Douglas–Peucker, 0.15 squares) and snapped to quarter squares. Strokes with fewer than 3 distinct points or almost no area are dropped.
  - MCP `add_room`, `add_cutout` and `resize` take `preset: { kind: "oval" | "triangle" | "hexagon" | "octagon", box: [x, y, w, h] }` instead of `rect`, `poly` or `circle`.
  - Core: `geometry/draw.ts` (`shapeFromBox`, `shapeFromDrag`, `dragBox`, `freehandShape`).
- **Solid cutouts:** a cutout with `fill: "solid"` is drawn filled with the style's wall colour inside its wall outline: solid pillars, thick wall blocks, standing stones. It shows in every style and both views (layer `solid-cutouts`, after the floor, before the walls). Only the floor the cutout took away is filled, so a block reaching out of a room ends at the room's edge, and rough walls stay closed around it.
  - The default, `"rock"` (or no `fill`), looks as before: whatever lies around the dungeon (hatching, or a white hole in "clean").
  - Editor: the Pillar tool's Fill choice (like the rock / solid) and the Fill field of a selected cutout. MCP: `add_cutout fill`. Core: `geometry/solid.ts`.

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
- **Terrain** is `{ type: "terrain", asset, shape, holes? }`, drawn over the floor and under the grid, as a tint plus a repeating 2×2-square tile. `holes` are rings (`[[x, y], ...]`, 3 points or more) cut out of the shape: a forest filled around a dungeon leaves its rooms out this way. Moving the terrain moves its holes; fog of war and the editor's clicks ignore the holes' area.
- **Drawing order:** decals lie under the walls, props sit on top of walls and doors, and GM symbols come last. GM symbols appear in the GM view only.
- **Recolouring:** every style recolours the three asset inks (`props` in the style preset).
- **GM markers** are `{ type: "marker", kind: "discover" | "interact" | "trap", at, text, done? }`. They are notes pinned to a spot: "?" is something to discover, "!" something to interact with, and a skull a trap.
  - They are drawn last, in the GM view only. The players' view, the players' screen and the players' 3D view never contain them, and neither do Dungeon Scrawl exports. They don't change the picture's size.
  - On open floor a badge is 0.68 squares across. On a prop or uploaded picture it shrinks to at most 30% of that item's shorter side (never under 0.16 squares), so the item stays visible (core `markerRadius`; clicks use the same size).
  - In the viewer, clicking a marker opens its note in a small box, which editors can edit. Shift-click toggles `done`, which fades the badge and strikes it through, and strikes the note's text through.
  - The editor's Marker tool (M) places them at square centres (Alt for half squares) and opens the box for typing.
  - The SVG tags each badge `data-marker="<id>" data-kind="<kind>"`, plus `data-done` when done. Code: core `markers.ts`, web `markers.ts`.
- **Where the art comes from:** `delve-props-design-system/assets`. `npm run assets` rebuilds `packages/core/src/assets/catalog.json` and the full `manifest.json` from the batch generators' metadata, and reports files that are listed but missing. Every SVG goes through a whitelist (`parseAssetSvg`) before it reaches a page or a PNG.

## Uploaded images (your own pictures)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/images?name=` | the raw file, `image/*` or `application/octet-stream` (token or editor login) | `201 { src, url, width, height, name }`; the same bytes again give `200` and the same `src` |
| GET | `/images` | | `{ images: [{ src, url, name, width, height, bytes, uploaded }] }`, newest first |
| GET | `/images/:src` | | The file, public like maps: its real type, `nosniff`, cached for a year (the name is its hash) |
| DELETE | `/images/:src` | (token or editor login) | `204`, or `409 { error, maps: [{ id, name }] }` while a map still uses it |

- **Files:** PNG, JPEG, WebP or GIF, up to 10 MB and 12000 px a side (50 megapixels). The kind comes from the first bytes, never from the client, and the pixel size from the header. They are kept as `${DELVE_DATA}/images/<sha256>.<ext>` beside `index.json` (name, size, upload time). Code: server `images.ts`.
- **On a map:** `{ type: "image", src, at, w, h, rotation?, layer?: "floor" | "props", opacity?, gmOnly?, name?, notes? }`. `src` must match `<sha256>.<png|jpg|webp|gif>`. `at` is the centre, `w` × `h` are squares, and `rotation` turns it clockwise about its centre.
  - `layer: "props"` (the default) draws it over the props, walls and doors, under GM symbols. `"floor"` draws it right after the floor and terrain, under the grid and walls: rugs, painted floors, mosaics.
  - `gmOnly` pictures are left out of the players' view. With fog of war, players see only pictures whose centre they have seen, and the GM view dims the rest. Dungeon Scrawl exports leave pictures out.
  - The SVG draws each as `<image data-image="<id>" href="/api/v1/images/<src>" preserveAspectRatio="none">`. Server PNGs (renders, the 3D view's floors, the handout) load them from disk through resvg's `imagesToResolve`/`resolveImage` (`png.ts`). resvg can't read WebP, so a WebP picture is missing from server PNGs; the editor uploads WebP files as PNG for that reason.
- **Editor:** the Image tool (I) has an upload button (and takes a picture dropped on the map or pasted with Ctrl+V), the uploaded pictures to pick from, and a ghost that follows the pointer, snapped like a prop, with Q/E to turn. New pictures get their longer side 2 squares. A selected picture has width and height (keep proportions on by default), position, rotation, layer, opacity and GM only in the panel. Code: web `images.ts`.
- **MCP:** `list_images`, and `add_image` (`src`, `at`, `w?`, `h?`, `rotation?`, `layer?`, `opacity?`, `gm_only?`): with only one of `w`/`h` the other follows the picture's proportions, with neither the longer side is 2 squares.

## Segments (saved pieces of maps)

A segment is part of a map saved under a name ("rooms 1–5 as Temple of Efferd", "this patch as Mixed forest"), kept for all maps in `delve.db` (table `segments`). It can be placed again anywhere, turned, or tiled over an area.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/segments` | | `{ segments: [{ id, name, size: [w, h], counts: {room: 5, prop: 20…}, created, updated, source? }] }`, newest first |
| GET | `/segments/:id` | | `{ segment: { id, name, created, size, objects, counts } }` |
| POST | `/segments` | `{ name, map, ids?: string[], rect?: [x, y, w, h] }` (exactly one of `ids`, `rect`) | `201 { segment }`, collected from the map |
| PATCH | `/segments/:id` | `{ name }` | `{ segment }` (the summary) |
| DELETE | `/segments/:id` | | `204`. A soft delete, like maps. Copies already placed stay |
| POST | `/maps/:id/segments/place` | `{ segment, at: [x, y], rotation?: 0 \| 90 \| 180 \| 270, baseRev?, by? }` | `{ rev, ids, summary }`, one undo step |
| POST | `/maps/:id/segments/fill` | `{ segment, rect?: [x, y, w, h], around?: 5, margin?: 0.5, vary?: true, seed?, baseRev?, by? }` | `{ rev, ids, props, terrain, skipped, summary }`, one undo step (nothing is applied when nothing fits) |

Writes need the token or an editor login; reads are public like maps. `segment` may be an id or a segment's exact name (ignoring case).

- **Saving** (core `collectSegment`): by `ids`, the objects plus, for rooms, the doors on their edges and everything whose centre stands inside them (props, terrain, labels, markers, cutouts, stairs, pictures; an area must also fit inside the picked floor, so a forest around the rooms stays behind), and every corridor whose two rooms are both in. By `rect`, every object lying completely inside it, terrain cut to it; doors on the walls of rooms left outside stay behind. A picked corridor whose rooms aren't both in keeps its current route as a fixed `path` (and drops the missing room); unpicked corridors to rooms outside stay behind. Objects are stored moved so the segment's top-left is 0,0, in a box of whole squares (`rect` saves are exactly the box, which is the tile size for filling).
- **Placing** (core `placeSegmentOps`): the copy's top-left goes to `at`, rounded to whole squares, turned clockwise about the segment's centre (shapes, points, paths, door directions, prop and picture rotation, the way up of stairs). Every object gets a fresh id after the highest of its kind on the map (r, c, d, p, s, l, i, t, m), numbered rooms continue the map's room numbers in their old order, and corridors point at the copies of their rooms. An auto-routed corridor that would route differently once turned keeps the turned route as a fixed path, so it still meets its doors. The summary names rooms of the map the copy overlaps.
- **Filling** (core `fillSegmentOps`): copies of the segment's props and terrain are laid side by side from the area's top-left. `rect` is the area; without it, the area is the bounds of the map's rooms, corridors, doors, stairs and cutouts grown by `around` squares (`regionAround`). A prop is left out when its footprint would come within `margin` squares of a room or corridor (plus the wall roughness bulge), stick out of the area, overlap a prop already on the map or from another copy, or stand on the map's own terrain of another kind (no trees in the river). With `vary`, each prop moves up to 0.3 squares and nature props and decals get a random turn. Terrain: per tile kind, the copies are joined and cut to the area minus the floor grown by the margin, so rooms and corridors become `holes`; it goes in under the map's other terrain. Fills repeat only props and terrain: rooms, doors, labels and markers of the segment are left out (the summary says so).
- **Editor:** the Segment tool (K) has three modes. **Save**: drag a box, name it in the panel, done; with the Select tool, the selection panel has "Save as segment…" too. **Place**: pick a segment in the library (thumbnails drawn in the browser), a ghost follows the pointer, Q/E turn it, a click places it (and selects the copy). **Fill**: pick a segment and drag an area, or press "Fill around the rooms" (5 squares out). Library entries can be renamed and deleted. Placing and filling are worked out in the browser with core and sent as ops. Code: web `segments.ts`, server `segments.ts` + `segment-store.ts`, core `segments.ts` + `geometry/terrain.ts`.
- **MCP:** `list_segments`, `save_segment` (`map`, `name`, `ids` or `rect`), `place_segment` (`map`, `segment`, `at`, `rotation?`), `fill_with_segment` (`map`, `segment`, `rect` or `around?`=5, `margin?`, `vary?`).

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
| `/maps/:id/render.png` | `ppg` (10–300, default **70**, Roll20's grid), `view` (`gm` or `players`), `style` (preset override), `grid=0`, `background=0`, `fog=1`, `bounds=full` (with fog, keep the unfogged picture size) | PNG. The filename includes the size in squares, e.g. `crypt_classic-hatching_players_26x38.png` |
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
| `add_room` (`rect` \| `poly` \| `circle` \| `preset`, `name?`, `label?`, `notes?`) | The room number defaults to the next free one. `preset` is `{kind: oval/triangle/hexagon/octagon, box: [x, y, w, h]}` |
| `connect` (`from`, `to`, `width?`=2, `doors?` none/from/to/both, `door_style?`) | Auto-routed corridor that follows its rooms, with doors across its mouths |
| `add_cutout` (a shape or `preset`, `fill?` solid/rock), `add_door`, `add_stairs`, `add_label` | Details |
| `list_assets` (`category?`, `search?`), `add_prop` (`asset`, `at`, `rotation?`, `scale?`, `notes?`), `add_props_along` (`asset`, `path`, `spacing?`, `placement?`, `spread?`), `add_terrain` (`asset`, one shape) | Furnishing and ground |
| `add_marker` (`kind` discover/interact/trap, `at`, `text`) | A GM note badge (GM view only); `update` with `{"done": true}` strikes it through |
| `list_images`, `add_image` (`src`, `at`, `w?`, `h?`, `rotation?`, `layer?`, `opacity?`, `gm_only?`) | The user's uploaded pictures, placed by `src` |
| `add_level` (`name`, `position?` above/below, `current_name?`) | Adds a storey (a new map in the same group) |
| `label_stairs` (`map`) | Numbers every stair of the place: 0A, 1A, 2A… (GM view only) |
| `list_segments`, `save_segment` (`name`, `ids` \| `rect`), `place_segment` (`segment`, `at`, `rotation?`), `fill_with_segment` (`segment`, `rect` \| `around?`=5, `margin?`, `vary?`) | Saved pieces of maps: save, place a renumbered copy, fill the land around the rooms (see "Segments") |
| `move`, `resize`, `update`, `delete`, `set_map` (name, style, overrides, seed, roughness 1–10, level_name, floor) | Changes; `add_room` also takes `roughness` |
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
