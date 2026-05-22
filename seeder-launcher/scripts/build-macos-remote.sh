#!/usr/bin/env bash
# Build the macOS .pkg for the PearCircle seeder-launcher from a non-Mac
# host by driving the Mac mini over SSH.
#
# The Mac-only steps (pkgbuild, productbuild, codesign, notarytool) all run
# remotely via the existing scripts/build-pkg-macos.sh; this wrapper just
# ships the source, runs that script on the Mac, and retrieves the .pkg.
# Mirrors scripts/build-windows.sh, which does the same for the Windows VM.
#
# Usage:   scripts/build-macos-remote.sh [version]      (default 0.1.0)
#
# Env overrides:
#   MAC_MINI_HOST          ssh target (default Tims-Mac-mini.local)
#   MAC_SEEDER_BUILD_DIR   build dir name on the Mac (default pearcircle-seeder-macos)
#   APP_SIGN_ID PKG_SIGN_ID NOTARY_PROFILE SKIP_NOTARIZE
#       forwarded to build-pkg-macos.sh; with the signing IDs unset the Mac
#       produces an unsigned, un-notarized .pkg.
#
# Requires locally: ssh, scp, tar, and key-based SSH to the Mac.
# Requires on the Mac: Node + npm, Xcode command-line tools; the Developer
#   ID certs + the pearcircle-seeder-notary keychain profile for a signed,
#   notarized build.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$LAUNCHER_DIR/.." && pwd)

VERSION="${1:-0.1.0}"
VERSION="${VERSION#v}"

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
MAC_DIR="${MAC_SEEDER_BUILD_DIR:-pearcircle-seeder-macos}"

echo "==> Preflight: ssh $MAC_HOST"
if ! ssh -o ConnectTimeout=6 -o BatchMode=yes "$MAC_HOST" exit 2>/dev/null; then
  echo "    ERROR: cannot reach $MAC_HOST via key-based SSH." >&2
  exit 1
fi
echo "    OK"

# ---- Pack the source the macOS build needs ---------------------------------
# build-pkg-macos.sh runs `npm install` on the Mac (it needs the darwin bare
# runtime + bare-pack), bundles the UI + host, and packages. It reads src/,
# the repo-root manifests, assets/images/icon.png, and seeder-launcher/.
RELEASE_TAR=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$RELEASE_TAR"' EXIT
echo "==> Packing source tree..."
tar -czf "$RELEASE_TAR" -C "$REPO_ROOT" \
  --exclude='seeder-launcher/node_modules' \
  --exclude='seeder-launcher/dist' \
  package.json \
  package-lock.json \
  src \
  assets \
  seeder-launcher
echo "    Tarball: $(du -sh "$RELEASE_TAR" | cut -f1)"

# ---- Copy to the Mac -------------------------------------------------------
echo "==> Copying to ${MAC_HOST}:${MAC_DIR}.tar.gz ..."
scp -q "$RELEASE_TAR" "${MAC_HOST}:${MAC_DIR}.tar.gz"

# ---- Extract + build on the Mac -------------------------------------------
# The build script is fed over stdin and run under a login shell so Node,
# npm and the Xcode tools resolve. Signing identities are interpolated by
# the local shell; $HOME and $target stay literal for the remote.
echo "==> Running remote build (several minutes; notarization waits on Apple)..."
ssh "$MAC_HOST" "bash -lc 'cat > /tmp/${MAC_DIR}-build.sh && bash /tmp/${MAC_DIR}-build.sh'" <<REMOTE
set -euo pipefail
target="\$HOME/${MAC_DIR}"
rm -rf "\$target"
mkdir -p "\$target"
tar -xzf "\$HOME/${MAC_DIR}.tar.gz" -C "\$target"
rm -f "\$HOME/${MAC_DIR}.tar.gz"
cd "\$target"
npm install --no-audit --no-fund --loglevel=error
# Modern npm can leave the bare-runtime binary without its executable bit;
# build-pkg-macos.sh requires it executable. Restore it before building.
for _b in node_modules/bare-runtime-darwin-*/bin/bare; do
  if [ -f "\$_b" ]; then chmod +x "\$_b"; fi
done
( cd seeder-launcher && npm install --no-audit --no-fund --loglevel=error )
cd seeder-launcher
VERSION='${VERSION}' \
APP_SIGN_ID='${APP_SIGN_ID:-}' \
PKG_SIGN_ID='${PKG_SIGN_ID:-}' \
NOTARY_PROFILE='${NOTARY_PROFILE:-pearcircle-seeder-notary}' \
SKIP_NOTARIZE='${SKIP_NOTARIZE:-0}' \
  bash scripts/build-pkg-macos.sh
REMOTE

# ---- Retrieve the installer ------------------------------------------------
PKG_NAME="PearCircleSeeder-${VERSION}.pkg"
OUT_DIR="${LAUNCHER_DIR}/dist/macos"
mkdir -p "$OUT_DIR"
echo "==> Retrieving ${PKG_NAME} ..."
scp -q "${MAC_HOST}:${MAC_DIR}/seeder-launcher/dist/macos/${PKG_NAME}" "${OUT_DIR}/${PKG_NAME}"
( cd "$OUT_DIR" && sha256sum "$PKG_NAME" > "${PKG_NAME}.sha256" )

echo ""
echo "==> Done."
echo "    Installer : ${OUT_DIR}/${PKG_NAME}  ($(du -sh "${OUT_DIR}/${PKG_NAME}" | cut -f1))"
echo "    sha256    : $(cut -d' ' -f1 < "${OUT_DIR}/${PKG_NAME}.sha256")"
