#!/usr/bin/env bash
# Build the Node SEA single-binary host. The .pkg ships this binary in
# /usr/local/lib/pearcircle-seeder/pearcircle-seeder.
#
# Strategy:
#   1. esbuild bundles host/index.js + ws into a single CJS .js file
#   2. node --experimental-sea-config writes a blob
#   3. cp + codesign-remove + postject inject blob into a node binary copy
#   4. codesign the result (caller signs the final .pkg)
#
# Caller responsibilities (Mac mini):
#   - Node 20+ on PATH
#   - npx postject available (postject is bundled in node-sea repo or as npm package)
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-dist/macos/payload/usr/local/lib/pearcircle-seeder}"
mkdir -p "$OUT_DIR"

# 1. Bundle host into a single CJS file.
node_modules/.bin/esbuild host/index.js \
  --bundle --platform=node --target=node20 --format=cjs \
  --external:ws \
  --outfile=dist/host-bundled.js
# ws is left external because Node SEA + native deps inside the bundle is
# fragile; we'll pre-bundle ws as well below. Switch back to inlined if
# the prebuilt-binary detection inside ws (bufferutil/utf-8-validate) is
# absent on the build machine.
node_modules/.bin/esbuild host/index.js \
  --bundle --platform=node --target=node20 --format=cjs \
  --outfile=dist/host-bundled.js

# 2. SEA config.
cat > dist/sea-config.json <<JSON
{
  "main": "dist/host-bundled.js",
  "output": "dist/host-blob.bin",
  "disableExperimentalSEAWarning": true
}
JSON

node --experimental-sea-config dist/sea-config.json

# 3. Inject into a node binary copy.
NODE_BIN=$(command -v node)
cp "$NODE_BIN" "$OUT_DIR/pearcircle-seeder"
chmod +w "$OUT_DIR/pearcircle-seeder"

# Strip the existing signature so postject can write a new section.
if command -v codesign >/dev/null 2>&1; then
  codesign --remove-signature "$OUT_DIR/pearcircle-seeder" 2>/dev/null || true
fi

npx --yes postject "$OUT_DIR/pearcircle-seeder" NODE_SEA_BLOB dist/host-blob.bin \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

# 4. Ad-hoc sign so the binary can run before .pkg-time codesigning.
if command -v codesign >/dev/null 2>&1; then
  codesign --sign - "$OUT_DIR/pearcircle-seeder"
fi

echo "built: $OUT_DIR/pearcircle-seeder"
