#!/bin/sh
# Builds the live app into ./release (entry release/main.mjs, must answer GET /health).
# The server and all its JS dependencies are bundled into one file by esbuild.
set -eu
cd "$(dirname "$0")/.."
rm -rf release
mkdir -p release
npx esbuild apps/server/src/main.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile=release/main.mjs --log-level=warning \
  --banner:js="import { createRequire as __delveRequire } from 'node:module'; const require = __delveRequire(import.meta.url);"
printf '%s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M)" > release/VERSION
echo "built release/ ($(cat release/VERSION), $(du -h --apparent-size release/main.mjs | cut -f1))"
