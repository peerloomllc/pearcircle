#!/usr/bin/env bash
# Generate a static StartOS 0.3.5.x community-registry tree for the PearCircle
# seeder from the built .s9pk. The output is a plain file tree that implements
# the marketplace protocol's GET endpoints; host it on any static HTTPS server
# (see README.md) and users add the URL via Marketplace -> Change -> Add custom
# registry.
#
# The JSON shapes mirror the live Start9 registry (registry.start9.com):
#   /package/v0/info                     {name, categories[]}
#   /package/v0/index                    [ {categories, dependency-metadata, icon(base64),
#                                            instructions(path), license(path), manifest,
#                                            published-at, versions[] } ]
#   /package/v0/latest                   {id: version}
#   /package/v0/version/<id>             {version}
#   /package/v0/manifest/<id>            <normalized manifest>
#   /package/v0/release-notes/<id>       {version: notes}
#   /package/v0/instructions/<id>        <raw markdown>
#   /package/v0/license/<id>             <raw text>
#   /package/v0/icon/<id>                <raw png bytes>
#   /package/v0/<id>.s9pk                <the signed s9pk>
#
# Usage: build-registry.sh [path-to-s9pk]   (default ../pearcircle-seeder.s9pk)
# Requires: start-sdk (manifest inspection), node (JSON assembly).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
S9PK="${1:-$PKG_DIR/pearcircle-seeder.s9pk}"
OUT="$HERE/dist"
REGISTRY_NAME="${REGISTRY_NAME:-PeerLoom Registry}"
CATEGORIES_JSON="${CATEGORIES_JSON:-[\"featured\",\"networking\"]}"
# published-at is not read from the clock (kept reproducible); override to stamp.
PUBLISHED_AT="${PUBLISHED_AT:-1970-01-01T00:00:00Z}"

[ -f "$S9PK" ] || { echo "build-registry: s9pk not found: $S9PK (run \`make\` in $PKG_DIR first)" >&2; exit 1; }
command -v start-sdk >/dev/null || { echo "build-registry: start-sdk not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "build-registry: node not on PATH" >&2; exit 1; }

echo "==> generating registry from $(basename "$S9PK")"
rm -rf "$OUT"
V0="$OUT/package/v0"
mkdir -p "$V0/version" "$V0/manifest" "$V0/release-notes" "$V0/instructions" "$V0/license" "$V0/icon"

# Normalized manifest (embeds id, version, eos-version, git-hash, arches).
start-sdk inspect manifest "$S9PK" > "$V0/manifest.tmp.json"
PKG_ID="$(node -e "console.log(require('$V0/manifest.tmp.json').id)")"
PKG_VER="$(node -e "console.log(require('$V0/manifest.tmp.json').version)")"
echo "    id=$PKG_ID version=$PKG_VER"

# Assets straight from the package sources (identical to what's in the s9pk).
cp "$PKG_DIR/instructions.md" "$V0/instructions/$PKG_ID"
cp "$PKG_DIR/LICENSE" "$V0/license/$PKG_ID"
cp "$PKG_DIR/icon.png" "$V0/icon/$PKG_ID"
cp "$S9PK" "$V0/$PKG_ID.s9pk"

# Per-id endpoints that just re-serve the manifest / a version stub.
cp "$V0/manifest.tmp.json" "$V0/manifest/$PKG_ID"

REGISTRY_NAME="$REGISTRY_NAME" CATEGORIES_JSON="$CATEGORIES_JSON" \
PUBLISHED_AT="$PUBLISHED_AT" PKG_ID="$PKG_ID" PKG_VER="$PKG_VER" \
ICON_PATH="$PKG_DIR/icon.png" INSTR_PATH="$PKG_DIR/instructions.md" \
LIC_PATH="$PKG_DIR/LICENSE" MANIFEST_PATH="$V0/manifest.tmp.json" V0="$V0" \
node <<'NODE'
const fs = require('fs')
const p = process.env
const manifest = JSON.parse(fs.readFileSync(p.MANIFEST_PATH, 'utf8'))
const id = p.PKG_ID, ver = p.PKG_VER
const iconB64 = fs.readFileSync(p.ICON_PATH).toString('base64')
const categories = JSON.parse(p.CATEGORIES_JSON)
const releaseNotes = manifest['release-notes'] || ''

const write = (rel, data) =>
  fs.writeFileSync(`${p.V0}/${rel}`, typeof data === 'string' ? data : JSON.stringify(data))

// /package/v0/info
write('info', { name: p.REGISTRY_NAME, categories })

// /package/v0/index  (one entry; icon is RAW base64, instructions/license are PATHS)
write('index', [{
  categories,
  'dependency-metadata': {},
  icon: iconB64,
  instructions: `/package/v0/instructions/${id}`,
  license: `/package/v0/license/${id}`,
  manifest,
  'published-at': p.PUBLISHED_AT,
  versions: [ver],
}])

// /package/v0/latest  and  /package/v0/version/<id>
write('latest', { [id]: ver })
write(`version/${id}`, { version: ver })

// /package/v0/release-notes/<id>
write(`release-notes/${id}`, { [ver]: releaseNotes })

console.log('    wrote info, index, latest, version, release-notes')
NODE

rm -f "$V0/manifest.tmp.json"

echo "==> registry tree ready at: $OUT"
echo "    entrypoint: $OUT/package/v0/info"
( cd "$OUT" && find package -type f | sort | sed 's/^/      /' )
