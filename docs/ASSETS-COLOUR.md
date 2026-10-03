# Delve colour props: prompt pack (about 520 assets)

Coloured top-down props for Delve: lots of trees, carpets and rugs, trapdoors and hidden trapdoors, plus plants, rocks, coloured furniture, market and camp, water and light. 25 batches of about 20, plus a style sheet with 6 samples to approve first.

The black-and-white rules in `docs/ASSETS.md` stay for the existing ink props. These colour props are a second library next to them.

## In Delve

Colour props are a second built-in library beside the ink props (since 2026-10-03). Maps place them like any prop: `{ type: "prop", asset: "c-oak-a", at, rotation?, scale? }`.

- **Ids:** the art's id behind the prefix `c-` (core `COLOUR_PREFIX`): `oak-a` is `c-oak-a`, and colour `rocks/stalagmites` is `c-stalagmites` beside the ink `stalagmites`. Ink ids never start with `c-` (`npm run assets` drops one that does) and custom props start with `my-`, so the three libraries can't clash. The art's ids are unique across all batches (the checker and the import both refuse a repeat), so the category is not part of the id; map files keep these ids for good, so an id is never reused for different art.
- **Files:** the art as drawn in `delve-props-design-system/assets/colour/<category>/<id>.svg`, every imported manifest entry (plus its `batch`) in `assets/colour/manifest.json`, and the catalog in `packages/core/src/assets/catalog-colour.json`: one compact row per asset (`[id, name, category, w, h, "tags,comma,separated", blocks, layer, group, "hidden modular tile difficult"]`), because every browser bundle carries it. The art itself loads per prop, like the ink art.
- **The palette** is checked exactly: core `COLOUR_PALETTE` (`assets/colour.ts`) must equal Prompt 0 above (a test compares them). `parseAssetSvg` keeps palette colours only for colour props and snaps anything else to the nearest palette colour; ink props keep the three inks. Hidden colour props may use `stroke-dasharray` (their GM outline), and the root `<g fill="none" stroke-linecap="round" stroke-linejoin="round">` is kept with its inherited attributes.
- **Per style** (`Style.colours`, worked out once per style by core `colourMap`):
  - classic-hatching and clean: as drawn.
  - parchment (and the handout): the style's sepia ramp (its prop ink → shade → paper) at each colour's lightness, plus 45 % of the colour's own hue, so props sit on the paper and stay apart.
  - old-school blue and print: each colour by its lightness onto the style's ramp from ink through shade to paper, in 6 tones (`rampLevels`), monotone in lightness. Ink stays the style's ink, `#999999` lands exactly on its shade and white on its paper, so colour props match the ink props.
  - Every picture uses this: server PNG and SVG, the editor and viewer, the players' screen, the handout, the 3D floors and Delve Table pages.
- **Manifest fields:**
  - `layer: "floor"` props (rugs, trapdoors, leaf piles, fields) draw in the decals layer, under the walls and the other props, so a table stands on a rug.
  - `hidden: true` props are GM-only until the GM shows them (`gmOnly: false`), like the ink pressure plates, spike traps and floor runes, which now carry `hidden` in catalog.json too (core `hiddenByDefault`).
  - `group` names the variants of one thing. The prop brush (Shift-drag, editor context bar "Mix <group>", on by default) and MCP `add_props_along` (`mix`, default on) mix them at random, seeded per stroke.
  - Ruin walls and foundations (category `ruins`, groups `ruin-wall…` and `ruin-foundation`) are marked `modular` in the catalog: the editor places and moves them on whole squares and MCP `add_prop` snaps them there, so the wall's centre line runs through square centres and open ends meet.
- **Terrain textures** (`"tile": true`: floors, ground and the water textures of EXTRA-SET2.md, batches 28–30) are colour terrain, not props: the catalog has them as `kind: "terrain"` with `palette: "colour"`, and a terrain object names one by id like an ink tile: `{ type: "terrain", asset: "c-floor-planks-oak", shape }` (the schema is unchanged, and ink tile ids work as before). They repeat at their own size (2×2 or 3×3 squares) from the grid origin, so areas of one texture join without a seam, in their own colours as the style shows them, with no tint under them. Tagged `swim` or `difficult terrain` makes them `difficult`. The Terrain tool (G) lists them by category (Ink tiles, Water, Floors, Ground), and MCP `add_terrain` takes their ids. Follow-up, not built: a room or corridor floor filled with a texture would reuse the same pattern layer, clipped to the room.
- **Editor:** the Prop picker has an All / Ink / Colour switch (kept in localStorage `delve-prop-palette`), the colour categories as chips, and search by name, tags and group.
- **Claude:** `list_assets` takes `palette` (ink, colour, all) and `category`; without filters it lists the ink catalog as before plus one line per colour category. The chat prompt sums the colour props up by category with a few ids and has a recipe for a forest of mixed trees.

### Importing new batches

The batches are drawn on the dev container in `~/colour-props` (`batch-NN/manifest.json` and `batch-NN/colour/<category>/<id>.svg`); a batch is finished when `batch-NN/DONE` exists.

```sh
npm run colour-props -- ~/colour-props
```

- It takes every finished batch (any `batch-00` … `batch-99` with a `DONE` file), skips the rest, ignores drawings that aren't in a manifest, and checks each prop with the art's rules (the same as `~/colour-props/tools/props.mjs`: manifest fields, size, elements and attributes, palette colours, dashes only on hidden props, translate/rotate only, the viewBox matching `w × h`) with the palette read from this file, then with `parseAssetSvg`, which must neither drop nor snap anything. A prop that fails is left out and listed, and the command exits with 1.
- It rebuilds `assets/colour/`, its manifest and `catalog-colour.json` from scratch each time, so run it again whenever more batches are finished; props taken out of a batch go too.
- New categories get a picker name (the table in `scripts/colour-props-lib.ts`, otherwise the id in words) and come after the known ones.
- Then run the tests (`packages/core/test/colour-props.test.ts` parses every imported file) and look at the new props in the picker.

## How to run it

**In Claude Design** (claude.ai/design), like the ink library:
1. Make a project called "Delve colour props".
2. Paste **Prompt 0**, check the 6 samples, and ask for changes until you like the look.
3. Paste the batch prompts one at a time in the same project.
4. Download each batch (SVGs + `manifest.json`), or give Claude the project, and they go into `assets/colour/` in the repo.

**Overnight with Claude Code** (on the dev container): each batch is one agent run. It writes `colour/<category>/<id>.svg` and the manifest, checks every file against the palette and the rules, renders a contact sheet at 70 px per square in all five styles, and redraws whatever fails. You review the contact sheets in the morning, before anything is released.

---

## Prompt 0: colour style sheet (paste first)

