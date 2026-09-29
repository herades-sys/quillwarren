#!/bin/sh
# Builds the live app into ./release (entry release/main.mjs, must answer GET /health).
# The server and its JS dependencies are bundled into one file by esbuild.
# resvg is a native addon, so it stays external and ships in release/node_modules,
# together with the label font in release/fonts.
set -eu
cd "$(dirname "$0")/.."
rm -rf release
mkdir -p release/node_modules/@resvg release/fonts
npx esbuild apps/server/src/main.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --external:@resvg/resvg-js --external:bufferutil --external:utf-8-validate \
  --outfile=release/main.mjs --log-level=warning \
  --banner:js="import { createRequire as __delveRequire } from 'node:module'; const require = __delveRequire(import.meta.url);"
# The chat bridge runs as dev (where Claude Code is logged in), from the same release.
npx esbuild apps/server/src/cli/chat-bridge.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile=release/chat-bridge.mjs --log-level=warning
sh scripts/build-web.sh release/web
for pkg in node_modules/@resvg/*; do cp -R "$pkg" release/node_modules/@resvg/; done
cp node_modules/@expo-google-fonts/im-fell-english/400Regular/IMFellEnglish_400Regular.ttf \
   node_modules/@expo-google-fonts/marcellus-sc/400Regular/MarcellusSC_400Regular.ttf release/fonts/
printf '%s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M)" > release/VERSION
echo "built release/ ($(cat release/VERSION), $(du -sh --apparent-size release | cut -f1))"
