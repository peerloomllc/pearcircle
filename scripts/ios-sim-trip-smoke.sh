#!/usr/bin/env bash
# scripts/ios-sim-trip-smoke.sh
#
# End-to-end trip-capture smoke on an iPhone Simulator on the Mac mini.
#
# Every earlier iteration of the background-trip work cost a real drive and a
# day to test. This reproduces the part that actually breaks - a worklet killed
# mid-drive - without leaving the desk: simctl feeds a simulated drive while the
# script terminates and relaunches the app underneath it, exactly the way iOS
# jetsams the app and SLC-relaunches it every few minutes on a real trip.
#
# What it proves (and what it does not): that the tripInFlight checkpoint
# rehydrates, that the coarse no-speed fix on relaunch no longer resets the
# trip, that the native fix log captures and drains, and that a trip finalizes
# across the kills. It does NOT reproduce iOS background suspension itself -
# the Simulator keeps apps running - so a real drive is still the final word.
#
# Usage:
#   ./scripts/ios-sim-trip-smoke.sh
#   SKIP_BUILD=1 ./scripts/ios-sim-trip-smoke.sh    # bundles already fresh
#   SKIP_SYNC=1 ./scripts/ios-sim-trip-smoke.sh     # sources already on the Mac
#   SKIP_XCBUILD=1 ./scripts/ios-sim-trip-smoke.sh  # reuse the built .app
#   KILLS=3 ./scripts/ios-sim-trip-smoke.sh         # more mid-drive kills
#
# Environment overrides:
#   MAC_MINI       host (default Tims-Mac-mini.local)
#   MAC_REPO_PATH  repo path on the Mac mini (default peerloomllc/pearcircle)
#   SIM_NAME       simulator device name (default PearCircleSim)
#   DERIVED_DATA   xcodebuild derived data dir on the Mac (default /tmp/pcsim-rel)
#   DRIVE_SPEED    simulated drive speed in m/s (default 25, ~56 mph)
#   KILLS          mid-drive app kills (default 2)
#   LEG_SECONDS    seconds of driving between kills (default 45)
#   COOLDOWN_WAIT  seconds to wait for the trip cooldown (default 310)

set -euo pipefail

MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"
MAC_REPO_PATH="${MAC_REPO_PATH:-peerloomllc/pearcircle}"
SIM_NAME="${SIM_NAME:-PearCircleSim}"
DERIVED_DATA="${DERIVED_DATA:-/tmp/pcsim-rel}"
BUNDLE_ID="com.pearcircle"
DRIVE_SPEED="${DRIVE_SPEED:-25}"
KILLS="${KILLS:-2}"
LEG_SECONDS="${LEG_SECONDS:-45}"
COOLDOWN_WAIT="${COOLDOWN_WAIT:-310}"

# A ~11km straight run north. At 25 m/s that is ~7 minutes of route, comfortably
# longer than the drive legs below, so the route never runs out mid-test.
ROUTE_START="40.000,-73.000"
ROUTE_END="40.100,-73.000"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

# Feed the remote command over stdin rather than embedding it in a quoted
# `bash -lc '...'` argument: the commands below contain their own single quotes
# (grep patterns, sed expressions) and would otherwise be shredded by the outer
# quoting. `-l` for a login shell so Xcode + Homebrew tools are on PATH.
mac() { ssh "$MAC_MINI" 'bash -l -s' <<< "$1"; }

# ── 0. Build bundles locally ────────────────────────────────────────────────
# Same trap as ios-dev-install.sh: Xcode packages whatever is in assets/, it
# never rebuilds the JS. Stale bundles here mean testing yesterday's worklet.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  step "build bundles locally (bare:ios + ui)"
  cd "$REPO_ROOT"
  npm run build:bare:ios
  npm run build:ui
fi

# ── 1. Sync to the Mac mini ─────────────────────────────────────────────────
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

  step "npm install + pod install on $MAC_MINI"
  mac "cd $MAC_REPO_PATH && npm install" | tail -2
  mac "cd $MAC_REPO_PATH/ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install" | tail -2
fi

# ── 2. Resolve / boot the simulator ─────────────────────────────────────────
step "resolve simulator '$SIM_NAME'"
UDID="$(mac "xcrun simctl list devices | grep '$SIM_NAME (' | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/'")"
[ -n "$UDID" ] || fail "no simulator named '$SIM_NAME'. Create one: xcrun simctl create $SIM_NAME <deviceType> <runtime>"
info "udid $UDID"
mac "xcrun simctl bootstatus $UDID -b" >/dev/null 2>&1 || mac "xcrun simctl boot $UDID" || true

# ── 3. Build for the simulator ──────────────────────────────────────────────
# MUST be Release: a Debug build expects a Metro packager and redboxes with
# "No script URL provided". Release embeds main.jsbundle.
if [ "${SKIP_XCBUILD:-0}" != "1" ]; then
  step "xcodebuild (Release, iphonesimulator)"
  mac "cd $MAC_REPO_PATH/ios && xcodebuild \
    -workspace PearCircle.xcworkspace \
    -scheme PearCircle \
    -configuration Release \
    -sdk iphonesimulator \
    -destination id=$UDID \
    -derivedDataPath $DERIVED_DATA \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    build 2>&1 | grep -E '^error:|BUILD FAILED|BUILD SUCCEEDED'" || true
