#!/usr/bin/env bash
# scripts/ios-dev-install.sh
#
# Build PearCircle for iOS device on Tims-Mac-mini.local and install on
# the paired iPhone. Captures the working pipeline from phase 3
# (commit landed 2026-05-08).
#
# Usage:
#   ./scripts/ios-dev-install.sh                  # full pipeline
#   SKIP_BUILD=1 ./scripts/ios-dev-install.sh     # bundles already fresh
#   SKIP_SYNC=1 ./scripts/ios-dev-install.sh      # already in sync
#   SKIP_INSTALL=1 ./scripts/ios-dev-install.sh   # archive+export only
#
# Required on the Mac mini:
#   - Xcode 16+ with command-line tools
#   - CocoaPods (~/.rbenv or /opt/homebrew via login shell)
#   - Apple Development cert in ~/Library/Keychains/buildkey.keychain
#     (signed under team G79ALD29NA)
#   - Paired iPhone visible to `xcrun devicectl list devices`
#
# Environment overrides:
#   MAC_MINI         host (default Tims-Mac-mini.local)
#   MAC_REPO_PATH    repo path on Mac mini (default peerloomllc/pearcircle)
#   DEVICE_UDID      iPhone CoreDevice UUID (default Timothy's iPhone SE)
#   TEAM_ID          signing team (default G79ALD29NA)
#   ARCHIVE_PATH     xcarchive output (default /tmp/PearCircle.xcarchive)
#   EXPORT_DIR       IPA output dir (default /tmp/PearCircle-dev)
#   KEYCHAIN_PATH    signing keychain (default ~/Library/Keychains/buildkey.keychain)

set -euo pipefail

MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"
MAC_REPO_PATH="${MAC_REPO_PATH:-peerloomllc/pearcircle}"
DEVICE_UDID="${DEVICE_UDID:-E1A6316D-C6A9-510B-9D3E-CD3D85C6DDF5}"
TEAM_ID="${TEAM_ID:-G79ALD29NA}"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/PearCircle.xcarchive}"
EXPORT_DIR="${EXPORT_DIR:-/tmp/PearCircle-dev}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-~/Library/Keychains/buildkey.keychain}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# ── 0. Build bundles locally ────────────────────────────────────────────────
# rsync copies assets/* to the Mac mini, but the iOS pipeline never
# rebuilds the JS bundles — Xcode just packages whatever's in assets/.
# Stale bundles from a previous build would ship to the device and
# the user would see "I just merged X but the iPhone doesn't show it"
# (which is exactly the trap that prompted this step).
# Builds bare-ios.bundle (worklet, ios preset) and app-ui.bundle
# (WebView UI) — both are required for an iOS install. The Android
# universal bare bundle is intentionally skipped here.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  step "build bundles locally (bare:ios + ui)"
  cd "$REPO_ROOT"
  npm run build:bare:ios
  npm run build:ui
fi

# ── 1. Sync workspace to Mac mini ───────────────────────────────────────────
# Excludes: anything regenerated on the build host (node_modules, Pods,
# build, xcworkspace), bulky local-only state (.git, .expo), and Android
# build artifacts that the iOS pipeline never reads.
if [ "${SKIP_SYNC:-0}" != "1" ]; then
  step "rsync $REPO_ROOT/ -> ${MAC_MINI}:${MAC_REPO_PATH}/"
  rsync -az --delete \
    --exclude='node_modules/' \
    --exclude='ios/Pods/' \
    --exclude='ios/build/' \
    --exclude='ios/PearCircle.xcworkspace/' \
    --exclude='android/build/' \
    --exclude='android/.gradle/' \
    --exclude='android/app/build/' \
    --exclude='.git/' \
    --exclude='.expo/' \
    --exclude='seeder-launcher/' \
    "$REPO_ROOT/" \
    "${MAC_MINI}:${MAC_REPO_PATH}/"
fi

# ── 1b. Install JS deps on Mac mini ─────────────────────────────────────────
# rsync excludes node_modules/ (regenerated on the build host), so a native
# module added locally (e.g. expo-clipboard) shows up in the synced
# package.json but is missing from the Mac's node_modules. Expo autolinking
# then silently omits its pod and the Metro bundle can't resolve the import,
# so the archive fails. Running npm install after every sync keeps the Mac's
# node_modules in step with package.json. Skipped alongside SKIP_SYNC (no new
# code synced -> deps already in place). bash -lc so /opt/homebrew/bin (node)
# is on PATH, same as the pod install step below.
if [ "${SKIP_SYNC:-0}" != "1" ]; then
  step "npm install on $MAC_MINI"
  ssh "$MAC_MINI" "bash -lc 'cd $MAC_REPO_PATH && npm install'" | tail -3
