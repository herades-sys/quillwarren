#!/bin/sh
# Builds Delve for Windows (x64) on Linux (the dev container): a portable zip and, when
# NSIS can be built without wine, an installer. Everything it downloads is
# kept in ~/.cache/delve-desktop (and electron-builder's own caches) and
# checked against published checksums. Run from anywhere:
#   sh apps/desktop/scripts/build.sh
# Needs: the root `npm ci` (the web release) and `npm ci` in apps/desktop
# (Electron and electron-builder; ELECTRON_SKIP_BINARY_DOWNLOAD=1 is fine,
# the Linux Electron is never run). See docs/DESKTOP.md, "Building".
set -eu
cd "$(dirname "$0")/.."
DESKTOP=$(pwd)
ROOT=$(cd ../.. && pwd)
CACHE="${DELVE_DESKTOP_CACHE:-$HOME/.cache/delve-desktop}"
RES="$DESKTOP/build/resources"
# The same Node.js the server is tested on (the CT's), unless told otherwise.
NODE_VERSION="${DELVE_NODE_VERSION:-$(node -p 'process.versions.node')}"
RESVG_VERSION=$(node -p "require('$ROOT/node_modules/@resvg/resvg-js/package.json').version")
APP_VERSION=$(node -p "require('$DESKTOP/package.json').version")
STAMP="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M)"
mkdir -p "$CACHE"

echo "== 1. the web release (npm run build, unchanged)"
(cd "$ROOT" && npm run -s build)

echo "== 2. the desktop server: release/ plus desktop-main.mjs"
rm -rf "$RES/server" && mkdir -p "$RES/server/node_modules/@resvg"
cp -R "$ROOT/release/web" "$ROOT/release/assets" "$ROOT/release/fonts" "$RES/server/"
# The app has no Delve Table and no players' screen (docs/DESKTOP.md, "What the Windows app
# leaves out"), so their browser bundles stay behind: table.js, table-dice.js and table3d.js
# (with PixiJS and cannon-es) and screen.js, as scripts/build-web.sh names them.
rm -f "$RES/server/web"/table* "$RES/server/web"/screen.*
echo "web bundles shipped: $(cd "$RES/server/web" && echo *)"
cp -R "$ROOT/release/node_modules/@resvg/resvg-js" "$RES/server/node_modules/@resvg/"
(cd "$ROOT" && npx esbuild apps/server/src/desktop/main.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --external:@resvg/resvg-js --external:bufferutil --external:utf-8-validate \
  --outfile="$RES/server/desktop-main.mjs" --log-level=warning \
  --banner:js="import { createRequire as __delveRequire } from 'node:module'; const require = __delveRequire(import.meta.url);")
# the local chat's prompt is read next to the bundle (chat/local-setup.ts)
cp "$ROOT/apps/server/src/chat/lean-prompt.md" "$RES/server/"
printf '%s\n' "$APP_VERSION-$STAMP" > "$RES/server/VERSION"

echo "== 3. resvg for Windows (@resvg/resvg-js-win32-x64-msvc $RESVG_VERSION from npm)"
TGZ="$CACHE/resvg-resvg-js-win32-x64-msvc-$RESVG_VERSION.tgz" # the name npm pack gives it
if [ ! -f "$TGZ" ]; then
  (cd "$CACHE" && npm pack "@resvg/resvg-js-win32-x64-msvc@$RESVG_VERSION" --silent >/dev/null)
fi
WANT=$(npm view "@resvg/resvg-js-win32-x64-msvc@$RESVG_VERSION" dist.integrity)
GOT="sha512-$(node -e "process.stdout.write(require('crypto').createHash('sha512').update(require('fs').readFileSync(process.argv[1])).digest('base64'))" "$TGZ")"
[ "$WANT" = "$GOT" ] || { echo "resvg: checksum mismatch ($GOT, npm says $WANT)"; exit 1; }
mkdir -p "$RES/server/node_modules/@resvg/resvg-js-win32-x64-msvc"
tar -xzf "$TGZ" -C "$RES/server/node_modules/@resvg/resvg-js-win32-x64-msvc" --strip-components=1

echo "== 4. Node.js $NODE_VERSION for Windows (nodejs.org)"
ZIP="node-v$NODE_VERSION-win-x64.zip"
if [ ! -f "$CACHE/$ZIP" ]; then
  curl -fsSL -o "$CACHE/$ZIP.part" "https://nodejs.org/dist/v$NODE_VERSION/$ZIP"
  mv "$CACHE/$ZIP.part" "$CACHE/$ZIP"
