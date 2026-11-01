# Quillwarren assets: props, environments and the standard kit

Colour props (a second library with a fixed palette) have their own prompt pack: `docs/ASSETS-COLOUR.md`.

This is the art Quillwarren needs, the rules it must follow so the renderer can use it, and ready-made prompts for **Claude Design** (claude.ai/design).

**How to use it:**
1. Make one Claude Design project called "Quillwarren assets".
2. Paste **Prompt 0**, check the look, and ask for changes until you like it.
3. Paste the batch prompts one at a time, in the same project.
4. When a batch is done, download its files, or tell Claude the project, and they go into `assets/` in the repo.

Everything is original artwork. Don't imitate existing packs (Dungeon Scrawl, Dungeondraft, Forgotten Adventures, 2-Minute Tabletop and so on).

## The rules (the renderer depends on these)

### Props

- **View:** straight top-down, like a floor plan. No isometric view, no perspective, no cast shadows (Quillwarren draws its own).
- **One SVG per prop.** 1 grid square = 100 units, so a prop that covers w×h squares has `viewBox="0 0 {w*100} {h*100}"`.
  - Keep 4 units of margin.
  - Small things (a chair, a candle) don't have to fill their square.
- **Plain SVG only:** `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `g`, with `fill`, `stroke` and `stroke-width` attributes.
  - No text or letters.
  - No images, filters, gradients, masks, clip paths, CSS, opacity or transforms other than `translate`/`rotate`.
- **Exactly three colours.** Quillwarren swaps them for each map style (parchment, clean, old-school blue, print), so no other colours are allowed.

  | Colour | Name | Used for |
  |---|---|---|
  | `#000000` | ink | outlines, details, openings |
  | `#FFFFFF` | paper | surfaces |
  | `#999999` | shade | darker surfaces, contents, depth |

- **Filled surfaces:** every surface is filled (paper or shade), so the grid doesn't show through. Holes and openings, like a pit or a well shaft, are ink or shade.
- **Line weights:**
  - outline `stroke-width="4"`
  - inner details `2`
  - fine texture `1.5`
  - round caps and joins (`stroke-linecap="round" stroke-linejoin="round"`)
