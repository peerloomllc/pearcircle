#!/usr/bin/env bash
# Stage the host process for an installer payload. Node 25 + postject
# 1.0.0-alpha.6 fails the SEA sentinel check; instead of fighting it, we ship
# a Node binary copy alongside an esbuild-bundled host CJS file and a tiny
# wrapper shell script. The macOS LaunchAgent / Linux systemd unit point at
# the wrapper.
#
# Payload layout under the install root:
#   pearcircle-seeder      shell wrapper that execs node host-bundled.js
#   node                   copy of a pinned Node binary for the target
#   host-bundled.js        esbuild output (host/index.js + ws)
#
# Cross-platform: NODE_OS / NODE_ARCH default to the build machine (darwin or
# linux; x64 or arm64) but may be overridden so a Linux box can stage an
# arm64 payload. OUT_DIR must be passed for any non-macOS build.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-dist/macos/payload/usr/local/lib/pearcircle-seeder}"
mkdir -p "$OUT_DIR" dist

# 1. Bundle host into a single CJS file. ws bundles fine because its
#    native optional deps (bufferutil / utf-8-validate) are imported via
#    try/catch and fall back to pure JS when absent.
#
#    Stamp the build version (proposal 2026-06-05-seeder-update slice 1) so the
#    running launcher knows its own version. SEEDER_VERSION overrides; otherwise
#    take the release git tag (vX.Y.Z -> X.Y.Z), else package.json's version.
#    host/version.js reads the PEARCIRCLE_SEEDER_VERSION global esbuild injects.
# Resolve robustly: an explicit SEEDER_VERSION wins; else the release git tag
# (only when this IS a git repo — the macOS/Windows remote builds run from an
# unpacked tarball, so `git describe` there must not abort the script); else
# package.json. Each step is guarded so `set -euo pipefail` never trips.
if [ -z "${SEEDER_VERSION:-}" ]; then
  SEEDER_VERSION="$( (git describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
if [ -z "${SEEDER_VERSION:-}" ]; then
  SEEDER_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
fi
echo "build-host-sea: stamping version $SEEDER_VERSION"
node_modules/.bin/esbuild host/index.js \
  --bundle --platform=node --target=node20 --format=cjs \
  --define:PEARCIRCLE_SEEDER_VERSION="\"$SEEDER_VERSION\"" \
  --outfile=dist/host-bundled.js

cp dist/host-bundled.js "$OUT_DIR/host-bundled.js"

# 2. Stage a self-contained Node binary. Homebrew's node dynamically links
#    to /opt/homebrew dylibs and is unusable on a clean machine. Download
#    the official Node.js distribution tarball (statically linked, ~80MB
#    extracted) and reuse it across builds via dist/cache.
NODE_VERSION="${NODE_VERSION:-22.20.0}"
if [ -z "${NODE_OS:-}" ]; then
  case "$(uname -s)" in
    Darwin) NODE_OS=darwin ;;
    Linux)  NODE_OS=linux ;;
    *) echo "unsupported OS: $(uname -s) — set NODE_OS explicitly" >&2; exit 1 ;;
  esac
fi
if [ -z "${NODE_ARCH:-}" ]; then
  case "$(uname -m)" in
    arm64|aarch64) NODE_ARCH=arm64 ;;
    x86_64|amd64)  NODE_ARCH=x64 ;;
    *) echo "unsupported arch: $(uname -m) — set NODE_ARCH explicitly" >&2; exit 1 ;;
  esac
fi
NODE_PKG="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}"
NODE_CACHE="dist/cache/$NODE_PKG"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  mkdir -p dist/cache
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz"
  echo "downloading $URL"
  curl -fsSL "$URL" -o "dist/cache/${NODE_PKG}.tar.xz"
  tar -xJf "dist/cache/${NODE_PKG}.tar.xz" -C dist/cache
  rm "dist/cache/${NODE_PKG}.tar.xz"
fi
rm -f "$OUT_DIR/node"
cp "$NODE_CACHE/bin/node" "$OUT_DIR/node"
chmod +x "$OUT_DIR/node"

# 3. Wrapper script. The LaunchAgent and CLI users invoke this.
cat > "$OUT_DIR/pearcircle-seeder" <<'WRAPPER'
#!/bin/bash
# Wrapper: invoke the bundled node binary against the bundled host script.
DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "$DIR/node" "$DIR/host-bundled.js" "$@"
WRAPPER
chmod +x "$OUT_DIR/pearcircle-seeder"

echo "staged:"
echo "  $OUT_DIR/pearcircle-seeder  (wrapper)"
echo "  $OUT_DIR/node               ($(wc -c < "$OUT_DIR/node" | tr -d ' ') bytes)"
echo "  $OUT_DIR/host-bundled.js    ($(wc -c < "$OUT_DIR/host-bundled.js" | tr -d ' ') bytes)"
