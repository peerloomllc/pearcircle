#!/bin/bash
# Runs as root under macOS installer's postinstall context. Resolves the
# actual console user (whose login session needs the LaunchAgent), writes
# the templated plist into their LaunchAgents directory, chowns it, loads
# it in the user's session, waits for the UI URL to appear in the log,
# opens the URL in the user's default browser, and prompts (via osascript)
# whether to drop a .webloc shortcut on the Desktop.
set -euo pipefail

# Resolve the console user, not $USER (which is root during install).
USER_NAME=$(stat -f %Su /dev/console)
USER_UID=$(id -u "$USER_NAME")
USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
if [ -z "$USER_HOME" ]; then USER_HOME="/Users/$USER_NAME"; fi

DATA_DIR="$USER_HOME/Library/Application Support/PearCircle Seeder"
LOG_PATH="$DATA_DIR/launchd.log"
PLIST_SRC="/usr/local/lib/pearcircle-seeder/installer/com.pearcircle.seeder.plist"
PLIST_DST="$USER_HOME/Library/LaunchAgents/com.pearcircle.seeder.plist"

# Update vs fresh install: if the LaunchAgent already exists this is a
# re-install / one-click auto-update, so skip the first-run UI (open browser,
# Desktop-shortcut prompt) — an auto-update must not pop dialogs.
# Proposal 2026-06-05-seeder-update slice 3b.
IS_UPDATE=0
[ -f "$PLIST_DST" ] && IS_UPDATE=1

mkdir -p "$DATA_DIR"
mkdir -p "$USER_HOME/Library/LaunchAgents"
chown "$USER_NAME" "$DATA_DIR" "$USER_HOME/Library/LaunchAgents"

# Substitute the log path into the template.
sed "s|__LOG_PATH__|$LOG_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
chown "$USER_NAME" "$PLIST_DST"
chmod 0644 "$PLIST_DST"

# Reload if already present (post-update install path). Run in the user's
# session so the daemon lives there, not in the root session.
launchctl asuser "$USER_UID" launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl asuser "$USER_UID" launchctl load "$PLIST_DST"

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

# On an auto-update / re-install, the seeder is already set up and the operator
# isn't watching — skip the browser-open + shortcut prompt entirely so the
# update stays silent (slice 3b). The LaunchAgent reload above already brought
# the new version up.
if [ "$IS_UPDATE" = "1" ]; then
  echo "PearCircle Seeder updated; LaunchAgent reloaded (silent update)."
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

# Prompt for a desktop shortcut via AppleScript. -e returns "button returned:..."
# on success, exits non-zero on failure or "User cancelled".
SHORTCUT_ANSWER=$(launchctl asuser "$USER_UID" sudo -u "$USER_NAME" osascript \
  -e 'try' \
  -e '  display dialog "Create a Desktop shortcut to open the PearCircle Seeder monitoring UI?" buttons {"Skip", "Create"} default button "Create" with title "PearCircle Seeder" with icon note' \
  -e '  return button returned of result' \
  -e 'on error' \
  -e '  return "Skip"' \
  -e 'end try' \
  2>/dev/null || echo "Skip")

if [ "$SHORTCUT_ANSWER" = "Create" ]; then
  # Drop a real .app bundle on the Desktop. macOS shows the .app with its
  # own AppIcon and hides the .app extension by default — looks like a
  # PearCircle Seeder shortcut tile, not an opaque .webloc file. The
  # launcher script reads auth.token fresh on every click, so the URL
  # survives token rotation (which happens if the data dir is wiped).
  APP="$USER_HOME/Desktop/PearCircle Seeder.app"
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
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

  cat > "$APP/Contents/MacOS/open-ui" <<'LAUNCH'
#!/bin/bash
# Read the current auth token and open the UI in the default browser.
DATA="$HOME/Library/Application Support/PearCircle Seeder"
TOKEN=$(cat "$DATA/auth.token" 2>/dev/null | tr -d '\n')
if [ -z "$TOKEN" ]; then
  /usr/bin/osascript -e 'display dialog "PearCircle Seeder is not running. Open Activity Monitor or check ~/Library/LaunchAgents/com.pearcircle.seeder.plist." with title "PearCircle Seeder" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi
exec /usr/bin/open "http://127.0.0.1:8730/?t=$TOKEN"
LAUNCH
  chmod +x "$APP/Contents/MacOS/open-ui"

  if [ -f /usr/local/lib/pearcircle-seeder/AppIcon.icns ]; then
    cp /usr/local/lib/pearcircle-seeder/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
  fi

  chown -R "$USER_NAME" "$APP"

  # Strip any quarantine attribute (installer-created files shouldn't have
  # one but belt + suspenders so Gatekeeper doesn't refuse the first launch).
  /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

  # Nudge Finder + LaunchServices to pick up the new bundle + icon.
  /usr/bin/touch "$APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

  echo "Created Desktop shortcut: $APP"
fi

exit 0
