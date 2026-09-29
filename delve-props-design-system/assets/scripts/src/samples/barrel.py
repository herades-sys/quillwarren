import math
from ink import Sheet, INK, PAPER, SHADE, NONE, OUTLINE, DETAIL, TEXTURE, circle_pts, clip_line

META = {"id": "barrel", "name": "Barrel", "category": "samples", "w": 1, "h": 1,
        "tags": ["barrel", "container", "storage", "wood", "cellar", "tavern"], "blocks": "movement"}


def draw():
    s = Sheet(1, 1, seed=11)
    cx, cy = 50, 50
    pen = s.pen

    # iron hoop band: outermost ring, darker metal
    s.shape(circle_pts(cx, cy, 41), fill=SHADE, sw=OUTLINE, amp=0.6)
    # inner hoop seam — splits the band into two hoops
    s.shape(circle_pts(cx, cy, 36.9), fill=NONE, sw=TEXTURE, amp=0.2)
    # stave ends (the chime): paper ring with joints
    chime = s.shape(circle_pts(cx, cy, 33.6), fill=PAPER, sw=DETAIL, amp=0.35)
    n = 15
    for k in range(n):
        a = 2 * math.pi * (k + pen.rng.uniform(-0.12, 0.12)) / n + 0.2
        p0 = (cx + 27.5 * math.cos(a), cy + 27.5 * math.sin(a))
        p1 = (cx + 34 * math.cos(a), cy + 34 * math.sin(a))
        s.line(p0, p1, sw=TEXTURE, amp=0.15)
    # the head (lid): boards run north-south
    lid = s.shape(circle_pts(cx, cy, 27.5), fill=PAPER, sw=DETAIL, amp=0.45)
    for x in (cx - 9.5, cx + 9.5):
        seg = clip_line((x, cy - 40), (x, cy + 40), lid)
        s.line(pen.jitter(seg[0], 0.3), pen.jitter(seg[1], 0.3), sw=DETAIL, amp=0.35)
    # grain
    for (x, y0, y1) in ((cx - 17, cy - 12, cy + 6), (cx - 3.5, cy - 20, cy - 4),
                        (cx + 3.5, cy + 5, cy + 19), (cx + 16, cy - 9, cy + 11)):
        s.line((x, y0), (x + pen.rng.uniform(-1, 1), y1), sw=TEXTURE, amp=0.6, bow=1.2)
    # bung hole — an opening, so ink
    s.circle(cx + 1.5, cy + 8.5 - 14, 2.8, fill=INK)
    # nail heads on the hoop
    for a in (0.9, 0.9 + math.pi):
        s.circle(cx + 38.9 * math.cos(a), cy + 38.9 * math.sin(a), 1.1, fill=INK)
    return s