```text
I'm building a COLOUR prop library for "Delve", my own top-down dungeon and outdoor map editor for tabletop RPGs (maps are used on Roll20 at 70 px per grid square). Please set up a colour style sheet and draw 6 sample props so I can approve the look before we make about 500 of them.

RULES FOR EVERY PROP (the map renderer depends on these):
- Straight top-down view, like a floor plan or a painted fantasy map seen from directly above. No isometric, no perspective, no cast shadows (the renderer adds its own soft drop shadow).
- One standalone SVG file per prop. 1 grid square = 100 units, so a prop covering w×h squares has viewBox="0 0 {w*100} {h*100}". Keep 4 units of margin. Sizes go from 1 to 6 squares per side.
- Plain SVG only: path, rect, circle, ellipse, line, polyline, polygon, g, with fill / stroke / stroke-width / stroke-linecap / stroke-linejoin attributes. NO text or letters, NO images, filters, gradients, patterns, masks, clip paths, CSS, style attributes, opacity, or transforms other than translate/rotate.
- Keep every SVG under 40 KB: build foliage, fur and weave from a moderate number of shapes, not thousands of tiny ones.
- COLOURS: only the Delve palette below, exact hex values, nothing else. The renderer recolours them per map style, so a colour that is off by one digit breaks.
- Ink outlines like hand-inked fantasy cartography: outline stroke-width 4 in ink #000000, inner details 2, fine texture 1.5, round caps and joins, slightly uneven pen lines. Colour fills sit inside the ink lines.
- Light comes from the north-west: use a darker palette tone on the south-east side of a shape and a lighter tone on the north-west for volume. Never a cast shadow on the ground.
- Every surface is filled, so the grid doesn't show through, except where the item is meant to be see-through (a net, a web, a grate).
- Anything with a front (chair, throne, bed, fireplace, altar, stall) faces SOUTH (down the page), back along the top edge. Wall-mounted things sit against the top edge (the wall side).
- Trees: the canopy as seen from above, built from clustered leaf masses in 3–4 tones of one palette family, a slightly irregular outline, the trunk hidden (or just visible at the centre for thin or bare trees). Fill the footprint loosely, not as a perfect circle.
- Original artwork only; don't imitate existing asset packs (Dungeondraft, Forgotten Adventures, 2-Minute Tabletop, Dungeon Scrawl, etc.).

THE DELVE PALETTE (name: hex):
Base: ink #000000, paper #FFFFFF, shade #999999
Foliage: leaf-deep #24452A, leaf-dark #345F34, leaf #4F803C, leaf-light #7EA34C, leaf-pale #AFC77A, needle-dark #233D33, needle #3B5E4B, needle-light #5E8068
Autumn and blossom: gold-leaf #D9A63A, orange-leaf #C76B2A, red-leaf #9C3626, blossom #E9A7BA, blossom-pale #F6E3EA
Wood: bark-dark #3E2C21, bark #5C4130, wood #86603D, wood-light #B48A5A, wood-pale #D6B98C
Stone and ground: stone-dark #4E4B47, stone #7C776F, stone-light #ABA598, stone-pale #CFC9BC, earth #6B5139, sand #D1BA8A, straw #D8C07A, moss #6E7F3A
Water, ice, snow: water-deep #2C5878, water #4A86A6, water-light #8DBBCF, ice #CFE5EC, snow #F1F5F7
Cloth and dyes: red #962B2B, red-light #C0524A, blue #2D4A84, blue-light #5A7EB6, green #2E6849, purple #5A3876, purple-light #8C6BB0, yellow #D9B44A, cream #EADFC2, black #2A2626
Metal: iron #575C63, iron-light #8A9098, brass #AE873C, gold #D4A93A, silver #C8CDD3
Fire and magic: flame #EE8B2B, flame-core #F7D766, ember #B5381D, witchfire #6FCB5A, arcane #8F6AD8, glow #79BDE9

FILES: save each prop as colour/<category>/<id>.svg and add a manifest.json listing every prop as
{"id","name","category","w","h","tags":[...],"blocks":"none"|"movement"|"sight","palette":"colour","layer":"floor"|"props","group":"<family>"?,"hidden":true?}
- blocks: none = you can walk over it (rug, leaf pile), movement = blocks walking only (table, chest, stump), sight = also blocks the view (tree, wardrobe, tall hedge).
- layer: "floor" for things that lie flat and sit UNDER other props (rugs, trapdoors, leaf piles, crop fields); "props" for everything else.
- group: the family of variants (all oaks "oak", all red persian rugs "rug-persian"), so the map editor can mix variants.
- hidden: true only for things the players must not see (hidden trapdoors, covered pits, tripwires). They show only on the GM's map.

Also make one overview card per batch: every prop of the batch on a light parchment background (#F0ECE0) with a faint 100-unit grid, each labelled with its id underneath (labels only on the overview card, never inside the prop SVGs).

SAMPLES for this first step:
1. trees/oak-a 3×3: broad summer oak canopy, leaf-deep to leaf-light, irregular lobed outline (blocks sight, group "oak")
2. trees/pine-a 2×2: pine seen from above, star-like needle tufts radiating from the centre, needle tones (blocks sight, group "pine")
3. carpets/persian-red-a 2×3: red persian rug with a cream and blue border, medallion in the middle, short fringe on the short ends (layer floor, blocks none, group "rug-persian-red")
4. trapdoors/trapdoor-wood 1×1: closed wooden trapdoor, planks, iron hinges and ring (layer floor, blocks none)
5. traps/hidden-trapdoor-stone 1×1: a flagstone with only a faint hairline seam and one worn edge, as the GM sees it, plus a thin dashed red-light outline around it (stroke-width 2, stroke-dasharray allowed only for this GM hint) (layer floor, blocks none, hidden true)
6. market/stall-red 2×2: market stall with a red-and-cream striped awning seen from above, goods peeking out at the front (south) (blocks movement)
```

---

## Batch prompts (paste one at a time into the same project)

Every batch prompt starts with the same short reminder, so each one stands on its own.

### Batch 1: trees, summer broadleaf (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants of one tree must look clearly different (outline, lobes, tone balance), not rotated copies.

Category "trees" (all blocks sight unless noted, layer props):
1. oak-b 3×3: summer oak, denser and rounder than oak-a (group oak)
2. oak-c 2×2: younger oak (group oak)
3. oak-old 4×4: ancient oak, huge spreading canopy with a few gaps showing branches (group oak)
4. beech-a 3×3: smooth beech canopy, fine scalloped edge (group beech)
5. beech-b 2×2: smaller beech (group beech)
6. maple-a 2×2: maple with pointed-lobe edge texture (group maple)
7. maple-b 3×3: larger maple (group maple)
8. elm-a 3×3: vase-shaped elm, airy layered canopy (group elm)
9. elm-b 2×2 (group elm)
10. ash-a 2×2: light, feathery ash canopy, leaf-light dominant (group ash)
11. ash-b 3×3 (group ash)
12. chestnut-a 3×3: chestnut with large leaf clusters and a few pale blossom candles (group chestnut)
13. linden-a 2×2: heart-leaf linden, dense and dark (group linden)
14. birch-a 2×2: birch with a loose, light canopy, bits of white bark visible at the centre (group birch)
15. birch-b 1×1: thin single birch (group birch)
16. birch-c 2×2: clump of three birch trunks with one shared light canopy (group birch)
17. poplar-a 1×1: narrow poplar, tight upright canopy (group poplar)
18. poplar-row 1×3: three poplars in a row, north–south (group poplar)
19. hornbeam-a 2×2 (group hornbeam)
20. sapling-a 1×1: young broadleaf sapling, small and sparse (blocks none, group sapling)
21. sapling-b 1×1: sapling tied to a stake (blocks none, group sapling)
22. walnut-a 3×3: walnut with long compound leaves, open crown (group walnut)
```

### Batch 2: trees, conifers (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants of one tree must look clearly different, not rotated copies.

Category "trees" (all blocks sight unless noted, layer props), needle tones for all:
1. pine-b 3×3: big pine, layered radiating tufts (group pine)
2. pine-c 1×1: small pine (group pine)
3. scots-pine 3×3: flat-topped pine with orange-brown bark showing between needle clumps (group pine)
4. fir-a 2×2: fir, neat star of drooping branch tiers (group fir)
5. fir-b 2×2: fir, slightly lopsided (group fir)
6. spruce-a 2×2: spruce, dense dark tiers (group spruce)
7. spruce-b 1×1 (group spruce)
8. cedar-a 4×4: great cedar with flat horizontal plates of foliage (group cedar)
9. cedar-b 3×3 (group cedar)
10. cypress-a 1×1: tight columnar cypress (group cypress)
11. cypress-b 1×1: cypress, slightly taller look with a pointed crown (group cypress)
12. yew-a 2×2: dark dense yew, a few red berries (group yew)
13. larch-a 2×2: soft, light larch, needle-light dominant (group larch)
14. juniper-a 1×1: low spreading juniper with blue-grey berries (blocks movement, group juniper)
15. juniper-b 2×2 (blocks movement, group juniper)
16. redwood-a 4×4: towering redwood, deep needle tones (group redwood)
17. hemlock-a 3×3: hemlock with drooping feathery tips (group hemlock)
18. pine-sapling 1×1 (blocks none, group pine)
19. pine-cluster 3×3: three pines of different sizes growing together (group pine)
20. fir-cluster 4×4: five firs, a small stand (group fir)
21. pine-windswept 2×2: pine bent by wind, canopy pushed to the east (group pine)
22. monkey-puzzle 2×2: spiky, whorled branches (group monkey-puzzle)
```