fi
curl -fsSL -o "$CACHE/SHASUMS256-v$NODE_VERSION.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$CACHE" && grep " $ZIP\$" "SHASUMS256-v$NODE_VERSION.txt" | sha256sum -c --quiet -) || { echo "node: checksum mismatch"; exit 1; }
rm -rf "$RES/node" && mkdir -p "$RES/node"
unzip -q -j -o "$CACHE/$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$RES/node"

echo "== 4b. llama.cpp's llama-server for Windows (the built-in model runtime, github.com/ggml-org/llama.cpp)"
# Pinned: the build the user approved on 2026-10-31 (Vulkan: NVIDIA, AMD and Intel GPUs, or the CPU).
LLAMA_BUILD=b11476
LLAMA_ZIP="llama-$LLAMA_BUILD-bin-win-vulkan-x64.zip"
LLAMA_SHA256=5c71e7b749697da4a8d46e9ee55486845cbba27c9dfbecb4007f31ba6610d523
LLAMA_LICENSE="llama.cpp-$LLAMA_BUILD-LICENSE"
LLAMA_LICENSE_SHA256=94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d
if [ ! -f "$CACHE/$LLAMA_ZIP" ]; then
  curl -fsSL -o "$CACHE/$LLAMA_ZIP.part" "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_BUILD/$LLAMA_ZIP"
  mv "$CACHE/$LLAMA_ZIP.part" "$CACHE/$LLAMA_ZIP"
fi
# the zip carries no llama.cpp licence: it comes from the same tag
if [ ! -f "$CACHE/$LLAMA_LICENSE" ]; then
  curl -fsSL -o "$CACHE/$LLAMA_LICENSE.part" "https://raw.githubusercontent.com/ggml-org/llama.cpp/$LLAMA_BUILD/LICENSE"
  mv "$CACHE/$LLAMA_LICENSE.part" "$CACHE/$LLAMA_LICENSE"
fi
(cd "$CACHE" && printf '%s  %s\n%s  %s\n' "$LLAMA_SHA256" "$LLAMA_ZIP" "$LLAMA_LICENSE_SHA256" "$LLAMA_LICENSE" | sha256sum -c --quiet -) || { echo "llama.cpp: checksum mismatch"; exit 1; }
rm -rf "$RES/llama" && mkdir -p "$RES/llama"
# llama-server and what it loads (its DLLs, ggml with every CPU variant and the Vulkan backend, OpenMP);
# the zip's other tools (llama-cli, llama-bench, …) and their *-impl.dll stay behind
unzip -q -o "$CACHE/$LLAMA_ZIP" llama-server.exe llama-server-impl.dll llama.dll llama-common.dll mtmd.dll 'ggml*.dll' libomp.dll LICENSE-LLVM-OpenMP -d "$RES/llama"
cp "$CACHE/$LLAMA_LICENSE" "$RES/llama/LICENSE-llama.cpp"
printf '%s\n' "$LLAMA_BUILD" > "$RES/llama/VERSION"
echo "llama.cpp $LLAMA_BUILD: $(ls "$RES/llama" | wc -l) files, $(du -sh "$RES/llama" | cut -f1)"

echo "== 5. icon and third-party notices"
node scripts/icon.mjs
node scripts/notices.mjs "$RES/THIRD-PARTY-NOTICES.txt" "$RES/node/LICENSE" "$RES/llama"

echo "== 5b. the Claude Desktop extension (Delve.mcpb: the bridge, Delve's tool list, the icon)"
# its tool list is read from the server's own MCP tools here, so it can't drift (docs/DESKTOP.md, "Claude Desktop")
(cd "$ROOT" && node apps/server/src/cli/build-mcpb.ts "$RES/Delve.mcpb" --version "$APP_VERSION")

echo "== 6. the Electron main process"
(cd "$ROOT" && npx esbuild apps/desktop/src/main.ts --bundle --platform=node --format=cjs --target=node22 \
  --external:electron --outfile=apps/desktop/dist/main.cjs --log-level=warning)
(cd "$ROOT" && npx tsc -p apps/desktop)

echo "== 7. package (electron-builder, Windows x64, cross-built without wine)"
rm -rf out
# rcedit and signing need Windows or wine: off here (Delve.exe keeps Electron's icon and version info).
npx electron-builder --win zip --x64 -c.win.signAndEditExecutable=false --publish never
if [ "${DELVE_NSIS:-1}" = "1" ]; then
  # electron-builder's own NSIS template runs a generated program under wine to
  # make the uninstaller; installer-nowine.nsi writes it at install time instead.
  npx electron-builder --win nsis --x64 --prepackaged out/win-unpacked -c.win.signAndEditExecutable=false \
    -c.nsis.script=build/installer-nowine.nsi --publish never || echo "!! the NSIS installer failed: the zip is the build to test"
fi
ls -la out
echo "built Delve $APP_VERSION ($STAMP)"
