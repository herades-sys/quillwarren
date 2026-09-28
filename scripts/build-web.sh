#!/bin/sh
# Bundle the browser code (apps/web) into <outdir>/viewer.js. Default outdir: apps/web/dist.
set -eu
cd "$(dirname "$0")/.."
out="${1:-apps/web/dist}"
mkdir -p "$out"
npx esbuild apps/web/src/viewer.ts \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --outfile="$out/viewer.js" --log-level=warning
