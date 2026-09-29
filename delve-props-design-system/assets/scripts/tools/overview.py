"""Overview card for one batch: every prop on parchment with a faint 100-unit grid, id underneath.

usage: python3 overview.py <library-root> <category> [out.svg]
Labels live ONLY on this card, never inside prop files.
"""
import json
import os
import re
import sys

PARCHMENT = "#F0ECE0"
GRID = "#DDD6C3"        # faint grid on parchment
LABEL = "#4A4336"       # label ink
FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
U = 100


def card(root, category, per_row=None):
    man = json.load(open(os.path.join(root, "manifest.json")))
    props = [p for p in man if p["category"] == category]
    # one row, props bottom-aligned on a shared baseline, one empty square between them
    rows, row, width = [], [], 1
    limit = per_row or 999
    for p in props:
        if row and (len(row) >= limit):
            rows.append(row)
            row = []
        row.append(p)
    if row:
        rows.append(row)
    W = max(1 + sum(p["w"] + 1 for p in r) for r in rows)
    y = 1
    body = []
    for r in rows:
        tallest = max(p["h"] for p in r)
        x = 1
        base = y + tallest
        for p in r:
            svg = open(os.path.join(root, p["category"], p["id"] + ".svg")).read()
            inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", svg.strip()).strip("\n")
            px, py = x * U, (base - p["h"]) * U
            body.append(f'  <svg x="{px}" y="{py}" width="{p["w"] * U}" height="{p["h"] * U}" '
                        f'viewBox="0 0 {p["w"] * U} {p["h"] * U}">\n{inner}\n  </svg>')
            body.append(f'  <text x="{px + p["w"] * U / 2}" y="{base * U + 36}" text-anchor="middle" '
                        f'font-family="{FONT}" font-size="20" fill="{LABEL}">{p["id"]}</text>')
            x += p["w"] + 1
        y = base + 1
    H = y
    grid = []
    for gx in range(1, W):
        grid.append(f'M{gx * U} 0V{H * U}')
    for gy in range(1, H):
        grid.append(f'M0 {gy * U}H{W * U}')
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W * U}" height="{H * U}" viewBox="0 0 {W * U} {H * U}">',
           f'  <rect width="{W * U}" height="{H * U}" fill="{PARCHMENT}"/>',
           f'  <path d="{"".join(grid)}" fill="none" stroke="{GRID}" stroke-width="1.5"/>']
    out += body
    out.append("</svg>")
    return "\n".join(out) + "\n", (W, H)


if __name__ == "__main__":
    root, cat = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(root, "overview", f"{cat}.svg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    svg, (W, H) = card(root, cat)
    open(out, "w").write(svg)
    print(out, f"{W}×{H} squares")
