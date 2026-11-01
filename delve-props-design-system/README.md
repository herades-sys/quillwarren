Props for Quillwarren maps, drawn the way an old-school fantasy cartographer inks a floor plan: a bold, calm outline around each piece, a few confident lines inside it, a light scatter of texture, and nothing else. Every prop has to survive two things: the renderer swapping its three colours for a map style, and being shrunk to 70 px per square on Roll20. Design for both before anything else.

## The view

- Draw straight down, like a floor plan. No isometric, no perspective, no cast or drop shadows, no sides of objects showing.
- Anything with a front — chair, throne, bed, fireplace, altar, chest, statue — faces **south** (down the page), its back along the top edge. Wall-mounted things sit against the top edge.
- Chairs that belong to a table face the table, as in `table-round`: the south chair faces north, the north chair faces south.
- Loose furniture sits a few degrees off-square (the chairs in `table-round` turn 4–6° and shift a few units). It keeps a set from reading as one rigid object. Bake the turn into the coordinates or use `rotate()`.

## Three inks, and what each one means

Use exactly the strings `#000000`, `#FFFFFF` and `#999999` (uppercase, six digits) on `fill` and `stroke`; `none` is allowed where there is no paint. The renderer replaces these strings per map style, so any other colour, `opacity`, gradient or filter would survive the swap wrong.

- `ink` draws every line and every **opening**: keyholes, bung holes, the gap behind a handle grip, pits. It fills only tiny marks (rivets, nail heads, a keyhole) — never a surface.
- `paper` is the **main top surface** of a piece: the table top and seats, the chest lid, the barrel head, the plinth top, a statue's arms and hands.
- `shade` is the **second surface**, used for one of four reasons, and a prop should be explainable in those terms:
  1. metal fittings — the chest's bands, lock plate and handles, the barrel's hoops, a sword's crossguard;
  2. a darker material — the chair back rails;
  3. something lower than its neighbour — the plinth's bevelled step, the statue's cloak falling below its arms, a recessed lid;
  4. contents and hair — liquid, coins, soil, the statue's hair.
- Alternate values so parts separate at 70 px: `statue` runs shade step → paper top → shade cloak → paper arms.
- Fill every surface. The floor may show only *between* separate pieces (around the chairs), never inside a closed shape. A closed loop with nothing in it is an error; a handle's gap is an ink opening, not a hole.

## Line weights

- `stroke-outline` (4) traces the silhouette of each separate piece.
- `stroke-detail` (2) draws construction inside a piece: seams, bands, plates, handles, rims, and the parts of a figure inside its silhouette.
- `stroke-texture` (1.5) is for grain, stave joints, cracks and folds — sparse, roughly one mark per 20×20 units.
- Every stroke gets `stroke-linecap="round"` and `stroke-linejoin="round"`. No other widths.
- Small hardware drops to `stroke-detail` even on its silhouette (lock plates, handles): a part narrower than about 8 units with a 4-unit outline turns solid black at 70 px.

## The hand-inked line

- Lines are smooth Bézier curves nudged off true by a slow swell: `wobble-outline` for silhouettes, `wobble-detail` for seams, `wobble-texture` for grain. Uneven when zoomed in, crisp at 70 px. No jitter, no sketchy double strokes, no gaps in outlines.
- Layer in this order: surface fills, then details, then the outline on top, so seams and board lines end under the outline's ink instead of poking past it. Split an outline from its fill when details must tuck under it.
- Boards: straight seams with a hint of bow, widths a little uneven (the table's run 17–19 units). Grain: short strokes of 12–24 units following the boards. No knots — a ring with a dot reads as a letter.
- Never draw marks that read as letters or digits at 70 px: rings with a centre dot, zigzags, radiating fans, paired brackets, a circle with a bar through it.

## Footprint and size

- One grid square is `square` (100 units). A prop covering w×h squares is `viewBox="0 0 {w*100} {h*100}"` with the same `width` and `height`.
- Keep every mark at least `margin` (4 units) inside the edge, stroke width included, so a 4-unit outline's geometry stays 6 units in.
- Small objects don't fill their square: `barrel` is about 0.85 square across, `chest` about 0.7 × 0.45. Draw real-world proportions first, then round up a little for legibility.
- Judge every prop at `map-square` (70 px). If a part only reads zoomed in, simplify it.

## What a prop file may contain

- Elements: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `g`.
- Attributes: geometry, plus `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, and `transform` with `translate()`/`rotate()` only. Give every shape an explicit `fill` (`none` for stroke-only paths).
- Never: text or letters, `title`/`desc`, comments, images, filters, gradients, masks, clip paths, `class`/`style`, `opacity`, `id`.