### Batch 3: trees, autumn (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Autumn means gold-leaf, orange-leaf and red-leaf mixed with a little leaf-dark; variants must look clearly different.

Category "trees" (blocks sight unless noted, layer props):
1. oak-autumn-a 3×3: oak in gold and orange (group oak-autumn)
2. oak-autumn-b 2×2 (group oak-autumn)
3. oak-autumn-sparse 3×3: half the leaves gone, branches showing (group oak-autumn)
4. beech-autumn 3×3: copper beech, orange and red (group beech-autumn)
5. maple-autumn-red-a 2×2: blazing red maple (group maple-autumn)
6. maple-autumn-red-b 3×3 (group maple-autumn)
7. maple-autumn-gold 2×2: golden maple (group maple-autumn)
8. birch-autumn-a 2×2: yellow birch (group birch-autumn)
9. birch-autumn-b 1×1 (group birch-autumn)
10. elm-autumn 3×3 (group elm-autumn)
11. ash-autumn 2×2: pale yellow ash (group ash-autumn)
12. chestnut-autumn 3×3: brown-orange with spiky husks (group chestnut-autumn)
13. larch-autumn 2×2: golden larch needles (group larch)
14. rowan-a 2×2: rowan with clusters of red berries (group rowan)
15. apple-autumn 2×2: apple tree with red apples among the leaves (group apple)
16. hawthorn-a 1×1: small hawthorn with red haws (group hawthorn)

Category "nature" (layer floor, blocks none):
17. leaf-pile-a 1×1: heap of fallen leaves (group leaf-pile)
18. leaf-pile-b 2×2: big raked leaf pile (group leaf-pile)
19. leaves-scatter-a 2×2: loose fallen leaves scattered on the ground, mostly empty, edges soft (group leaves-scatter)
20. leaves-scatter-b 2×2 (group leaves-scatter)
21. acorns-chestnuts 1×1: acorns, chestnuts and a few leaves
22. pumpkins 1×1: three pumpkins with vines (layer props, blocks movement)
```

### Batch 4: trees, winter and snow (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Snow is snow and ice with a little water-light in the shadows; variants must look clearly different.

Category "trees" (blocks sight unless noted, layer props):
1. pine-snow-a 2×2: pine with snow heaped on its tiers (group pine-snow)
2. pine-snow-b 3×3 (group pine-snow)
3. pine-snow-c 1×1 (group pine-snow)
4. fir-snow-a 2×2 (group fir-snow)
5. fir-snow-b 3×3 (group fir-snow)
6. spruce-snow 2×2: almost white, heavy with snow (group spruce-snow)
7. pine-snow-cluster 3×3: three snowy pines (group pine-snow)
8. oak-winter-a 3×3: bare oak, branching pattern from above, snow on the branches (group oak-winter)
9. oak-winter-b 2×2 (group oak-winter)
10. birch-winter 2×2: bare birch, white bark, fine twigs (group birch-winter)
11. dead-snow 2×2: dead twisted tree with snow (group dead-snow)
12. frost-tree 2×2: fey tree of ice, ice and glow crystals instead of leaves (group frost-tree)

Category "nature":
13. bush-snow-a 1×1: snow-covered bush (blocks movement, group bush-snow)
14. bush-snow-b 2×2 (blocks movement, group bush-snow)
15. stump-snow 1×1: stump with a snow cap (blocks movement)
16. log-frozen 2×1: fallen log, snow on top, icicles (blocks movement)
17. rock-snow 1×1: rock with snow (blocks movement, group rock-snow)
18. boulder-snow 2×2: big snowy boulder (blocks sight, group rock-snow)
19. snowdrift-a 2×2: soft drift, ripples (layer floor, blocks none, group snowdrift)
20. snowdrift-b 3×2 (layer floor, blocks none, group snowdrift)
21. snowman 1×1: snowman from above, stick arms, scarf in red (blocks movement)
22. firewood-snow 1×1: stacked firewood with snow (blocks movement)
```

### Batch 5: trees, blossom and orchard (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants must look clearly different.

Category "trees" (blocks sight unless noted, layer props):
1. cherry-blossom-a 2×2: cherry in full blossom, blossom and blossom-pale with a little leaf-light (group cherry-blossom)
2. cherry-blossom-b 3×3 (group cherry-blossom)
3. plum-blossom 2×2: white-pink plum (group plum-blossom)
4. almond-blossom 2×2: pale blossom, almost white (group almond)
5. magnolia 2×2: big cup-shaped pink and cream flowers (group magnolia)
6. apple-a 2×2: summer apple tree with red-light apples (group apple)
7. apple-b 2×2: apple tree with yellow apples (group apple)
8. pear-a 2×2: pear tree with pale fruit (group pear)
9. orange-a 2×2: orange tree, glossy dark leaves, orange fruit (group orange)
10. lemon-a 1×1: lemon tree in a big clay pot (blocks movement, group lemon)
11. olive-a 2×2: silvery olive, stone-light and leaf-light, twisted trunk at the centre (group olive)
12. olive-b 3×3: old olive grove tree (group olive)
13. fig-a 2×2: fig with large lobed leaves (group fig)
14. peach-a 2×2: peach with blossom-coloured fruit (group peach)
15. orchard-row 1×3: three small fruit trees in a row (group orchard)

