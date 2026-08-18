#!/bin/bash
# Runs as root under macOS installer's postinstall context. Resolves the actual
# console user (whose account the seeder runs under and whose home holds the
# store), templates the plist into /Library/LaunchDaemons, bootstraps it into the
# SYSTEM domain so it outlives the login session, retires the login-bound
# LaunchAgent this used to be, waits for the UI URL to appear in the log, opens
# the URL in the user's default browser, and prompts (via osascript) whether to
# drop a .webloc shortcut on the Desktop.
set -euo pipefail

# Resolve the console user, not $USER (which is root during install).
USER_NAME=$(stat -f %Su /dev/console)
USER_UID=$(id -u "$USER_NAME")
USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
if [ -z "$USER_HOME" ]; then USER_HOME="/Users/$USER_NAME"; fi

DATA_DIR="$USER_HOME/Library/Application Support/PearCircle Seeder"
LOG_PATH="$DATA_DIR/launchd.log"
PLIST_SRC="/usr/local/lib/pearcircle-seeder/installer/com.pearcircle.seeder.plist"
PLIST_DST="/Library/LaunchDaemons/com.pearcircle.seeder.plist"
# Where this used to live. Every install before 2026-08-17 has one, and it must be
# torn down or we end up running two seeders against one store.
LEGACY_AGENT="$USER_HOME/Library/LaunchAgents/com.pearcircle.seeder.plist"

# Update vs fresh install: if either the daemon or the legacy agent already
# exists this is a re-install / one-click auto-update, so skip the first-run UI
# (open browser, Desktop-shortcut prompt) — an auto-update must not pop dialogs.
# Proposal 2026-06-05-seeder-update slice 3b.
IS_UPDATE=0
{ [ -f "$PLIST_DST" ] || [ -f "$LEGACY_AGENT" ]; } && IS_UPDATE=1

mkdir -p "$DATA_DIR"
chown "$USER_NAME" "$DATA_DIR"

# --- Retire the login-bound LaunchAgent --------------------------------------
# This job used to be an agent in ~/Library/LaunchAgents, whose own comment
# claimed it "survives logout via KeepAlive". It does not: agents there load into
# gui/501, a `type = login` domain that loginwindow tears down at logout, and
# KeepAlive does not exempt a job from its domain's teardown. Measured on the
# mac-mini 2026-07-31 across one real logout/login - the job was killed and a
# DIFFERENT pid appeared only at the next login. Boot it out before bootstrapping
# the daemon, or both run at once against the same store.
if [ -f "$LEGACY_AGENT" ]; then
  launchctl asuser "$USER_UID" launchctl unload "$LEGACY_AGENT" 2>/dev/null || true
  launchctl bootout "gui/$USER_UID/com.pearcircle.seeder" 2>/dev/null || true
  rm -f "$LEGACY_AGENT"
fi

# Substitute the log path, the credentials to run under and the data dir (see the
# template's own note on why the data dir is passed explicitly).
sed -e "s|__LOG_PATH__|$LOG_PATH|g" \
    -e "s|__USER__|$USER_NAME|g" \
    -e "s|__GROUP__|staff|g" \
    -e "s|__USER_HOME__|$USER_HOME|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    "$PLIST_SRC" > "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 0644 "$PLIST_DST"

# Reload if already present (post-update install path). A system daemon so it
# outlives the login session; UserName in the plist keeps it running as the user,
# so the store's ownership is untouched.
launchctl bootout "system/com.pearcircle.seeder" 2>/dev/null || true
launchctl bootstrap system "$PLIST_DST" 2>/dev/null \
  || launchctl load "$PLIST_DST" 2>/dev/null || true

# --- Privileged updater LaunchDaemon (proposal 2026-06-05-seeder-update 3b) ---
# Installs the root auto-updater that applies one-click updates without sudo.
# The unprivileged seeder drops a verified-pkg request into REQ_DIR; the daemon's
# WatchPaths fires the helper, which re-verifies (sha256 + team + notarization)
# and installs. We do NOT bootout an already-loaded updater here: during an
# auto-update THIS postinstall runs *inside* the helper, and booting it out
# would kill the in-flight install.
UPDATES_DIR="/Library/Application Support/PearCircle Seeder/updates"
REQ_DIR="$UPDATES_DIR/requests"
mkdir -p "$REQ_DIR"
chown root:wheel "$UPDATES_DIR" "$REQ_DIR"
chmod 0755 "$UPDATES_DIR"
# 0733: root rwx; the console-user seeder can write+traverse to drop apply.json
# but cannot list other requests. The helper re-verifies, so a hostile drop is
# rejected at install time anyway.
chmod 0733 "$REQ_DIR"

DAEMON_SRC="/usr/local/lib/pearcircle-seeder/installer/com.pearcircle.seeder.updater.plist"
DAEMON_DST="/Library/LaunchDaemons/com.pearcircle.seeder.updater.plist"
if [ -f "$DAEMON_SRC" ]; then
  cp "$DAEMON_SRC" "$DAEMON_DST"
  chown root:wheel "$DAEMON_DST"
  chmod 0644 "$DAEMON_DST"
  # The helper must be root-owned + not group/world-writable (it runs as root).
  chown root:wheel /usr/local/lib/pearcircle-seeder/updater-helper.sh 2>/dev/null || true
  chmod 0755 /usr/local/lib/pearcircle-seeder/updater-helper.sh 2>/dev/null || true
  # Bootstrap only if not already loaded (no bootout — see above).
  launchctl bootstrap system "$DAEMON_DST" 2>/dev/null \
    || launchctl load "$DAEMON_DST" 2>/dev/null || true