- **Look:** hand-inked old-school fantasy cartography: slightly uneven pen lines, but crisp and readable at 70 px per square (Roll20's grid).
- **Facing:** anything with a front (chair, throne, bed, fireplace, lectern, altar) faces **south**, down the page, with its back along the top edge. Quillwarren rotates in 90° steps. Wall-mounted things (sconce, fireplace, shackles, shelves) sit against the **top edge**, which is the wall side.
- **Placement in Quillwarren:** a prop's `at` is the centre of its footprint, and it rotates around that point.

### Environments (terrain tiles)

- **Tile size:** 2×2 squares, `viewBox="0 0 200 200"`.
- **Seamless:** the tile repeats, so anything that crosses an edge must continue on the opposite edge. Avoid a single eye-catching feature that shows the repeat.
- **Colours:** ink and shade only, on a transparent background, with no paper fill. Quillwarren lays a tint colour underneath.
- **Weight:** lighter than props (stroke-width 1.5 to 2.5) and sparse enough that props, labels and the grid stay readable on top.

### Files

- Props go in `<category>/<id>.svg`, terrain in `terrain/<id>.svg`, and the other kinds of asset in their own folder.
- Each batch also writes a `manifest.json`: an array with one entry per asset.
  - Props: `{"id", "name", "category", "w", "h", "tags": [...], "blocks": "none" | "movement" | "sight"}`.
    - **none:** you can walk over it (rug, rune circle).
    - **movement:** you can't walk through it but can see past it (table, chest, altar).
    - **sight:** it also blocks the view (wardrobe, bookshelf, large statue, tree). Quillwarren uses this later for Roll20 walls.
  - Terrain: `{"id", "name", "kind": "terrain", "tile": 2, "tint": "#RRGGBB", "difficult": true | false}`. The tint is the suggested base colour on parchment.

## Prompt 0: style sheet (paste first)

```text
I'm building art for "Quillwarren", my own top-down dungeon map editor for tabletop RPGs (maps are used on Roll20 at 70 px per grid square). Please set up a style sheet for a prop library and draw 4 sample props so I can approve the look before we make ~100 of them.

RULES FOR EVERY PROP (the map renderer depends on these):
- Straight top-down view like a floor plan. No isometric, no perspective, no cast shadows.
- One standalone SVG file per prop. 1 grid square = 100 units, so a prop covering w×h squares has viewBox="0 0 {w*100} {h*100}". Keep 4 units margin. Small objects don't need to fill their square.
- Plain SVG only: path, rect, circle, ellipse, line, polyline, polygon, g, with fill / stroke / stroke-width attributes. NO text or letters, NO images, filters, gradients, masks, clip paths, CSS classes, opacity, or transforms other than translate/rotate.
- EXACTLY three colours, because my renderer swaps them per map style: ink #000000 (outlines, details, openings), paper #FFFFFF (surfaces), shade #999999 (darker surfaces, contents, depth). No other colours.
- Every surface is filled (paper or shade) so the grid doesn't show through.
- Line weights: outline stroke-width 4, inner details 2, fine texture 1.5, round caps and joins.
- Look: hand-inked old-school fantasy cartography, slightly uneven pen lines, but crisp and readable at 70 px per square.
- Anything with a front (chair, throne, bed, fireplace, altar) faces SOUTH (down the page), back along the top edge. Wall-mounted things sit against the top edge.
- Original artwork only; don't imitate existing asset packs (Dungeondraft, Forgotten Adventures, Dungeon Scrawl, etc.).

FILES: save each prop as <category>/<id>.svg and add a manifest.json listing every prop as {"id","name","category","w","h","tags":[...],"blocks":"none"|"movement"|"sight"} (none = can walk over, movement = blocks walking only, sight = also blocks view).

Also make one overview card showing all props of a batch on a light parchment background (#F0ECE0) with a faint 100-unit grid, each labelled with its id underneath (labels only on the overview card, never inside the prop SVGs).

SAMPLES for this first step (category "samples"):
1. table-round, 2×2: round wooden table, plank lines, two chairs tucked at south and north
2. chest, 1×1: closed treasure chest with iron bands and lock
3. barrel, 1×1: barrel seen from above, lid planks and hoops
4. statue, 1×1: human statue on a square plinth, seen from above
```

## Batch prompts (paste one at a time into the same project)

Every batch prompt starts with the same short reminder, so each one stands on its own.

### Prompt 1: furniture (16)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "furniture":
1. table-square 1×1: small square table
2. table-rect 2×1: rectangular table, plank grain
3. table-long 3×1: long feast table with a runner cloth down the middle
4. table-round 2×2: round table with 4 chairs
5. chair 1×1: wooden chair, back along the top
6. bench 2×1: plain wooden bench
7. bed-single 1×2: bed with pillow at the top, blanket folded back
8. bed-double 2×2: large bed, two pillows, canopy posts at the corners
9. bunk-bed 1×2: bunk bed with a small ladder on one side
10. bedroll 1×2: rolled-out bedroll with a pack at the head
11. wardrobe 2×1: tall wardrobe against the wall, doors closed (blocks sight)
12. bookshelf 2×1: bookshelf against the wall, book spines visible from above (blocks sight)
13. desk 2×1: writing desk with open book, quill and inkpot
14. throne 2×2: carved throne on a small dais with one step at the front
15. bar-counter 3×1: tavern bar counter with tankards
16. fireplace 2×1: stone fireplace set into the wall, fire opening facing south, logs and embers (embers in shade)
```

### Prompt 2: storage and treasure (17)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "storage":
1. chest 1×1: closed chest (match the sample)
2. chest-open 1×1: open chest, lid up at the top, coins inside (shade)
3. barrel 1×1: single barrel (match the sample)
4. barrels 2×2: cluster of 4-5 barrels, one on its side
5. crate 1×1: wooden crate, cross-braced lid
6. crates 2×2: stack of crates, different sizes, one smaller crate on top
7. sack 1×1: tied grain sack
8. sacks 2×1: pile of sacks
9. supply-shelf 2×1: wall shelf with jars, boxes and bottles
10. urns 1×1: two or three clay urns

Category "treasure":
11. coins 1×1: scattered pile of coins and a few gems
12. hoard 2×2: treasure hoard, heaped coins, goblet, crown, chest half buried
13. weapon-rack 2×1: rack against the wall with swords, spears and an axe
14. armor-stand 1×1: armor on a stand, helmet visible from above
15. war-table 2×2: map table with a spread-out map (just lines, no text), markers and candles
16. books 1×1: stacked books and loose scrolls
17. mirror 1×1: ornate standing mirror seen from above
```

### Prompt 3: temple and arcane (14)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "temple":
1. altar 2×1: stone altar with cloth, candles and a bowl
2. altar-grand 3×2: grand altar on a raised step, carved edges, offerings
3. statue 1×1: human statue on a plinth (match the sample)
4. statue-large 2×2: large statue of a robed figure with outstretched arms on a round base (blocks sight)
5. sarcophagus 1×2: carved stone sarcophagus with an effigy lid
6. coffin 1×2: plain wooden coffin
7. tombstone 1×1: rounded gravestone with a grave mound in front
8. font 1×1: stone basin on a pedestal, water in shade
9. lectern 1×1: lectern with an open tome, front facing south
10. summoning-circle 3×3: magic circle, nested rings, arcane symbols (abstract glyphs, not letters), candles at 5 points (blocks: none)
11. rune 1×1: single glowing floor rune, abstract glyph (blocks: none)
12. obelisk 1×1: square obelisk seen from above, pointed tip, carved faces
13. orb-pedestal 1×1: crystal orb on a pedestal
14. idol 1×1: squat idol statue with offerings around its base
```

### Prompt 4: dungeon features and hazards (18)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "dungeon":
1. pillar-broken 1×1: toppled column stump with fallen pieces
2. rubble 1×1: small pile of stones
3. rubble-large 2×2: collapsed ceiling debris, big blocks and small stones
4. pit 1×1: open pit, dark inside (ink), jagged rim
5. spike-trap 1×1: floor spikes poking up in a grid
6. pressure-plate 1×1: slightly raised stone plate with a thin gap around it
7. well 2×2: round stone well, dark water shaft (ink), bucket and crank
8. cage 1×1: iron cage, bars seen from above
9. stocks 1×1: wooden stocks
10. rack 1×2: torture rack with rollers at both ends
11. shackles 1×1: chains and shackles hanging from the wall (top edge)
12. lever 1×1: wall lever against the top edge
13. trapdoor 1×1: closed wooden trapdoor with an iron ring
14. ladder 1×1: ladder going down through a square hole
15. stairs-spiral 2×2: spiral staircase, wedge steps around a central post, darker toward the bottom
16. bones 1×1: scattered bones and a skull
17. skeleton 1×2: skeleton lying on the floor, head at the top
18. web 2×2: large spider web spanning a corner (web anchored at the top-left)
```

### Prompt 5: kitchen, workshop and light (16)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "workshop":
1. cooking-fire 2×2: open cooking fire in a stone ring with a spit and pot
2. cauldron 1×1: big iron cauldron, contents in shade, bubbles
3. oven 2×1: brick bread oven against the wall, opening facing south
4. anvil 1×1: anvil on a stump
5. forge 2×2: smithy forge with coals (shade), bellows and a chimney hood along the top edge
6. workbench 2×1: carpenter's bench with tools
7. alchemy-table 2×1: flasks, alembic, mortar and pestle
8. loom 2×1: weaving loom
9. grindstone 1×1: round grindstone in a frame
10. keg-rack 2×1: kegs on a rack against the wall

Category "light" (Quillwarren will use these later as light sources):
11. sconce 1×1: wall torch against the top edge, small flame
12. brazier 1×1: iron brazier with flames
13. candles 1×1: cluster of candles of different heights
14. lantern 1×1: hanging lantern seen from above
15. chandelier 2×2: round iron chandelier with candles
16. campfire 1×1: small campfire with logs in a stone ring
```

### Prompt 6: nature, caves and water (19)

```text
Next batch for the Quillwarren prop library. Follow the style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2 / texture 1.5, no text, fronts face south, wall-side on the top edge, one SVG per prop plus manifest.json entries, plus an overview card.

Category "nature":
1. tree 2×2: leafy tree canopy seen from above, trunk hidden (blocks sight)
2. tree-dead 2×2: bare dead tree, twisted branches seen from above
3. bush 1×1: round shrub
4. stump 1×1: tree stump with rings
5. log 2×1: fallen log
6. boulder 1×1: single boulder
7. boulder-large 2×2: big boulder with cracks (blocks sight)
8. stalagmites 1×1: cluster of stalagmites seen from above (concentric rings)
9. mushrooms 1×1: patch of small mushrooms
10. mushroom-giant 2×2: giant mushroom cap with spots
11. crystals 1×1: cluster of crystal shards
12. ferns 1×1: fern fronds
13. reeds 1×1: reeds and cattails
14. tent 2×2: canvas tent, ridge line, entrance flap facing south

Category "water":
15. fountain 2×2: round fountain with a central spout, water in shade
16. rowboat 1×3: small rowboat with oars, bow at the top
17. plank-bridge 1×3: rope-and-plank bridge running north–south
18. drain-grate 1×1: iron floor grate over a dark drain
19. stepping-stones 1×2: flat stepping stones (blocks: none)
```

### Prompt 7: environments, the terrain tiles (18)

```text
Next batch for Quillwarren: seamless TERRAIN TILES (floor fills), not props. Different rules from the props:
- Each tile is 2×2 grid squares: viewBox="0 0 200 200".
- It must tile seamlessly: anything that crosses an edge continues exactly on the opposite edge. Avoid one eye-catching feature that shows the repeat.
- Colours: ink #000000 and shade #999999 only, on a TRANSPARENT background (no paper fill); my renderer puts a tint colour underneath.
- Lighter than props: stroke-width 1.5 to 2.5, sparse enough that props, labels and the grid stay readable on top.
- Same hand-inked cartography look as the props. No text.
- Save as terrain/<id>.svg. manifest.json entries: {"id","name","kind":"terrain","tile":2,"tint":"#RRGGBB","difficult":true|false}, where tint is the base colour you suggest on parchment (#F0ECE0) and difficult means difficult terrain in D&D terms.
- Overview card: each tile repeated 3×3 over its suggested tint, on parchment, with its id underneath.

Tiles:
1. water-shallow: gentle ripple lines
2. water-deep: denser, darker wave pattern
3. lava: cracked crust plates with glowing seams (seams in shade)
4. grass: short grass tufts
5. dirt: packed earth, pebbles and small cracks
6. mud: wet mud swirls and puddles (difficult)
7. swamp: murky water with reeds and lily pads (difficult)
8. sand: dune ripples and scattered grains
9. snow: soft snow drifts, a few footprints (difficult)
10. ice: smooth ice with long hairline cracks
11. cave-floor: uneven natural rock, irregular cracks
12. flagstones: large irregular stone slabs
13. cobblestones: small rounded cobbles
14. wood-planks: floorboards running east–west with nails and grain
15. carpet: ornate rug pattern border-free (geometric, no text)
16. rubble: broken stone field (difficult)
17. chasm: bottomless drop, mostly shade with ink cracks and rock ledges
18. moss: thick moss and lichen patches
```

### Prompt 8: decals and overlays (12)

```text
Next batch for Quillwarren: DECALS, small overlays placed on top of the floor for atmosphere. Follow the prop rules in this project (top-down, 100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, no text), except: transparent background, no outline around the whole thing, and lighter lines (1.5 to 2.5). blocks is always "none". Category "decals", one SVG each plus manifest.json and an overview card.

1. cracks 1×1: floor cracks
2. cracks-large 2×2: long branching cracks
3. puddle 1×1: small puddle (shade) with a ripple
4. puddle-large 2×2: larger irregular puddle
5. moss-patch 1×1: moss creeping across stones
6. scorch 1×1: scorch mark from fire or a spell
7. stain 1×1: dark stain splatter (shade)
8. debris 1×1: scattered small debris, splinters and pebbles
9. roots 2×2: roots breaking through the floor
10. cobweb-corner 1×1: cobweb in a corner (corner at the top-left)
11. slime-trail 1×2: slime trail running north–south
12. footprints 1×2: trail of footprints heading north
```

### Prompt 9: GM symbols and map furniture (19)

```text
Next batch for Quillwarren: GM SYMBOLS and MAP FURNITURE. Follow the prop rules in this project (100 units per square, viewBox = footprint × 100, only #000000 / #FFFFFF / #999999, outline 4 / detail 2, NO text or letters anywhere; my renderer adds any text itself). One SVG each plus manifest.json and an overview card.

Category "symbols": bold, instantly readable 1×1 markers in an old-school module style, each on a small paper-filled circle or shield with an ink outline so it reads on any floor. blocks: none.
1. trap: bear-trap jaws
2. treasure: an X over a small chest
3. danger: skull
4. encounter: three claw marks
5. npc: simple standing figure silhouette
6. entrance: arrow pointing in (north)
7. stairs-up: double chevron up
8. stairs-down: double chevron down
9. light: small sun
10. water: water drop
11. note: pushpin
12. locked: padlock
13. key: key
14. portal: spiral swirl

Category "cartography":
15. compass-rose 3×3: ornate compass rose, north point clearly marked by shape (no letters)
16. scale-bar 5×1: scale bar with 5 alternating ink/paper blocks and end ticks (no numbers)
17. title-cartouche 8×2: empty decorative scroll or banner for the map title (text area left blank, paper-filled)
18. legend-frame 4×6: empty decorative frame for a map legend (paper-filled inside)
19. room-badge 1×1: small decorative frame for a room number (paper-filled, blank)
```

### Prompt 10: editor icons and the Quillwarren logo

```text
Last batch for Quillwarren: the web editor's UI ICONS and the app LOGO. These are UI, not map art, so different rules:

ICONS:
- 24×24: viewBox="0 0 24 24", stroke="currentColor", fill="none", stroke-width 1.75, round caps and joins, no text. One consistent family, simple and clear at 20 px, with a subtle hand-drawn feel that fits a fantasy map editor.
- Save as icons/<id>.svg and an overview card showing all of them in a toolbar on dark (#1E1E22) and light (#F4F1EA) backgrounds.
- Icons: select (arrow cursor), pan (hand), room (square), polygon (irregular polygon with vertex dots), corridor (two squares linked by a path), door (door in a wall line), pillar (filled circle in a square), stairs (steps), label (serif T), prop (small chest), terrain (paint brush over hatching), eraser, undo, redo, zoom-in, zoom-out, fit (four corners), grid, eye (players' view), eye-off, download (export), upload (import), chat (speech bubble), send (paper plane), stop (square), settings (gear), trash, lock, unlock, layers.

LOGO:
- "Quillwarren" wordmark in an old-style serif in the spirit of IM FELL English or Marcellus SC (draw the letters as paths so no font is needed), plus a square icon mark: an arched dungeon doorway with stairs descending into darkness.
- The mark must still read at 16 px, so make a simplified favicon version too.
- Files: brand/logo.svg (mark + wordmark), brand/mark.svg (viewBox 0 0 64 64), brand/favicon.svg (viewBox 0 0 32 32). Ink #111111 on parchment #F0ECE0, plus inverted versions (parchment on #1E1E22) as brand/*-dark.svg.
```

## What Quillwarren does with them (phase 7)

- **Loader:** reads the manifests, checks the rules (viewBox, only the three colours, no text), and swaps the colours per style preset.
- **Editor:** a prop picker with search and categories, placing on the grid, and rotation in 90° steps.
- **Terrain:** a new `terrain` object (a shape plus a tile id), drawn under props and clipped to the floor.
- **MCP and chat:** `add_prop` and `add_terrain`, with the catalogue listed in the chat prompt, so "put a well in the courtyard" works.
- **Later:** `blocks: sight` and light props feed Roll20 walls and lights (Universal VTT), if the user has Roll20 Pro.

## Custom props: drawn by Claude in the editor

Besides this catalog, each Quillwarren has its own shared library of props that Claude draws on request, in the editor's chat. The API, storage and editor side are in `docs/API.md`, "Custom props".

- **The same rules.** The MCP tool `prop_rules` hands Claude the rules above in short form (footprint and margin, facing south, the three inks and what each means, the three line weights, fills, layering, no letter-like marks), plus two clean example SVGs and the built-in chair as Quillwarren draws it. `create_prop` refuses anything outside them and says what to fix (core `checkPropSvg`).
- **Clean geometry in, inked line out.** Claude sends plain shapes; Quillwarren redraws each with the hand-inked line of the generators (core `inkBody` in `assets/ink.ts`, a port of the Pen in `assets/tools/*.js`: resampled, a slow seeded swell, smooth Béziers). Closed shapes swell with their size, never their stroke, so a fill-only shape and its outline from the same coordinates stay on top of each other, which is how "fills, then details, then the outline" is drawn. Marks under 6 units (rivets, keyholes) stay exact.
- **Judged at 70 px.** Every saved drawing comes back as a preview: the prop on a 3 × 3 floor at 70 px per square in classic-hatching, print and parchment, plus an enlargement. Claude fixes what doesn't read and tries again (`update_prop`), a few times at most.
- **Ids** start with `my-`, and their files live in `${DELVE_DATA}/props`, not in this folder. A good custom prop can be promoted: copy its `<id>.svg` (already inked and cleaned) into `assets/<category>/`, add it to the batch's metadata, and run `npm run assets`.
- **Proof run (2026-10-02):** a blacksmith's anvil with tongs (3 tries), a wooden signpost (5 tries) and a 2 × 2 corner spider web (2 tries; `web` is one of the 7 missing built-in props).
