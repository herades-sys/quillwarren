"""Rasterise SVG / HTML with headless Chromium (the same engine a browser map uses)."""
from playwright.sync_api import sync_playwright


def render_svgs(jobs):
    """jobs: list of dicts {svg: text, out: path, scale: px per unit, bg: css colour or None}"""
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        for j in jobs:
            import re
            m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', j["svg"])
            W, H = float(m.group(1)), float(m.group(2))
            s = j.get("scale", 1.0)
            w, h = round(W * s), round(H * s)
            svg = re.sub(r'width="[\d.]+" height="[\d.]+"', f'width="{w}" height="{h}"', j["svg"], count=1)
            bg = j.get("bg")
            html = (f"<html><body style='margin:0;background:{bg or 'transparent'}'>"
                    f"<div style='width:{w}px;height:{h}px'>{svg}</div></body></html>")
            pg.set_viewport_size({"width": w, "height": h})
            pg.set_content(html)
            pg.screenshot(path=j["out"], omit_background=bg is None, clip={"x": 0, "y": 0, "width": w, "height": h})
        b.close()


def render_html(html, out, width, height, scale=1):
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(device_scale_factor=scale)
        pg.set_viewport_size({"width": width, "height": height})
        pg.set_content(html)
        pg.wait_for_timeout(150)
        pg.screenshot(path=out, full_page=True)
        b.close()
