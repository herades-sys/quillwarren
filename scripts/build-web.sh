#!/bin/sh
# Bundle the browser code (apps/web) into <outdir>: viewer.js (viewer + editor) and
# stack.js (the 3D view, with three.js), screen.js (the players' screen), trace.js +
# trace-worker.js (the picture tracer), table.js (Delve Table), table-dice.js (its
# 3D dice, with three.js and cannon-es, loaded on the first roll) and table3d.js (the
# 3D table view at /play/:id/3d, with three.js). Default outdir: apps/web/dist.
set -eu
cd "$(dirname "$0")/.."
out="${1:-apps/web/dist}"
mkdir -p "$out"
for entry in viewer stack screen trace trace-worker table table-dice table3d; do
  npx esbuild "apps/web/src/$entry.ts" \
    --bundle --format=esm --platform=browser --target=es2022 --minify \
    --outfile="$out/$entry.js" --log-level=warning
done