Category "nature" (layer props unless noted):
16. grape-trellis 1×2: vines on a wooden trellis, purple grapes (blocks movement)
17. grape-arbor 2×2: arbor roof of vines with hanging grapes, open below (blocks none)
18. petals-scatter 2×2: fallen blossom petals on the ground (layer floor, blocks none)
19. fruit-crates 1×1: crates of apples and pears (blocks movement)
20. ladder-orchard 1×2: orchard ladder lying on the grass (blocks none, layer floor)
```

### Batch 6: trees, jungle, desert and coast (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants must look clearly different.

Category "trees" (blocks sight unless noted, layer props):
1. palm-a 2×2: palm seen from above, a star of long feathered fronds (group palm)
2. palm-b 2×2: palm leaning, fronds pushed to one side (group palm)
3. palm-c 1×1: small palm (group palm)
4. coconut-palm 2×2: palm with a cluster of coconuts at the centre (group palm)
5. date-palm 2×2: date palm with hanging orange-brown dates (group palm)
6. palm-cluster 3×3: three palms (group palm)
7. banana-plant 2×2: big paddle leaves, a hanging bunch (group banana)
8. baobab 4×4: baobab, thick stubby branches, sparse leaves (group baobab)
9. acacia 3×3: flat umbrella acacia, layered thin canopy (group acacia)
10. mangrove 3×3: mangrove with arching roots showing around the canopy edge, water between (group mangrove)
11. jungle-canopy-a 4×4: dense jungle tree, big leaves, vines hanging (group jungle)
12. jungle-canopy-b 3×3 (group jungle)
13. kapok 4×4: giant emergent tree with buttress roots at the edge (group kapok)
14. strangler-fig 3×3: fig with roots wrapping a ruined pillar (group strangler-fig)
15. rubber-tree 3×3: large glossy leaves (group rubber-tree)
16. tree-fern 2×2: tree fern, a star of big fronds (group tree-fern)
17. bamboo-clump 2×2: bamboo stand, many culms and leaf sprays (group bamboo)
18. bamboo-a 1×1 (group bamboo)

Category "nature" (layer props):
19. cactus-saguaro 1×1: tall cactus with arms, seen from above (blocks movement, group cactus)
20. cactus-cluster 2×2: prickly pears and barrel cacti, a few yellow flowers (blocks movement, group cactus)
21. joshua-tree 2×2: spiky branched yucca tree (blocks sight)
22. dragon-tree 3×3: umbrella "dragon blood" tree, red-leaf sap spots on the trunk centre (blocks sight)
```

### Batch 7: trees, dead, burnt and magical (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants must look clearly different.

Category "trees" (blocks sight unless noted, layer props):
1. dead-a 2×2: bare dead tree, grey-brown branches from above (group dead)
2. dead-b 3×3: big dead tree, broken limbs (group dead)
3. dead-c 1×1: dead sapling (blocks movement, group dead)
4. burnt-a 2×2: charred tree, black and ember tones, a few glowing spots (group burnt)
5. burnt-b 2×2: burnt stump with a few blackened branches (blocks movement, group burnt)
6. lightning-split 2×2: tree split down the middle by lightning, scorched centre
7. gnarled-oak 3×3: twisted spooky oak, dark leaves, knotted branches showing (group gnarled)
8. willow-a 3×3: weeping willow, long hanging strands, leaf-light and leaf-pale (group willow)
9. willow-b 4×4: big willow by the water, strands touching the ground (group willow)
10. swamp-cypress 3×3: cypress with grey hanging moss (stone-light), knees at the base edge (group swamp-cypress)
11. dead-swamp 2×2: drowned tree, grey, moss strands (group dead-swamp)
12. fey-tree 3×3: fey tree with purple-light and glow leaves, faint arcane motes (group fey-tree)
13. blight-tree 2×2: sickly tree, moss and witchfire-green rot, curled leaves (group blight)
14. crystal-tree 2×2: tree of glow and arcane crystals instead of leaves (group crystal-tree)
15. mushroom-tree 3×3: giant mushroom cap, red with cream spots (group mushroom-tree)
16. mushroom-tree-blue 2×2: glowing blue cap, glow spots (group mushroom-tree)
17. elder-tree 5×5: enormous ancient tree, many tones, the oldest tree in the forest (group elder)
18. sacred-tree 4×4: holy tree with coloured cloth ribbons tied in its branches (red, blue, yellow) (group sacred)
19. petrified-tree 2×2: tree turned to stone, stone tones (group petrified)
20. treant-sleeping 3×3: a sleeping treant: canopy with a faint bark face hidden in the centre, mossy (group treant)
21. thorn-tree 2×2: black thorny tree, red berries (group thorn)
22. ghost-tree 2×2: pale white tree, ice and snow tones, faint glow (group ghost-tree)
```

### Batch 8: stumps, logs, roots and groves (22)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "nature" (layer props):
1. stump-a 1×1: stump with rings (blocks movement, group stump)
2. stump-b 1×1: wide old stump, roots spreading (blocks movement, group stump)
3. stump-mossy 1×1: mossy stump with mushrooms (blocks movement, group stump)
4. stump-axe 1×1: chopping stump with an axe in it (blocks movement)
5. log-a 2×1: fallen log, bark and a cut end (blocks movement, group log)
6. log-b 3×1: long log with a broken branch (blocks movement, group log)
7. log-hollow 3×1: hollow log, dark opening at the east end (blocks movement, group log)
8. log-mossy 2×1 (blocks movement, group log)
9. woodpile 2×1: split firewood stacked (blocks movement)
10. log-pile 2×2: cut logs stacked in a pyramid (blocks movement)
11. fallen-tree 4×2: whole fallen tree, roots at the west end, leafy crown at the east end (blocks movement)
12. roots-a 2×2: exposed tree roots across the ground (layer floor, blocks none, group roots)
13. roots-b 2×1 (layer floor, blocks none, group roots)
14. branches-scatter 2×2: broken twigs and branches on the ground (layer floor, blocks none)
15. sawhorse-log 2×1: sawhorse with a log and a saw (blocks movement)
16. felled-trunks 3×2: three felled trunks side by side (blocks movement)

Category "trees" (blocks sight, layer props):
17. grove-mixed 4×4: small grove: two oaks, a birch and bushes under them (group grove)
18. grove-pines 4×4: tight group of pines and firs (group grove)
19. thicket 3×3: dense tangle of saplings and undergrowth (group thicket)
20. copse 4×4: copse of mixed broadleaf trees, overlapping canopies (group grove)
21. forest-edge 6×2: a strip of forest edge, trees on the north side thinning to bushes on the south (group forest-edge)
22. tree-line 6×1: a row of trees along a road (group tree-line)
```

### Batch 9: bushes and hedges (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants must look clearly different.

