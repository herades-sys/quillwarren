#!/bin/sh
# Bundle the browser code (apps/web) into <outdir>: viewer.js (viewer + editor) and
# stack.js (the 3D view, with three.js) and screen.js (the players' screen). Default outdir: apps/web/dist.
set -eu
cd "$(dirname "$0")/.."
out="${1:-apps/web/dist}"
mkdir -p "$out"
for entry in viewer stack screen; do
  npx esbuild "apps/web/src/$entry.ts" \
    --bundle --format=esm --platform=browser --target=es2022 --minify \
    --outfile="$out/$entry.js" --log-level=warning
done
