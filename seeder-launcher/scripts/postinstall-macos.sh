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
  WEBLOC="$USER_HOME/Desktop/PearCircle Seeder.webloc"
  cat > "$WEBLOC" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>$URL</string>
</dict>
</plist>
EOF
  chown "$USER_NAME" "$WEBLOC"
  chmod 0644 "$WEBLOC"
  echo "Created Desktop shortcut: $WEBLOC"
fi

exit 0