Category "plants" (layer props; blocks movement unless noted):
1. bush-a 1×1: round green bush (group bush)
2. bush-b 1×1: bush with an uneven outline (group bush)
3. bush-c 2×2: large shrub (group bush)
4. berry-bush 1×1: bush with blue-black berries (group berry-bush)
5. rose-bush-red 1×1: rose bush with red blooms (group rose-bush)
6. rose-bush-white 1×1 (group rose-bush)
7. holly 1×1: dark spiky holly with red berries
8. gorse 1×1: spiky gorse with yellow flowers
9. heather 1×1: purple heather clump (blocks none)
10. lavender-row 1×2: lavender in a row (blocks none)
11. hydrangea 1×1: big blue-light and purple-light flower heads
12. bramble 2×2: tangle of thorny brambles with berries (difficult ground)
13. thornbush 1×1: dry grey-brown thornbush
14. hedge-straight-a 1×2: clipped hedge, straight (blocks sight, group hedge)
15. hedge-straight-b 1×3 (blocks sight, group hedge)
16. hedge-corner 2×2: L-shaped hedge corner (blocks sight, group hedge)
17. hedge-end 1×1: rounded hedge end (blocks sight, group hedge)
18. topiary-ball 1×1: clipped ball in a stone pot
19. topiary-spiral 1×1: spiral topiary in a pot
20. tall-grass 1×1: clump of tall grass and seed heads (blocks none)
```

### Batch 10: flowers and gardens (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "plants" (layer props unless noted):
1. flowerbed-red 1×2: bed of red flowers with a wooden edging (blocks none)
2. flowerbed-mixed 2×2: mixed flowerbed, red, yellow, purple, blossom (blocks none)
3. wildflowers-a 1×1: scattered wildflowers in grass (layer floor, blocks none, group wildflowers)
4. wildflowers-b 2×2 (layer floor, blocks none, group wildflowers)
5. sunflowers 1×1: tall sunflowers seen from above, big yellow heads (blocks movement)
6. tulips 1×1: rows of red and yellow tulips (blocks none)
7. lily-pads 1×1: lily pads with a white flower, on water (layer floor, blocks none)
8. lily-patch 2×2: big lily-pad patch on water (layer floor, blocks none)
9. reeds 1×1: reeds and cattails in colour (blocks none)
10. potted-plant-a 1×1: leafy plant in a clay pot (blocks movement, group potted-plant)
11. potted-plant-b 1×1: flowering plant in a glazed blue pot (blocks movement, group potted-plant)
12. pots-cluster 1×1: three small herb pots (blocks movement)
13. planter-box 2×1: wooden planter box with flowers (blocks movement)
14. herb-garden 2×2: herb beds with paths between them (blocks none)
15. vegetable-patch 2×2: rows of cabbages, carrots and leeks (blocks none)
16. pumpkin-patch 2×2: pumpkins on vines (blocks movement)
17. cabbage-row 1×3: a row of cabbages (blocks none)
18. scarecrow 1×1: scarecrow from above, straw hat, arms out (blocks movement)
19. beehive 1×1: straw beehive skep on a stand, a few bees (blocks movement)
20. garden-arch 2×1: rose arch over a path, open below (blocks none)
```

### Batch 11: crops, farm and fungi (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "plants" (layer props unless noted):
1. wheat-field 2×2: patch of ripe wheat, straw and gold-leaf rows (layer floor, blocks none, group field)
2. corn-rows 2×2: rows of tall corn (blocks sight, group field)
3. vineyard-rows 2×3: rows of vines on posts (blocks movement, group field)
4. hay-bale-round 1×1: round hay bale (blocks movement, group hay)
5. hay-bale-square 1×1: square hay bale with twine (blocks movement, group hay)
6. haystack 2×2: big haystack with a pitchfork (blocks sight, group hay)
7. sheaves 1×1: grain sheaves standing in a stook (blocks movement)
8. hay-scatter 2×2: loose straw on the ground (layer floor, blocks none)
9. fly-agaric 1×1: cluster of red-capped, white-spotted mushrooms (blocks none, group mushrooms)
10. mushrooms-brown 1×1: brown mushroom cluster (blocks none, group mushrooms)
11. mushrooms-glowing 1×1: glowing blue mushrooms (blocks none, group mushrooms)
12. mushroom-giant 2×2: giant mushroom, colour version, ochre cap with cream gills edge (blocks sight)
13. fairy-ring 3×3: ring of small mushrooms in the grass, empty middle (layer floor, blocks none)
14. moss-patch 2×2: thick moss on the ground (layer floor, blocks none)
15. ferns-a 1×1: fern clump (blocks none, group ferns)
16. ferns-b 2×2: big fern patch (blocks none, group ferns)
17. ivy-ground 2×2: ivy creeping over the ground (layer floor, blocks none)
18. clover-patch 1×1: clover with tiny white flowers (layer floor, blocks none)
19. nettles 1×1: stinging nettles (blocks none)
20. thistles 1×1: thistles with purple heads (blocks none)
```

### Batch 12: rocks, stones and crystals (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Variants must look clearly different.

Category "rocks" (layer props):
1. boulder-a 1×1: grey boulder, facets (blocks movement, group boulder)
2. boulder-b 1×1 (blocks movement, group boulder)
3. boulder-c 2×2: big cracked boulder (blocks sight, group boulder)
4. boulder-mossy 2×2: boulder with moss on the north side (blocks sight, group boulder)
5. boulder-cluster 2×2: three boulders together (blocks sight, group boulder)
6. sandstone-rock 2×2: warm sandstone, layered bands (blocks sight)
7. rock-pile 1×1: pile of smaller stones (blocks movement)
8. pebbles 1×1: scattered pebbles (layer floor, blocks none)
9. river-stones 2×1: smooth round river stones (layer floor, blocks none)
10. scree 2×2: loose scree on a slope (layer floor, blocks none, difficult ground)
11. outcrop 3×2: rock outcrop with ledges and cracks (blocks sight)
12. standing-stone 1×1: tall standing stone with lichen (blocks sight)
13. stone-circle 5×5: ring of standing stones with an altar stone in the middle, grass between (blocks none for the inside; the stones block sight; draw as one prop)
14. amethyst 1×1: purple crystal cluster (blocks movement, group crystals)
15. emerald 1×1: green crystal cluster (blocks movement, group crystals)
16. ice-crystals 1×1: pale ice crystals (blocks movement, group crystals)
17. geode 1×1: split geode, purple inside (blocks movement)
18. gold-vein 2×1: rock with a gold ore vein (blocks movement)
19. lava-rock 1×1: black rock with ember cracks (blocks movement)
20. stalagmites 1×1: colour stalagmites, stone tones, wet highlights (blocks movement)
```

### Batch 13: rugs, rectangular (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text or letters (no lettering in borders either), under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Rugs are flat: no volume shading, just the weave and pattern; ink outline 3 at the edge is fine.

