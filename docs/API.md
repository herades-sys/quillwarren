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
- **Password only** (GMs with an authenticator): the other way round, without a new link. The GM keeps their password and sessions; their authenticator, recovery codes and any open "new authenticator" link stop working. A GM still setting up keeps their setup link, which then asks for the password only. Admins can't be switched.
- Make admin / make GM, remove an account, and see and end sessions ("Log out everywhere" per account, or "Log out everyone except me").
- The last active admin can't be removed, demoted or reset. Admins can't remove, demote or reset themselves here (their own login is on `/account`).
- **Feature requests:** the count, the newest 5, and the whole file to view or download (see "Feature requests: `/feedback`").

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
- **Open without a login:** `/play/*`, `/api/v1/games/*` (the table's own membership checks), `/feedback` (the form checks for a login or a player seat itself; see "Feature requests"), `/auth/*`, `/login`, `/logout`, `/account/setup`, `/api/v1/session`, `/health`, and static files (`/assets/*`, `/fonts/*`, `/favicon.svg`).
  - **Everything else needs an editor login** (admin or GM account). Pages redirect to `/login?next=…`; the API answers 401.
  - **Players' map pictures** come from `GET /api/v1/games/:id/pages/:pageId/background.png?view=players|gm`. It is for members only: players get only their own page in the players' view, and only the GM may ask for `view=gm`. On a page with dynamic vision, the players' picture is cut to what the party has explored, black elsewhere (TABLE.md, "Vision and light").
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
| POST | `/maps` | `{ name?, style?, template?: "empty" \| "test-dungeon", unit?, by? }`, or `{ map: <full delve.map>, by? }`. `unit` is what one square stands for, in feet or metres: `"5 ft"` (default), `"10 ft"`, `"1.5 m"`, `"2 m"`… | `201 { id, rev: 1, map }` |
| GET | `/maps/:id` | | `{ id, rev, map }` |
| DELETE | `/maps/:id` | | `204`. A soft delete: the row stays in the database file, and the id can't be reused. The start page and the editor's map panel have Delete buttons |
| GET | `/maps/:id/levels` | | `{ levels: [{ id, name, level }] }`: this map's storeys, top first (just the map itself when it has none) |
| POST | `/maps/:id/levels` | `{ name, position?: "above" \| "below", currentName?, by? }` | `201 { id, rev, map }`: a new empty storey in the same group. The first time, this map joins the group as `currentName` (default "Ground floor"). The stairs are then numbered again (below) |
| POST | `/maps/:id/levels/label-stairs` | `{ by? }` | `{ storeys: [{ id, name, floor, stairs, changed, rev }], summary }`, top first: labels every stair of the map's storeys (a single map counts as floor 0). One undo step per map whose labels changed; maps already right are left alone |
| PUT | `/maps/:id/category` | `{ category: string \| null, by? }` | `{ category, changed: [mapId] }`: files the map, and every storey of its place, under a library category (trimmed, at most 60 characters; `null` or `""` takes it off its shelf). A category typed in other case takes the spelling already in use. One `update_map` per storey that changes; like notes, it redraws nothing |
| PUT | `/maps/:id/name` | `{ name?, storey?, by? }` | `{ name?, storey?, changed: [mapId] }`: `name` renames the place: the map and every storey of it (they share one name); `storey` renames only this storey (its `level.name`). Trimmed; 1–200 characters (storeys 1–60). The start page offers both in each map's ⋯ menu, the editor's map settings rename the whole place, and MCP `set_map name` on a storey renames its place too |

**Storeys:** a place with several storeys is several maps that share `level: { group, name, order }` (higher `order` is further up). Each storey has its own undo history and exports as its own Roll20 page, and all of them share one grid, so stairs line up. The editor shows a storey picker at the top and the floor of the storey below as a dashed outline. Open viewers get `{ type: "levels" }` when a storey is added, deleted, renamed or renumbered.

**The library (start page):** maps sit on shelves by their `category` (named shelves A–Z, then "No category"), and the storeys of one place are one row that opens to show each storey (`apps/server/src/library.ts`). Editors type a category into the row's field; Enter saves it. Open places and folded shelves are remembered per browser (localStorage `delve-library-open`, `delve-library-folded`). MCP `set_map` takes `category` too; `list_maps` and `describe_map` show it.

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

## Doors (at any angle)

- **The object:** `{ type: "door", id, at, along: "x" | "y", angle?, width, style?, open?, name?, notes? }`. `at` is where the door's line starts, `width` its length in squares. Styles: `normal` (default), `double`, `locked`, `secret`, `portcullis`, `archway`; `open: true` draws it open.
- **`angle`** (optional, degrees clockwise from east, since y grows down: 0 runs east like `along: "x"`, 90 south like `along: "y"`, 45 down to the right, 135 down to the left) turns a door any way, so it sits in the slanted walls of octagons, hexagons and polygons and in curved and cave walls. It wins over `along`, which then holds the nearest axis (for anything that reads only `along`). The editor folds it into 0–180 and rounds it to 0.01°.
- **Old doors don't change:** without `angle` a door cuts only wall lying exactly on its line, as always, and renders, exports and describes byte for byte as before (core test "old doors (no angle)"). New doors on a straight x or y wall (or across an opening) are made the old way too; only where that couldn't open the wall (a slanted wall, a circle's top) do they get an angle.
- **The gap of a turned door:** the wall running along it (within 40° of its direction, and up to 0.2 + 0.15 × width squares, at most 0.6, either side of its line, so a curve or a cave wall bowing away from the straight door counts) is taken out between its two ends. Where the wall goes on off the door's line, a short jamb joins it to the door's end, so neither the picture nor line of sight gets a crack beside the door. Rough walls stay smooth at every door, as before, so the door and its gap line up with the wall there.
- **Secret doors** look like plain wall to players: no gap, and a turned one in a wall draws nothing of its own (a curve stays one clean curve); across an opening it closes it with its line (core `shutDoorLines`). The same walls feed the 3D view and the table's line of sight.
- **Snapping onto a wall** (core `doorOnWall`): on a straight stretch at least as long as the door it is centred on the nearest point and slid back to stay on that stretch; on a curve or across a corner its ends are walked round the wall until they are `width` apart, so both ends lie on the wall (a chord). `placeDoor` / `placeDoorBetween` decide the old form or an angle.
- **Editor:**
  - The **Prop tool (P)** picker has a **Doors** group (also under All, and found by search) with a tile per style, drawn by the map renderer in the map's own style. Picking one and clicking places a real door, not a prop: within 0.75 squares of a wall it goes onto the wall, centred on the wall line and turned to the wall there (on a straight x or y wall its ends snap to the grid); away from walls it takes the current turn, Q / E 15° (Shift 90°). The context bar has its width (double doors and portcullises start at 2 squares). A ghost shows where it will land. Switching to the Prop tool with a door selected picks that door's style, width and turn.
  - The **Door tool (D)** still drags along a wall: within 6° of an axis it makes the old door along x or y; slanted, a turned door whose ends go onto the wall nearest each.
  - A selected door moves like anything else, turns about its middle with **Q / E**, and gets wider or narrower by dragging either end (half squares, Alt in tenths; a turned door's end that comes near a wall goes onto it, so a door in a curve stays a chord of it). The inspector has Style, Open, Width, **Angle** and its start X / Y.
  - Code: web `edit-logic.ts` (`doorDrag`, `pickerDoor`, `turnDoor`, `stretchDoor`, `doorUpdate`, `doorEndAt`) and `door-tiles.ts`.
- **MCP:** `add_door` takes `at` with `along` or `angle`, or `near` (a spot by a wall: the door is centred on the nearest wall within a square and turned to match) instead of `at`; `update {"angle": 30}` turns a door about its start point, `unset ["angle"]` makes it run along x or y again.
- **Dungeon Scrawl:** a turned door is exported as its rectangle and jambs turned with it (the asset keeps the identity transform, field for field like the fixture's), and comes back turned on import; a door more than a degree off both axes imports turned.
- **Core:** `geometry/doors.ts` (`doorAngle`, `doorDirection`, `doorNormal`, `doorSegment`, `doorCentre`, `doorFromCentre`, `doorSlot`, `cutTurnedGaps`, `doorOnWall`); walls in `geometry/walls.ts` (`computeWalls`, `wallPolylines`, `shutDoorLines`, `onEdge`, `placeDoor`).

## Corridors between rooms of any shape

Corridors meet hexagons, octagons, triangles, circles, ovals, polygons and freehand rooms at their real outline, not at their bounding box, so there are no gaps, notches or slivers where a corridor meets a slanted or curved wall.

- **Which corridors:** `connect` (MCP, REST ops) and the editor's Corridor tool (C) make corridors with `route: "outline"`. Corridors made before 2026-10-02 have no `route` and keep their old route between the rooms' boxes exactly, until they are rerouted. Between two rectangles both ways give the same route.
- **Where it leaves a room (a mouth):** a stretch of the outline as wide as the corridor. The router tries mouths square to a straight wall, near its middle and away from its corners; a slant into a wall of up to about 30° (a straight run into a hexagon's or triangle's side); an obtuse corner met along its bisector (a hexagon's point); a sharp point met head on (a triangle's tip, which then opens into the corridor like a funnel); and radial mouths on circles and ovals. The corridor's end reaches a tenth of a square past the mouth's lowest point into the room (on a straight wall along the grid it ends exactly on the wall, as before), never more than its width, so the floor joins seamlessly.
- **The route:** straight, L or Z on the grid when both mouths face along the grid, every bend on half squares and corridor edges on whole squares where they fit. A mouth off the grid either squares off its wall with a short stub and turns onto the grid, or runs at 45° (between diagonal walls such as an octagon's sides, or off a circle), or, between two parallel slanted walls, straight across. Each candidate gets a cost (length, bends, slanted runs, how clean its mouths are, a corridor side flush with a nearby wall, rock wedges sharper than 50°) and the cheapest one that keeps clear of both rooms wins; second-best mouths (slants up to the corridor's width deep, wedges down to 40°, short legs) compete at a fixed extra cost, so rooms too close for an L still get a short, clean corridor. If nothing fits, the old box route is the fallback; rooms that overlap get no corridor.
- **Doors at the mouths:** `connect` with `doors` puts each door across its mouth, from one corner of the mouth to the other (core `mouthDoor`, made with `doorBetween`): the old form along x or y where the mouth lies on an axis (exactly as before for rectangles), turned with an `angle` in a slanted or curved wall (see "Doors (at any angle)"). Across a corridor's mouth there is no wall to cut, so the door only closes the opening.
- **Rerouting:** MCP `reroute` (`map`, `ids?`, default every corridor) and the corridor inspector's **Re-route** button (shown for older corridors and ones with their own path) switch corridors to `route: "outline"` in one undo step. A corridor with its own `path` goes back to following its rooms (found from its two ends when it has no `from`/`to`), and doors across its old ends (their middle within the corridor's width of its last stretch, running across it) move to the new mouths, keeping their style and state. The result lists what changed and what was skipped (no such corridor, not between two rooms, overlapping rooms).
- **Speed:** a route takes a few milliseconds and is cached by the two shapes and the width, so dragging a room in the editor re-routes live.
- **Floor clean-up:** where a corridor crosses a slanted or curved wall, points of the merged floor closer than 0.00001 squares are merged, so wall lines get no kinks. Floors of whole and half squares never have such points and stay exactly as they were.
- Core: `geometry/attach.ts` (`outlineRoute`), `geometry/corridors.ts` (`shapeRoute`, `corridorRoute`, `endMouth`), `build.ts` (`connectOps`, `mouthDoor`, `rerouteOps`); server `corridor-tools.ts`. Tests: `packages/core/test/attach.test.ts` with the layouts in `test/layouts.ts`.

## Open ends and open areas

Hatching and shading (and the classic style's drop shadow) run along the outside of every wall. Two things leave that band out, so an edge reads as open ground instead of solid rock:

- **Outer archways, automatically:** a door of style `archway` on the floor's outer edge (floor on one side of the gap, no floor within the band's reach beyond it) gets an open end. A strip as wide as the gap is left out of the band straight outwards, past the hatching's reach, with softly rounded corners (the same look fog of war gives a revealed edge). The wall stays cut at the gap as before. Archways between two rooms or across a corridor mouth, and every other door style on an outer wall (a normal exit door), keep the band. `describe_map` says "leads outside (an open end…)". Core: `render/open-ends.ts` (`outerArchways`, `archwayEnds`, `openAreas`).
- **Open areas, drawn by hand:** the `opening` object, `{ type: "opening", id, name?, notes?, shape, walls?: true }`.
  - Inside its shape there is no hatching, no shading and no drop shadow, in the GM and the players' view. The object itself is never drawn and never exported to Dungeon Scrawl.
  - `walls: true` also leaves out the wall lines inside the shape, and a wall that runs along its edge with the open area on the outside: a cave mouth, a ledge that drops away, a room edge that is simply open. Walls running along its edge on the floor side stay, so an open area reaching into a room keeps the room's side walls. This also holds for the 3D view and the table's line of sight, which use the same walls (core `computeWalls` / `wallPolylines`).
  - Ids default to `o1`, `o2`… It moves, resizes, undoes and comes along in segments (with the room it touches) like any shape. `describe_map` lists open areas.
  - Editor: the **Open area** tool (**N**, the eraser on the rail): shapes 1–7 like the Pillar tool, Shift for a square, and Keep walls / Open walls. All open areas show as dashed outlines while the tool is on, a selected one also with Select; a click with the tool picks one. The inspector has its name, "Open the walls too", the shape and its size.
  - MCP: `add_opening` (`rect` | `poly` | `circle` | `preset`, `walls?`, `name?`, `id?`); `update {"walls": true}`, `resize` and `delete` change it.
  - Core: `geometry/openings.ts` (`openingsOf`, `openWallRings`, `cutSegments`), the band in `render/scene.ts`.

## Heights within a map

Raised and sunken ground on one map (separate floors stay storeys, `level`): a ledge archers shoot from, a hill with a crest, a sunken arena, a pit, the plateaus of a mountainside.

- **The object:** `{ type: "height", id, name?, notes?, shape, height, edge?, profile?, hidden?: true }`. Ids default to `h1`, `h2`…
  - `shape`: any shape (rect, circle, poly; the tools also take `preset`).
  - `height`: relative to the map's floor, in the map's units (`grid.unit`, feet or metres; core `units.ts`): `10` is a 10 ft ledge, `-5` a pit, `20` a hilltop. From −10000 to 10000.
  - It only changes the height where there is ground: the floor (rooms and corridors minus cutouts) or terrain. Outdoors a mountainside is terrain (snow, grass, rock) plus height areas, no room needed. The part of an area outside the ground changes nothing.
  - **Overlaps:** the area that comes later in the map wins where areas overlap, so a hill can carry a higher crest and a ledge can hold a pit. An edge belongs to the later of the two areas it divides (or to the area, against the plain ground).
  - `edge`, how the boundary is crossed:
    - `cliff`: a sheer drop or ledge, drawn as a firm line with short ticks on the low side; not walkable.
    - `rock`: a cliff drawn as a band of rock face on the low side, as wide as the drop (about a square per 10 ft, from half a square to three), with hachures fanning down, stipple, a few boulders and a ragged foot; it narrows to a point where it runs out on open ground. Not walkable.
    - `slope`: a walkable hill or ramp. The ramp lies on the low side of the line (outside a raised area, which keeps its whole top; inside a sunken one, which keeps its rim) and is 2.5 squares long per square of rise, from 1 to 8 (core `slopeRun`): about 22° on average, a hillside you walk up; below a square it would read as a step, and past 8 a big rise would eat the map, so it gets steeper instead (a 5 m rise on a 1 m grid ramps over 8 squares). Where the ground ends (a wall, terrain's edge, the map's edge) or another height area is in the way, the ramp narrows to fit (half the gap when that one ramps toward it too), never below a square. Drawn by the relief (below).
    - `step`: walkable: a low step or rubble, a thin line with tiny ticks.
    - Unset: a drop of one square's size or more (5 ft on a 5 ft grid, 1.5 m on a 1.5 m one) is a `cliff` on the floor and a `rock` face outdoors on terrain; less is a `step`.
  - `profile`, the ground's shape inside the area (core `surface.ts`, `heightProfile`):
    - `plateau`: flat at its height. Ledges, arenas, terraces, built platforms, cliff tops.
    - `hill`: rounded. It rises from its outline toward its full height at its deepest part (by distance from the outline, eased at foot and top, the outline's corners rounded off), so long, thin areas become ridges and narrow arms become lower spurs; a seeded warp sets the top a little off-centre and a seeded unevenness keeps it from being a perfect dome (the top still reaches the height). With a `slope` edge the foot spreads outside the outline when the area is too small for its slope (the slope's length minus the area's depth), with a sheer edge it starts at 40 % of its rise (a rocky knoll). A sunken hill is a round hollow.
    - Unset (old maps too): a `hill` for a `slope` edge, a `plateau` for the rest.
  - **Nesting:** areas apply in map order and each pulls the ground toward its own height (`h ← h + (height − h) · weight`), so heights don't add: a +10 crest on a +5 hill rises out of the hill to +10, a plateau with a cliff edge on a hill stands at its own height (its cliff as tall as the hill is low there), and a +3 hill on a +5 one makes a dip.
  - `hidden: true`: the GM's only. The players' view shows flat ground there, their 3D scene leaves it out, and Delve Table doesn't hold their tokens back at its edge.
  - It moves, resizes, undoes and comes along in segments (inside its room) like any shape; fog of war treats it like other objects (players see its edges only where they have seen the map). Dungeon Scrawl exports leave it out.
- **Stairs and ladders:** stairs objects, and ladder or spiral-stair props, lying across a cliff or rock edge make it passable there (the line and ticks are left out under stairs). Stairs that "go down on the same map" are stairs from the floor across a sunken area's edge. Stairs between two heights get an arrow up the flight (in both views), toward the higher end whatever their `direction` says; the editor's Stairs tool sets `direction` that way when it draws across an edge, and `add_height` names stairs that now run the wrong way. The 3D views climb them from the low height to the high one. They no longer count as loose stairs in the storeys' 3D view.
- **The look** (core `render/heights.ts`, in the style's own ink, every jitter from the seeded RNG, no filters): flat raised ground a shade lighter, flat sunken ground a shade darker (on white floors, as in clean and print, only sunken ground shows a tone); the edges as above, in both views. Hills and ramps are drawn from the ground's real shape (the relief): a hillshade lit from the north-west, 45° up, as six soft vector steps each way (lighter toward the light in the style's paper colour, darker away in its ink), thin contour lines a little wobbly (every 1, 2 or 5 times a power of ten of the map's units, about six over the biggest rise: 1 m on a 5 m hill, 5 ft on a 30 ft one) with a heavier one every fifth, and light hachures down the steepest parts. The foot of a hill fades out with no line round it; a flat area with a slope edge keeps a soft line at its brow. The GM view adds a small tag with the height on each area ("+10 ft", "−5 ft"), on a hill at its top, away from room numbers and stairs. The parchment handout shows the edges, relief and shading like the players' view.
- **Where you can go:** core `walkableMap(map)`: the ground by height, the edges that block movement (cliff and rock edges minus where stairs or ladders cross), the crossings (stairs, ladders, slopes, steps), and the walls and shut doors as before. `blockingEdges(map)` gives Delve Table the blocking pieces with their drop (hidden areas left out).
- **describe_map** lists every area: its height (with "hill" or "hollow" for a rounded one), edge, size, where it is ("along the north side of room 1 Great hall", "on Snow (t1)") and how it is reached ("reached by stairs s1 (up n)", or "no stairs or ladder: only by climbing, jumping or flying").
- **Editor:**
  - The **Height** tool (**K**, the layers icon on the rail): shapes 1–7 like the Pillar tool (Shift for a square), the height with − and + (a square's size per step), the edge chips Auto, Cliff, Rock face, Slope, Step, and the top chips Auto, Flat, Hill. While it is on, every height area shows as a dashed outline; a click picks one.
  - The inspector: name, height, edge, top (Auto, Flat, Hill), "Hidden from players", how it is reached, the shape and its size, GM notes.
  - **Where you can go** (**Shift K**, the footprints switch at the bottom of the rail, the Height tool's bar, or Map settings → Heights and movement): the ground tinted by height (blues down, yellow to orange up) with its height, red dashes on edges nobody can walk over, green on crossings (thick for stairs and ladders). Kept per browser (localStorage `delve-movement`); it shows in the GM view of Delve Table too.
- **3D** (`/maps/:id/3d`, and Delve Table's, see docs/TABLE.md): the floor picture is draped over the ground's real shape, heights in squares (a square per square of height: 10 ft on a 5 ft grid is 2 up). So sand stays sand and grass stays grass on a slope, and hills and ramps rise smoothly into the ground around them. Where the ground drops sheer (cliff, rock and step edges, and a raised area's edge against the plain ground or the map's edge) a face of rock stands straight from the high edge down to the ground below: drawn in code (bedded blocks, joints, weathering; no picture files) and toned halfway toward the style's shade colour, cut in rows that bulge a little back into the high ground (never out over the low side), the top and foot exactly on the ground's edges. A sunken area's walls come down from the plain ground. Walls, doors and stairs stand on the ground beside them; stairs climb from the ground at their foot to the ground at their head. Sunken parts keep their own slab in the storeys' view, whose draped ground is lit (it shows its shape) and cut out where the picture is clear.
  - **How it is sent** (core `heightScene` → `pieces`): the ground where it isn't flat (hills, ramps, with their surroundings) is cut by the sheer edges into pieces, each with a grid of heights on a lattice from the map's origin (4 posts per square, coarser on big maps: about 24 000 cells in all, at most a post per 2 squares), as 16-bit steps, base64; flat raised and sunken ground goes as pieces at one height, the rest of the frame (`base`) at 0. With fog the pieces are cut to what the players have seen and the grid posts beyond them are blanked, so nothing unseen leaves. Test 006: 19 KB, one 93 × 70 grid.
  - **In the browser** (`apps/web/src/heights3d.ts`, the math `heights3d-logic.ts`): each piece is triangulated, its triangles cut along the lattice (crossings worked out the same way from both sides, so neighbours share their points and no seam opens), every corner at the grid's height; faces wherever a piece stands above its neighbour. Test 006: about 20 000 vertices and 16 500 triangles for ground and rock, built in about 15 ms.
- **MCP:** `add_height` (`rect` | `poly` | `circle` | `preset`, `height`, `edge?`, `profile?`, `name?`, `notes?`, `hidden?`, `id?`); `update` (e.g. `{"height": -5}`, `{"edge": "slope"}`, `{"profile": "hill"}`), `resize`, `move` and `delete` change it. The chat prompt has recipes for an archers' ledge, a sunken arena, a snowy mountainside with plateaus and a path up, and a hill with a rocky outcrop and a path winding up.
- Core: `heights.ts` (`heightPlan`, `walkableMap`, `blockingEdges`, `heightScene`, `stairsUphill`, `describeHeights`), `surface.ts` (`heightProfile`, `heightSurface`: the ground's real height anywhere, `sampleSurface`, `isolines`), `render/heights.ts` (`heightDrawing`, `contourInterval`).

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

## GM notes on rooms, corridors and terrain

- **The field:** every object may carry `notes` (text, at most 10 000 characters; schema `common`). On rooms, corridors and terrain they are the GM's prep: a description, the monsters, the loot. (Markers keep their own `text`.)
- **Who sees them:** the GM and Claude. They are never drawn (in no style or view), so they are never in a picture, the players' screen (`/maps/:id/screen` and its socket), a 3D scene, the handout or a Dungeon Scrawl export, and Delve Table never sends them to players (players' pages carry no map id). `describe_map` (and `GET /maps/:id/describe`) lists them at the end under "GM notes (GM only, never drawn)"; the editor chat's prompt cuts each to 300 characters.
- **Writing them:** the editor's inspector (a "GM notes" box for a room, corridor or terrain, also props), `add_room notes`, MCP `update {"notes": "…"}` (unset `["notes"]` removes them), or an `update` op from anywhere. On Delve Table the GM edits them by clicking a room (see docs/TABLE.md, "GM notes"), saved as ops through `POST /maps/:id/ops` with the editor login (`by: "table"`), one undo step each.
- **A change of nothing but notes** (core `notesOnly(ops)`) leaves every picture as it was: the players' screen isn't told (no `changed`), and the table pages drawn from the map aren't sent again; the table tells only the GM's connections (`map.notes`).
- **Core:** `notes.ts`: `noteAreasAt(map, p)` (the rooms under a point, the topmost first, then corridors, then terrain; terrain holes and corridor ends left out), `noteAreaAt`, `areaTitle`, `noteAnchor` (where the GM's pin goes), `notedAreas`, `notesOps(id, text)` (blank removes them), `notesOnly`; `pointInShape` in `geometry/shapes.ts`.

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
| `GET /api/v1/assets` | `{ categories, assets: [{ id, name, category, kind: prop \| terrain, w, h, tags, blocks, tint?, difficult?, hidden?, palette?, layer?, group?, modular?, canopy?, available, custom? }] }`: the ink catalog, then the colour props (`palette: "colour"`, see "Colour props" below), then this Delve's custom props (`custom: true`, see "Custom props") |
| `GET /assets/props/<id>.svg` | The cleaned SVG in its original inks (thumbnails; the viewer loads art from here) |
| `GET /assets/icons/<name>.svg`, `/assets/brand/<name>.svg`, `/favicon.svg` | Editor icons and the Delve logo |

- **Props** are `{ type: "prop", asset, at, rotation?, scale? }`. `at` is the centre of the footprint. At rotation 0 a prop faces south, and rotation turns it clockwise in degrees.
  - **Hidden from players:** `gmOnly: true` keeps a prop out of the players' view (their screen, Delve Table, players' exports and handouts). Unset, the asset decides (`hidden` in the catalog, core `hiddenByDefault`): pressure plates, spike traps and floor runes (core `HIDDEN_ASSETS`) and the colour props marked hidden (hidden trapdoors, covered pits) are hidden until found; `gmOnly: false` shows one. GM symbols are never drawn for players. The editor has a "Hidden from players" checkbox per prop; MCP `add_prop` takes `hidden`. Pictures keep the same size in both views, so the GM and players' PNGs line up.
- **Prop brush:** in the editor's Prop tool, Shift + drag paints copies of the picked prop along the path.
  - **Regular** puts one every N squares, snapped to the grid like a click.
  - **Irregular** varies the gaps and strays up to `spread` squares to the sides, turning each copy at random and sizing it 0.8–1.2×.
  - The dashed stroke and a ghost of every copy show while dragging. No copy lands within 0.6 × spacing of the same prop already on the map, and a stroke is one undo step.
  - **Occupied spots are skipped:** a copy that blocks movement or sight is left out where it would stand on a tree, boulder, wall or other blocking prop, or on an earlier copy of the same stroke (see "Keeping props apart" below). The ghost shows only the copies that land, and a toast says how many spots were skipped. The context bar's **Overlap** chip (off by default; shown for props that block) lets copies overlap, for a deliberate thicket.
  - Selecting a prop on the map and switching to the Prop tool picks that prop (and its turn).
  - **Mixing variants:** for a prop with a `group` (colour props: all oaks are `oak`), the brush mixes the group's props at random, seeded per stroke, never the same twice running; the context bar's "Mix <group> (n)" chip turns it off (on by default). No copy lands near any prop of the group already there.
  - Over MCP: `add_props_along` (`asset`, `path`, `spacing?`=3, `placement?`, `spread?`, `rotation?`, `mix?` = true when the prop has a group, `overlap?` = false, `seed?` = random), up to 500 per call. It skips occupied spots like the brush and says so: "Added 18 × Boulder (i2–i19) along the path. 3 spots were skipped where a copy would have stood on a tree, boulder, wall or other blocking prop, or on another copy (overlap true allows that)." The same `seed`, path and map give the same copies.
  - Core: `scatterAlong` in `scatter.ts`, then `keepClear` in `placement.ts`.
- **Keeping props apart** (core `placement.ts`):
  - **Obstacles** are every tree (all canopies, saplings too: a crown hides what stands under it) and the props that block movement or sight and stand up: boulders, ruin walls, columns, tables, rubble heaps (core `isObstacle`: a canopy, or `blocks` is `movement` or `sight` and the prop draws in the props layer). Floor props (rugs, leaf piles) and other props you walk over (`blocks: none`: candles, mushrooms, ferns) are no obstacles, and are never kept off one: a table stands on a rug, a candle on a table, a leaf pile under a tree. GM symbols and unknown assets don't count either.
  - **Footprints:** a square footprint is a disc (a tree's crown, a boulder, a column: the same however it is turned), any other the turned rectangle (a wall piece, a cart, a fallen column), both at the prop's scale.
  - **Tolerance:** two footprints count as overlapping only when one reaches more than a quarter of a square into the other (core `OVERLAP_TOLERANCE` = 0.25), or more than a quarter of the smaller one's shorter side when that is less. Trees in a wood touch at their edges and ruin wall pieces meet end to end, but a boulder never stands under a crown.
  - **The brush and `add_props_along`** skip spots (above); `overlap: true` / the Overlap chip turns that off.
  - **MCP `add_prop`** still places a prop where asked, but when it overlaps an obstacle the reply warns with the ids and the nearest free spot: "Warning: it overlaps i1 (Oak), so they are drawn over each other. The nearest free spot is [11.5, 4]: move it there, or add it with avoid true." With `avoid: true` it goes there instead ("Moved to [11.5, 4], the nearest free spot: at [10.5, 5.5] it would overlap i1 (Oak)."). The free spot is the nearest in half-square steps (modular pieces on whole squares), up to 6 squares away (core `blockingProps`, `freeSpot`).
  - **MCP `apply_ops`** names added props that stand on obstacles, at most 8, a pair of new ones at the later one (core `overlapReport`): "Warning: 2 new props stand on trees or other props in the way, so they are drawn over each other: i2 overlaps i1; i4 overlaps i3. Move them clear unless that is meant."
  - **Single clicks** with the editor's Prop tool place exactly where the GM clicks, without a warning.
- **Wall roughness** runs from 1 (smooth: straight walls, no hand wobble) to 10 (extremely rough: caves).
  - Set it for the whole map (`roughness` on the map, via `update_map` or MCP `set_map roughness`, `null` resets) and override it per room, corridor or cutout (`roughness` on the object).
  - It reshapes the floor outline itself with smooth noise, so the floor, walls, shading and hatching all follow the rough edge. Each point of the outline takes the level of the nearest object edge.
  - Doors stay on straight wall (no roughness within about a square of a door), and bulges outward are kept smaller than dents inward.
  - Fog of war widens what players see by the largest possible bulge.
  - Unset keeps the style's own look.
  - Exports to Dungeon Scrawl keep the plain outline.
  - Core: `geometry/rough.ts`.
- **Terrain** is `{ type: "terrain", asset, shape, holes?, edge?, fadeWidth?, edgeDetails?, stack? }`, drawn over the floor and under the grid, as a tint plus a repeating 2×2-square tile (a colour texture instead: its own tile size, no tint; see "Colour props"). `holes` are rings (`[[x, y], ...]`, 3 points or more) cut out of the shape: a forest filled around a dungeon leaves its rooms out this way. Moving the terrain moves its holes; fog of war and the editor's clicks ignore the holes' area. Areas fade into each other and have ragged outlines by default (see "Terrain edges").
- **Drawing order:** decals (and colour props with `layer: "floor"`: rugs, trapdoors, leaf piles) lie under the walls, props sit on top of walls and doors, uploaded pictures on the props layer over them, then the **canopy** layer, then GM symbols, labels, the GM's fog shade, handwritten notes on the map, room numbers and GM markers. GM symbols appear in the GM view only.
  - **Canopies:** trees are tall, so they draw after every other prop and picture (scene layer `canopy`): whatever stands under a crown is hidden by it, as on a real forest map. Canopies are every colour prop of the category `trees` (core `CANOPY_CATEGORY`: all its groups, saplings and potted trees included) and the ink `tree`, `tree-dead` and `mushroom-giant` (core `CANOPY_INK`). It is decided in core `assets/catalog.ts` when the catalogs load, not stored in them: those entries get `canopy: true` (`GET /api/v1/assets` shows it), `isCanopy(id)` asks, and `propLayer` returns `canopy`. Custom props draw by their category as before.
  - Every picture goes through the shared scene, so server renders, the editor and viewer, the handout, Delve Table pages and the 3D view's floors agree. Maps without trees draw byte for byte as before (hashes in `packages/core/test/canopy.test.ts`).
  - The editor's clicks follow the drawing order too: a click on a tree picks the tree before the boulder under it, whichever was placed first.
- **Recolouring:** every style recolours the three asset inks (`props` in the style preset). Colour props keep their palette as the style shows it (`colours` in the style preset, see "Colour props").
- **GM markers** are `{ type: "marker", kind: "discover" | "interact" | "trap", at, text, done? }`. They are notes pinned to a spot: "?" is something to discover, "!" something to interact with, and a skull a trap.
  - They are drawn last, in the GM view only. The players' view, the players' screen and the players' 3D view never contain them, and neither do Dungeon Scrawl exports. They don't change the picture's size.
  - On open floor a badge is 0.68 squares across. On a prop or uploaded picture it shrinks to at most 30% of that item's shorter side (never under 0.16 squares), so the item stays visible (core `markerRadius`; clicks use the same size).
  - In the viewer, clicking a marker opens its note in a small box, which editors can edit. Shift-click toggles `done`, which fades the badge and strikes it through, and strikes the note's text through.
  - The editor's Marker tool (M) places them at square centres (Alt for half squares) and opens the box for typing.
  - The SVG tags each badge `data-marker="<id>" data-kind="<kind>"`, plus `data-done` when done. Code: core `markers.ts`, web `markers.ts`.
- **Where the art comes from:** `delve-props-design-system/assets`. `npm run assets` rebuilds `packages/core/src/assets/catalog.json` and the full `manifest.json` from the batch generators' metadata, and reports files that are listed but missing. The colour props are in `assets/colour/`, imported by `npm run colour-props -- ~/colour-props` (see "Colour props"). Every SVG goes through a whitelist (`parseAssetSvg`) before it reaches a page or a PNG.

## Colour props

A second built-in library in full colour: trees, plants, rocks, rugs and carpets, trapdoors, hidden traps, modular ruin walls, and more as the batches are finished. The art, its rules and the import are in `docs/ASSETS-COLOUR.md`.

- **Ids** are the art's ids behind `c-` (core `COLOUR_PREFIX`, `isColourAsset`): `c-oak-a`, `c-persian-red-a`, `c-wall-2`. They never clash with ink ids (ink `stalagmites`, colour `c-stalagmites`) or custom props (`my-…`). Maps, REST, MCP, segments and the editor use them like any prop id.
- **Catalog:** core `COLOUR_ASSETS` and `COLOUR_CATEGORIES` (from `catalog-colour.json`); `allAssets()` is ink, then colour, then custom; `ASSETS` and `CATEGORIES` stay the ink catalog's. Each entry has `palette: "colour"`, `layer` (`floor` or `props`), and maybe `group`, `hidden` and `modular`. Categories can share an id with an ink one (`nature`); then the ink one names it.
- **Drawing:** `layer: "floor"` props go into the decals layer (core `propLayer`), so furniture stands on a rug; trees (category `trees`) go into the canopy layer over the other props (see "Drawing order"). The art keeps its palette, shown per style by core `colourMap(style)` (`Style.colours`): as drawn in classic-hatching and clean, toned toward the style's sepia on parchment and the handout, and by lightness onto the style's ink → shade → paper ramp in 6 tones in old-school blue and print. The scene's assets layer carries the style's colours (`colours`) only when it holds colour props, so maps without them draw exactly as before.
- **Hidden** colour props are GM-only by default, like the ink traps (see "Hidden from players" above).
- **Terrain textures:** the seamless textures (`"tile": true` in the art: floorboards, flagstones, grass, sand, calm or stormy water…) are `kind: "terrain"`, `palette: "colour"`, `w × h` their tile size in squares (2 or 3). A terrain object takes one as its `asset` (`{ type: "terrain", asset: "c-water-calm", shape }`); the scene draws it as a pattern of that size from the grid origin (so neighbouring areas of one texture join without a seam), in the style's colours and without a tint. Water tagged `swim` or `difficult terrain` is `difficult`. MCP `add_terrain` and the Terrain tool (G, chips Ink tiles, Water, Floors, Ground) take them; `list_assets` lists them as `(terrain, colour texture 3×3, group …)`. The Prop picker and `add_prop` leave them out.
- **Groups:** core `groupVariants(id)` lists a prop's variants; the brush and `add_props_along` mix them (see "Prop brush").
- **Modular ruin walls** (`modular: true`): 36 units thick on the centre line of their squares, open ends running to the edge. Core `modularAt` puts a footprint on whole squares; the editor uses it when placing (Stamp and Brush) and moving them, and MCP `add_prop` snaps them and says so ("Moved onto whole squares…"). Rotation 90 runs a piece north–south.
- **MCP:** `list_assets` takes `palette` (`ink`, `colour` or `all`) besides `category` and `search` (which also matches groups). Without filters it lists the ink catalog as before plus one line per colour category (count and first ids); `palette: "colour"` alone gives just that summary; any list stops after 200 lines with a hint to narrow it. Each colour line says `colour`, `on the floor`, `group …`, `modular` and `hidden from players` where they apply.
- **Editor:** the Prop picker's All / Ink / Colour switch (localStorage `delve-prop-palette`) picks the library, with the colour categories as chips; search matches names, tags and groups. The inspector's Prop list swaps a prop within its own library.

## Terrain edges (ragged outlines and fades)

Terrain areas fade into each other instead of meeting at straight polygon edges: a river's deep water into its shallows, the shallows into the grass, a dirt road into the field beside it, grass slowly turning into sand over several squares.

- **What covers what doesn't change:** areas are drawn in map order as before, so a pond drawn over a field is still a pond and a later area still covers an earlier one where they overlap. Each area softens its own outline against what lies under it there: the topmost earlier area at that point, or nothing (bare floor or the map's background). Where a later area lies over an outline, the later one does the softening.
- **Edges** (`edge` on the terrain object):
  - `hard`: exactly the drawn shape, as terrain was drawn before (byte for byte: maps whose terrain is all hard draw as they did).
  - `ragged`: a seeded, natural wobble of about a seventh of a square, like rough walls, so no straight edge is left.
  - `fade`: across the boundary the area fades into the one under it, from full to none over `fadeWidth` squares (default 0.75, from 0.25 to 5), and the area under it runs on underneath where nothing else drawn before lies, so no gap or seam opens (where something else does, that shows through, as it lies there).
    - **Short fades** (up to about a square) are patches and tongues (a noise pattern, thinning out evenly over the width) with two soft see-through rims, never a straight gradient.
    - **Long fades** (wider than a square; fully from 2.5) are a gradual change of ground, the way grass thins out into sand: five see-through steps (10 % to 78 % of the area, then the opaque core) spread evenly over the width, so how much of each ground shows falls off steadily across it (about half at the drawn edge). Their outlines are broken up by noise at several scales: big soft tongues about the fade's width, clumps that get smaller towards the far side, and a little grit, partly laid along the outline so they stretch a little along the edge. The faintest steps drop their tiniest bits, so no lone specks lie far out. Between the two the look blends over.
    - Edge details spread over a long fade's width, and a long shoreline gets fainter, shorter foam.
  - **Defaults** (unset `edge`): natural ground and water fade (colour categories `ground` and `water`, and the ink tiles grass, dirt, mud, sand, snow, ice, moss, water, lava, swamp, cave floor, rubble); indoor floors stay hard (colour category `floors`: planks, tiles, carpets, marble…, and the ink flagstones, wood planks, carpet, cobblestones); a chasm is ragged. Against nothing an edge is at most ragged: no fading into paper.
  - **Where two areas meet:** an edge set on one of them wins over the other's default; otherwise the harder of the two (hard, then ragged, then fade). Two areas of the same texture join without a seam (hard). The fade is the wider `fadeWidth` either sets.
  - **Walls:** within about half a square of a wall (the floor's outline) every edge stays as drawn, so a texture never wobbles past a wall or fades through it into the next room.
- **Stacking order** (`stack`, 0–9): of two areas fading into each other, the higher lies on top: it forms the patches and tongues, the lower shows in the cracks between them, and the edge details follow it. Default by material: deep water and the sea 0, water (calm, river, pond, lava, thin ice) 1, shallows 2, sand, mud and swamp 3, dirt, gravel, paving, stone and cave floor 4, grass, moss and forest floor 5, snow and ice 6, indoor floors 7. So deep water → shallows → sand → grass fade in that order.
- **Edge details** (`edgeDetails: false` turns them off for an area), scattered along soft edges between two areas, seeded, in the textures' own colours as the style shows them (ink tiles from their tint and the style's inks):
  - water meeting land: a light, wet band along the shore, a broken foam line and a few pebbles on the land (wide, gradual shores get less foam);
  - grass meeting bare ground (dirt, gravel, sand, mud): tufts of grass reaching over the edge, specks of the bare ground spilt into the grass;
  - lava meeting land: a dark crust and a glowing line;
  - other natural pairs: a few small patches of each on the other side. None along floors or chasms, none against nothing.
- **Everywhere the same:** it is all in the shared scene (core `buildScene`), plain vector shapes (no masks, no filters; see-through parts are a copy of the tile at its opacity, a `<pattern>` painting the tile's pattern, not `fill-opacity`, which resvg drew too dark along the anti-aliased edge and so outlined every step), so the editor, viewer, players' screen, exports, the handout, the 3D view's floors and Delve Table pages agree, and resvg draws it safely (a PNG stress test in `apps/server/test/terrain-edges.test.ts` renders every style, view, crop and paper in a child process). Exports keep their size (the picture's bounds come from the areas' shapes). With fog of war the edges are worked out on the whole map and then cut to what the players have seen, so nothing leaks past it and the seen part looks as the GM sees it.
- **Stable and cached:** seeded by the map's seed and the area's id, so redraws never shift. The result is cached per terrain and floor state, and each area's own work per what it depends on (itself, the areas near its outline, the walls there), so other edits cost nothing and moving one area works out only it and its neighbours again (Test 006, 10 areas: about 0.15 s from scratch; 100 areas: about 0.5 s from scratch, 30–80 ms after moving one).
- **Editor:** the Terrain tool's context bar has Edge (Auto · fade/hard, Hard, Ragged, Fade), the fade's width (when it fades) and Details for new areas; a selected area's inspector has Edge, Fade width, Edge details and "Lies on top" (Auto by material, or 0–9), and the picture follows each change live.
- **MCP:** `add_terrain` takes `edge`, `fade_width`, `edge_details` and `stack` and says how the edge will look ("fades over 0.75 squares into the terrain under it (ragged against bare ground) (by material)"); `update {"edge": "ragged"}`, `{"fadeWidth": 3}`, `{"edgeDetails": false}`, `{"stack": 6}` change an area (unset goes back to the default). `describe_map` names the edge of areas that set one.
- **Core:** `render/terrain-edges.ts` (`terrainEdges`, `terrainEdgeSettings`, `terrainMaterial`, `defaultTerrainEdge`, `pairEdge`, `MATERIAL_STACK`, `terrainEdgeText`); scene layers `terrain:<id>` (the opaque part), `terrain-fade:<id>` (see-through rims, `alpha`) and `terrain-edge:<id>` (details). Web: `apps/web/src/terrain-edges.ts`.
- **Known:** height areas still tone their own polygon (raised ground lighter), so over a long fade the straight edge of a height area's tone can show where the terrain under it now fades.

## Custom props (this Delve's own)

A GM asks Claude in the editor's chat for a prop the catalog doesn't have ("a blacksmith's anvil with tongs, 1×1"). Claude draws it in Delve's ink style, looks at a preview, fixes it, and then it is in every GM's Prop picker. There is one shared library for all GMs and admins of the server.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/props` | | `{ categories, props: [{ id, name, category, w, h, tags, blocks, ink, created, updated, by, custom: true, url, preview }] }`, newest first |
| GET | `/props/:id` | | The same fields, plus `svg` (the drawing as it was sent, before inking) and `maps: [{ id, name, count }]` (the maps that use it) |
| GET | `/props/:id/preview.png` | | The preview (see below) |
| POST | `/props` | `{ name, w, h, svg, category?, tags?, blocks?, ink?, id? }` (token or editor login) | `201 { prop, notes }`, or `400 { error, problems: [...] }` listing everything to fix, or `409` for a taken `id` |
| PUT | `/props/:id` | Any of `name`, `category`, `w`, `h`, `tags`, `blocks`, `svg`, `ink` (token or editor login) | `200 { prop, notes }`. The id never changes |
| DELETE | `/props/:id` | `?force=1` (token or editor login) | `204`, or `409 { error, maps: [{ id, name, count }] }` while maps use it |
| GET | `/assets/props/<id>.svg` | | The cleaned, inked art, served like the built-in props (`no-cache`, `nosniff` and a `default-src 'none'; sandbox` CSP) |

- **Ids** are `my-` plus a slug of the requested `id` or of the name (`my-blacksmiths-anvil`), so they can never clash with built-in ids (core `CUSTOM_PREFIX`, `CUSTOM_ID`).
  - A name that is already taken gets `-2`, `-3` and so on. An `id` that is already taken is refused with `409`.
  - Maps place them like any other prop: `{ type: "prop", asset: "my-…" }`.
- **Category:** `custom` by default (the picker's Custom chip), or any built-in prop category (core `PROP_CATEGORIES`, which leaves out terrain).
  - The category decides the layer, as for built-in props: `decals` lie under the walls, and `symbols` are GM-only.
  - `blocks` is `none`, `movement` (the default) or `sight`.
- **Storage:** `${DELVE_DATA}/props/` holds `<id>.svg` (the art the renderer draws), `<id>.source.svg` (the drawing as sent) and `index.json` (the metadata). A lost index is rebuilt from the files. Without `DELVE_DATA` the library lives in a temp dir. It holds at most 1000 props. Code: server `custom-props.ts`.
- **Checks on every save** (core `checkPropSvg` in `assets/custom.ts`). Anything else is refused with the full list:
  - At most 64 KB as sent (192 KB once inked). `w` and `h` from 0.5 to 6 squares, in half squares.
  - `viewBox="0 0 {w*100} {h*100}"`, and `width` and `height` the same if they are given.
  - Elements: only `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` and `g`.
  - Colours: only the inks `#000000`, `#FFFFFF`, `#999999`, or `none`.
  - Stroke widths 4, 2 or 1.5. An explicit fill on every shape except lines. `transform` with `translate()` and `rotate()` only.
  - Never: scripts, event handlers, `<image>`, `href` or other links, `url(…)`, `data:` or `javascript:` URLs, `<use>`, `<foreignObject>`, filters, gradients, masks, clip paths, CSS (`style`, `class`), opacity, text, DOCTYPE or entities.
  - Every mark inside the footprint, stroke included.
  - Kept with a note instead of refused: marks inside the 4-unit margin, ids and titles. Missing round caps and joins are added.
  - The art then goes through `parseAssetSvg` like every built-in file, so only whitelisted shapes ever reach a page or a PNG.
- **Inking:** with `ink: true` (the default), every shape is redrawn with the built-in art's hand-inked line (core `inkBody`, a port of the design system's Pen). Each shape is resampled, nudged by a slow seeded swell, and written as smooth Béziers.
  - The seed is the prop id plus the shape's geometry. So a fill and its outline drawn from the same coordinates stay together, and shapes that didn't change keep their line when the prop is redrawn.
  - Marks under 6 units stay as drawn. `ink: false` keeps all the lines as sent.
- **A new size without new art** redraws the old drawing at that size (core `scaleBody`: the geometry is scaled, the line weights stay). New art must fit the size it comes with.
- **The preview** is what `preview.png`, `create_prop`, `update_prop` and `get_prop` return. It shows the prop on a floor of at least 3 × 3 squares at 70 px per square (Roll20's grid), in `classic-hatching`, `print` and `parchment` side by side. Next to them is the prop alone in print, enlarged about 3× (at most 420 px a side). Each panel is labelled.
- **Deleting a prop that maps use** is refused, with the list of maps. `?force=1` deletes it anyway: those maps keep their props, which then draw as the dashed "unknown asset" outline (1×1) until a prop with that id exists again.
- **Rendering:** the server registers the library with core (`registerAssets`) at start and after every change.
  - So `assetInfo`, `propBounds`, `describeMap`, the chat context and every server render (PNG, SVG, handout, Delve Table pages, the 3D view's floors) know custom props.
  - Their art reaches the renderer through `assets.body` (`addCustomPropSource` in `assets.ts`).
  - Browsers fetch `/api/v1/props` (web `custom-props.ts`) and register it the same way. The art loader fetches custom art with `?v=<updated>`, so a redrawn prop shows up.
- **From the internet** (the tunnel): `/api/v1/props` and the previews need a login, like maps, and writes refuse the API token there, like everything else. The art at `/assets/props/<id>.svg` stays open like the built-in props: a GM may drop one on a Delve Table board as a picture, and the players' browsers load it. It shows nothing of any map.
- **Editor:** the Prop picker (P) lists custom props with the others: search and categories as before, a "custom" badge, and a Custom chip with all of them.
  - **New prop…** in the picker's foot opens the Claude panel with "Draw a new prop: <describe it>, size 1×1 squares, category …" for the GM to finish and send.
  - Each custom tile has a ⋯ menu: Rename…, Change category…, Change size… and Change what it blocks… (one dialog, with the preview); Ask Claude to change it… (prefills the chat); and Delete… (names the maps that use it and offers "Delete anyway").
  - When a chat reply runs `create_prop`, `update_prop` or `delete_prop`, the picker reloads. Code: web `prop-maker.ts`.
- **MCP:** `prop_rules`, `create_prop`, `update_prop`, `get_prop` and `delete_prop` (see "MCP"). `list_assets` lists custom props, marked "custom". Changes over MCP are recorded with `by: "claude"`; REST ones with the account's name (`api` for the token, `editor` for the shared password).

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
| `/maps/:id/render.png` | `ppg` (10–300, default **70**, Roll20's grid), `view` (`gm` or `players`), `style` (preset override), `grid=0`, `background=0`, `fog=1`, `bounds=full` (with fog, keep the unfogged picture size), `frame=x0,y0,x1,y1` (crop: just this part, in squares, widened to whole squares, at most 1000 each way) | PNG. The filename includes the size in squares, e.g. `crypt_classic-hatching_players_26x38.png` |
| `/maps/:id/render.svg` | same | SVG, scalable, for print |
| `/maps/:id/describe` | | Plain text: rooms, sizes, connections, doors |
| `/maps/:id/export.ds` | `view` (`gm` or `players`) | A Dungeon Scrawl save file, e.g. `crypt.ds` or `crypt_players.ds`. Open it in Dungeon Scrawl with File → Open save file |

**Cropped exports:** `frame` draws exactly that part of the map. It is widened to whole squares (`2.5,0,7.2,4` draws `2,0,8,4`), so the picture's edges fall on grid lines and a VTT grid lines up; the PNG is `(x1 − x0) × ppg` by `(y1 − y0) × ppg` pixels and the filename carries the size in squares.
- **Editor:** with something selected (a box selection, say), the Export menu (and ⋯ on narrow screens) gets **Crop to selection**: PNG · GM view, PNG · players, SVG (in the current view) and the parchment handout, each framed on the selection's bounds plus one square. The label shows the count and the size, e.g. "6 objects · 5 × 20 sq".
- **MCP `export`:** `crop: [x, y, w, h]` in squares and/or `around: [ids]` (their bounds plus `margin`, default 1); both together cover both. It answers with the link and "Cropped to x 2–6, y -16–4 (4×20 squares)". `ds` exports are always whole and refuse a crop.
- **Handout:** `crop=x0,y0,x1,y1` on `/api/v1/maps/:id/handout.{png,svg}` and on the page `/maps/:id/handout?crop=…`, which passes it on and says it's cropped. A cropped handout's scene is cut to its frame first (core `cropScene`): resvg panicked (and so killed the server) on a cropped sheet whose map geometry ran far past the page under a stain's blur.
- **Core:** `crop.ts` (`cropFrame`, `selectionBounds`, `tightBounds`, `wholeSquares`, `cropScene`); server `render.ts` `parseFrame`.

The players' view hides room numbers and draws secret doors as solid wall. Styles are `classic-hatching`, `clean`, `old-school-blue`, `print` and `parchment`. Parchment is brown ink on old paper, with sketched walls; the handout below puts it on a whole parchment sheet.

**The map's background colour:** each map can have its own colour around and between the rooms instead of the style's (classic: `#EFEAE2`).
- **Stored** as the style override `style.overrides.background`, `"#RRGGBB"`. Unset (or the style's own colour) means the style's. Validation refuses anything that isn't a hex colour. It's the map's, so it stays when the editor or `set_map style` changes the style; `set_map overrides: null` clears it with the rest.
- **Where it shows:** everywhere the scene's background is drawn, because `resolveStyle` reads it: the editor and viewer canvas and the stage behind it, PNG and SVG exports (cropped with `frame=`, and snipped), the players' screen, Delve Table pages drawn from the map, and the Dungeon Scrawl export's page colour. `background=0` stays transparent. The parchment handout keeps its own paper, and the 3D views keep their own dark surroundings (their floors are `background=0`).
- **What follows it:** the background grid (old-school blue) takes a shade of the new colour, and hatching whose ink would vanish on it (contrast below 2, e.g. dark hatching on night blue, forest green or black) is drawn in a lighter ink, the colour mixed halfway to white. Overrides that set those themselves (`backgroundGrid.color`, `hatching.color`) win. Maps without the override draw byte for byte as before.
- **Editor:** Map settings → Background: a colour wheel (hue round the ring, saturation towards the rim; drag, or the arrow keys: ← → hue, ↑ ↓ saturation, Shift bigger steps, Enter applies, Esc goes back), a brightness slider, a hex field, the style's own colour and six ready-made ones (parchment beige, slate, forest green, night blue, white, black) and "Reset to the style's colour". Dragging, sliding and typing preview live on the canvas without redrawing the map; letting go (or a pause after the arrow keys) applies it as one undo step. A hint says when the hatching is drawn lighter, shows only faintly, or the rooms are the colour of the background. Code: core `colour-math.ts` (hex, RGB, HSV, WCAG contrast), `background.ts` (`mapBackground`, `withBackground`, `backgroundOps`, `parseBackground`, `backgroundHints`, `BACKGROUND_PRESETS`) and `render/style.ts`; web `colour-wheel.ts` + `colour-wheel-logic.ts`, and the viewer's `previewBackground`.
- **MCP:** `set_map background` takes `"#RRGGBB"` (also `#RGB`, with or without `#`) or `"reset"`, and keeps the other overrides.

### Parchment handout (to print or hand out)

- **What it is:** the players' view of the map, drawn in the parchment style on an aged sheet.
  - **The map:** no room numbers, secret doors shut, and no GM markers or GM symbols. It shows the whole map, unless "only what the players have seen" is on.
  - **The sheet:** paper texture and stains, a torn and burnt edge, and a hand-ruled frame.
  - **Extras:** a title with a flourish, a compass rose, a scale bar in the map's own unit, and a legend (see "The legend" below).
- **Page:** `/maps/:id/handout`, with a "Handout" button in the viewer and "Parchment handout" on the start page.
  - It has a live preview and the options. The preview lies on a wooden table lit by a candle standing beside the sheet (top right; on phones above it): the wood is drawn in code on a canvas (planks, grain, knots, seams; no image files), the table darkens away from the flame, a warm pool of light flickers around it, and the sheet is lit warmer on the candle's side and darker on the far side by an overlay cut to its torn outline, with its shadow falling away from the candle. The flicker animates only transform and opacity and stands still with `prefers-reduced-motion`. "Candle light" under "On the table" (localStorage `delve-handout-candle`) turns the light off for true colours. It's page display only: printing and the PNG, SVG and PDF are the plain sheet, and the Notes tool's clicks pass through the light (`pointer-events: none`). Code: server `handout-table.ts`.
  - Print or save as PDF: the 200 dpi PNG goes on a page of the right paper size.
  - Downloads: PNG at 200 or 300 dpi, and SVG.
- **Images:** `GET /api/v1/maps/:id/handout.png` and `handout.svg`. The query parameters are:
  - `paper`: `a4` (the default), `a3`, `letter`, or `fit` (the sheet is sized to the map).
  - `orientation`: `auto` (whichever way round draws the map bigger), `portrait` or `landscape`.
  - `title`: missing means the map's name; empty means no title.
  - `compass=0`, `scale=0`, `frame=0`, `stains=0`, `legend=0` leave each of those out. `legend=1` draws a legend even for a single entry.
  - `names=1` writes the room names on the map.
  - `revealed=1` draws only what the players have seen.
  - `dpi`: 50–400; PNG defaults to 200, SVG to 96.
  - `download=1` sends the file as an attachment.
- **Response:** the header `x-handout-size: <w>x<h>pt` gives the sheet size, and the PNG corners outside the torn edge are transparent.
- **Big maps:** past 1500 squares of wall (a city), the hatching is left out. It would take seconds and only look busy.
- **Code:** core `render/handout.ts`, server `handout-page.ts`.
- **Don't use `feDisplacementMap`** in anything resvg renders. It panics on uneven region rounding (e.g. A3 at 60 dpi), and the panic aborts the whole server.
- **Keep handout geometry on the page:** a cropped sheet with the whole map's geometry running far past the page made resvg panic under a stain's blur filter (geom.rs `unwrap` on `None`), so cropped handouts are cut to their frame first (`cropScene`).
- **resvg also panics** when what a clipped or see-through group holds reaches far into negative coordinates (on A4, about 1000 pt left of or above the sheet). Handwritten notes are therefore drawn only when they stay within a quarter sheet of the sheet's edge (core `inscriptionNear`); the same rule, a quarter of the picture's shorter side, keeps far-off `onMap` notes out of map renders.

#### The legend

- **What it is:** a hand-drawn key box (an ink frame like the sheet's, "Legend" with a flourish) listing each kind of thing drawn on this handout once: a small picture in the same art and parchment colours as on the map, and its name in IM FELL English, like the title.
- **What it lists:**
  - **Doors** by style: Door, Double door, Locked door, Portcullis, Archway (open doors count as their style). Each picture is a door in a stub of wall, drawn by the renderer from a tiny sample map.
  - **Stairs** (a few treads in a stairwell), then the props that lead somewhere: ladders, trapdoors, hatches, spiral stairs.
  - **Terrain:** ink tiles and colour textures, by area, as a swatch of one tile. A strip less than half a square deep (the edge of the revealed fog) doesn't count.
  - **Height edges:** Cliff, Rock face, Slope, Step, when height areas are drawn.
  - **Props**, ink, colour and custom alike, by how often they appear. A group of variants is one entry, named from the catalog (core `groupName`): c-oak-a, -b and -c are "Oak", the two red Persian rugs "Persian rug, red", the market stalls "Market stall". Its picture is the variant there is most of, upright, scaled to fit the icon (a big tree shrinks to one icon). Two groups that would share a name get fuller ones ("Oak", "Oak, autumn"). Map parts (the compass rose, title cartouche and other cartography props) aren't listed.
  - **Never:** anything players don't see on the sheet. Hidden and `gmOnly` props (hidden traps), GM symbols, markers, secret doors and room numbers aren't in the handout's scene, which the entries come from. With `revealed=1`, only what lies in the revealed fog; with `crop=`, only what lies inside the crop.
  - **Order:** doors, stairs, ladders and trapdoors first (classic dungeon keys open with these), then the ground (terrain, height edges), then props from the most common. So a capped legend drops only the rarest props.
  - **At most 24 entries**, then "and N more". Names over 28 characters are cut at a comma or a word.
- **Where it goes:** in a corner inside the margins, clear of the map's ink (its floor grown by the hatching, terrain, props, labels), the title, the compass rose, the scale bar and handwritten notes, in 1 to 6 columns.
  - **Which corner:** of the corners where it fits, the one with the most empty paper around the box (up to 3 icons' worth), weighed against a box that's too long or too flat; then bottom right first, the compass's corner last.
  - **No corner has room:** the map is moved away from a corner (centred the other way where it fits), then shrunk in 3 % steps down to 60 %. The biggest map that leaves room wins, which on a sheet the map spans makes a strip along a margin.
  - **A sheet fitted to the map** (`paper=fit`) keeps the map's size and grows a strip under it (above the scale bar) or beside it, whichever adds less paper.
  - The `x-handout-frame` header always gives the map's final place and size, so the Notes tool stays lined up.
- **Default:** on when there are at least 2 entries (a map with only plain doors gets none). `legend=0` gives the sheet byte for byte as it was before the legend. The page has a "Legend" checkbox under "On the sheet"; `/maps/:id/handout?legend=0` opens it unchecked, and `legend=1` keeps a one-entry legend.
- **Code:** core `render/legend.ts` (`legendEntries`, `groupName`, `legendLayout`, `InkMask`: a coarse grid of where the map has ink, with running sums so every box test is instant) and `render/handout.ts` (`placeLegend`, `legendSvg`). Terrain swatches fill with the map's own tile patterns (`sceneToSvg`'s `patternPrefix`), so each tile is in the file once.

#### Handwritten notes on the handout

- **The object:** `{ type: "inscription", id, text, at, size?, rotation?, ink?, onMap? }` (ids `w1`, `w2`…).
  - `text`: 1–300 characters, not blank; `\n` starts a new line.
  - `at`: the middle of the text in squares, like a label's. It may lie outside the rooms, in the sheet's margin.
  - `size`: the text height in squares (default 0.8, at most 20). On a dungeon on A4, 0.8 squares is about 15 pt.
  - `rotation`: tilt in degrees clockwise, −180 to 180. A few degrees looks hand-made.
  - `ink`: `brown` (the default), `black`, `faded` or `red`.
  - `onMap`: also draw it on the normal map renders (both views, the editor, Delve Table pages). By default a note is on the handout only.
- **Who sees them:** they are for the players. They're on every handout, and fog of war never hides them: the GM writes them on purpose, often in unexplored parts ("Here be dragons"). To keep one back, delete it until later.
- **The look:** IM FELL English Italic (`/fonts/im-fell-english-italic.ttf`, shipped in `release/fonts` and loaded by resvg). Each line is tilted by up to 0.8° and nudged sideways, each word rides a little up or down, is a touch bigger or smaller and a little darker or lighter, and a soft halo of the same ink (a 20% stroke under the letters) looks like ink bled into the paper. The randomness comes from the map seed and the note's id, so a note never shifts between renders. Plain text and strokes only, no filters. On the handout, notes are drawn over everything, in the sheet's own frame, so they can run into the margin; they are clipped by the torn edge.
- **Everywhere else:** ops (`add`, `update`, `move`, `delete`, undo) like any object. `describeMap` lists them under "Handout notes". Segments carry them (they keep their own tilt when a segment turns). The Dungeon Scrawl export leaves them out.
- **The page's Notes tool** (GMs with the editor login only; players and visitors see the handout without it). Under "Handwritten notes", "Write notes on the sheet" turns it on:
  - A click on the parchment opens a small box at that spot. Enter starts a new line; Ctrl+Enter or a click elsewhere saves; Esc cancels.
  - Drag a note to move it, and arrow keys nudge it (Shift: half a square). Double-click it (or press Enter) to change its text; emptying the text deletes it. Delete or Backspace removes it, and Ctrl+Z / Ctrl+Y undo and redo.
  - The panel sets the selected note's size (in points on this sheet), tilt, ink and "Also on the normal map". With no note selected, it sets them for new notes, which also keep the last size and ink used. New notes get a random tilt of −3° to 3°, and 0.8 squares unless that would be under 9 or over 24 pt on the sheet (then 14 pt).
  - Every change is a normal op (`POST /api/v1/maps/:id/ops` with the editor login, same origin, `by: "handout"`), so the editor and viewers follow and undo works. The page follows the map live over the WebSocket.
  - While the tool is on, the preview is drawn with `inscriptions=0`, and the page draws the notes on top itself (`/assets/handout.js`, `apps/web/src/handout.ts`, with core's own renderer and the page's copy of the font), so they move as you drag. A note that runs too far off the sheet to be printed shows faint. Printing and the downloads always have the notes.
- **The images' extras:** `inscriptions=0` leaves the notes out of `handout.png` / `handout.svg`, and the header `x-handout-frame: {"w","h","x","y","k","x0","y0"}` says where the map sits on the sheet: the square (`x0`, `y0`) is at (`x`, `y`) points and a square is `k` points, so a sheet point (X, Y) is the square (x0 + (X − x)/k, y0 + (Y − y)/k). `w` × `h` is the sheet in points.
- **In the editor:** notes show as a dashed box turned with the note; the ones only on the handout also show their text, faint. Select, move, duplicate and delete them like labels; the inspector has text, size, X/Y, tilt, ink and "Also on the map". Placing happens on the handout page.
- **MCP:** `add_inscription` (see below), then the usual `update` (e.g. `{"text": "…", "ink": "red", "onMap": true}`), `move` and `delete`.
- **Code:** core `inscriptions.ts` (inks, `inscriptionSvg`, `inscriptionBounds`, `inscriptionNear`) and `render/handout.ts`; web `handout.ts` + `handout-logic.ts` (the page's tool) and `inscriptions.ts` (the editor's drawing and inspector).

### Dungeon Scrawl `.ds`

- **Export** writes the floor (rooms, corridors and cutouts merged into one outline), normal/locked/barred doors, room numbers and labels. Secret doors become an "S" in the GM view and plain wall for players; archways stay open. Stairs and Delve's styles don't carry over (Dungeon Scrawl uses its own).
- **Import:** `POST /maps/import.ds?name=` with the raw file as `application/octet-stream` (token or editor login). Returns `201 { id, rev, map, notes }`. Dungeon Scrawl keeps only the merged outline, so the floor comes in as one polygon room per area (holes become cutouts), door stamps become doors and text becomes labels. `notes` says what came across and what was left out. Bad files get a `400` that says why. The start page has an "Import .ds" button.

### Cities from Watabou's Medieval Fantasy City Generator

- **Where the file comes from:** in the generator, Menu → Export as → JSON. It's version 0.11 or later: metres, with y pointing north.
- **Request:** `POST /maps/import.city?name=&unit=10%20ft&style=clean` (`unit` is the square size in feet or metres, e.g. `3 m`; the older `feet=10` still works) with the file as `application/json` (token or editor login). Returns `201 { id, rev, map, notes }`. The start page has an "Import city (Watabou JSON)" button with a scale choice.
- **What comes across:**
  - Buildings become rooms, pulled apart by 0.4 m so each keeps its own walls. The keep ("prisms") becomes a Landmark room.
  - Each city or castle wall becomes wall strips, a round tower at every corner, and a gap where a road passes through a corner (a gate). A small gatehouse stands on each side of every gate.
  - Terrain: roads and plazas become cobblestones and flagstones, rivers and water become deep water, fields become dirt, and parks become grass.
  - Trees become tree props and districts become name labels, and a compass rose is added.
- **Crop and scale:** the map is cropped to the city (buildings, walls, plazas and 30 m around), not the generator's whole landscape. Default scale is 10 ft per square, and `feet=5` gives true scale. The style defaults to clean, because hatching around hundreds of houses is slow and busy.
- **Streets:** the export has no street shapes inside the walls; the streets are the gaps between buildings.
- **Dungeon Scrawl:** the result exports to `.ds` like any map, one outline per house.
- **Code:** core `fromWatabou`.

### Tracing a map picture (PNG, JPG, WebP)

- **Page:** `/import/image`, linked from the start page as "Trace a map picture". The picture never leaves the browser: `/assets/trace.js` runs the page, and `/assets/trace-worker.js` does the work, so the page stays responsive. Only the finished map goes to the server, through `POST /api/v1/maps` with `{ map }`, which needs the editor login.
- **Steps:**
  1. Load the picture (choose, drop or paste). Pictures bigger than 2000 px are shrunk first.
  2. Delve looks at it (`analysePicture`): its main colours, a printed grid, whether it is painted or textured, and the kind of map. The kind can be switched:
     - **Dungeon or battle map:** light floor inside dark wall lines (Dungeon Scrawl, DungeonFog, One Page Dungeon, Delve's own renders, drawings and scans).
     - **City plan:** flat colours (Watabou's generator) or painted (RPG city maps).
     - **Painted or textured** (a checkbox, set when the picture has a lot of texture): the colours are found on a smoothed copy (a Kuwahara filter: textures, brush strokes and the lit and shaded side of a roof flatten, edges stay).
  3. Set the scale, and **1 square =** any of `SQUARE_SIZES` (5, 10, 20 ft or 1, 1.5, 2, 3, 5 m). The map gets that unit (`grid.unit`). The scale comes from one of:
     - **Grid** (the default when a grid was found): one grid cell is one square. The cell size in px and how many squares a cell is can be changed. **Grid lines** (a tool): click two grid lines and say how many squares apart they are.
     - **Scale bar:** **Measure** both ends, then enter its length in m or ft.
     - **Width:** the whole picture's width in m or ft.
     - The page draws the squares over the picture (pink when they come from the grid), so the scale can be checked. Without a printed grid, dungeon pictures start from the lattice their straight walls stand on (`wallLattice`: the same frequency fit on the wall lines' centres, near a first guess from the wall thickness, walls being about 0.12 squares thick), and say so.
  4. Check the colour roles. Roles: ignore, building/room, wall, water, road, grass, field, sand. They read by kind: in a dungeon "building" is the floor and "wall" the wall lines (and text); in a city "wall" is the city wall.
  5. Optionally crop, check the outlines over the picture or the finished map, then Create map. It opens in the editor.
- **Dungeon mode** (`trace/dungeon.ts`):
  - Ink is the wall colours (plus the soft grey edges darker than halfway to the floor). Thick ink, what survives an opening a little thinner than the measured wall width, is a wall; thin ink (grid lines, text, hatching strokes, door leaves, furniture) is not.
  - The parts that walls enclose are floor when they are mostly floor coloured, walled all round, not cut by the picture's edge and, with a grid, show the grid; without a grid, hatched rock is told apart by its many strokes. The ground round the map, rock between rooms and the inside of pillars are left out.
  - Door leaves (small light rectangles in an ink outline, a quarter of a square thick) close their gap while the floor is looked for, so a door to the outside doesn't open the floor to it. They become Delve doors on the half-square grid; the floor runs through the opening.
  - Holes over a third of a square stay (pillars and pits as cutouts, solid when they are mostly ink); smaller ones (room numbers, text, symbols) are filled.
  - The floor grows half a wall into the walls, because a map's wall line is drawn on the floor's edge. A thin wall with floor on both sides (two rooms behind one wall, a shut secret door) stays as a solid cutout named "Wall", and the floor runs on under it.
  - Each floor area is split into rooms and corridors (`trace/rooms.ts`): every pixel's local thickness (the biggest disk, and the biggest square, inside the floor that covers it); pieces are where both change gently, crumbs and thin strips join a neighbour, and pieces longer than three times their width (up to 2.6 squares) are corridors.
  - Outlines are tidied (`trace/snap.ts`): straight walls along x, y or at 45° within 0.2 squares of a half-square line move onto it (not into a neighbour behind a thin wall), corners are rebuilt where the walls meet, short kinks go, and curves (round rooms, caves) stay smooth polygons.
  - Water (blue) and grass (green) inside are terrain.
- **City mode, flat colours** (`trace/trace.ts`), as before:
  - Buildings become rooms. Courtyards stay holes (cutouts). Small holes, like printed text, are filled.
  - Walls become rooms named "Wall". A shape with a hole, like a ring wall, is split into solid pieces that overlap by a pixel.
  - The other roles become terrain.
  - A printed grid is removed: straight lines up to 3 px thick that cross at least 12% of the picture; short lines such as house outlines stay.
  - Each role skips parts thinner than a set width in squares. Walls default to 0.5 and water to 1, which drops text, outlines and house shadows in those colours.
  - Pieces under 0.3 squares are dropped. Touching buildings can be joined into blocks.
  - Its colours are plain RGB k-means (7 by default) and its roles the old guesses, so flat plans trace as they always did.
- **City mode, painted** (`trace/painted.ts`; sizes scale with the picture, for one about 1300 px long):
  - Colours in Lab on the smoothed copy (12 by default), roles from hue and layout: red to brown roofs (both shades) are buildings, grey or dark olive the wall, pale cyan to blue water, greens grass, light yellow fields, the sandy colour among the houses streets, white and black left out.
  - Houses: the roof colours as the unsmoothed picture has them (there the thin gaps of street between touching houses are still open), ridge highlights, tiles and printed numbers filled, strong dark lines part touching houses. Each house is squared up: its oriented rectangle, or right angles in its own direction; a block of several houses is cut into rectangles when they cover it well. Join touching buildings makes blocks instead.
  - The city wall: the long thin lines of the wall colour (its blobs are dark roofs), and "houses" far longer than wide. Round and square buildings standing on the wall line are its towers (circles named "Tower").
  - Water (brooks a few pixels wide too), streets, gardens and fields become terrain with their holes. Anything inside a big pale area (a legend box, a cartouche) is left out.
- **Command line:** `npm run trace -- picture.png out.delve.json [--mode dungeon|city] [--painted|--flat] [--unit "2 m"] [--px-per-square N | --ppm N | --width N | --width-ft N] [--colours 8] [--roles ignore,building,...] [--min water=1.5] [--join] [--render out.png]`. `--ppm` is picture pixels per metre (from a scale bar). Dungeon pictures with a grid need no scale. It prints what it found and reads PNG only (decoded with `node:zlib`).
- **Benchmark:** `npm run trace-bench -- [--set full|quick|perf] [--out dir] [--verbose] [--timings] [--legacy [--true-scale]] [--city feyvale.png] [--sample painted.png --sample-ppm 2.18 --sample-unit "2 m"]` renders the bench maps (`apps/server/src/cli/trace-bench-lib.ts`: the test dungeon and six more, every style, 30–100 px per square, with and without the grid, noisy, blurred, with room numbers), traces them as the page does and prints floor IoU, scale error, room count, the share of outline points on half squares and the time. `--out` writes the pictures and overlays. `apps/server/test/trace-bench.test.ts` holds a fast subset to thresholds (IoU ≥ 0.95, scale within 2 %).
- **Code:** core `trace/colour.ts` (Lab, `mainColours`, `classify`, `colourStats`), `trace/grid.ts` (`detectGrid`), `trace/smooth.ts` (`kuwahara`, `textureShare`), `trace/analyse.ts` (`analysePicture`, `coloursForMode`, role guesses), `trace/dungeon.ts`, `trace/rooms.ts`, `trace/snap.ts`, `trace/painted.ts`, `trace/raster.ts` (masks, outlines) and `trace/trace.ts` (`traceImage`, `guessRoles`, `tracedMap`).

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
| `get_map`, `describe_map` | Full JSON / plain-text summary (with the GM notes of rooms, corridors and terrain) |
| `add_room` (`rect` \| `poly` \| `circle` \| `preset`, `name?`, `label?`, `notes?`) | The room number defaults to the next free one. `preset` is `{kind: oval/triangle/hexagon/octagon, box: [x, y, w, h]}` |
| `connect` (`from`, `to`, `width?`=2, `doors?` none/from/to/both, `door_style?`) | Auto-routed corridor that follows its rooms, meeting any room shape at its real outline, with doors across its mouths (see "Corridors between rooms of any shape") |
| `reroute` (`map`, `ids?`) | Redoes corridors (default all) with the outline routing; doors at their ends move to the new mouths. One undo step |
| `add_cutout` (a shape or `preset`, `fill?` solid/rock), `add_door` (`at` + `along` or `angle`, or `near` a wall; `width`, `style?`, `open?`), `add_stairs`, `add_label` | Details. Doors can sit in walls at any angle (see "Doors") |
| `add_opening` (a shape or `preset`, `walls?`, `name?`) | An open area: no hatching, shading or shadow inside; with `walls` no wall lines either (see "Open ends and open areas") |
| `add_height` (a shape or `preset`, `height`, `edge?` cliff/rock/slope/step, `name?`, `notes?`, `hidden?`) | Raised or sunken ground: a ledge, a hill, a pit, a mountain's plateaus; says how it is reached (see "Heights within a map") |
| `list_assets` (`category?`, `search?`), `add_prop` (`asset`, `at`, `rotation?`, `scale?`, `notes?`, `avoid?`), `add_props_along` (`asset`, `path`, `spacing?`, `placement?`, `spread?`, `overlap?`, `seed?`), `add_terrain` (`asset`, one shape, `edge?` hard/ragged/fade, `fade_width?`, `edge_details?`, `stack?`) | Furnishing and ground. Terrain areas fade into each other by default (see "Terrain edges"). `add_props_along` skips spots on trees, boulders and walls; `add_prop` warns with the ids it overlaps and the nearest free spot (`avoid` moves it there); `apply_ops` names new props that overlap (see "Keeping props apart") |
| `add_marker` (`kind` discover/interact/trap, `at`, `text`) | A GM note badge (GM view only); `update` with `{"done": true}` strikes it through |
| `add_inscription` (`text`, `at`, `size?`, `rotation?`, `ink?` brown/black/faded/red, `on_map?`) | A handwritten note on the players' parchment handout ("Here be dragons"); `on_map` also writes it on the normal map. See "Handwritten notes on the handout" |
| `list_images`, `add_image` (`src`, `at`, `w?`, `h?`, `rotation?`, `layer?`, `opacity?`, `gm_only?`) | The user's uploaded pictures, placed by `src` |
| `prop_rules` | How to draw a prop: the art rules, condensed, with two clean example SVGs and a built-in one |
| `create_prop` (`name`, `w`, `h`, `svg`, `category?`, `tags?`, `blocks?`, `ink?`, `id?`), `update_prop` (`id`, any of those), `get_prop` (`id`), `delete_prop` (`id`, `force?`) | This Delve's own props (see "Custom props"). A refused drawing comes back with what to fix, a saved one with the preview picture (an MCP image) and a link to it. `get_prop` also returns the drawing as sent and the maps that use it |
| `add_level` (`name`, `position?` above/below, `current_name?`) | Adds a storey (a new map in the same group) |
| `label_stairs` (`map`) | Numbers every stair of the place: 0A, 1A, 2A… (GM view only) |
| `list_segments`, `save_segment` (`name`, `ids` \| `rect`), `place_segment` (`segment`, `at`, `rotation?`), `fill_with_segment` (`segment`, `rect` \| `around?`=5, `margin?`, `vary?`) | Saved pieces of maps: save, place a renumbered copy, fill the land around the rooms (see "Segments") |
| `move`, `resize`, `update`, `delete`, `set_map` (name, style, background `"#RRGGBB"` or `"reset"`, overrides, seed, roughness 1–10, level_name, floor) | Changes; `add_room` also takes `roughness`. `update {"notes": "…"}` writes GM notes on a room, corridor or terrain (see "GM notes"); `update {"edge": "ragged"}`, `{"fadeWidth": 3}`, `{"edgeDetails": false}` or `{"stack": 6}` changes a terrain area's edge (see "Terrain edges") |
| `undo`, `redo` | History |
| `render` (`view?`, `style?`, `ppg?`=24) | Returns a PNG image, so Claude can look at its work |
| `export` (`format?` png/svg/ds/handout, `view?`=players, `ppg?`=70, `crop?` [x, y, w, h], `around?` ids, `margin?`=1, `legend?`) | A download link for the user; `handout` links the parchment handout page. `crop` / `around` crop png, svg and handout to whole squares (see "Cropped exports"). `legend` (handout only): `false` opens the page without the legend, `true` keeps even a one-entry legend (see "The legend") |
| `focus` (`ids`) | Pans and highlights every open viewer |
| `plan` (`steps: [{title, status}]` with status `pending` \| `active` \| `done` \| `skipped`, `note?`) | Claude's plan for the editor's chat panel (a checklist with a progress bar and time left; see "Claude's plan"). Each call replaces the whole plan; it says "ok" and changes no map. Elsewhere it shows nowhere |
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
| `plan {steps: [{title, status}], note?, mode?}` | Claude's plan, the whole list each time (see "Claude's plan"). Calls of the `plan` tool and of the task list come only as these, never as `tool` / `tool_done`. `mode: "activity"`: Claude has no plan, and the steps are what it has been doing |
| `usage {fiveHour, sevenDay}` | Subscription use, 0 to 1 of each window |
| `done {ok, turns, ms, error?}` | The reply is complete |
| `error {error, code?}` | Something failed. `code` `no_session` means start a new conversation |

- **Closing the request stops Claude.** Changes it already made stay, and undo removes them.
- **Limits:** a run stops after 5 minutes, and at most 2 run at once (`429` otherwise).
- **Bridge health:** `curl http://127.0.0.1:8792/health` on the CT.

### Claude's plan: steps, progress and time left

For bigger requests the chat panel shows what Claude is working on: a checklist with a progress bar and an estimate of the time left, at the top of its reply.

- **Where the steps come from (2026-10-03):** Claude ignored the MCP `plan` tool (109 tool calls in three chats without one), so the bridge now also offers Claude Code's own task list, the checklist it is trained to keep: `--tools TaskCreate,TaskUpdate,TaskList`, nothing else built in. The prompt asks for one task per step with TaskCreate before any other tool, then TaskUpdate to `in_progress` and `completed`; the last line of the context block repeats it. `chat/events.ts` turns the tasks created in a run into `plan` events (`in_progress` is active, `completed` done, `deleted` skipped; a task's number comes from its result, "Task #4 created successfully") and never shows these calls as tools. The `plan` tool still works the same way.
- **When Claude doesn't keep the list up to date, or has none (2026-10-06):** Sonnet without Claude Code's own system prompt often creates its tasks and updates them late (chat 250589df: 4 tasks, then 9 prop lookups and 75 s before the first `in_progress`) or makes none at all (chat a06cd203: 11 messages, 148 tool calls). `chat/events.ts` now fills the gaps, so the card always shows the work:
  - **Tasks without updates:** a map tool call while no step is active makes the first pending one active; a step completed while no other is active makes the next pending one active. What Claude sets always wins: a guessed step goes back to pending as soon as Claude starts another one. A TaskUpdate sent in the same message as its TaskCreate (before the result gives the number) is applied once the number arrives.
  - **The end:** when the run ends well, every step still open (active or pending) is finished in one last `plan` event before `done`, so the reply reads "✓ 4 steps". An error or a Stop keeps the real state.
  - **No plan at all:** after 4 map tool calls (`ACTIVITY_AFTER`) without tasks or a plan, a `plan` event with `mode: "activity"` lists what Claude has been doing, grouped into phases by tool kind (`activityKind`): "Looking through the props", "Building rooms and corridors", "Adding doors and stairs", "Placing props", "Painting terrain", "Shaping heights", "Writing labels and notes" (labels, markers, notes), "Placing saved pieces", "Checking the map" (render, describe_map, get_map), "Showing the result" (focus), "Adjusting the map" (update, move, delete, undo…) and a few more. `apply_ops` counts as what it adds most. Consecutive calls of one kind are one phase; the phase is active while its tools run and done when another kind starts; a kind that comes back takes up its old step again. Tasks or a plan that arrive later replace it. The phase names are English only.
  - The prompt now spells the task list out with an example: all TaskCreate calls in one message first, then for each step TaskUpdate `{"taskId": "1", "status": "in_progress"}` together with the step's first tool call and `"completed"` together with the next step's first call, everything completed before the answer.
  - Replays: `fixtures/chat/tasks-without-updates.jsonl` and `no-tasks-11-runs.jsonl` are the two chats, shrunk from Claude Code's transcripts (tool and task calls, the kinds of objects `apply_ops` added, short results; no context blocks or map ids); `chat-plan.test.ts` replays them.

- **The tool:** for a request with 3 or more steps, the prompt ("Showing your plan" in `chat/prompt.ts`) asks Claude to call MCP `plan` first, with short, concrete step titles in the user's language ("Make room 3 an octagon", "Place 6 chairs") and the first one active, then again after each step with the whole list (that step done, the next active). It may add steps or mark them skipped as things change, and sends every step done or skipped before its answer. Small requests get no plan.
  - It is a Delve tool, not Claude Code's TodoWrite, because the bridge runs Claude with Delve's MCP tools only (`--tools ''`, `--allowedTools mcp__delve`), and that should stay that tight.
- **The events** (`chat/events.ts`): each plan call becomes `plan` events and is left out of the tool list. The tool input is parsed while it streams in (`input_json_delta` pieces; `chat/partial-json.ts` keeps only the steps that are complete), so the plan shows while Claude is still writing it. While a later call streams in, its finished steps replace the first ones of the last plan and the rest stay, so the list never shrinks on the way. Repeats aren't sent.
- **The panel** (`apps/web/src/chat.ts`; the pure part, `plan-progress.ts`, has the timing, bar and estimate):
  - The card: "Step 2 of 5", the estimate, the bar, and the steps (○ to do, dots for the active one, ✓ done, ‒ skipped and struck through). In a chat log at least 400 px tall it stays at the top of the log while the reply scrolls under it.
  - **The bar:** done and skipped steps, plus a share of the active step: by its tool calls (each fills 35 % of what is left of it) or by its time against the average step, whichever is more, and at most 90 % of a step, so it never reaches the next step early. It glides between updates (no animation with reduced motion).
  - **The estimate:** once a step is done, the average time per done step (from the first plan to the latest done step, divided by the done steps) times the steps still to go, less what the active step has used so far (it counts at least a quarter step while it runs). Before the first step is done it says "estimating…", once every step is done or skipped "finishing…". Always rounded and "about": "a few seconds left", "about 15 s left", "about 40 s left", "about 1 min left", "about 2 min left". It updates once a second. Times are as the browser saw the events.
  - **Afterwards** the reply keeps a summary line: "4 steps · 1 min 12 s" (from sending to the end of the reply), "3 steps · 1 skipped · 50 s", "3 of 4 steps done · 56 s", "Stopped at step 3 of 5 · 48 s" (Stop), "Ended at step 2 of 5 · 17 s" (an error). The checklist folds away after a good run (the line unfolds it) and stays open where a run stopped or failed, with the step it ended on marked. When a reply ends well, a step still marked active counts as done (Claude sometimes skips the last update). The plan is saved with the conversation in the browser.
  - **The activity list** (`mode: "activity"`): the card is titled "What Claude is doing" and shows the time so far ("26 s so far") instead of an estimate, with a bar that only moves to say Claude is working (no fill, so it promises no total; a faint full bar with reduced motion). Afterwards: "What Claude did · 6 steps · 41 s", or "Stopped while placing props · 48 s" / "Ended while …". When Claude's own tasks replace it, the card starts over with their step count and estimate.
  - **"Show Claude's plan":** the checklist button in the panel's header hides all of it (remembered per browser: localStorage `delve-chat-plan`, on by default). While a reply runs, the "Editing live" tag takes the model picker's place in the header, so the buttons keep their room.
- **Tests:** `apps/server/test/chat-plan.test.ts` (the parser, recorded stream-json with plan calls cut into pieces, the MCP tool, the prompt, the fallback rules and the activity list, replays of the two real chats, and whole runs with a fake `claude` through the bridge and `/chat`) and `apps/web/test/plan-progress.test.ts`.

## Selecting and resizing in the editor

- **Box selection (Select, V):** drag on empty ground to draw a box; everything whose bounds lie wholly inside is selected (a door counts by its line, GM markers not in the players' view). Shift or Ctrl adds to the selection, Ctrl-drag draws a box from anywhere (over rooms too), and Esc cancels the box and puts the old selection back. Open areas are invisible until selected, so a drag on one draws a box and a click selects it.
  - The context bar shows the count ("12 objects"), and the inspector the kinds and the size they span. Dragging any selected object moves them all (a click on one picks just it), and the arrows, Delete, Ctrl D, Q / E (props and pictures each turn), "Save as segment" and Export → Crop to selection all work on the whole set.
  - Panning: H or Space with the left button, or the middle or right button in any tool (the map has no browser context menu).
  - Touch: one finger on empty ground pans (a tap clears the selection or picks an open area); the context bar's **One-finger drag: Pan | Box** switch (on touch devices) makes it draw a box instead. A second finger always cancels what the first was drawing and pinches.
  - Code: `apps/web/src/edit-logic.ts` (`boxSelect`, `mergeSelection`, `clickSelection`, `pressesGround`, `groundDrag`, `cropToSelection`).
- **Resizing props and pictures:** a selected prop or picture has a handle on each corner (turned with it; a 44 px target on touch).
  - A prop scales uniformly about its centre, by whichever side the pointer pulls further, in steps that keep both sides of its footprint whole half squares (a 1 × 1 barrel steps 50 %, a 2 × 2 table 25 %); Alt is free (1 %). It stays within 25–400 %, and a chip shows the size while dragging ("3 × 1.5 sq · 150 %"). One `update` of `scale`, so one undo step. Props never stretch.
  - A picture takes the width and height the pointer gives, about its centre, in half squares (Alt free, Shift keeps its proportions): one `update` of `w` and `h`.
  - The prop inspector has Width and Height in squares next to the Scale slider; either sets the scale and the other follows.
  - Code: `edit-logic.ts` (`corners`, `cornerAt`, `scaleStep`, `snapScale`, `scaleFromCorner`, `sizeFromCorner`, `sizeText`).

## Live viewer: `/maps/:id`

A read-only page:
- **First paint:** rendered on the server, so the map shows before the script loads.
- **Live changes:** the browser bundle `/assets/viewer.js` (built from `apps/web` by esbuild) redraws with `@delve/core` on every change and briefly highlights what changed.
- **Controls:** drag to pan; wheel, `+` and `-` to zoom; double-click or `F` to fit. It follows `focus` with a short animation and an orange highlight.
- **Options:** GM or players' view, style preview, a Roll20 PNG button.
- **Connection:** it reconnects by itself (for example across a release) and resyncs if it missed a revision.

## Feature requests: `/feedback`

"Request a feature": a form where people ask for features or report problems. Every request is appended to a text file that only admins read. Code: `apps/server/src/feedback/` (`log.ts` the file and the limits, `routes.ts`, `page.ts`).
- **The form** (`GET /feedback?from=<path>`): kind (Feature idea, Problem / bug, Other), a title (required, ≤ 120 characters), a description (required, ≤ 4000), optionally the map or page it is about (prefilled from `from`, ≤ 200) and a name (prefilled from the login, ≤ 60). After sending it shows a thank-you and an empty form.
- **Who may send:** admin and GM accounts, the shared editor login while it still counts, Delve Table players (a valid player cookie from an invite link, or a Discord login with a seat in a game) and the Discord co-GMs. Everyone else, public visitors through the tunnel included, gets a short note with the login links (`/login`, and `/auth/discord` when Discord is set up) instead of the form; their posts get 401. `/feedback` is open through the tunnel so players reach it; the form checks the login itself.
- **Who sent it** comes from the login: the account's name and role, the player's seat name and game (and whether it came from an invite link or Discord), "GM at the table" for co-GMs, or "shared editor login" / "open dev server". A typed name is only ever recorded next to that (`… as "Tim"`).
- **Abuse limits:**
  - posts must come from Delve's own origin (403 otherwise), like the other forms;
  - a hidden honeypot field (`website`): if it is filled in, the answer looks like a success but nothing is kept;
  - at most 5 requests per person in any hour and 50 from everyone in any 24 hours (429, the text stays in the form). The counts are kept in memory, so a restart starts afresh;
  - the length limits above, a 64 KB body limit, and typed text cleaned: control characters and bidi marks stripped, one-line fields on one line, line breaks in the description kept as typed (at most one empty line in a row).
- **The file:** `${DELVE_DATA}/feature-requests.txt` (UTF-8, made on the first request; a temp file without `DELVE_DATA`). The form only appends to it; it is never served to anyone but admins. One block per request, numbered in order (the next number is the highest in the file plus one, so hand edits are fine):
  ```
  ==== #12 · 2026-10-03 21:40 · Feature idea · from Robin (GM) · about /maps/map_x
  Title: Legend on the 3D view
  <the description, line breaks as typed>

  ```
  The time is the server's local time. Player names, game names and typed names are in quotes. A description line that starts with `====` gets a space in front, so it can't pass for a header. Each block is written with one append and fsync; a write that fails halfway is cut off again, and a file edited by hand without a final line break gets one before the next block.
- **Reading them (admins only):** `/admin` has a "Feature requests" section with the count, the newest 5, and links to `GET /admin/feature-requests.txt` (the whole file, `text/plain; charset=utf-8`, `no-store`, `nosniff`) and `?download=1` (the same as an attachment). GMs get 403 there (they can send but not read), players and strangers the login redirect (through the tunnel: 303 for pages, 401 otherwise). Before the first admin account exists nobody can read the file in the browser; it is on the container.
- **Links to the form:** the start page's top bar ("Request a feature", wide screens) and footer, the editor's ⋯ menu and the keyboard shortcuts dialog (both with `from=/maps/<id>`), the players' `/play` page and the GM's table lobby, and the players' table top bar (wide screens, `from=/play/<id>`).
- **Tests:** `apps/server/test/feedback.test.ts`.

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
