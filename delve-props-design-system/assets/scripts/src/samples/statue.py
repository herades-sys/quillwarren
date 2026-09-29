import math
from ink import Sheet, INK, PAPER, SHADE, NONE, OUTLINE, DETAIL, TEXTURE, circle_pts, rrect_pts, arc_bar_pts

META = {"id": "statue", "name": "Statue on Plinth", "category": "samples", "w": 1, "h": 1,
        "tags": ["statue", "plinth", "stone", "monument", "hero", "decor"], "blocks": "sight"}


def capsule(p0, p1, r, n=6):
    """Rounded bar from p0 to p1 (a sleeve, a limb)."""
    ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    pts = []
    for (cx, cy), a0 in ((p1, ang - math.pi / 2), (p0, ang + math.pi / 2)):
        for k in range(n + 1):
            a = a0 + math.pi * k / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def draw():
    s = Sheet(1, 1, seed=41)
    # plinth: bevelled lower step in shade (it sits lower), top face in paper
    s.shape([(9, 9), (91, 9), (91, 91), (9, 91)], fill=SHADE, sw=OUTLINE, amp=0.45, step=5, corners=(0, 1, 2, 3))
    for a, b in (((9, 9), (16, 16)), ((91, 9), (84, 16)), ((91, 91), (84, 84)), ((9, 91), (16, 84))):
        s.line(a, b, sw=DETAIL, amp=0.1)
    s.shape([(16, 16), (84, 16), (84, 84), (16, 84)], fill=PAPER, sw=DETAIL, amp=0.35, step=5, corners=(0, 1, 2, 3))
    # a crack in the stone
    s.stroke([(16.5, 66), (19.5, 67.5), (21.5, 71.5), (24.5, 72.8), (26, 76.5), (29.5, 78.5)],
             sw=TEXTURE, amp=0.05, step=1.5)

    # --- the figure faces south ---
    # cloak over the shoulders: the silhouette, wide and shallow, falling behind (north)
    cloak = [(50 + 27 * math.cos(t), 45 + (14 if math.sin(t) < 0 else 12) * math.sin(t))
             for t in [2 * math.pi * k / 48 for k in range(48)]]
    s.shape(cloak, fill=SHADE, sw=OUTLINE, amp=0.35, step=3.5)
    for a, b in (((29, 39), (26.5, 44)), ((71, 39), (73.5, 44)), ((36, 33.5), (34, 36.5)), ((64, 33.5), (66, 36.5))):
        s.line(a, b, sw=TEXTURE, amp=0.05)       # folds
    # crossguard of the planted sword, then the forearms reaching to its hilt
    s.shape(rrect_pts(35, 62.5, 30, 5, r=2.5), fill=SHADE, sw=DETAIL, amp=0.1, step=2.5)
    for sx in (-1, 1):
        s.shape(capsule((50 + sx * 14, 50), (50 + sx * 4.8, 61), 4.5), fill=PAPER, sw=DETAIL, amp=0.1, step=2)
    s.shape(circle_pts(50, 62.5, 4.2, n=16), fill=PAPER, sw=DETAIL, amp=0.1, step=1.5)   # hands on the pommel
    # head: hair in shade over the crown, a sliver of brow at the front (south)
    hx, hy, hr = 50, 45, 9.3
    s.shape(circle_pts(hx, hy, hr, n=28), fill=PAPER, sw=DETAIL, amp=0.15, step=2.5)
    hair = [(hx + (hr - 0.3) * math.cos(math.radians(a)), hy + (hr - 0.3) * math.sin(math.radians(a)))
            for a in range(128, 413, 6)]
    hair += [(hx + 3, hy + 5.4), (hx - 3, hy + 5.4)]
    s.shape(hair, fill=SHADE, sw=DETAIL, amp=0.1, step=2)
    return s
