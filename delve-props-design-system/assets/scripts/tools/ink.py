"""Quillwarren prop toolkit — hand-inked line generator.

Every prop is plain SVG in three colours. Shapes are sampled from ideal
geometry, nudged along their normals by smooth seeded noise (the "pen"),
and written as cubic Bézier paths. Same seed -> same drawing, always.
"""
import math
import random

INK = "#000000"
PAPER = "#FFFFFF"
SHADE = "#999999"
NONE = "none"

OUTLINE = 4      # silhouettes
DETAIL = 2       # inner details: planks, bands, seams
TEXTURE = 1.5    # grain, cracks, hair

UNIT = 100       # one grid square
MARGIN = 4


def fmt(v):
    s = f"{v:.1f}"
    if s.endswith(".0"):
        s = s[:-2]
    if s in ("-0", "-0.0"):
        s = "0"
    return s


# ---------------------------------------------------------------- geometry

def _len(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def resample(pts, step, closed):
    """Uniform arc-length resampling of a polyline."""
    seg = list(zip(pts, pts[1:] + ([pts[0]] if closed else [])))
    total = sum(_len(a, b) for a, b in seg)
    n = max(2 if not closed else 6, round(total / step))
    d = total / n
    out, acc, i = [], 0.0, 0
    targets = [k * d for k in range(n + (0 if closed else 1))]
    for t in targets:
        while i < len(seg) - 1 and acc + _len(*seg[i]) < t - 1e-9:
            acc += _len(*seg[i])
            i += 1
        a, b = seg[i]
        L = _len(a, b) or 1e-9
        u = min(1.0, max(0.0, (t - acc) / L))
        out.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))
    return out


def circle_pts(cx, cy, r, n=None, start=0.0):
    n = n or max(12, int(2 * math.pi * r / 2))
    return [(cx + r * math.cos(start + 2 * math.pi * k / n),
             cy + r * math.sin(start + 2 * math.pi * k / n)) for k in range(n)]


def ellipse_pts(cx, cy, rx, ry, n=None, start=0.0):
    n = n or max(16, int(math.pi * (rx + ry) / 2))
    return [(cx + rx * math.cos(start + 2 * math.pi * k / n),
             cy + ry * math.sin(start + 2 * math.pi * k / n)) for k in range(n)]


