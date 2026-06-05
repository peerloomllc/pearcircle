#!/usr/bin/env bash
# Build a Debian .deb for the PearCircle seeder-launcher.
#
# Installs the flat payload under /opt/pearcircle-seeder, adds a
# /usr/bin/pearcircle-seeder symlink, and ships maintainer scripts that
# install + enable the systemd user service for the installing user.
#
# Usage:   scripts/build-deb-linux.sh
# Env:     ARCH      amd64 | arm64   (default amd64)
#          VERSION   package version (default 0.1.0)
set -euo pipefail

cd "$(dirname "$0")/.."
LAUNCHER=$(pwd)
REPO=$(cd "$LAUNCHER/.." && pwd)
SCRIPT_DIR="$LAUNCHER/scripts"
INSTALLER="$LAUNCHER/installer/linux"

ARCH="${ARCH:-amd64}"
VERSION="${VERSION:-0.1.0}"
VERSION="${VERSION#v}"

case "$ARCH" in
  amd64) BARE_HOST=linux-x64 ;;
  arm64) BARE_HOST=linux-arm64 ;;
  *) echo "build-deb: ARCH must be amd64 or arm64 (got '$ARCH')" >&2; exit 1 ;;
esac

command -v dpkg-deb >/dev/null 2>&1 || {
  echo "build-deb: dpkg-deb not found. Install it (Fedora: sudo dnf install dpkg)." >&2
  exit 1
}

echo "=== building .deb  arch=$ARCH  version=$VERSION ==="

STAGE="$LAUNCHER/dist/linux/deb-$ARCH"
PKGROOT="$STAGE/pkgroot"
INSTALL_DIR="$PKGROOT/opt/pearcircle-seeder"
rm -rf "$STAGE"
mkdir -p "$INSTALL_DIR" "$PKGROOT/usr/bin" "$PKGROOT/DEBIAN"

# 1. Stage the flat payload under /opt/pearcircle-seeder. Pass SEEDER_VERSION so
#    the runtime version (host/version.js, surfaced in /api + the update check)
#    matches the package version. Without it build-host-sea.sh falls back to
#    `git describe`, which mis-stamps any build whose VERSION != the latest tag.
SEEDER_VERSION="$VERSION" BARE_HOST="$BARE_HOST" OUT_DIR="$INSTALL_DIR" bash "$SCRIPT_DIR/stage-payload-linux.sh"

# 2. Ship the systemd user unit template; the postinst templates __EXEC__.
cp "$INSTALLER/pearcircle-seeder.service" "$INSTALL_DIR/pearcircle-seeder.service"

# 2b. Privileged auto-updater (proposal 2026-06-05-seeder-update slice 3c): the
#     root-run helper + the polkit rule template. The postinst installs the rule
#     (templated to the install user) and ensures the helper is root-owned 0755.
cp "$INSTALLER/updater-helper.sh" "$INSTALL_DIR/updater-helper.sh"
chmod 0755 "$INSTALL_DIR/updater-helper.sh"
cp "$INSTALLER/com.pearcircle.seeder.update.rules.in" "$INSTALL_DIR/updater-helper.rules.in"

# 2c. Desktop integration: a dashboard-opener script + a system-wide .desktop
#     entry so the seeder is searchable + clickable in the apps menu, and an
#     icon. The postinst opens the dashboard on a fresh interactive install.
cp "$INSTALLER/open-dashboard.sh" "$INSTALL_DIR/open-dashboard.sh"
chmod 0755 "$INSTALL_DIR/open-dashboard.sh"
install -D -m 0644 "$INSTALLER/pearcircle-seeder-dashboard.desktop" \
  "$PKGROOT/usr/share/applications/pearcircle-seeder.desktop"
ICON_SRC="$REPO/assets/images/icon.png"
if [ -f "$ICON_SRC" ]; then
  install -D -m 0644 "$ICON_SRC" \
    "$PKGROOT/usr/share/icons/hicolor/256x256/apps/pearcircle-seeder.png"
else
  echo "build-deb: warning: $ICON_SRC missing; app entry will use a generic icon" >&2
fi

# 3. CLI symlink on PATH.
ln -s /opt/pearcircle-seeder/pearcircle-seeder "$PKGROOT/usr/bin/pearcircle-seeder"

# 4. Maintainer scripts.
for s in postinst prerm postrm; do
  cp "$INSTALLER/deb/$s" "$PKGROOT/DEBIAN/$s"
  chmod 0755 "$PKGROOT/DEBIAN/$s"
done

# 5. control file. Installed-Size is in KiB per Debian policy.
INSTALLED_KB=$(du -sk "$PKGROOT" | cut -f1)
sed -e "s|__VERSION__|$VERSION|g" \
    -e "s|__ARCH__|$ARCH|g" \
    -e "s|__SIZE__|$INSTALLED_KB|g" \
    "$INSTALLER/deb/control" > "$PKGROOT/DEBIAN/control"
chmod 0644 "$PKGROOT/DEBIAN/control"

# 6. Build. --root-owner-group forces root:root ownership without fakeroot.
OUT_DIR="$LAUNCHER/dist/linux"
DEB="$OUT_DIR/pearcircle-seeder_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKGROOT" "$DEB"
( cd "$OUT_DIR" && sha256sum "$(basename "$DEB")" > "$(basename "$DEB").sha256" )

echo "=== built  $DEB  ($(du -sh "$DEB" | cut -f1)) ==="
echo "    sha256  $(cut -d' ' -f1 < "$DEB.sha256")"
