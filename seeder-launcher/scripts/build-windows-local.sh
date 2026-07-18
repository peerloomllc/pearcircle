#!/usr/bin/env bash
# Build the PearCircle seeder-launcher Windows installer ENTIRELY ON LINUX
# (or macOS) - no Windows build VM required.
#
# The Windows installer is a cross-build: every binary in the payload is a
# prebuilt Windows artifact (node.exe fetched from nodejs.org, bare.exe from
# the bare-runtime-win32-x64 npm package, nssm.exe checked into the repo), the
# worklet is cross-packed with `bare-pack --host win32-x64`, and the only
# compile step is `makensis`, which runs natively on Linux (Fedora: `dnf
# install mingw*-nsis` ships /usr/bin/makensis; the stock MUI2 + nsExec plugins
# it needs are included). This mirrors scripts/windows-remote-build.ps1 step
# for step, minus the PowerShell/robocopy Windows-isms.
#
# Usage:   scripts/build-windows-local.sh [version]      (default from git tag / package.json / 0.1.0)
#
# Requires locally: bash, node + npm, makensis (NSIS 3.x), curl, tar, unzip/bsdtar.
# Requires in the repo node_modules: bare-pack, and bare-runtime-win32-x64 (an
#   optional npm dep gated to os=win32, so a plain `npm install` on Linux SKIPS
#   it). Force it in once with:
#     npm install bare-runtime-win32-x64@<ver> --os=win32 --cpu=x64 --force --no-save
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
WIN_DIR="$LAUNCHER/installer/windows"
NODE_VERSION="${NODE_VERSION:-22.20.0}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# --- version resolution (mirror build-host-sea.sh precedence) ----------------
VERSION="${1:-}"
if [ -z "$VERSION" ] && [ -z "${SEEDER_VERSION:-}" ]; then
  VERSION="$( (git describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
VERSION="${VERSION:-${SEEDER_VERSION:-}}"
[ -n "$VERSION" ] || VERSION="$(node -p "require('$LAUNCHER/package.json').version" 2>/dev/null || echo 0.1.0)"
VERSION="${VERSION#v}"

# --- preflight ---------------------------------------------------------------
step "Preflight"
[ -x "$REPO/node_modules/.bin/bare-pack" ] || fail "repo node_modules missing bare-pack - run \`npm install\` in $REPO"
[ -x "$LAUNCHER/node_modules/.bin/esbuild" ] || fail "seeder-launcher node_modules missing esbuild - run \`npm install\` in $LAUNCHER"
command -v makensis >/dev/null || fail "makensis not found - install NSIS (Fedora: dnf install mingw32-nsis)"
BARE_EXE="$REPO/node_modules/bare-runtime-win32-x64/bin/bare.exe"
[ -f "$BARE_EXE" ] || fail "bare.exe missing - run: npm install bare-runtime-win32-x64 --os=win32 --cpu=x64 --force --no-save (in $REPO)"
echo "    version   : $VERSION"
echo "    makensis  : $(command -v makensis) ($(makensis -VERSION 2>/dev/null))"
echo "    bare.exe  : $BARE_EXE"

# --- 1. UI bundle ------------------------------------------------------------
step "Build UI bundle"
( cd "$LAUNCHER" && node ui/build.js )

# --- 2. esbuild the host into a single CJS file ------------------------------
# The PowerShell build edits package.json's version because PowerShell mangles
# an esbuild --define's quotes; bash has no such problem, so use the clean
# --define path that build-host-sea.sh uses (host/version.js reads the global).
step "Bundle host (esbuild), stamping version $VERSION"
( cd "$LAUNCHER" && node_modules/.bin/esbuild host/index.js \
    --bundle --platform=node --target=node20 --format=cjs \
    --define:PEARCIRCLE_SEEDER_VERSION="\"$VERSION\"" \
    --outfile=dist/host-bundled.js )

# --- 3. Fetch the pinned Node.js runtime for Windows -------------------------
step "Stage Node.js $NODE_VERSION (win-x64)"
NODE_PKG="node-v${NODE_VERSION}-win-x64"
CACHE_DIR="$LAUNCHER/dist/cache"
NODE_EXE="$CACHE_DIR/$NODE_PKG/node.exe"
if [ ! -f "$NODE_EXE" ]; then
  mkdir -p "$CACHE_DIR"
  ZIP="$CACHE_DIR/$NODE_PKG.zip"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.zip"
  echo "    downloading $URL"
  curl -fsSL "$URL" -o "$ZIP"
  if command -v unzip >/dev/null; then unzip -q -o "$ZIP" -d "$CACHE_DIR"
  else bsdtar -xf "$ZIP" -C "$CACHE_DIR"; fi
  rm -f "$ZIP"
