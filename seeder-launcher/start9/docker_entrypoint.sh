#!/bin/sh
set -e

# StartOS mounts the persistence volume at /root (manifest main.mounts.main).
# Keep the seeder's state in a subdir so the duplicity backup (which mounts the
# same volume at /root/data) lines up exactly.
DATA_DIR=/root/data
mkdir -p "$DATA_DIR"

# Container adaptation, same as the Umbrel image:
#   0.0.0.0        - StartOS reaches the dashboard over its own network, not loopback
#   no-auth        - the StartOS interface proxy already gates access
#   no-update-check- updates come from the StartOS marketplace, not the in-app checker
export SEEDER_HOST=0.0.0.0
export SEEDER_PORT=8730
export SEEDER_NO_AUTH=1
export SEEDER_NO_UPDATE_CHECK=1

printf "\n [i] Starting PearCircle Seeder (data: %s) ...\n\n" "$DATA_DIR"

# tini as PID 1 so the worklet's `bare` child is reaped and signals propagate.
exec tini -- node /app/host-bundled.js --data-dir "$DATA_DIR" --no-open
