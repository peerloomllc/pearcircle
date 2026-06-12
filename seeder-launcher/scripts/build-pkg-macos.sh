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
# Optional signing identities. If APP_SIGN_ID is unset the daemon binaries
# get ad-hoc codesigned (works locally, fails Gatekeeper without --allow-untrusted).
# If PKG_SIGN_ID is unset the .pkg is unsigned (install via
#   sudo installer -allowUntrusted -pkg PearCircleSeeder-*.pkg -target /
# or System Settings -> Privacy & Security -> Open Anyway).
# Notarization is skipped automatically when the .pkg is unsigned.
APP_SIGN_ID="${APP_SIGN_ID:-}"
PKG_SIGN_ID="${PKG_SIGN_ID:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-pearcircle-seeder-notary}"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
# Both the Developer ID Installer cert and the notarytool credential
# profile live in the buildkey keychain (empty password) so codesign +
# notarytool work non-interactively over SSH. The login keychain can't
# be unlocked from a script.
KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/buildkey.keychain}"

ROOT=$(pwd)
PAYLOAD="$ROOT/dist/macos/payload"
INSTALL_PREFIX="usr/local/lib/pearcircle-seeder"
PAYLOAD_LIB="$PAYLOAD/$INSTALL_PREFIX"
SCRIPTS_DIR="$ROOT/dist/macos/scripts"

rm -rf "$ROOT/dist/macos"
mkdir -p "$PAYLOAD_LIB/installer" "$PAYLOAD_LIB/worklet" "$PAYLOAD_LIB/ui/dist" "$SCRIPTS_DIR"

# 1. UI bundle (mandatory artifact for the host to serve).
node ui/build.js

# 2. Host SEA binary. Pass the build VERSION through so host/version.js is
#    stamped with the release version even though the Mac builds from an
#    unpacked tarball (no git) — proposal 2026-06-05-seeder-update slice 1/3b.
SEEDER_VERSION="$VERSION" bash scripts/build-host-sea.sh

# 3. bare-runtime native binary.
ARCH=$(uname -m)
case "$ARCH" in
  arm64) BARE_PKG="bare-runtime-darwin-arm64"; BARE_HOST="darwin-arm64" ;;
  x86_64) BARE_PKG="bare-runtime-darwin-x64"; BARE_HOST="darwin-x64" ;;
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

# 4. Worklet bundle. bare-pack collapses the worklet's entire JS module
#    graph into a single bundle; only the native addon prebuilds ship
#    alongside it. --base one level below node_modules makes the bundle's
#    addon references resolve as ../node_modules/ next to the bundle.
#    --linked is omitted on purpose: that flag is the mobile path
#    (pre-linked addons); the desktop runtime loads file: prebuilds from
#    disk.
"$ROOT/../node_modules/.bin/bare-pack" --host "$BARE_HOST" \
  --base "$ROOT/../worklet" --defer fs --defer path \
  "$ROOT/../src/bare.js" -o "$PAYLOAD_LIB/worklet/worklet.bundle"

# 4b. Stage only the native addon prebuilds the bundle references, at
#     worklet/node_modules/<pkg>/prebuilds/$BARE_HOST/ so the bundle's
#     ../node_modules/ specifiers resolve. The Mach-O binaries here are
#     signed by the addon-signing loop below for notarization.
( cd "$ROOT/../node_modules" && find . -type d -path "*/prebuilds/$BARE_HOST" ) | while read -r d; do
  rel="${d#./}"
  mkdir -p "$PAYLOAD_LIB/worklet/node_modules/$(dirname "$rel")"
  cp -R "$ROOT/../node_modules/$rel" "$PAYLOAD_LIB/worklet/node_modules/$(dirname "$rel")/"
done

# 5. UI.
cp ui/index.html "$PAYLOAD_LIB/ui/index.html"
cp ui/dist/app.js "$PAYLOAD_LIB/ui/dist/app.js"
cp ui/dist/style.css "$PAYLOAD_LIB/ui/dist/style.css"

# 6. Installer metadata: ship the LaunchAgent template so postinstall can
#    template it per-user.
cp installer/macos/com.pearcircle.seeder.plist "$PAYLOAD_LIB/installer/"

# 6a1. Privileged updater (proposal 2026-06-05-seeder-update slice 3b): ship the
#      root LaunchDaemon plist + the helper script so postinstall can install the
#      one-click auto-updater. The helper lands beside pearcircle-seeder; the
#      daemon plist is templated/installed to /Library/LaunchDaemons.
cp installer/macos/com.pearcircle.seeder.updater.plist "$PAYLOAD_LIB/installer/"
cp installer/macos/updater-helper.sh "$PAYLOAD_LIB/updater-helper.sh"
chmod +x "$PAYLOAD_LIB/updater-helper.sh"

