#!/usr/bin/env bash
# Build a notarized macOS .pkg for the seeder launcher.
#
# Prereqs (one-time, Mac mini):
#   - Xcode CLT installed (pkgbuild, productbuild, codesign, notarytool, stapler)
#   - Developer ID Application + Developer ID Installer certs in the keychain
#     (Team G79ALD29NA per memory project_apple_team_id.md)
#   - notarytool keychain profile saved as 'pearcircle-seeder-notary' (see README)
#
# Env vars:
#   APP_SIGN_ID="Developer ID Application: ... (G79ALD29NA)"
#   PKG_SIGN_ID="Developer ID Installer: ... (G79ALD29NA)"
#   NOTARY_PROFILE="pearcircle-seeder-notary"
#   VERSION="0.1.0"
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-0.1.0}"
APP_SIGN_ID="${APP_SIGN_ID:?must set APP_SIGN_ID env var}"
PKG_SIGN_ID="${PKG_SIGN_ID:?must set PKG_SIGN_ID env var}"
NOTARY_PROFILE="${NOTARY_PROFILE:-pearcircle-seeder-notary}"

ROOT=$(pwd)
PAYLOAD="$ROOT/dist/macos/payload"
INSTALL_PREFIX="usr/local/lib/pearcircle-seeder"
PAYLOAD_LIB="$PAYLOAD/$INSTALL_PREFIX"
SCRIPTS_DIR="$ROOT/dist/macos/scripts"

rm -rf "$ROOT/dist/macos"
mkdir -p "$PAYLOAD_LIB/installer" "$PAYLOAD_LIB/worklet/lib" "$PAYLOAD_LIB/ui/dist" "$SCRIPTS_DIR"

# 1. UI bundle (mandatory artifact for the host to serve).
node ui/build.js

# 2. Host SEA binary.
bash scripts/build-host-sea.sh

# 3. bare-runtime native binary.
ARCH=$(uname -m)
case "$ARCH" in
  arm64) BARE_PKG="bare-runtime-darwin-arm64" ;;
  x86_64) BARE_PKG="bare-runtime-darwin-x64" ;;
  *) echo "unsupported arch: $ARCH" >&2 ; exit 1 ;;
esac
BARE_BIN_SRC="$ROOT/../node_modules/$BARE_PKG/bin/bare"
if [ ! -x "$BARE_BIN_SRC" ]; then
  echo "missing bare binary: $BARE_BIN_SRC" >&2
  echo "Run \`npm install\` in the repo root on a Mac so the darwin native runtime drops." >&2
  exit 1
fi
cp "$BARE_BIN_SRC" "$PAYLOAD_LIB/bare"
chmod +x "$PAYLOAD_LIB/bare"

# 4. Worklet entry + JS modules + node_modules. Ship all repo-root worklet code
#    plus the third-party dep tree the worklet imports at runtime.
cp "$ROOT/../src/bare.js" "$PAYLOAD_LIB/worklet/bare.js"
cp "$ROOT/../src/seeder.js" "$PAYLOAD_LIB/worklet/seeder.js"
cp "$ROOT/../src/identity.js" "$PAYLOAD_LIB/worklet/identity.js"
cp "$ROOT/../src/circle.js" "$PAYLOAD_LIB/worklet/circle.js"
cp "$ROOT/../src/invite.js" "$PAYLOAD_LIB/worklet/invite.js"
cp "$ROOT/../src/swarm.js" "$PAYLOAD_LIB/worklet/swarm.js"
cp "$ROOT/../src/pair.js" "$PAYLOAD_LIB/worklet/pair.js"
cp -R "$ROOT/../src/lib" "$PAYLOAD_LIB/worklet/lib"

# node_modules: copy the repo-root tree. Size is ~200MB; the worklet
# resolves bare-* + corestore + hyperbee + hyperswarm + autobase + sodium
# + b4a + protomux from here.
cp -R "$ROOT/../node_modules" "$PAYLOAD_LIB/worklet/node_modules"

# 5. UI.
cp ui/index.html "$PAYLOAD_LIB/ui/index.html"
cp ui/dist/app.js "$PAYLOAD_LIB/ui/dist/app.js"
cp ui/dist/style.css "$PAYLOAD_LIB/ui/dist/style.css"

# 6. Installer metadata: ship the LaunchAgent template so postinstall can
#    template it per-user.
cp installer/macos/com.pearcircle.seeder.plist "$PAYLOAD_LIB/installer/"

# 7. Sign binaries inside the payload (productbuild seals the directory tree
#    but each native executable must be signed individually first).
codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/pearcircle-seeder"
codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/bare"

# 8. Scripts directory for pkgbuild.
cp scripts/postinstall-macos.sh "$SCRIPTS_DIR/postinstall"
chmod +x "$SCRIPTS_DIR/postinstall"

# 9. Component pkg.
COMPONENT="$ROOT/dist/macos/PearCircleSeeder-component.pkg"
pkgbuild \
  --root "$PAYLOAD" \
  --identifier com.pearcircle.seeder \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location / \
  "$COMPONENT"

# 10. Distribution pkg.
DIST="$ROOT/dist/macos/PearCircleSeeder-$VERSION.pkg"
productbuild \
  --distribution installer/macos/Distribution.xml \
  --resources installer/macos/Resources \
  --package-path "$ROOT/dist/macos" \
  --sign "$PKG_SIGN_ID" \
  --timestamp \
  "$DIST"

# 11. Notarize + staple.
xcrun notarytool submit "$DIST" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DIST"

echo "built: $DIST"
