#!/bin/bash
# PearCircle Seeder - macOS uninstaller.
#
# Tears down everything an install lays down. As of the one-click auto-updater
# (proposal 2026-06-05-seeder-update slice 3b) that is FIVE things, three of
# which the old hand-written README steps missed entirely:
#
#   user LaunchAgent   ~/Library/LaunchAgents/com.pearcircle.seeder.plist
#   payload            /usr/local/lib/pearcircle-seeder
#   root LaunchDaemon  /Library/LaunchDaemons/com.pearcircle.seeder.updater.plist   (missed)
#   root updates dir   /Library/Application Support/PearCircle Seeder               (missed)
#   Desktop shortcut   ~/Desktop/PearCircle Seeder.app                              (missed)
#   Uninstall app      /Applications/Uninstall PearCircle Seeder.app
#
# The seeder identity + circle enrollments live separately under the user's
# ~/Library/Application Support/PearCircle Seeder and are KEPT by default so a
# reinstall stays the same seeder. Pass --purge to wipe them too, --keep to
# force-keep; with neither, an interactive terminal is prompted.
#
# Must run as root (it removes a root LaunchDaemon + /usr/local/lib). The
# Uninstall.app wrapper handles the privilege prompt; from a terminal use:
#   sudo bash /usr/local/lib/pearcircle-seeder/uninstall.sh
set -uo pipefail

PAYLOAD="/usr/local/lib/pearcircle-seeder"

# Re-exec from /tmp if we're running from inside the payload we're about to
# delete — bash re-reads the script file as it runs, so removing it mid-flight
# would break later lines.
SELF="$0"
case "$SELF" in
  "$PAYLOAD"/*)
    TMP=$(mktemp /tmp/pcseeder-uninstall.XXXXXX) || exit 1
    cp "$SELF" "$TMP" && chmod +x "$TMP"
    exec /bin/bash "$TMP" "$@"
    ;;
esac

PURGE=""   # "", "1" (wipe identity), or "0" (keep)
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --keep)  PURGE=0 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "error: must run as root. Try: sudo bash $PAYLOAD/uninstall.sh" >&2
  exit 1
fi

# Resolve the console user whose LaunchAgent + data dir we touch (postinstall
# uses the same dance). $USER is root during an installer/admin context.
USER_NAME=$(stat -f %Su /dev/console 2>/dev/null)
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = "root" ]; then
  USER_NAME="${SUDO_USER:-$USER_NAME}"
fi
USER_UID=$(id -u "$USER_NAME" 2>/dev/null || echo "")
USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -z "$USER_HOME" ] && USER_HOME="/Users/$USER_NAME"

IDENTITY_DIR="$USER_HOME/Library/Application Support/PearCircle Seeder"

echo "Uninstalling PearCircle Seeder (user: $USER_NAME)..."

# 1. User LaunchAgent: stop in the user's GUI session, then remove the plist.
AGENT="$USER_HOME/Library/LaunchAgents/com.pearcircle.seeder.plist"
if [ -n "$USER_UID" ]; then
  launchctl asuser "$USER_UID" launchctl bootout "gui/$USER_UID/com.pearcircle.seeder" 2>/dev/null \
    || launchctl asuser "$USER_UID" launchctl unload "$AGENT" 2>/dev/null || true
fi
rm -f "$AGENT"

# 2. Root updater LaunchDaemon: bootout of the system domain, then remove.
DAEMON="/Library/LaunchDaemons/com.pearcircle.seeder.updater.plist"
launchctl bootout system/com.pearcircle.seeder.updater 2>/dev/null \
  || launchctl unload "$DAEMON" 2>/dev/null || true
rm -f "$DAEMON"

# 3. Root updates scratch dir (verified-pkg requests + updater.log).
rm -rf "/Library/Application Support/PearCircle Seeder"

# 4. Dashboard shortcut + the Uninstall app itself, both in /Applications
# (unrestricted, so root removes them cleanly). The legacy ~/Desktop shortcut
# from older installs is best-effort only — ~/Desktop is TCC-protected, so this
# rm works just from a Full-Disk-Access terminal; otherwise the user drags that
# stale tile to the Trash by hand (new installs no longer put it there).
rm -rf "/Applications/PearCircle Seeder.app"
rm -rf "/Applications/Uninstall PearCircle Seeder.app"
rm -rf "$USER_HOME/Desktop/PearCircle Seeder.app" 2>/dev/null || true

# 5. Payload (binaries, worklet, UI, this script's origin).
rm -rf "$PAYLOAD"

# 6. Identity / enrollments — decide last so a keep/purge choice is explicit.
if [ -z "$PURGE" ]; then
  if [ -t 0 ]; then
    printf 'Also remove the seeder identity and all circle enrollments at\n  %s ? [y/N] ' "$IDENTITY_DIR"
    read -r ans
    case "$ans" in y|Y|yes|YES) PURGE=1 ;; *) PURGE=0 ;; esac
  else
    PURGE=0   # non-interactive default: keep identity
  fi
fi

if [ "$PURGE" = "1" ]; then
  rm -rf "$IDENTITY_DIR"
  echo "Removed the seeder identity and enrollments."
else
  echo "Kept the seeder identity at:"
  echo "  $IDENTITY_DIR"
  echo "Delete it by hand for a full wipe, or re-run with --purge."
fi

echo "PearCircle Seeder uninstalled."