# 6a2. Uninstaller: ship the teardown script + a clickable "Uninstall
#      PearCircle Seeder.app" wrapper. postinstall copies the .app to
#      /Applications (reliable, unlike ~/Desktop which is TCC-restricted for
#      the installer). The wrapper prompts keep/remove-identity, then runs the
#      script with admin privileges. The script removes everything the install
#      lays down, including the now-orphaned root updater LaunchDaemon.
cp installer/macos/uninstall.sh "$PAYLOAD_LIB/uninstall.sh"
chmod +x "$PAYLOAD_LIB/uninstall.sh"

UNINSTALL_APP="$PAYLOAD_LIB/Uninstall PearCircle Seeder.app"
mkdir -p "$UNINSTALL_APP/Contents/MacOS" "$UNINSTALL_APP/Contents/Resources"
cat > "$UNINSTALL_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>uninstall</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.pearcircle.seeder.uninstall</string>
  <key>CFBundleName</key><string>Uninstall PearCircle Seeder</string>
  <key>CFBundleDisplayName</key><string>Uninstall PearCircle Seeder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict>
</plist>
PLIST
cat > "$UNINSTALL_APP/Contents/MacOS/uninstall" <<'LAUNCH'
#!/bin/bash
# Prompt keep/remove-identity, then run the teardown as root.
SCRIPT="/usr/local/lib/pearcircle-seeder/uninstall.sh"
if [ ! -f "$SCRIPT" ]; then
  /usr/bin/osascript -e 'display dialog "PearCircle Seeder does not appear to be installed." with title "Uninstall PearCircle Seeder" buttons {"OK"} default button "OK" with icon caution'
  exit 0
fi
CONFIRM=$(/usr/bin/osascript \
  -e 'try' \
  -e '  display dialog "Uninstall PearCircle Seeder?\n\nThis stops and removes the background seeder service and all its program files." buttons {"Cancel", "Uninstall"} default button "Uninstall" cancel button "Cancel" with title "Uninstall PearCircle Seeder" with icon caution' \
  -e '  return "go"' \
  -e 'on error' -e '  return "cancel"' -e 'end try' 2>/dev/null)
[ "$CONFIRM" = "go" ] || exit 0
IDENTITY=$(/usr/bin/osascript \
  -e 'try' \
  -e '  display dialog "Also remove the seeder identity and all circle enrollments?\n\nKeep them to reinstall later as the same seeder." buttons {"Keep", "Remove"} default button "Keep" with title "Uninstall PearCircle Seeder" with icon note' \
  -e '  return button returned of result' \
  -e 'on error' -e '  return "Keep"' -e 'end try' 2>/dev/null)
FLAG="--keep"; [ "$IDENTITY" = "Remove" ] && FLAG="--purge"
OUT=$(/usr/bin/osascript -e "do shell script \"/bin/bash '$SCRIPT' $FLAG 2>&1\" with administrator privileges" 2>&1)
RC=$?
if [ "$RC" = "0" ]; then
  /usr/bin/osascript -e 'display dialog "PearCircle Seeder has been uninstalled." with title "Uninstall PearCircle Seeder" buttons {"OK"} default button "OK" with icon note' >/dev/null 2>&1
else
  /usr/bin/osascript -e "display dialog \"Uninstall did not complete:\n\n$OUT\" with title \"Uninstall PearCircle Seeder\" buttons {\"OK\"} default button \"OK\" with icon stop" >/dev/null 2>&1
fi
exit 0
LAUNCH
chmod +x "$UNINSTALL_APP/Contents/MacOS/uninstall"

# 6b. Build the PearCircle .icns icon from the repo's 1024x1024 png. iconutil
#     needs an .iconset directory with the standard 10 size variants.
ICON_SRC="$ROOT/../assets/images/icon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$ROOT/dist/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
  sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
  sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
  cp "$ICON_SRC"                  "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$PAYLOAD_LIB/AppIcon.icns"
  rm -rf "$ICONSET"
  # Give the Uninstall.app the PearCircle icon too.
  cp "$PAYLOAD_LIB/AppIcon.icns" "$PAYLOAD_LIB/Uninstall PearCircle Seeder.app/Contents/Resources/AppIcon.icns" 2>/dev/null || true
else
  echo "warning: icon source $ICON_SRC missing; Desktop shortcut will use a generic icon"
fi

