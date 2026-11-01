"""Quillwarren prop validator — checks every rule the map renderer depends on.

usage: python3 validate.py <library-root>     (the folder holding manifest.json)
"""
import json
import os
import re
import sys
import tempfile

import numpy as np
from lxml import etree
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from render import render_svgs  # noqa: E402

SVGNS = "http://www.w3.org/2000/svg"
COLOURS = {"#000000", "#FFFFFF", "#999999", "none"}
WIDTHS = {"4", "2", "1.5"}
SHAPES = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
GEOM = {
    "path": {"d"}, "rect": {"x", "y", "width", "height", "rx", "ry"},
    "circle": {"cx", "cy", "r"}, "ellipse": {"cx", "cy", "rx", "ry"},
    "line": {"x1", "y1", "x2", "y2"}, "polyline": {"points"}, "polygon": {"points"}, "g": set(),
}
PAINT = {"fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "transform"}
TRANSFORM = re.compile(r"^\s*((translate|rotate)\(\s*-?[\d.]+(\s*[, ]\s*-?[\d.]+){0,2}\s*\)\s*)+$")
BLOCKS = {"none", "movement", "sight"}
SCALE = 4        # px per unit for the raster checks
MARGIN = 4


def check_tree(path, want_w=None, want_h=None):
    errs = []
    try:
        tree = etree.parse(path, etree.XMLParser(remove_comments=False))
    except Exception as e:
        return [f"not well-formed XML: {e}"], None
    root = tree.getroot()
    if root.tag != f"{{{SVGNS}}}svg":
        errs.append("root is not <svg> in the SVG namespace")
    extra = set(root.attrib) - {"viewBox", "width", "height"}
    if extra:
        errs.append(f"root has extra attributes {sorted(extra)}")
    vb = root.get("viewBox", "")
    m = re.fullmatch(r"0 0 (\d+) (\d+)", vb)
    size = None
    if not m:
        errs.append(f'viewBox "{vb}" is not "0 0 W H"')
    else:
        W, H = int(m.group(1)), int(m.group(2))
        size = (W, H)
        if W % 100 or H % 100:
            errs.append(f"viewBox {W}×{H} is not whole grid squares")
        if want_w is not None and (W, H) != (want_w * 100, want_h * 100):
            errs.append(f"viewBox {W}×{H} does not match manifest {want_w}×{want_h}")
        for k in ("width", "height"):
            if root.get(k) is not None and root.get(k) != str(W if k == "width" else H):
                errs.append(f"root {k} differs from viewBox")

    def walk(el, inherited):
        if not isinstance(el.tag, str):
            errs.append("comment or processing instruction found (keep files bare)")
            return
        if (el.text or "").strip() or (el.tail or "").strip():
            errs.append(f"character data inside <{etree.QName(el).localname}>")
        tag = etree.QName(el).localname
        if el is not root:
            if etree.QName(el).namespace != SVGNS or tag not in GEOM:
                errs.append(f"forbidden element <{tag}>")
                return
            bad = set(el.attrib) - GEOM[tag] - PAINT
            if bad:
                errs.append(f"<{tag}> has forbidden attributes {sorted(bad)}")
        st = dict(inherited)
        for k in ("fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"):
            if el.get(k) is not None:
                st[k] = el.get(k)
        for k in ("fill", "stroke"):
            v = el.get(k)
            if v is not None and v not in COLOURS:
                errs.append(f"<{tag}> {k}={v!r} is not ink/paper/shade/none")
        t = el.get("transform")
        if t is not None and not TRANSFORM.match(t):
            errs.append(f"<{tag}> transform {t!r} (only translate/rotate)")
        if tag in SHAPES:
            if tag != "line" and "fill" not in st:
                errs.append(f"<{tag}> has no explicit fill (would default to black)")
            if st.get("stroke", "none") != "none":
                if st.get("stroke-width") not in WIDTHS:
                    errs.append(f"<{tag}> stroke-width {st.get('stroke-width')!r} not 4 / 2 / 1.5")
                if st.get("stroke-linecap") != "round" or st.get("stroke-linejoin") != "round":
                    errs.append(f"<{tag}> stroke without round caps and joins")
            elif tag in ("line", "polyline") and st.get("stroke", "none") == "none":
                errs.append(f"<{tag}> draws nothing (no stroke)")
        for c in el:
            walk(c, st)

    walk(root, {})
    return errs, size


def raster_checks(svgs):
    """Margin band must be empty; no enclosed see-through holes."""
    out = {}
    with tempfile.TemporaryDirectory() as td:
        jobs = []
        for i, (p, txt) in enumerate(svgs):
            jobs.append({"svg": txt, "out": os.path.join(td, f"{i}.png"), "scale": SCALE, "bg": None})
        render_svgs(jobs)
        for i, (p, txt) in enumerate(svgs):
            a = np.array(Image.open(jobs[i]["out"]).convert("RGBA"))[:, :, 3]
            errs = []
            band = MARGIN * SCALE - 1   # 1px of anti-alias slack
            h, w = a.shape
            mask = np.zeros_like(a, bool)
            mask[:band, :] = mask[-band:, :] = True
            mask[:, :band] = mask[:, -band:] = True
            if (a[mask] > 24).any():
                ys, xs = np.nonzero((a > 24) & mask)
                errs.append(f"ink inside the {MARGIN}-unit margin (e.g. at {xs[0] / SCALE:.1f},{ys[0] / SCALE:.1f})")
            clear = a < 128
            lab, n = ndimage.label(clear)
            edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
            for k in range(1, n + 1):
                if k in edge:
                    continue
                area = (lab == k).sum() / SCALE ** 2
                if area >= 1.0:
                    ys, xs = np.nonzero(lab == k)
                    errs.append(f"unfilled hole of {area:.1f} unit² near "
                                f"({xs.mean() / SCALE:.0f},{ys.mean() / SCALE:.0f}) — grid would show through")
            cov = (a > 128).mean()
            out[p] = (errs, cov)
    return out


def main(root):
    man_path = os.path.join(root, "manifest.json")
    problems = 0
    man = json.load(open(man_path))
    props = man["props"] if isinstance(man, dict) else man
    ids = [p["id"] for p in props]
    if len(ids) != len(set(ids)):
        print("manifest: duplicate ids")
        problems += 1
    svgs = []
    for p in props:
        errs = []
        for k in ("id", "name", "category", "w", "h", "tags", "blocks"):
            if k not in p:
                errs.append(f"manifest entry missing {k}")
        if p.get("blocks") not in BLOCKS:
            errs.append(f"blocks={p.get('blocks')!r}")
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", p.get("id", "")):
            errs.append("id is not kebab-case")
        f = os.path.join(root, p.get("category", "?"), f"{p.get('id')}.svg")
        if not os.path.exists(f):
            errs.append(f"missing file {f}")
        else:
            e2, _ = check_tree(f, p.get("w"), p.get("h"))
            errs += e2
            svgs.append((f, open(f).read()))
        p["_errs"] = errs
    ras = raster_checks(svgs)
    for p in props:
        f = os.path.join(root, p["category"], f"{p['id']}.svg")
        errs = p.pop("_errs") + (ras.get(f, ([], 0))[0])
        cov = ras.get(f, ([], 0))[1]
        status = "OK  " if not errs else "FAIL"
        print(f"{status} {p['category']}/{p['id']}.svg  {p['w']}×{p['h']}  coverage {cov:.0%}")
        for e in errs:
            print(f"     - {e}")
        problems += len(errs)
    print(f"\n{len(props)} props, {problems} problem(s)")
    return problems


if __name__ == "__main__":
    sys.exit(1 if main(sys.argv[1] if len(sys.argv) > 1 else ".") else 0)
