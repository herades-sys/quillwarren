from ink import Sheet, INK, PAPER, SHADE, NONE, OUTLINE, DETAIL, TEXTURE, rrect_pts, clip_line

META = {"id": "chest", "name": "Treasure Chest", "category": "samples", "w": 1, "h": 1,
        "tags": ["chest", "treasure", "loot", "container", "locked", "wood", "iron"], "blocks": "movement"}


def draw():
    s = Sheet(1, 1, seed=23)
    pen = s.pen
    x0, y0, x1, y1 = 16, 29, 84, 71          # lid, front (lock) faces south

    # carry handles on the short ends (drawn first, the lid overlaps their roots)
    for sx in (-1, 1):
        ex = x0 if sx < 0 else x1
        o = ex + sx * 7
        s.shape([(ex - sx * 2, 42.5), (o, 43.5), (o, 56.5), (ex - sx * 2, 57.5)], fill=SHADE,
                sw=DETAIL, amp=0.1, step=2.5)
        gx = ex + sx * 3.8                            # gap behind the grip: an opening, so ink
        s.polygon([(gx - 1, 46), (gx + 1, 46), (gx + 1, 54), (gx - 1, 54)], fill=INK)

    body, outline = s.fill_then_outline(rrect_pts(x0, y0, x1 - x0, y1 - y0, r=3), fill=PAPER, amp=0.6, step=4)

    # lid boards run east-west; two seams
    for y in (y0 + 14, y1 - 14):
        seg = clip_line((x0 - 5, y), (x1 + 5, y), body)
        s.line(seg[0], seg[1], sw=DETAIL, amp=0.4, bow=0.4)
    # grain between the bands
    for (xa, xb, y) in ((36, 50, 35.5), (52, 63, 40), (37, 47, 49.5), (55, 64, 53.5), (40, 56, 64)):
        s.line((xa, y), (xb, y + pen.rng.uniform(-0.6, 0.6)), sw=TEXTURE, amp=0.2, bow=pen.rng.uniform(-0.7, 0.7))

    # iron bands wrap the lid; they run long at the back (hinge straps)
    for bx in (24, 69):
        s.shape([(bx, y0 - 4), (bx + 7, y0 - 4), (bx + 7, y1 + 2), (bx, y1 + 2)], fill=SHADE,
                sw=DETAIL, amp=0.25, step=4, corners=(0, 1, 2, 3))
        for ry in (y0 - 0.5, 50, y1 - 3):
            s.circle(bx + 3.5, ry, 1.5, fill=INK)

    # hasp strap from the lid down to the lock
    s.shape([(46.5, 56), (53.5, 56), (53.5, 66), (46.5, 66)], fill=SHADE, sw=DETAIL, amp=0.2, step=4,
            corners=(0, 1, 2, 3))
    outline()

    # lock plate hangs over the front edge
    s.shape(rrect_pts(42.5, 64, 15, 13.5, r=2.5), fill=SHADE, sw=DETAIL, amp=0.3, step=3)
    # keyhole — an opening, so ink
    s.circle(50, 69, 2.1, fill=INK)
    s.polygon([(48.9, 70), (51.1, 70), (51.9, 74.2), (48.1, 74.2)], fill=INK)
    return s
