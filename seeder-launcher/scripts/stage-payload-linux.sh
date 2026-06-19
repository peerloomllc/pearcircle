#!/usr/bin/env bash
# Stage the flat seeder-launcher payload for a Linux target. Shared by the
# .deb and AppImage builders. Mirrors steps 1-5 of build-pkg-macos.sh with
# darwin-arm64 swapped for the Linux target triple.
#
# The payload layout is exactly what host/index.js resolvePaths() expects in
# a non-dev install: host-bundled.js, node, bare, the pearcircle-seeder
# wrapper, worklet/worklet.bundle (+ its addon prebuilds), and ui/ all flat
# in one directory.
#
# Env:
#   BARE_HOST   linux-x64 | linux-arm64   (required)
#   OUT_DIR     absolute path to stage the payload into (required)
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
SCRIPT_DIR="$LAUNCHER/scripts"

BARE_HOST="${BARE_HOST:?BARE_HOST must be linux-x64 or linux-arm64}"
OUT_DIR="${OUT_DIR:?OUT_DIR must be set to an absolute payload path}"

case "$BARE_HOST" in
  linux-x64)   NODE_ARCH=x64 ;;
  linux-arm64) NODE_ARCH=arm64 ;;
  *) echo "stage-payload: unsupported BARE_HOST '$BARE_HOST'" >&2; exit 1 ;;
esac

echo "==> staging payload  host=$BARE_HOST  ->  $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/worklet" "$OUT_DIR/ui/dist"

# 1. UI bundle (mandatory artifact for the host to serve).
echo "--> ui bundle"
node ui/build.js

# 2. Host: esbuilt CJS + pinned Node binary + wrapper. build-host-sea.sh is
#    cross-platform via NODE_OS / NODE_ARCH overrides.
echo "--> host (esbuild + node runtime)"
OUT_DIR="$OUT_DIR" NODE_OS=linux NODE_ARCH="$NODE_ARCH" bash "$SCRIPT_DIR/build-host-sea.sh"

# 3. bare-runtime native binary. `npm install` only drops the host
#    platform's runtime; a foreign arch (linux-arm64 from an x64 box) is
#    refused with EBADPLATFORM. `npm pack` runs no platform check, so fetch
#    the tarball that way and extract it into node_modules ourselves, at the
#    version already resolved for linux-x64.
BARE_BIN_SRC="$REPO/node_modules/bare-runtime-$BARE_HOST/bin/bare"
if [ ! -x "$BARE_BIN_SRC" ]; then
  REF_PKG="$REPO/node_modules/bare-runtime-linux-x64/package.json"
  if [ ! -f "$REF_PKG" ]; then
    echo "stage-payload: bare-runtime-linux-x64 missing; run \`npm install\` in $REPO" >&2
    exit 1
  fi
  BARE_VER=$(node -p "require('$REF_PKG').version")
  echo "--> fetching bare-runtime-$BARE_HOST@$BARE_VER (cross-arch runtime via npm pack)"
  PACKDIR=$(mktemp -d)
  ( cd "$PACKDIR" && npm pack --loglevel=error "bare-runtime-$BARE_HOST@$BARE_VER" >/dev/null )
  DEST="$REPO/node_modules/bare-runtime-$BARE_HOST"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  tar -xzf "$PACKDIR"/*.tgz -C "$DEST" --strip-components=1
  rm -rf "$PACKDIR"
  # npm pack normalizes file modes to 0644; the install-time bin linking
  # that would restore +x never runs here, so set it back by hand.
  chmod +x "$BARE_BIN_SRC"
fi
if [ ! -x "$BARE_BIN_SRC" ]; then
  echo "stage-payload: bare binary still missing: $BARE_BIN_SRC" >&2
  exit 1
fi
cp "$BARE_BIN_SRC" "$OUT_DIR/bare"
chmod +x "$OUT_DIR/bare"

# 4. Worklet bundle. bare-pack collapses the worklet's entire JS module
#    graph into one bundle; only the native addon prebuilds ship beside it.
#    --base one level below node_modules makes the bundle's addon references
#    resolve as ../node_modules/ next to the bundle. --linked is omitted on
#    purpose: that flag is the mobile path (pre-linked addons); the desktop
#    runtime loads file: prebuilds from disk.
echo "--> worklet bundle (bare-pack --host $BARE_HOST)"
"$REPO/node_modules/.bin/bare-pack" --host "$BARE_HOST" \
  --base "$REPO/worklet" --defer fs --defer path \
  "$REPO/src/bare.js" -o "$OUT_DIR/worklet/worklet.bundle"

# 4b. Stage only the native addon prebuilds the bundle references, at
#     worklet/node_modules/<pkg>/prebuilds/$BARE_HOST/ so the bundle's
#     ../node_modules/ specifiers resolve.
echo "--> worklet addon prebuilds"
staged=0
while read -r d; do
  [ -z "$d" ] && continue
  rel="${d#./}"
  mkdir -p "$OUT_DIR/worklet/node_modules/$(dirname "$rel")"
  cp -R "$REPO/node_modules/$rel" "$OUT_DIR/worklet/node_modules/$(dirname "$rel")/"
  staged=$((staged + 1))
done < <(cd "$REPO/node_modules" && find . -type d -path "*/prebuilds/$BARE_HOST")
echo "    staged $staged addon prebuild dirs"
if [ "$staged" -eq 0 ]; then
  echo "stage-payload: no $BARE_HOST prebuilds found; the worklet would fail to" >&2
  echo "  load native addons. Run \`npm install\` in $REPO and retry." >&2
  exit 1
fi

# 5. UI files.
echo "--> ui static files"
cp ui/index.html       "$OUT_DIR/ui/index.html"
cp ui/dist/app.js      "$OUT_DIR/ui/dist/app.js"
cp ui/dist/style.css   "$OUT_DIR/ui/dist/style.css"

echo "==> payload staged ($(du -sh "$OUT_DIR" | cut -f1))"
