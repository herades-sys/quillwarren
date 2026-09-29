import math
from ink import (Sheet, INK, PAPER, SHADE, NONE, OUTLINE, DETAIL, TEXTURE,
                 circle_pts, rrect_pts, band_pts, clip_line, rotate)

META = {"id": "table-round", "name": "Round Table with Chairs", "category": "samples", "w": 2, "h": 2,
        "tags": ["table", "round", "chair", "furniture", "wood", "tavern", "dining"], "blocks": "movement"}

R = 55          # table radius
C = 100         # centre
TUCK = 11       # how far each seat slides under the table top


def chair(s, flip, turn, shift):
    """Chair tucked under the table. flip=False: the south chair, back rail along the south.
    turn/shift: a few degrees and units off-square, as a real chair is left."""
    f = (lambda p: (p[0], 200 - p[1])) if flip else (lambda p: p)
    y0 = C + R - TUCK                                   # seat front edge

    def place(pts):
        pts = rotate([(x + shift, y) for x, y in pts], C + shift, y0 + 18, turn)
        return [f(p) for p in pts]

    # seat, boards parallel to the back
    s.shape(place(rrect_pts(C - 18, y0, 36, 34, r=6)), fill=PAPER, sw=OUTLINE, amp=0.3, step=3)
    for y in (y0 + 14, y0 + 24):
        a, b = place([(C - 17.5, y), (C + 17.5, y)])
        s.line(a, b, sw=TEXTURE, amp=0.1)
    # back rail, darker turned wood, a touch wider than the seat
    rail = [(C + x, y0 + 33.5 + 2.2 * (1 - (x / 21) ** 2)) for x in range(-21, 22, 3)]
    s.shape(place(band_pts(rail, 3.8)), fill=SHADE, sw=OUTLINE, amp=0.15, step=2.5)


def draw():
    s = Sheet(2, 2, seed=5)
    pen = s.pen
    chair(s, flip=False, turn=6, shift=5)
    chair(s, flip=True, turn=-4, shift=-3)

    top, outline = s.fill_then_outline(circle_pts(C, C, R), fill=PAPER, amp=0.6, step=5)
    # boards run north-south, slightly uneven widths
    for x in (C - 36.5, C - 18, C + 0.5, C + 18.5, C + 36):
        seg = clip_line((x + pen.rng.uniform(-0.4, 0.4), 20), (x + pen.rng.uniform(-0.4, 0.4), 180), top)
        s.line(seg[0], seg[1], sw=DETAIL, amp=0.35, bow=pen.rng.uniform(-0.5, 0.5))
    # grain: short, sparse, following the boards
    grain = [(C - 45, 92, 108), (C - 27, 70, 86), (C - 28, 116, 132), (C - 9, 58, 72), (C - 9, 98, 110),
             (C + 9, 118, 134), (C + 27, 72, 88), (C + 28, 112, 126), (C + 45, 94, 110)]
    for gx, ga, gb in grain:
        s.line((gx, ga), (gx + pen.rng.uniform(-0.7, 0.7), gb), sw=TEXTURE, amp=0.25,
               bow=pen.rng.uniform(-1.1, 1.1))
    outline()
    return s