def arc_pts(cx, cy, r, a0, a1, n=None):
    n = n or max(4, int(abs(a1 - a0) * r / 2))
    return [(cx + r * math.cos(a0 + (a1 - a0) * k / n),
             cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]


def arc_bar_pts(cx, cy, r, half, a0, a1, cap_n=6):
    """A curved bar with round caps following an arc (angles in radians, a0 < a1)."""
    outer = arc_pts(cx, cy, r + half, a0, a1)
    inner = arc_pts(cx, cy, r - half, a1, a0)
    pts = list(outer)
    ex, ey = cx + r * math.cos(a1), cy + r * math.sin(a1)
    for k in range(1, cap_n):            # cap at a1: outward -> forward tangent -> inward
        t = a1 + math.pi * k / cap_n
        pts.append((ex + half * math.cos(t), ey + half * math.sin(t)))
    pts.extend(inner)
    ex, ey = cx + r * math.cos(a0), cy + r * math.sin(a0)
    for k in range(1, cap_n):            # cap at a0: inward -> backward tangent -> outward
        t = a0 - math.pi + math.pi * k / cap_n
        pts.append((ex + half * math.cos(t), ey + half * math.sin(t)))
    return pts


def rrect_pts(x, y, w, h, r=0.0, corner_n=5):
    """Rounded rectangle outline, clockwise from top-left."""
    r = min(r, w / 2, h / 2)
    if r <= 0.01:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    pts = []
    for (cx, cy, a0) in ((x + w - r, y + r, -math.pi / 2), (x + w - r, y + h - r, 0),
                         (x + r, y + h - r, math.pi / 2), (x + r, y + r, math.pi)):
        for k in range(corner_n + 1):
            a = a0 + (math.pi / 2) * k / corner_n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def line_poly_hits(p0, p1, poly):
    """Parameters t in [0,1] where segment p0-p1 crosses a closed polygon."""
    hits = []
    x1, y1 = p0
    x2, y2 = p1
    n = len(poly)
    for i in range(n):
        x3, y3 = poly[i]
        x4, y4 = poly[(i + 1) % n]
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(den) < 1e-12:
            continue
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
        u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
        if 0 <= t <= 1 and 0 <= u <= 1:
            hits.append(t)
    return sorted(hits)


def clip_line(p0, p1, poly):
    """Longest inside span of p0-p1 within polygon (assumes convex-ish)."""
    t = line_poly_hits(p0, p1, poly)
    if len(t) < 2:
        return None
    a, b = t[0], t[-1]
    lerp = lambda u: (p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u)
    return lerp(a), lerp(b)


def inside(pt, poly):
    x, y = pt
    c = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


# ---------------------------------------------------------------- the pen

class Pen:
    """Seeded hand: turns ideal point lists into slightly uneven ink."""

    def __init__(self, seed):
        self.rng = random.Random(seed)

    def noise(self, length, amp, closed, wl=(22, 60), terms=3):
        """Smooth offset along a line: one slow swell plus quieter ripples.
        `amp` is the (approximate) peak deviation in units."""
        rng = self.rng
        comps = []
        for i in range(terms):
            lam = rng.uniform(*wl) * (2.2 if i == 0 else 1.0 / i)
            if closed:
                k = max(1, round(length / lam))
                f = k / length
            else:
                f = 1.0 / lam
            w = 1.0 if i == 0 else 0.35 / i
            comps.append([w * rng.uniform(0.8, 1.0), f, rng.uniform(0, 2 * math.pi)])
        peak = sum(c[0] for c in comps)
        for c in comps:
            c[0] *= amp / peak
        return lambda s: sum(a * math.sin(2 * math.pi * f * s + p) for a, f, p in comps)

    def wobble(self, pts, closed, amp, step=5.0, wl=(22, 60), corners=()):
        """Resample, then push every point along its normal by smooth noise.
        corners: indices into the ORIGINAL pts that must stay sharp."""
        if amp <= 0 and not corners:
            pts2 = resample(pts, step, closed) if len(pts) > 2 else list(pts)
            return pts2, set()
        # sample side-by-side so corner vertices survive resampling
        corner_idx = sorted(set(corners))
        if corner_idx:
            out, flags = [], set()
            m = len(corner_idx)
            spans = [(corner_idx[i], corner_idx[(i + 1) % m]) for i in range(m)] if closed else \
                    [(corner_idx[i], corner_idx[i + 1]) for i in range(m - 1)]
            for a, b in spans:
                if b <= a:
                    chain = pts[a:] + pts[:b + 1]
                else:
                    chain = pts[a:b + 1]
                side = resample(chain, step, closed=False)
                flags.add(len(out))
                out.extend(side[:-1])
            if not closed:
                out.append(pts[corner_idx[-1]])
                flags.add(len(out) - 1)
            base = out
        else:
            base = resample(pts, step, closed)
            flags = set()
        n = len(base)
        # arc length
        s, acc = [0.0], 0.0
        for i in range(1, n):
            acc += _len(base[i - 1], base[i])
            s.append(acc)
        total = acc + (_len(base[-1], base[0]) if closed else 0)
        nz = self.noise(total, amp, closed, wl)
        res = []
        for i, p in enumerate(base):
            if closed:
                a, b = base[i - 1], base[(i + 1) % n]
            else:
                a, b = base[max(0, i - 1)], base[min(n - 1, i + 1)]
            tx, ty = b[0] - a[0], b[1] - a[1]
            L = math.hypot(tx, ty) or 1
            nx, ny = -ty / L, tx / L
            o = nz(s[i])
            res.append((p[0] + nx * o, p[1] + ny * o))
        return res, flags

    def jitter(self, p, amt):
        return (p[0] + self.rng.uniform(-amt, amt), p[1] + self.rng.uniform(-amt, amt))


def bezier_d(pts, closed, sharp=()):
    """Catmull-Rom through pts -> cubic Bézier path data. `sharp` indices keep corners."""
    n = len(pts)
    if n < 2:
        return ""
    sharp = set(sharp)

    def P(i):
        return pts[i % n] if closed else pts[max(0, min(n - 1, i))]

    def t_out(i):
        if i in sharp or (not closed and i == 0):
            a, b = P(i), P(i + 1)
            return (b[0] - a[0], b[1] - a[1])
        a, b = P(i - 1), P(i + 1)
        return ((b[0] - a[0]) / 2, (b[1] - a[1]) / 2)

    def t_in(i):
        if i in sharp or (not closed and i == n - 1):
            a, b = P(i - 1), P(i)
            return (b[0] - a[0], b[1] - a[1])
        a, b = P(i - 1), P(i + 1)
        return ((b[0] - a[0]) / 2, (b[1] - a[1]) / 2)

    d = [f"M{fmt(pts[0][0])} {fmt(pts[0][1])}"]
    segs = n if closed else n - 1
    for i in range(segs):
        p0, p1 = P(i), P(i + 1)
        j = (i + 1) % n if closed else i + 1
        to, ti = t_out(i), t_in(j)
        c1 = (p0[0] + to[0] / 3, p0[1] + to[1] / 3)
        c2 = (p1[0] - ti[0] / 3, p1[1] - ti[1] / 3)
        d.append(f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(p1[0])} {fmt(p1[1])}")
    if closed:
        d.append("Z")
    return "".join(d)


# ---------------------------------------------------------------- the sheet

class Sheet:
    """One prop: w×h grid squares, drawn in ink/paper/shade only."""

    def __init__(self, w, h, seed):
        self.w, self.h = w, h
        self.W, self.H = w * UNIT, h * UNIT
        self.pen = Pen(seed)
        self.els = []

    # raw emitters ----------------------------------------------------
    def _attrs(self, fill, stroke, sw):
        a = [("fill", fill), ("stroke", stroke)]
        if stroke != NONE:
            assert sw in (OUTLINE, DETAIL, TEXTURE), sw
            a += [("stroke-width", fmt(sw)), ("stroke-linecap", "round"), ("stroke-linejoin", "round")]
        return a

    def path(self, d, fill=NONE, stroke=INK, sw=OUTLINE):
        self.els.append(("path", [("d", d)] + self._attrs(fill, stroke, sw)))

    def circle(self, cx, cy, r, fill=INK, stroke=NONE, sw=None):
        self.els.append(("circle", [("cx", fmt(cx)), ("cy", fmt(cy)), ("r", fmt(r))] + self._attrs(fill, stroke, sw)))

    def polygon(self, pts, fill=INK, stroke=NONE, sw=None):
        p = " ".join(f"{fmt(x)},{fmt(y)}" for x, y in pts)
        self.els.append(("polygon", [("points", p)] + self._attrs(fill, stroke, sw)))

    # inked helpers ---------------------------------------------------
    def shape(self, pts, fill=PAPER, stroke=INK, sw=OUTLINE, amp=0.8, step=5.0,
              corners=(), wl=(22, 60)):
        """Closed hand-inked shape. Returns the wobbled polygon (for clipping)."""
        wp, flags = self.pen.wobble(pts, True, amp, step, wl, corners)
        self.path(bezier_d(wp, True, flags), fill, stroke, sw)
        return wp

    def fill_then_outline(self, pts, fill=PAPER, sw=OUTLINE, amp=0.8, step=5.0, corners=(), wl=(22, 60)):
        """Same wobbled geometry, split: returns (poly, emit_outline)."""
        wp, flags = self.pen.wobble(pts, True, amp, step, wl, corners)
        d = bezier_d(wp, True, flags)
        self.path(d, fill, NONE, None)
        return wp, (lambda: self.path(d, NONE, INK, sw))

    def stroke(self, pts, sw=DETAIL, amp=0.5, step=5.0, wl=(18, 45), corners=()):
        wp, flags = self.pen.wobble(pts, False, amp, step, wl, corners)
        self.path(bezier_d(wp, False, flags), NONE, INK, sw)
        return wp

    def line(self, p0, p1, sw=DETAIL, amp=0.5, step=6.0, bow=0.0):
        """Hand-ruled straight line with an optional gentle bow."""
        L = _len(p0, p1)
        n = max(2, int(L / step))
        nx, ny = -(p1[1] - p0[1]) / (L or 1), (p1[0] - p0[0]) / (L or 1)
        pts = []
        for k in range(n + 1):
            u = k / n
            b = bow * math.sin(math.pi * u)
            pts.append((p0[0] + (p1[0] - p0[0]) * u + nx * b, p0[1] + (p1[1] - p0[1]) * u + ny * b))
        return self.stroke(pts, sw, amp, step)

    # output ----------------------------------------------------------
    def svg(self):
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.W}" height="{self.H}" '
               f'viewBox="0 0 {self.W} {self.H}">']
        for tag, attrs in self.els:
            a = " ".join(f'{k}="{v}"' for k, v in attrs)
            out.append(f"  <{tag} {a}/>")
        out.append("</svg>")
        return "\n".join(out) + "\n"


def rotate(pts, cx, cy, deg):
    a = math.radians(deg)
    c, s_ = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * c - (y - cy) * s_, cy + (x - cx) * s_ + (y - cy) * c) for x, y in pts]


def band_pts(center, half, cap_n=6):
    """Closed outline of a thick band (round caps) around an open centre polyline."""
    n = len(center)
    normals = []
    for i in range(n):
        a = center[max(0, i - 1)]
        b = center[min(n - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1
        normals.append((-ty / L, tx / L))
    left = [(p[0] + nx * half, p[1] + ny * half) for p, (nx, ny) in zip(center, normals)]
    right = [(p[0] - nx * half, p[1] - ny * half) for p, (nx, ny) in zip(center, normals)]
    pts = list(left)
    for end, (nx, ny), sgn in ((center[-1], normals[-1], 1), (center[0], normals[0], -1)):
        base = math.atan2(ny, nx)
        for k in range(1, cap_n):
            t = base - math.pi * k / cap_n if sgn > 0 else base + math.pi - math.pi * k / cap_n
            pts.append((end[0] + half * math.cos(t), end[1] + half * math.sin(t)))
        if sgn > 0:
            pts.extend(reversed(right))
    return pts
