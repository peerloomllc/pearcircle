#!/bin/bash
# Runs as the installing user (not root) under productbuild's installer-script
# context. Writes a LaunchAgent plist into the user's LaunchAgents directory
# and loads it so the daemon starts immediately.
set -euo pipefail

USER_HOME=$(eval echo ~"$USER")
DATA_DIR="$USER_HOME/Library/Application Support/PearCircle Seeder"
LOG_PATH="$DATA_DIR/launchd.log"
PLIST_SRC="/usr/local/lib/pearcircle-seeder/installer/com.pearcircle.seeder.plist"
PLIST_DST="$USER_HOME/Library/LaunchAgents/com.pearcircle.seeder.plist"

mkdir -p "$DATA_DIR"
mkdir -p "$USER_HOME/Library/LaunchAgents"

# Substitute the log path into the template.
sed "s|__LOG_PATH__|$LOG_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
chmod 0644 "$PLIST_DST"

# Reload if already present (post-update install path).
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

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
