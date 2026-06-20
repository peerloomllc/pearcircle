#!/usr/bin/env bash
# Build all Linux seeder-launcher packages: a .deb and an AppImage for
# x86_64 and arm64. Runs entirely on a Linux x86_64 host - arm64 is
# cross-packaged (build-verified only; run-test it on real arm64 hardware).
#
# Usage:   scripts/build-linux.sh [version]        (default version 0.1.0)
#
# Env (subset the matrix):
#   LINUX_ARCHES   space-separated: x86_64 arm64   (default both)
#   LINUX_FORMATS  space-separated: deb appimage   (default both)
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
SCRIPT_DIR="$LAUNCHER/scripts"

VERSION="${1:-0.1.0}"
VERSION="${VERSION#v}"
LINUX_ARCHES="${LINUX_ARCHES:-x86_64 arm64}"
LINUX_FORMATS="${LINUX_FORMATS:-deb appimage}"

# --- preflight --------------------------------------------------------------
[ -x "$REPO/node_modules/.bin/bare-pack" ] || {
  echo "ERROR: repo-root node_modules missing. Run \`npm install\` in $REPO." >&2
  exit 1
}
[ -x "$LAUNCHER/node_modules/.bin/esbuild" ] || {
  echo "ERROR: seeder-launcher node_modules missing. Run \`npm install\` in $LAUNCHER." >&2
  exit 1
}

echo "########################################################"
echo "# PearCircle Seeder - Linux packaging"
echo "#   version : $VERSION"
echo "#   arches  : $LINUX_ARCHES"
echo "#   formats : $LINUX_FORMATS"
echo "########################################################"

built=()
for arch in $LINUX_ARCHES; do
  case "$arch" in
    x86_64) DEB_ARCH=amd64; AI_ARCH=x86_64 ;;
    arm64)  DEB_ARCH=arm64; AI_ARCH=aarch64 ;;
    *) echo "ERROR: unknown arch '$arch' (expected x86_64 or arm64)" >&2; exit 1 ;;
  esac
  for fmt in $LINUX_FORMATS; do
    case "$fmt" in
      deb)
        ARCH="$DEB_ARCH" VERSION="$VERSION" bash "$SCRIPT_DIR/build-deb-linux.sh"
        built+=("dist/linux/pearcircle-seeder_${VERSION}_${DEB_ARCH}.deb")
        ;;
      appimage)
        ARCH="$AI_ARCH" VERSION="$VERSION" bash "$SCRIPT_DIR/build-appimage-linux.sh"
        built+=("dist/linux/PearCircleSeeder-${AI_ARCH}.AppImage")
        ;;
      *) echo "ERROR: unknown format '$fmt' (expected deb or appimage)" >&2; exit 1 ;;
    esac
  done
done

echo ""
echo "########################################################"
echo "# Done. Artifacts in seeder-launcher/dist/linux/ :"
for f in "${built[@]}"; do
  echo "#   $f"
done
echo "#"
echo "# arm64 packages are cross-built - build-verified only."
echo "# Run-test them on real arm64 hardware (e.g. a Raspberry Pi)."
echo "########################################################"
