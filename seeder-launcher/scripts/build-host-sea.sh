#!/usr/bin/env bash
# Stage the host process for the .pkg payload. Node 25 + postject 1.0.0-alpha.6
# fails the SEA sentinel check; instead of fighting it, we ship a Node binary
# copy alongside an esbuild-bundled host CJS file and a tiny wrapper shell
# script. The LaunchAgent points at the wrapper.
#
# Payload layout under /usr/local/lib/pearcircle-seeder/:
#   pearcircle-seeder      shell wrapper that execs node host-bundled.js
#   node                   copy of the build-machine's node binary
#   host-bundled.js        esbuild output (host/index.js + ws)
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-dist/macos/payload/usr/local/lib/pearcircle-seeder}"
mkdir -p "$OUT_DIR" dist

# 1. Bundle host into a single CJS file. ws bundles fine because its
#    native optional deps (bufferutil / utf-8-validate) are imported via
#    try/catch and fall back to pure JS when absent.
node_modules/.bin/esbuild host/index.js \
  --bundle --platform=node --target=node20 --format=cjs \
  --outfile=dist/host-bundled.js

cp dist/host-bundled.js "$OUT_DIR/host-bundled.js"

# 2. Stage a self-contained Node binary. Homebrew's node dynamically links
#    to /opt/homebrew dylibs and is unusable on a clean machine. Download
#    the official Node.js distribution tarball (statically linked, ~80MB
#    extracted) and reuse it across builds via dist/cache.
NODE_VERSION="${NODE_VERSION:-22.20.0}"
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) NODE_OS=darwin ;;
  *) echo "this script builds darwin payloads only" >&2; exit 1 ;;
esac
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
