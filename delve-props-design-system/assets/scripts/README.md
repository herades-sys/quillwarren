# scripts

The Python 3 scripts that draw and check the props (numpy, scipy, lxml, Pillow, Playwright with Chromium). Download them into a library folder as `tools/` and `src/`.

- `src/samples/<id>.py` — one drawing script per prop: its manifest entry (`META`) and `draw()`.
- `tools/ink.py` — the hand-inked line: seeded wobble, Bézier output, the three inks and three stroke widths.
- `tools/build.py` — draws every prop into `build/<category>/<id>.svg` and writes `build/manifest.json`; it redraws the four sample files byte for byte.
- `tools/validate.py` — checks every file against the rules: viewBox vs manifest, 4-unit margin, three inks only, widths 4/2/1.5 with round caps and joins, allowed elements and attributes, no enclosed unfilled hole.
- `tools/overview.py` — writes a batch's overview card.
- `tools/render.py` — Chromium rasteriser used by the validator.