fi

# --- Uninstaller app ---------------------------------------------------------
# Install the clickable "Uninstall PearCircle Seeder.app" to /Applications on
# every install (fresh + update) so it stays current. /Applications is chosen
# over ~/Desktop because the latter is TCC-restricted for an installer/daemon
# context; /Applications is reliable and shows in Launchpad + Spotlight.
UNINSTALL_SRC="/usr/local/lib/pearcircle-seeder/Uninstall PearCircle Seeder.app"
UNINSTALL_DST="/Applications/Uninstall PearCircle Seeder.app"
if [ -d "$UNINSTALL_SRC" ]; then
  ( set +e
    rm -rf "$UNINSTALL_DST"
    /usr/bin/ditto "$UNINSTALL_SRC" "$UNINSTALL_DST" 2>/dev/null \
      || cp -R "$UNINSTALL_SRC" "$UNINSTALL_DST"
    /usr/bin/xattr -dr com.apple.quarantine "$UNINSTALL_DST" 2>/dev/null
    /usr/bin/touch "$UNINSTALL_DST"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$UNINSTALL_DST" 2>/dev/null
    /usr/bin/mdimport "$UNINSTALL_DST" 2>/dev/null
  )
fi

# On an auto-update / re-install, the seeder is already set up and the operator
# isn't watching — skip the browser-open + shortcut prompt entirely so the
# update stays silent (slice 3b). The daemon reload above already brought the new
# version up.
if [ "$IS_UPDATE" = "1" ]; then
  echo "PearCircle Seeder updated; LaunchDaemon reloaded (silent update)."
  exit 0
fi

# From here down is best-effort first-run convenience (open the browser, offer a
# Desktop shortcut). None of it may fail the install — in a sandboxed / headless
# installer context (e.g. an auto-update via the privileged daemon, or any
# install without Full Disk Access) writing to ~/Desktop is TCC-blocked and
# would otherwise abort the whole package with `set -e`. Drop the strict flags.
# Proposal 2026-06-05-seeder-update slice 3b (hardening).
set +e

# Wait up to ~15s for the host to bind and log the UI URL.
URL=""
for i in $(seq 1 30); do
  if grep -q 'UI at ' "$DATA_DIR/seeder.log" 2>/dev/null; then
    URL=$(grep 'UI at ' "$DATA_DIR/seeder.log" | tail -1 | sed 's/.*UI at //')
    break
  fi
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "warning: PearCircle Seeder did not log a UI URL within 15s; check $DATA_DIR/launchd.log"
  exit 0
fi

echo "PearCircle Seeder running. Open: $URL"

# Open the UI in the user's default browser. `launchctl asuser` puts us
# in their Aqua session so `open` routes to their default app.
launchctl asuser "$USER_UID" sudo -u "$USER_NAME" open "$URL" 2>/dev/null || true

# Dashboard shortcut. Created in /Applications, NOT ~/Desktop: ~/Desktop is
# TCC-protected, so a later uninstall — which runs as a non-Installer root
# process with no Full Disk Access — cannot delete a Desktop item (it fails
# silently, no prompt). /Applications is unrestricted, so the uninstaller
# removes it cleanly, and the app is searchable in Spotlight + Launchpad. No
# LSUIElement, for the same searchability reason.
APP="/Applications/PearCircle Seeder.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>open-ui</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.pearcircle.seeder.shortcut</string>
  <key>CFBundleName</key><string>PearCircle Seeder</string>
  <key>CFBundleDisplayName</key><string>PearCircle Seeder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/open-ui" <<'LAUNCH'
#!/bin/bash
# Read the current auth token and open the UI in the default browser.
DATA="$HOME/Library/Application Support/PearCircle Seeder"
TOKEN=$(cat "$DATA/auth.token" 2>/dev/null | tr -d '\n')
if [ -z "$TOKEN" ]; then
  /usr/bin/osascript -e 'display dialog "PearCircle Seeder is not running. Open Activity Monitor or check /Library/LaunchDaemons/com.pearcircle.seeder.plist." with title "PearCircle Seeder" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi
exec /usr/bin/open "http://127.0.0.1:8730/?t=$TOKEN"
LAUNCH
chmod +x "$APP/Contents/MacOS/open-ui"

if [ -f /usr/local/lib/pearcircle-seeder/AppIcon.icns ]; then
  cp /usr/local/lib/pearcircle-seeder/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi

# Strip any quarantine attribute (installer-created files shouldn't have
# one but belt + suspenders so Gatekeeper doesn't refuse the first launch).
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Nudge Finder + LaunchServices + Spotlight to pick up the new bundle so it is
# findable by name right away.
/usr/bin/touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
/usr/bin/mdimport "$APP" 2>/dev/null || true

echo "Installed dashboard shortcut: $APP"

exit 0
