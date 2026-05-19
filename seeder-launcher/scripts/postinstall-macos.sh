#!/bin/bash
# Runs as root under macOS installer's postinstall context. Resolves the
# actual console user (whose login session needs the LaunchAgent), writes
# the templated plist into their LaunchAgents directory, chowns it, and
# loads it via launchctl asuser so the daemon runs in the user session
# (not as root).
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

# Surface the UI URL on first boot. The launcher writes ?t=<token> into
# its log; tail that for a few seconds so the install completes with a
# clickable URL in the installer log.
for i in $(seq 1 10); do
  if grep -q 'UI at ' "$DATA_DIR/seeder.log" 2>/dev/null; then
    URL=$(grep 'UI at ' "$DATA_DIR/seeder.log" | tail -1 | sed 's/.*UI at //')
    echo "PearCircle Seeder running. Open: $URL"
    break
  fi
  sleep 1
done

exit 0
