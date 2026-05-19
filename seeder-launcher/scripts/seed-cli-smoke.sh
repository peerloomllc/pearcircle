#!/usr/bin/env bash
# Phase 1 smoke: bare-runtime CLI boots src/bare.js with --seed, accepts an
# init+status IPC over stdin, and persists identity:seeder across two boots.
#
# Run from the repo root: bash seeder-launcher/scripts/seed-cli-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# Use the platform-native bare-runtime binary directly. The `node bin/bare`
# JS wrapper installs a no-op SIGTERM handler (bare-runtime/lib/spawn.js:33),
# which means killing the wrapper leaves the native bare child running and
# holding the corestore lock — boot 2 then fails on a stale lock.
detect_bare_runtime() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
  esac
  case "$os" in
    darwin) echo "node_modules/bare-runtime-darwin-$arch/bin/bare" ;;
    linux) echo "node_modules/bare-runtime-linux-$arch/bin/bare" ;;
    *) echo "node node_modules/bare/bin/bare" ;;
  esac
}
BARE_BIN="${BARE_BIN:-$(detect_bare_runtime)}"
BUNDLE_ENTRY="${BUNDLE_ENTRY:-src/bare.js}"
DATADIR="$(mktemp -d /tmp/pcs-smoke-XXXXXX)"
trap 'rm -rf "$DATADIR"' EXIT

# Portable timeout: macOS doesn't ship `timeout` by default. Spawn bare into
# background, capture stdout to a temp file, kill it after a hard cap.
run_one() {
  local out
  out="$(mktemp /tmp/pcs-smoke-out-XXXXXX)"
  local fifo
  fifo="$(mktemp -u /tmp/pcs-smoke-fifo-XXXXXX)"
  mkfifo "$fifo"
  ( exec $BARE_BIN $BUNDLE_ENTRY --seed < "$fifo" > "$out" 2>/dev/null ) &
  local PID=$!
  (
    echo '{"id":1,"method":"init","args":{"mode":"seed","dataDir":"'"$DATADIR"'"}}'
    sleep 3
    echo '{"id":2,"method":"seeder:status","args":{}}'
    sleep 2
  ) > "$fifo"
  # Give the worklet a moment to flush, then kill.
  sleep 1
  kill -TERM "$PID" 2>/dev/null
  ( sleep 5 && kill -KILL "$PID" 2>/dev/null ) &
  wait "$PID" 2>/dev/null
  grep '"id":2' "$out" | head -1
  rm -f "$out" "$fifo"
}

extract_pubkey() {
  python3 -c "import sys,json; print(json.loads(sys.stdin.read())['result']['pubkey'])"
}

extract_field() {
  local field="$1"
  python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('result',{}).get('$field') or 'err:'+str(d.get('error','no-error-field')))"
}

R1=$(run_one)
echo "boot 1 response: $R1"
sleep 2  # let corestore release the lock cleanly
R2=$(run_one)
echo "boot 2 response: $R2"

PK1=$(echo "$R1" | extract_field pubkey)
PK2=$(echo "$R2" | extract_field pubkey)

if [ -z "$PK1" ] || [ -z "$PK2" ] || [[ "$PK1" == err:* ]] || [[ "$PK2" == err:* ]]; then
  echo "FAIL: bad pubkey response (boot1=$PK1, boot2=$PK2)" >&2
  exit 1
fi

if [ "$PK1" != "$PK2" ]; then
  echo "FAIL: identity changed across boots ($PK1 != $PK2)" >&2
  exit 1
fi

echo "PASS: identity persisted across boots (pubkey=${PK1:0:12}...)"