Category "carpets" (all layer floor, blocks none):
1. persian-red-b 2×3: red persian rug, different border and medallion from persian-red-a (group rug-persian-red)
2. persian-blue 2×3: blue persian rug with red and cream (group rug-persian-blue)
3. persian-green 3×4: green and gold persian (group rug-persian-green)
4. oriental-gold 3×5: large gold and red oriental carpet (group rug-oriental)
5. kilim-orange 2×3: flat-woven kilim, orange and red diamonds (group rug-kilim)
6. kilim-red 2×4: kilim with stepped zigzags (group rug-kilim)
7. woven-stripes 2×3: striped wool rug, earthy colours (group rug-stripes)
8. braided-oval 2×3: braided oval rag rug, mixed colours (group rug-braided)
9. rag-rug 1×2: small rag rug (group rug-rag)
10. rush-mat 2×2: woven rush mat, straw (group mat-rush)
11. tattered-red 2×3: old red rug, worn patches and torn corner (group rug-tattered)
12. stained-rug 2×3: rug with a dark stain and a burn hole (group rug-tattered)
13. elven-rug 3×4: elven rug, leaf and vine pattern, green and cream (group rug-elven)
14. dwarven-rug 3×4: dwarven rug, hard geometric knots, red, gold and black (group rug-dwarven)
15. hide-rug 2×3: crude orc hide rug, stitched patches (group rug-hide)
16. crest-rug 3×5: noble rug with a heraldic shield in the middle (no letters), blue and gold (group rug-crest)
17. prayer-rug 1×2: small prayer rug with an arch motif pointing north (group rug-prayer)
18. doormat 1×1: coarse doormat (group mat-door)
19. checkered-rug 2×2: checkered rug, red and cream (group rug-checkered)
20. bath-mat 1×1: small woven bath mat, blue-light (group mat-bath)
```

### Batch 14: runners, round rugs and great carpets (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text or letters (no lettering in borders either), under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Rugs are flat: no volume shading, just the weave and pattern.

Category "carpets" (all layer floor, blocks none unless noted):
1. runner-red-4 1×4: red runner with a gold border, north–south (group runner-red)
2. runner-red-6 1×6 (group runner-red)
3. runner-blue-5 1×5: blue runner with a silver border (group runner-blue)
4. runner-gold-6 1×6: gold runner with red diamonds (group runner-gold)
5. runner-green-4 1×4 (group runner-green)
6. runner-tattered 1×4: worn runner, frayed (group runner-tattered)
7. runner-bloody 1×4: runner with a trail of blood stains (group runner-tattered)
8. throne-carpet 2×6: royal carpet, red with a wide gold border, ends in a fringe (group carpet-throne)
9. aisle-runner 1×6: white and cream wedding or temple aisle with petals (group runner-aisle)
10. round-red 2×2: round red rug with a star pattern (group rug-round)
11. round-blue 3×3: round blue rug with rings (group rug-round)
12. medallion-round 4×4: large round medallion carpet, many colours (group rug-round)
13. hearth-rug 2×1: half-round rug for in front of a fireplace (group rug-hearth)
14. octagon-rug 3×3: octagonal rug, geometric (group rug-octagon)
15. mosaic-carpet 4×4: temple carpet woven like a mosaic, blue, gold and cream (group carpet-temple)
16. rune-carpet 3×3: arcane carpet, purple with arcane-coloured circle and glyph shapes (abstract, no letters) (group carpet-arcane)
17. starmap-rug 3×3: navy (blue and black) rug with gold stars and constellation lines (group carpet-arcane)
18. festival-rug 2×2: bright festival rug, yellow, red and blue (group rug-festival)
19. rug-over-trapdoor 2×2: rug with a faint square bulge and one lifted corner showing a trapdoor edge, a hint for sharp-eyed players (group rug-trapdoor)
20. rug-rolled 1×2: rolled-up carpet lying on the floor (layer props, blocks movement)
```

### Batch 15: furs, mats and cloths (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "carpets" (all layer floor, blocks none unless noted):
1. bearskin 2×3: brown bearskin rug with head and paws (group fur)
2. wolf-pelt 1×2: grey wolf pelt (group fur)
3. white-fur 2×2: white fur rug, snow and ice tones (group fur)
4. sheepskin 1×1: cream sheepskin (group fur)
5. tiger-skin 2×3: orange-striped big-cat skin (group fur)
6. cowhide 2×2: patched cowhide (group fur)
7. tatami-a 1×2: tatami mat with a black edge (group tatami)
8. tatami-grid 2×2: four tatami in a pinwheel (group tatami)
9. reed-mat 1×2: reed sleeping mat (group mat-reed)
10. straw-mat 1×1: round straw mat (group mat-straw)
11. picnic-blanket 2×2: red and cream checked blanket with a basket, bread and apples (group blanket)
12. blanket-wool 1×2: folded wool blanket, blue (group blanket)
13. prayer-mats 1×3: three small prayer mats in a row (group rug-prayer)
14. cushion-pile 2×2: pile of floor cushions, many colours (layer props, blocks none)
15. floor-cushions 1×1: two cushions (layer props, blocks none)
16. tapestry-floor 2×3: a tapestry laid on the floor, a hunting scene in simple shapes (no letters) (group tapestry)
17. banner-fallen 1×3: fallen banner, red with a gold emblem (group banner)
18. sailcloth 2×3: folded sailcloth with ropes (group cloth)
19. tarp-goods 2×2: tarp over a pile of goods, roped down (layer props, blocks movement)
20. mosaic-inset 2×2: round mosaic set into the floor, blue and gold (group mosaic)
```

### Batch 16: trapdoors and hatches (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Open trapdoors show the lid swung up against the north edge and a dark opening (ink and bark-dark) with the top of a ladder or steps.

Category "trapdoors" (all layer floor, blocks none):
1. trapdoor-wood-open 1×1: the wooden trapdoor from the samples, open, ladder down (group trapdoor-wood)
2. trapdoor-wood-big 2×2: large double-leaf wooden trapdoor, closed (group trapdoor-wood)
3. trapdoor-wood-big-open 2×2: the same, open, steps going down (group trapdoor-wood)
4. trapdoor-iron 1×1: riveted iron trapdoor with a heavy ring (group trapdoor-iron)
5. trapdoor-iron-open 1×1 (group trapdoor-iron)
6. trapdoor-stone 1×1: stone slab trapdoor with an iron ring (group trapdoor-stone)
7. trapdoor-stone-open 1×1: the slab slid aside, dark shaft (group trapdoor-stone)
8. cellar-doors 2×1: angled double cellar doors against the north wall, closed (group cellar-doors)
9. cellar-doors-open 2×1: open, stone steps going down (group cellar-doors)
10. ship-hatch 1×1: ship's deck hatch, grated (group hatch)
11. manhole 1×1: round iron sewer cover with a pattern (group manhole)
12. manhole-open 1×1: cover pushed aside, rungs going down (group manhole)
13. grate-1 1×1: iron floor grate over darkness, a glint of water below (group grate)
14. grate-2 2×1: long drain grate (group grate)
15. trapdoor-chained 1×1: trapdoor chained shut with a padlock (group trapdoor-wood)
16. trapdoor-broken 1×1: splintered trapdoor, a hole in it (group trapdoor-wood)
17. rope-hatch 1×1: open hatch with a rope ladder going down (group hatch)
18. well-hatch 1×1: wooden lid over a well shaft (group hatch)
19. trapdoor-straw 1×1: trapdoor half covered by straw in a barn (group trapdoor-wood)
20. stairs-down-hatch 2×2: open floor hatch with stone stairs going down into the dark (group hatch)
```

### Batch 17: hidden trapdoors and traps (GM only) (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

These are what the GM sees of hidden things: draw the thing itself, subtle like the floor around it, plus ONE clear GM hint: a thin dashed red-light outline around the hidden part (stroke-width 2, dash pattern with stroke-dasharray is allowed here). The players never see these props.

