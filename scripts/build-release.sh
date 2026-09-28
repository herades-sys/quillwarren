#!/bin/sh
# Builds the live app into ./release (entry release/main.mjs, must answer GET /health).
# Phase 0: ships the placeholder server. Replace with the real bundle step later.
set -eu
cd "$(dirname "$0")/.."
rm -rf release
mkdir -p release
cp apps/server/placeholder.mjs release/main.mjs
printf '%s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M)" > release/VERSION
echo "built release/ ($(cat release/VERSION))"