fi

# ── 2. Pod install on Mac mini ──────────────────────────────────────────────
# UTF-8 env vars are required: bash -lc returns ASCII-8BIT by default on
# this Mac, and CocoaPods' UnicodeNormalize crashes without UTF-8.
# Re-running pod install on every iteration is the simplest way to keep
# the workspace in sync after rsync --delete wipes it.
step "pod install on $MAC_MINI"
ssh "$MAC_MINI" "bash -lc 'cd $MAC_REPO_PATH/ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install'" \
  | tail -3

# ── 3. Archive + export ─────────────────────────────────────────────────────
# Why we strip /opt/homebrew/bin from PATH: Xcode's distribution pipeline
# invokes rsync internally; if Homebrew's GNU rsync (3.4.x) shadows
# Apple's openrsync, IPA packaging fails with "Copy failed". Same shim
# pearguard/pearcal use.
#
# Why unlock + set-key-partition-list: codesign over SSH hits
# errSecInternalComponent unless the keychain is unlocked AND
# apple-tool/codesign access to the private key is explicitly granted
# in this session. Empty password ("") matches the buildkey keychain
# pearguard/pearcal already use on this host.
#
# Why CODE_SIGN_STYLE=Automatic without Apple ID logged in: Xcode's
# cached wildcard team profile ("iOS Team Provisioning Profile: *")
# covers com.pearcircle as long as the entitlements file requests no
# capabilities the wildcard profile lacks. PearCircle.entitlements is
# intentionally empty (no aps-environment, no associated domains).
step "archive (Release, generic/platform=iOS, automatic signing)"
ssh "$MAC_MINI" "bash -lc '
  set -euo pipefail
  cd $MAC_REPO_PATH/ios
  security unlock-keychain -p \"\" $KEYCHAIN_PATH
  security list-keychains -s $KEYCHAIN_PATH ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k \"\" $KEYCHAIN_PATH >/dev/null 2>&1 || true
  XCODE_PATH=\$(printf %s \"\$PATH\" | sed \"s|/opt/homebrew/bin:||g; s|:/opt/homebrew/bin||g\")
  rm -rf $ARCHIVE_PATH
  PATH=\"\$XCODE_PATH\" xcodebuild \
    -workspace PearCircle.xcworkspace \
    -scheme PearCircle \
    -configuration Release \
    -destination generic/platform=iOS \
    -archivePath $ARCHIVE_PATH \
    DEVELOPMENT_TEAM=$TEAM_ID \
    CODE_SIGN_STYLE=Automatic \
    archive 2>&1 | grep -E \"^error:|ARCHIVE FAILED|ARCHIVE SUCCEEDED\" || true
'"

step "export development IPA"
ssh "$MAC_MINI" "bash -lc '
  set -euo pipefail
  security unlock-keychain -p \"\" $KEYCHAIN_PATH
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k \"\" $KEYCHAIN_PATH >/dev/null 2>&1 || true
  cat > /tmp/PearCircleExportDev.plist << EOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>method</key><string>development</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>compileBitcode</key><false/>
  <key>stripSwiftSymbols</key><false/>
</dict>
</plist>
EOF
  cd $MAC_REPO_PATH/ios
  XCODE_PATH=\$(printf %s \"\$PATH\" | sed \"s|/opt/homebrew/bin:||g; s|:/opt/homebrew/bin||g\")
  rm -rf $EXPORT_DIR
  PATH=\"\$XCODE_PATH\" xcodebuild \
    -exportArchive \
    -archivePath $ARCHIVE_PATH \
    -exportPath $EXPORT_DIR \
    -exportOptionsPlist /tmp/PearCircleExportDev.plist \
    OTHER_CODE_SIGN_FLAGS=\"--keychain $KEYCHAIN_PATH\" 2>&1 | tail -3
  ls $EXPORT_DIR/PearCircle.ipa
'"

# ── 4. Install + launch on iPhone ───────────────────────────────────────────
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  step "install on iPhone $DEVICE_UDID"
  ssh "$MAC_MINI" "bash -lc '
    xcrun devicectl device install app \
      --device $DEVICE_UDID \
      $EXPORT_DIR/PearCircle.ipa 2>&1 | tail -3
  '"

  step "launch com.pearcircle"
  ssh "$MAC_MINI" "bash -lc '
    xcrun devicectl device process launch \
      --device $DEVICE_UDID \
      com.pearcircle 2>&1 | tail -2
  '"
fi

step "Done. IPA: $EXPORT_DIR/PearCircle.ipa on $MAC_MINI"