# 7. Sign the native executables inside the payload. The pearcircle-seeder
#    wrapper is a shell script — codesign doesn't apply. Without APP_SIGN_ID
#    we ad-hoc sign; Gatekeeper will refuse to launch the .pkg unsigned, but
#    `sudo installer -allowUntrusted -pkg ... -target /` still works locally.
if [ -n "$APP_SIGN_ID" ]; then
  # Unlock the buildkey keychain so codesign over SSH stops hitting
  # errSecInternalComponent. Matches the pattern in scripts/ios-dev-install.sh.
  if [ -e "$KEYCHAIN_PATH" ] || [ -e "${KEYCHAIN_PATH}-db" ]; then
    security unlock-keychain -p "" "$KEYCHAIN_PATH" 2>/dev/null || true
    security list-keychains -s "$KEYCHAIN_PATH" "$HOME/Library/Keychains/login.keychain-db" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  ENTITLEMENTS="$ROOT/installer/macos/entitlements.plist"
  # Sign every Mach-O native addon in the payload first (inside-out).
  # Apple's notary service rejects the .pkg if any nested binary is
  # unsigned or lacks a secure timestamp. ELF/PE addons for foreign
  # platforms are skipped — notary only inspects Mach-O. Addons don't
  # JIT, so they're signed without the JIT entitlements.
  signed_addons=0
  while IFS= read -r f; do
    if file "$f" | grep -q 'Mach-O'; then
      codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$f" \
        || { echo "error: failed to sign $f" >&2; exit 1; }
      signed_addons=$((signed_addons + 1))
    fi
  done < <(find "$PAYLOAD_LIB" -type f \( -name '*.node' -o -name '*.bare' -o -name '*.dylib' -o -name '*.so' \))
  echo "signed $signed_addons native addon binaries"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/node"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APP_SIGN_ID" "$PAYLOAD_LIB/bare"
else
  codesign --force --sign - "$PAYLOAD_LIB/node"
  codesign --force --sign - "$PAYLOAD_LIB/bare"
fi

# 8. Scripts directory for pkgbuild.
cp scripts/postinstall-macos.sh "$SCRIPTS_DIR/postinstall"
chmod +x "$SCRIPTS_DIR/postinstall"

# 9. Component pkg.
#
# pkgbuild infers /usr/local/lib/pearcircle-seeder as a relocatable,
# version-checked bundle. On an upgrade that makes `installer` (a) relocate to a
# previously-installed copy and (b) SKIP overwriting the payload when the new
# version isn't strictly higher — which left a half-updated install during slice
# 3b validation (top-level files like host-bundled.js + updater-helper.sh not
# replaced). An auto-updater must always lay down exactly the shipped payload, so
# disable both flags via a component plist. Proposal 2026-06-05-seeder-update 3b.
COMPONENT="$ROOT/dist/macos/PearCircleSeeder-component.pkg"
COMPONENT_PLIST="$ROOT/dist/macos/component.plist"
pkgbuild --analyze --root "$PAYLOAD" "$COMPONENT_PLIST"
python3 - "$COMPONENT_PLIST" <<'PY'
import sys, plistlib
p = sys.argv[1]
with open(p, 'rb') as f:
    comps = plistlib.load(f)
for c in comps:
    c['BundleIsRelocatable'] = False
    c['BundleIsVersionChecked'] = False
    c['BundleOverwriteAction'] = 'upgrade'
with open(p, 'wb') as f:
    plistlib.dump(comps, f)
PY
pkgbuild \
  --root "$PAYLOAD" \
  --component-plist "$COMPONENT_PLIST" \
  --identifier com.pearcircle.seeder \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location / \
  "$COMPONENT"

# 10. Distribution pkg.
DIST="$ROOT/dist/macos/PearCircleSeeder-$VERSION.pkg"
if [ -n "$PKG_SIGN_ID" ]; then
  productbuild \
    --distribution installer/macos/Distribution.xml \
    --resources installer/macos/Resources \
    --package-path "$ROOT/dist/macos" \
    --sign "$PKG_SIGN_ID" \
    --timestamp \
    "$DIST"
else
  productbuild \
    --distribution installer/macos/Distribution.xml \
    --resources installer/macos/Resources \
    --package-path "$ROOT/dist/macos" \
    "$DIST"
  echo "warning: built unsigned .pkg. Install with: sudo installer -allowUntrusted -pkg $DIST -target /"
fi

# 11. Notarize + staple — only if signed. The notary credential profile
# lives in the buildkey keychain (see store-credentials --keychain), so
# point notarytool at it explicitly rather than the locked login keychain.
if [ -n "$PKG_SIGN_ID" ] && [ "$SKIP_NOTARIZE" != "1" ]; then
  NOTARY_KEYCHAIN="$KEYCHAIN_PATH"
  [ -e "$NOTARY_KEYCHAIN" ] || NOTARY_KEYCHAIN="${KEYCHAIN_PATH}-db"
  xcrun notarytool submit "$DIST" --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" --wait
  xcrun stapler staple "$DIST"
fi

echo "built: $DIST"
