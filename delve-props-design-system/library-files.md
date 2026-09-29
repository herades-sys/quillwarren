# Library files

## Layout

- Save each prop as `<category>/<id>.svg`, one standalone file per prop. This first batch is category `samples`.
- `id` is kebab-case, unique across the whole library, and never reused: `table-round`, `chest`, `barrel`, `statue`.
- `manifest.json` at the library root is one JSON array with an entry per prop, in the order props should appear in the editor:

```json
[
  {"id": "table-round", "name": "Round Table with Chairs", "category": "samples", "w": 2, "h": 2, "tags": ["table", "round", "chair", "furniture", "wood", "tavern", "dining"], "blocks": "movement"},
  {"id": "statue", "name": "Statue on Plinth", "category": "samples", "w": 1, "h": 1, "tags": ["statue", "plinth", "stone", "monument", "hero", "decor"], "blocks": "sight"}
]
```

- `name` is Title Case, as a person would say it. `w` and `h` are whole squares and must match the file's viewBox.
- `tags`: lowercase single words, 4–8 per prop — what it is, what it's made of, where it belongs (`tavern`, `cellar`, `temple`).

## blocks

- `none` — can be walked over: rugs, puddles, scattered bones, floor grates.
- `movement` — blocks walking but not view: tables with chairs, chests, barrels, crates, beds, low altars.
- `sight` — blocks walking and view: anything solid and taller than a person — statues on plinths, pillars, bookcases, curtains, stacked crates.

## Overview card, one per batch

- Save it as `overview/<category>.svg` (a PNG copy beside it is fine). It is not a prop and is not listed in the manifest.
- Background `parchment`; a `grid-faint` line every 100 units, 1.5 wide.
- Place props at their real size on whole squares, bottom-aligned on one shared row, with one empty square between them and around the edge.
- Label each prop with its `id` only, in `card-label`, `label-ink`, centred under its footprint. Labels exist only on the card — never inside a prop file.

## Before a batch ships

Check every file against the rules in the brand book: viewBox and size match the manifest; nothing inside the 4-unit margin; only the three inks (plus `none`); only widths 4, 2 and 1.5 with round caps and joins; only the allowed elements and attributes; no enclosed unfilled hole. Then look at the overview card at 70 px per square and fix whatever doesn't read.
