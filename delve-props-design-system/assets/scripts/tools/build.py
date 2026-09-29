"""Build every prop under src/<category>/*.py into build/<category>/<id>.svg + build/manifest.json."""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)


def load_props(src=os.path.join(ROOT, "src")):
    props = []
    for cat in sorted(os.listdir(src)):
        d = os.path.join(src, cat)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".py"):
                continue
            spec = importlib.util.spec_from_file_location(fn[:-3], os.path.join(d, fn))
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            props.append(m)
    return props


def build(out=os.path.join(ROOT, "build"), order=None):
    mods = load_props()
    if order:
        mods.sort(key=lambda m: order.index(m.META["id"]) if m.META["id"] in order else 999)
    manifest = []
    for m in mods:
        meta = dict(m.META)
        sheet = m.draw()
        assert (sheet.w, sheet.h) == (meta["w"], meta["h"]), meta["id"]
        os.makedirs(os.path.join(out, meta["category"]), exist_ok=True)
        with open(os.path.join(out, meta["category"], meta["id"] + ".svg"), "w") as f:
            f.write(sheet.svg())
        manifest.append({k: meta[k] for k in ("id", "name", "category", "w", "h", "tags", "blocks")})
    with open(os.path.join(out, "manifest.json"), "w") as f:
        f.write("[\n" + ",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in manifest) + "\n]\n")
    return manifest


if __name__ == "__main__":
    for p in build(order=["table-round", "chest", "barrel", "statue"]):
        print(p["category"] + "/" + p["id"])