Category "traps" (all hidden true, layer floor, blocks none):
1. hidden-trapdoor-wood 1×1: floorboards with a barely visible square seam (group hidden-trapdoor)
2. hidden-trapdoor-wood-2 2×2: large hidden trapdoor in floorboards (group hidden-trapdoor)
3. hidden-trapdoor-stone-2 2×2: four flagstones that drop together, faint seam (group hidden-trapdoor)
4. hidden-trapdoor-dirt 1×1: cave floor with a faint square edge in the dirt (group hidden-trapdoor)
5. hidden-trapdoor-tile 1×1: one floor tile slightly different in colour (group hidden-trapdoor)
6. pit-cover-sticks 2×2: pit covered with sticks and leaves (group pit-cover)
7. pit-cover-rug 2×2: rug laid over a pit, sagging a little in the middle (group pit-cover)
8. pit-cover-snow 2×2: snow crust over a pit (group pit-cover)
9. pressure-plate-stone 1×1: stone plate a touch raised (group pressure-plate)
10. pressure-plate-wood 1×1: loose floorboard that clicks (group pressure-plate)
11. tripwire 1×2: thin cord across the floor between two pegs (group tripwire)
12. tripwire-bells 1×3: tripwire with little bells at one end (group tripwire)
13. hidden-spikes 1×1: holes in the floor where spikes come up (group hidden-spikes)
14. dart-holes 1×1: tiny holes in the wall at the top edge (group dart-trap)
15. warding-glyph 1×1: faint arcane glyph on the floor (abstract, no letters), arcane tone (group glyph)
16. cracked-floor 2×2: weakened floor tiles that collapse (group collapse)
17. snare 1×1: rope snare loop hidden in leaves (group snare)
18. bear-trap 1×1: open iron jaws half buried in leaves (group bear-trap)
19. loose-plank-cache 1×1: loose floor plank with a hidden cache under it (coins, a scroll) (group cache)
20. secret-floor-panel 2×1: sliding floor panel over a crawlway (group hidden-trapdoor)
```

### Batch 18: furniture, bedroom and living (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, wall side on the top edge, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "furniture" (layer props; blocks movement unless noted):
1. bed-single-red 1×2: single bed, red blanket, cream pillow (group bed-single)
2. bed-single-blue 1×2 (group bed-single)
3. bed-double-green 2×2: double bed, green quilt (group bed-double)
4. bed-canopy 2×3: canopy bed, red curtains tied at the posts, gold trim (blocks sight)
5. bed-straw 1×2: straw pallet with a rough blanket (blocks none)
6. bunk-bed-colour 1×2: bunk bed, two blankets (group bunk-bed)
7. cradle 1×1: wooden cradle with a small blanket
8. wardrobe-oak 2×1: oak wardrobe, brass handles (blocks sight)
9. dresser 2×1: chest of drawers with a basin and jug on top
10. vanity 2×1: vanity table with a mirror against the wall, bottles
11. chest-colour 1×1: painted chest, blue with iron bands (group chest)
12. chest-red 1×1: red chest with brass corners (group chest)
13. chair-padded 1×1: padded chair, red seat (group chair)
14. armchair 1×1: wing armchair, green velvet (group chair)
15. stool 1×1: three-legged stool (group stool)
16. table-dining 2×3: dining table with a cream cloth and place settings
17. table-round-colour 2×2: round table with four colourful chairs
18. coat-rack 1×1: coat rack with a cloak and a hat
19. screen-folding 2×1: folding screen with painted panels (blocks sight)
20. bathtub 1×2: copper bathtub with water, a towel over the side
```

### Batch 19: tavern and kitchen (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, wall side on the top edge, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "tavern" (layer props; blocks movement unless noted):
1. bar-counter-colour 3×1: polished bar counter with tankards and a spill
2. bar-corner 2×2: L-shaped bar corner
3. keg-wall 3×1: kegs on a rack against the wall, taps
4. table-tavern-a 2×1: tavern table with tankards, bread and a candle (group table-tavern)
5. table-tavern-b 2×2: round tavern table with a game of dice and cards (no letters) (group table-tavern)
6. table-feast 2×4: feast table with a roast, fruit, goblets and candles
7. stool-bar 1×1: bar stool (group stool)
8. bench-colour 2×1: worn bench (group bench)
9. hearth-tavern 3×1: big tavern hearth on the north wall, fire and a hanging pot
10. stage-small 3×2: small wooden stage with a lute and a stool (blocks none)
11. dartboard-wall 1×1: target board on the wall (top edge), coloured rings, no numbers (blocks none)
12. spilled-ale 1×1: spilled ale and a dropped tankard (layer floor, blocks none)

Category "kitchen" (layer props; blocks movement unless noted):
13. kitchen-counter 2×1: counter with chopping board, knife, vegetables
14. stove-iron 2×1: iron stove with pots and a kettle, against the wall
15. pantry-shelf 2×1: shelves with jars, cheese wheels and sausages
16. sink-basin 1×1: stone sink with a pump
17. flour-sacks 1×1: flour sacks, one split (group sacks)
18. herbs-hanging 2×1: herbs and onions hanging from a beam (blocks none)
19. cheese-wheels 1×1: stacked cheese wheels
20. barrels-colour 2×2: barrels, wine-dark and oak, one open with apples (group barrels)
```

### Batch 20: noble hall, library and study (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, wall side on the top edge, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "hall" (layer props; blocks movement unless noted):
1. throne-gold 2×2: gold throne with a red cushion on a dais (group throne)
2. throne-dark 2×2: black iron throne with spikes (group throne)
3. throne-elven 2×2: throne grown from living wood and leaves (group throne)
4. banner-stand 1×1: standing banner, blue and gold, no letters (group banner)
5. suit-armor 1×1: polished suit of armour on a stand
6. statue-marble 1×1: marble statue on a plinth, stone-pale (group statue)
7. statue-bronze 2×2: bronze knight statue, brass tones, green patina hints (blocks sight, group statue)
8. harp 1×1: golden harp
9. harpsichord 2×1: painted harpsichord, keys at the south
10. dining-noble 2×5: long noble table, silver and gold tableware, candelabras
11. fireplace-grand 3×1: grand fireplace with a carved mantel, fire (blocks movement)
12. chandelier-colour 2×2: brass chandelier with lit candles (blocks none)

Category "library" (layer props; blocks movement unless noted):
13. bookshelf-colour 2×1: bookshelf with coloured spines (blocks sight, group bookshelf)
14. bookshelf-tall 3×1: tall shelf, a ladder leaning on it (blocks sight, group bookshelf)
15. reading-chair 1×1: reading armchair with a book and a candle table
16. desk-scholar 2×1: scholar's desk, open book, scrolls, inkpot, candle
17. globe 1×1: globe on a stand, blue seas, cream lands (no letters)
18. map-table 2×2: table with an unrolled map (no letters), compass and weights
19. scroll-rack 2×1: rack of scroll cubbies against the wall
20. book-piles 1×1: stacks of coloured books and loose papers (blocks none)
```

### Batch 21: market and town (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text (no signs with writing), fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "market" (layer props; blocks movement unless noted):
1. stall-blue 2×2: stall with a blue-and-cream striped awning (group stall)
2. stall-green 2×2: green awning (group stall)
3. stall-yellow 2×2: yellow and red awning (group stall)
4. stall-fruit 2×2: open fruit stall, crates of apples, oranges, grapes (group stall)
5. stall-fish 2×2: fish on ice, a scale (group stall)
6. stall-cloth 2×2: bolts of coloured cloth (group stall)
7. stall-pottery 2×2: pots and jugs on the ground and a table (group stall)
8. stall-smith 2×2: weapons and tools laid out, an anvil (group stall)
9. cart-hand 1×2: hand cart with sacks (group cart)
10. cart-vegetables 2×2: cart full of vegetables (group cart)
11. wagon-covered 2×3: covered wagon, cream canvas, front (horse end) to the south (blocks sight, group wagon)
12. wagon-open 2×3: open wagon with crates (group wagon)
13. wheelbarrow 1×1: wheelbarrow with dirt (group cart)
14. well-town 2×2: town well with a little tiled roof (blocks movement)
15. lamp-post 1×1: iron lamp post, lit (group lamp)
16. signpost 1×1: wooden signpost with three blank arrow boards
17. crates-colour 2×2: stacked crates, some painted (group crates)
18. sacks-colour 2×1: sacks of grain and spices, open tops showing colour (group sacks)
19. bench-park 2×1: stone and wood bench (group bench)
20. pillory 1×1: town pillory (stocks) on a small platform
```

### Batch 22: camp and outdoors (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "camp" (layer props; blocks movement unless noted):
1. tent-red 2×2: red canvas tent, ridge line, flap facing south (blocks sight, group tent)
2. tent-green 2×2 (blocks sight, group tent)
3. tent-white 2×3: large white tent (blocks sight, group tent)
4. tent-pavilion 4×4: striped round pavilion with pennants (blocks sight, group tent)
5. tent-hide 2×2: hide tent with poles (blocks sight, group tent)
6. lean-to 2×1: branch lean-to shelter open to the south (blocks sight)
7. bedroll-red 1×2: red bedroll with a pack (blocks none, group bedroll)
8. bedroll-green 1×2 (blocks none, group bedroll)
9. campfire-colour 1×1: campfire, flame and flame-core, stone ring (group campfire)
10. campfire-spit 2×2: campfire with a roasting spit and a pot (group campfire)
11. campfire-out 1×1: burnt-out campfire, ash and embers (blocks none, group campfire)
12. firewood-colour 1×1: bundle of firewood (group firewood)
13. training-dummy 1×1: straw training dummy on a post
14. archery-target 1×1: straw target with red, yellow and blue rings
15. weapon-rack-colour 2×1: weapon rack with swords, spears and coloured shields
16. banner-pole 1×1: pole with a red war banner (blocks none)
17. supply-pile 2×2: crates, barrels and sacks under a tarp
18. horse-post 2×1: hitching post with a saddle and a water trough
19. palisade-a 1×2: sharpened log palisade section (blocks sight, group palisade)
20. palisade-gate 2×1: palisade gate, closed (blocks sight, group palisade)
```

