#!/usr/bin/env bash
# Build the VellumInput sidecar.
#
#   bash native/VellumInput/build.sh            # arm64 (this machine)
#   UNIVERSAL=1 bash native/VellumInput/build.sh  # arm64 + x86_64 fat binary
#
# Output: native/VellumInput/dist/vellum-input
#
# -swift-version 5 on purpose: the file-scope mutable state this binary relies on
# (practiceMode, abortRequested, the tap handles) is exactly what Swift 6 strict
# concurrency rejects, and the access pattern here is already serialised by the
# single action queue.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/dist/vellum-input"
DEPLOY_TARGET="13.0"

mkdir -p "$DIR/dist"

SOURCES=("$DIR/Proto.swift" "$DIR/Mouse.swift" "$DIR/Apps.swift" "$DIR/Guard.swift" "$DIR/main.swift")

build_one() {
  local arch="$1" out="$2"
  swiftc \
    -swift-version 5 \
    -O -whole-module-optimization \
    -target "${arch}-apple-macos${DEPLOY_TARGET}" \
    -framework AppKit -framework CoreGraphics -framework ApplicationServices \
    -o "$out" \
    "${SOURCES[@]}"
}

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  build_one arm64 "$DIR/dist/.vellum-input-arm64"
  build_one x86_64 "$DIR/dist/.vellum-input-x86_64"
  lipo -create -output "$OUT" "$DIR/dist/.vellum-input-arm64" "$DIR/dist/.vellum-input-x86_64"
  rm -f "$DIR/dist/.vellum-input-arm64" "$DIR/dist/.vellum-input-x86_64"
else
  build_one "$(uname -m)" "$OUT"
fi

chmod +x "$OUT"
echo "built $OUT"
lipo -archs "$OUT" 2>/dev/null | sed 's/^/  archs: /' || true