fi
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/PearCircle.app"
mac "test -d $APP_PATH" || fail "no app at $APP_PATH - the xcodebuild step failed"

# ── 4. Install + grant + reset the trace ────────────────────────────────────
step "install + grant location-always"
mac "xcrun simctl install $UDID $APP_PATH"
mac "xcrun simctl privacy $UDID grant location-always $BUNDLE_ID"

step "clear previous trace files"
CONTAINER="$(mac "xcrun simctl get_app_container $UDID $BUNDLE_ID data")"
info "container $CONTAINER"
mac "rm -f '$CONTAINER/Documents/trips.log' '$CONTAINER/Documents/fixbuffer.log' '$CONTAINER/Documents/coldstart.log'"

# ── 5. Drive, killing the app mid-route ─────────────────────────────────────
step "start simulated drive (${DRIVE_SPEED} m/s, $ROUTE_START -> $ROUTE_END)"
mac "xcrun simctl location $UDID start --speed $DRIVE_SPEED --distance 12 $ROUTE_START $ROUTE_END"
mac "xcrun simctl launch $UDID $BUNDLE_ID" >/dev/null

info "leg 1: driving ${LEG_SECONDS}s to arm the trip"
sleep "$LEG_SECONDS"

for k in $(seq 1 "$KILLS"); do
  step "kill $k/$KILLS - terminate mid-drive (the jetsam every real trip sees)"
  mac "xcrun simctl terminate $UDID $BUNDLE_ID" || true
  # The route keeps playing while the app is dead: those fixes are exactly what
  # the native durable log has to capture and the drain has to replay.
  sleep 10
  mac "xcrun simctl launch $UDID $BUNDLE_ID" >/dev/null
  info "relaunched; driving another ${LEG_SECONDS}s"
  sleep "$LEG_SECONDS"
done

step "end the drive (stop the route, park the device)"
# `clear`, not `stop`: simctl location has no stop action and just prints usage.
mac "xcrun simctl location $UDID clear" || true
# A stationary fix so the machine sees a real measured stop and enters cooldown,
# rather than just going quiet.
mac "xcrun simctl location $UDID set $ROUTE_END"
sleep 15

# ── 6. Wait out the cooldown, then wake the app to settle the trip ──────────
# Two paths can finalize here and both are worth exercising: a live fix arriving
# after the cooldown elapses, or hydrateTripCheckpoint's settleStaleTrip on the
# next boot. Killing the app for the wait forces the second, harder one.
step "kill the app and wait out the ${COOLDOWN_WAIT}s trip cooldown"
mac "xcrun simctl terminate $UDID $BUNDLE_ID" || true
sleep "$COOLDOWN_WAIT"

step "relaunch - hydrate should settle and finalize the trip"
mac "xcrun simctl launch $UDID $BUNDLE_ID" >/dev/null
sleep 25

# ── 7. Read the trace and judge ─────────────────────────────────────────────
step "pull trips.log"
OUT="${OUT_DIR:-/tmp}/pearcircle-sim-trips.log"
scp -q "${MAC_MINI}:$CONTAINER/Documents/trips.log" "$OUT" 2>/dev/null || fail "no trips.log was written - the worklet never saw a fix"
info "wrote $OUT"
echo
awk '{ $1=strftime("%H:%M:%S", $1/1000); print }' "$OUT" 2>/dev/null || cat "$OUT"
echo

FIXBUF_LINES="$(mac "wc -l < '$CONTAINER/Documents/fixbuffer.log' 2>/dev/null || echo 0" | tr -d ' ')"

step "verdict"
sessions=$(grep -c ' session-start ' "$OUT" || true)
hydrates=$(grep -c ' hydrate ' "$OUT" || true)
drains=$(grep -c ' drain ' "$OUT" || true)
finalizes=$(grep -c ' finalize ' "$OUT" || true)
skips=$(grep -c ' fix-skip ' "$OUT" || true)
info "session-start $sessions | hydrate $hydrates | drain $drains | finalize $finalizes | fix-skip $skips"
info "fixbuffer.log lines captured by native: $FIXBUF_LINES"

[ "$sessions" -ge 2 ] || fail "expected the app to restart at least twice; the kills did not take"
[ "$hydrates" -ge 1 ] || fail "no hydrate line: the in-flight checkpoint did not survive a kill"
[ "$FIXBUF_LINES" -gt 0 ] || fail "fixbuffer.log is empty: native captured nothing (Part B regression)"
[ "$finalizes" -ge 1 ] || fail "no finalize line: the drive was killed mid-flight and never became a trip"

printf '\n\033[1;32mPASS\033[0m a trip survived %s mid-drive kill(s) and finalized.\n' "$KILLS"