### Batch 23: water, boats and docks (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Boats point north (bow at the top).

Category "water" (layer props; blocks movement unless noted):
1. rowboat-colour 1×3: rowboat, painted blue hull, oars (group boat)
2. rowboat-red 1×3: red hull, fishing gear (group boat)
3. canoe 1×3: birch-bark canoe with paddles (group boat)
4. raft 2×2: log raft with a pole (group boat)
5. sailboat 2×5: small sailboat with a cream sail seen from above, rigging lines (group boat)
6. dock-planks 2×2: dock section, planks and posts (layer floor, blocks none, group dock)
7. pier-end 2×2: end of a pier with mooring posts and a lantern (layer floor, blocks none, group dock)
8. mooring-post 1×1: mooring post with rope coil
9. buoy 1×1: red and cream buoy in the water
10. fishing-nets 2×2: nets drying on poles (blocks none)
11. lobster-pots 1×1: stacked lobster pots
12. fountain-colour 2×2: stone fountain, blue water, coins (group fountain)
13. fountain-grand 3×3: grand fountain with a statue spout and three basins (group fountain)
14. bridge-wood 1×3: wooden footbridge with rails, north–south (layer floor, blocks none, group bridge)
15. bridge-stone 2×4: stone arch bridge with parapets (layer floor, blocks none, group bridge)
16. stepping-stones-colour 1×2: stepping stones in water (layer floor, blocks none)
17. waterwheel 2×1: mill waterwheel against a wall (top edge), water splashing
18. reeds-water 2×2: reeds and cattails standing in water (blocks none)
19. washing-line 1×3: line of coloured washing between two poles (blocks none)
20. ship-wheel-deck 2×2: section of ship's deck with the wheel and a coil of rope (layer floor, blocks none)
```

### Batch 24: light and fire (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text, fronts face south, wall side on the top edge, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card. Light glows are drawn as a few rings of flame-core and flame around the source, never with opacity.

Category "light" (layer props; blocks movement unless noted):
1. brazier-colour 1×1: iron brazier, orange flames (group brazier)
2. brazier-witchfire 1×1: brazier with green witchfire (group brazier)
3. brazier-blue 1×1: brazier with blue magical flames (group brazier)
4. sconce-colour 1×1: wall torch against the top edge (blocks none, group sconce)
5. sconce-pair 2×1: two torches either side of a door gap (blocks none, group sconce)
6. candles-colour 1×1: cluster of candles (blocks none, group candles)
7. candelabra 1×1: brass candelabra with five candles (group candles)
8. candles-ritual 2×2: ring of black candles, wax pools (blocks none, group candles)
9. lantern-colour 1×1: lantern on the floor (blocks none, group lantern)
10. lanterns-paper 2×1: string of coloured paper lanterns (blocks none, group lantern)
11. lamp-oil 1×1: oil lamp on a small table (group lantern)
12. fire-pit 2×2: big stone fire pit, high flames (group fire)
13. bonfire 3×3: bonfire of stacked logs (group fire)
14. fire-spread 2×2: flames spreading across the floor (layer floor, blocks none, group fire)
15. embers 1×1: glowing embers and ash (layer floor, blocks none, group fire)
16. torch-floor 1×1: dropped torch on the ground (blocks none)
17. glowing-crystal 1×1: crystal giving off glow light (group magic-light)
18. will-o-wisp 1×1: floating wisp of glow light, a few rings (blocks none, group magic-light)
19. fireplace-colour 2×1: fireplace against the wall, fire, a kettle (group fireplace)
20. forge-colour 2×2: smithy forge, glowing coals, bellows (group forge)
```

### Batch 25: temple, arcane and alchemy (20)

```text
Next batch for the Delve colour prop library. Follow the colour style sheet in this project exactly: top-down, 100 units per square, viewBox = footprint × 100, only the Delve palette (exact hex values), ink outlines 4 / details 2 / texture 1.5, light from the north-west with no cast shadows, no text or letters (glyphs are abstract shapes), fronts face south, wall side on the top edge, under 40 KB per SVG, one SVG per prop in colour/<category>/<id>.svg plus manifest.json entries, plus an overview card.

Category "arcane" (layer props; blocks movement unless noted):
1. altar-cloth-red 2×1: stone altar with a red cloth, gold chalice, candles (group altar)
2. altar-cloth-white 2×1: altar with a white and gold cloth (group altar)
3. altar-dark 2×1: black altar, blood-red cloth, a dagger (group altar)
4. font-colour 1×1: stone font with blue water (group font)
5. summoning-circle-colour 3×3: summoning circle in arcane and purple, candles at five points (layer floor, blocks none, group circle)
6. summoning-circle-fire 3×3: circle drawn in ember and flame (layer floor, blocks none, group circle)
7. rune-blue 1×1: glowing glow-blue floor rune (layer floor, blocks none, group rune)
8. rune-red 1×1: glowing red-light rune (layer floor, blocks none, group rune)
9. rune-green 1×1: witchfire rune (layer floor, blocks none, group rune)
10. portal 3×3: swirling portal, arcane and glow rings, stone frame on the ground (layer floor, blocks none)
11. crystal-ball 1×1: crystal ball on a gold stand, glow inside
12. alchemy-table-colour 2×1: alchemy table, flasks of red, green, blue and purple liquids
13. potion-shelf 2×1: shelf of coloured potions against the wall
14. cauldron-green 1×1: cauldron bubbling with witchfire-green brew
15. cauldron-purple 1×1: cauldron with purple brew and steam rings
16. stained-glass-light 2×2: coloured light from a stained-glass window lying on the floor (red, blue, yellow panes, simple shapes) (layer floor, blocks none)
17. shrine-small 1×1: wayside shrine with offerings and a candle
18. prayer-candles 2×1: rack of votive candles (group candles)
19. reliquary 1×1: gold reliquary box with gems
20. idol-gold 1×1: golden idol on a pedestal, red gems for eyes
```

---

**Total:** 6 samples + 7 batches of 22 + 18 batches of 20 = **520 props.**
