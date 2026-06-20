#!/usr/bin/env bash
# Delegates to the repo-root build:bare script so the desktop launcher
# always ships the same worklet bundle as mobile. Phase 3 of the launcher
# does not actually use the bundle (we run src/bare.js directly), but
# this script exists so a future bundle-based load path can be wired in
# without changing the .pkg pipeline.
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run build:bare
echo "bundle: $(pwd)/assets/bare-universal.bundle ($(wc -c < assets/bare-universal.bundle) bytes)"
