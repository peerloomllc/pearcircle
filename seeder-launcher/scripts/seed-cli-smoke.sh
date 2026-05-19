#!/usr/bin/env bash
# Phase 1 smoke: bare-runtime CLI boots src/bare.js with --seed, accepts an
# init+status IPC over stdin, and persists identity:seeder across two boots.
#
# Run from the repo root: bash seeder-launcher/scripts/seed-cli-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

BARE_BIN="${BARE_BIN:-node node_modules/bare/bin/bare}"
BUNDLE_ENTRY="${BUNDLE_ENTRY:-src/bare.js}"
DATADIR="$(mktemp -d /tmp/pcs-smoke-XXXXXX)"
trap 'rm -rf "$DATADIR"' EXIT

run_one() {
  (
    echo '{"id":1,"method":"init","args":{"mode":"seed","dataDir":"'"$DATADIR"'"}}'
    sleep 3
    echo '{"id":2,"method":"seeder:status","args":{}}'
    sleep 1
  ) | timeout 10 $BARE_BIN $BUNDLE_ENTRY --seed 2>/dev/null | grep '"id":2' | head -1
}

extract_pubkey() {
  python3 -c "import sys,json; print(json.loads(sys.stdin.read())['result']['pubkey'])"
}

PK1=$(run_one | extract_pubkey)
PK2=$(run_one | extract_pubkey)

if [ -z "$PK1" ] || [ -z "$PK2" ]; then
  echo "FAIL: empty pubkey response (boot crashed before responding to seeder:status)" >&2
  exit 1
fi

if [ "$PK1" != "$PK2" ]; then
  echo "FAIL: identity changed across boots ($PK1 != $PK2)" >&2
  exit 1
fi

echo "PASS: identity persisted across boots (pubkey=${PK1:0:12}...)"