fi
[ -f "$NODE_EXE" ] || fail "node.exe missing after extract: $NODE_EXE"

# --- 4. Assemble the payload -------------------------------------------------
step "Assemble payload"
STAGE="$LAUNCHER/dist/windows/stage"
PAYLOAD="$STAGE/payload"
rm -rf "$STAGE"
mkdir -p "$PAYLOAD/ui/dist"

# 4a. Top-level binaries + installer resources.
cp "$NODE_EXE"                      "$PAYLOAD/node.exe"
cp "$BARE_EXE"                      "$PAYLOAD/bare.exe"
cp "$LAUNCHER/dist/host-bundled.js" "$PAYLOAD/host-bundled.js"
cp "$WIN_DIR/nssm.exe"              "$PAYLOAD/nssm.exe"
cp "$WIN_DIR/open-ui.vbs"           "$PAYLOAD/open-ui.vbs"
cp "$WIN_DIR/AppIcon.ico"           "$PAYLOAD/AppIcon.ico"

# 4b. Worklet bundle. bare-pack collapses the worklet's JS module graph into
#     one bundle; only the native addon prebuilds ship beside it. --base one
#     level below node_modules makes the bundle's addon references resolve as
#     ../node_modules/ next to the bundle.
WORKLET="$PAYLOAD/worklet"
mkdir -p "$WORKLET"
( cd "$REPO" && node_modules/.bin/bare-pack \
    --host win32-x64 --base "$REPO/worklet" --defer fs --defer path \
    "$REPO/src/bare.js" -o "$WORKLET/worklet.bundle" )

# 4c. Stage only the win32-x64 native addon prebuilds the bundle references, at
#     worklet/node_modules/<pkg>/prebuilds/win32-x64/ so the bundle's
#     ../node_modules/ specifiers resolve.
NM_ROOT="$REPO/node_modules"
while IFS= read -r d; do
  rel="${d#"$NM_ROOT"/}"
  dst="$WORKLET/node_modules/$rel"
  mkdir -p "$dst"
  cp -a "$d/." "$dst/"
done < <(find "$NM_ROOT" -type d -path '*/prebuilds/win32-x64')

# 4d. UI.
cp "$LAUNCHER/ui/index.html"     "$PAYLOAD/ui/index.html"
cp "$LAUNCHER/ui/dist/app.js"    "$PAYLOAD/ui/dist/app.js"
cp "$LAUNCHER/ui/dist/style.css" "$PAYLOAD/ui/dist/style.css"

# --- 5. Compile the NSIS installer -------------------------------------------
# makensis on Linux uses '/' as its path separator, so the .nsi's COMPILE-TIME
# file references (MUI_ICON and `File /r "payload\*"`, which makensis reads off
# the local FS) must use forward slashes. The runtime `$INSTDIR\...` paths are
# Windows install-time strings baked into the installer and are left untouched.
step "Compile NSIS installer"
sed -e 's#payload\\AppIcon\.ico#payload/AppIcon.ico#g' \
    -e 's#payload\\\*#payload/*#g' \
    "$WIN_DIR/installer.nsi" > "$STAGE/installer.nsi"

( cd "$STAGE" && makensis "-DVERSION=$VERSION" installer.nsi )

# --- 6. Collect the output ---------------------------------------------------
OUT_NAME="PearCircleSeeder-Setup-${VERSION}.exe"
BUILT="$STAGE/$OUT_NAME"
[ -f "$BUILT" ] || fail "installer not produced: $BUILT"
DIST_DIR="$LAUNCHER/dist/windows"
mv -f "$BUILT" "$DIST_DIR/$OUT_NAME"
( cd "$DIST_DIR" && sha256sum "$OUT_NAME" > "$OUT_NAME.sha256" )

SIZE=$(du -h "$DIST_DIR/$OUT_NAME" | cut -f1)
printf '\n==> Done.\n'
printf '    Installer : %s  (%s)\n' "$DIST_DIR/$OUT_NAME" "$SIZE"
printf '    sha256    : %s\n' "$(cut -d' ' -f1 < "$DIST_DIR/$OUT_NAME.sha256")"
