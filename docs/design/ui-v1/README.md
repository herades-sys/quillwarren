# Delve UI v1: the design reference

The user's design from Claude Design (claude.ai/design), exported 2026-10-02 as "Delve UI design system.zip". It is the source of truth for Delve's UI. Build the real pages to match it; don't serve these files.

- `Delve Design System.dc.html`: the colour tokens (dark "Slate" and light "Limestone"), type, space, radius and elevation, icons, and every component with its states.
- `Delve Editor.dc.html`: the map editor at 1440 × 900 (dark and light) and on a 390 px phone, plus layout notes: the grid, what collapses at which width, and the shortcuts.
- `delve-tokens.css`: the token sheet (Nocturne's variable names, retuned). `_ds/nocturne-*/styles.css` is the Nocturne base and component layer it builds on (`.btn`, `.seg`, `.field`, `.card`, `.table`, `.tag`, `.dialog`…).
- `delve-icons.js`: the icon set (24 × 24 stroke paths).
- `delve-map.js`: the mockup's demo map renderer (not Delve's real renderer).
- `shots/`: screenshots of both documents.
- `support.js`: Claude Design's runtime, so the `.dc.html` files open in a browser (they use `<sc-if>`, `<sc-for>` and `<d-icon>` template tags).
