#!/usr/bin/env bash
# Build a versioned universal PearCircle seeder .s9pk for StartOS (Start9), and
# optionally regenerate the community-registry metadata on the website.
#
# Mirrors build-umbrel-image.sh: takes the release version, pins the Start9
# package to the freshly-pushed multi-arch seeder image, builds + verifies the
# s9pk, and writes it (plus a .sha256 sidecar) to seeder-launcher/start9/. Run
# AFTER build-umbrel-image.sh — it resolves the IMAGE:VERSION manifest-list
# digest from the registry, so that image must already be pushed.
#
# Usage:   build-start9-s9pk.sh [version]
#
# Version resolution: arg > release git tag (vX.Y.Z) > seeder package.json.
#
# Env:
#   IMAGE        base image repo (default ghcr.io/peerloomllc/pearcircle-seeder)
#
# Publishing the built s9pk to the website community registry is a separate,
# post-release step: publish-start9-registry.sh (it must run after the GitHub
# release + s9pk asset exist).
#
# Requires: the StartOS SDK toolchain (start-sdk), deno, yq, skopeo, and docker
# or podman (+ qemu-user-static for the arm64 image tar on an x86 host).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START9_DIR="$REPO_ROOT/seeder-launcher/start9"
IMAGE="${IMAGE:-ghcr.io/peerloomllc/pearcircle-seeder}"

# --- version ---------------------------------------------------------------
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$( (git -C "$REPO_ROOT" describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$REPO_ROOT/seeder-launcher/package.json').version" 2>/dev/null || echo 0.0.0)"
fi
VERSION="${VERSION#v}"
echo "==> Start9 s9pk for version $VERSION (image $IMAGE)"

# --- toolchain preflight (fail fast; release.sh gates on this too) ----------
_missing=""
for t in start-sdk deno yq skopeo; do command -v "$t" >/dev/null || _missing="$_missing $t"; done
command -v docker >/dev/null || command -v podman >/dev/null || _missing="$_missing docker/podman"
if [ -n "$_missing" ]; then
  echo "build-start9-s9pk: missing required tools:$_missing" >&2
  echo "  Install the StartOS SDK + deno/yq to build the s9pk." >&2
  exit 1
fi

# --- resolve the multi-arch manifest-list digest of IMAGE:VERSION ----------
# The image must already be pushed (by build-umbrel-image.sh). The OCI list
# digest is the sha256 of the raw manifest bytes exactly as the registry serves
# them, which is what `skopeo inspect --raw` prints.
echo "==> resolving $IMAGE:$VERSION digest ..."
if ! RAW="$(skopeo inspect --raw "docker://$IMAGE:$VERSION" 2>/dev/null)"; then
  echo "build-start9-s9pk: cannot inspect $IMAGE:$VERSION — is it pushed?" >&2
  echo "  Run seeder-launcher/scripts/build-umbrel-image.sh $VERSION first." >&2
  exit 1
fi
DIGEST="sha256:$(printf '%s' "$RAW" | sha256sum | cut -d' ' -f1)"
echo "    digest=$DIGEST"
printf '%s' "$RAW" | grep -q '"manifests"' \
  || echo "    WARNING: $IMAGE:$VERSION is not a manifest list — the aarch64 tar build will fail." >&2

# --- pin the version-bearing files -----------------------------------------
echo "==> pinning manifest.yaml / migrations.ts / Dockerfile to $VERSION ..."
yq -i ".version = \"$VERSION\"" "$START9_DIR/manifest.yaml"
sed -i -E "s/fromMapping\(\{\}, \"[0-9.]+\"\)/fromMapping({}, \"$VERSION\")/" \
  "$START9_DIR/scripts/procedures/migrations.ts"
# FROM <image>:<ver>@sha256:<digest>  ->  new ver + digest
sed -i -E "s#^FROM ${IMAGE}:[0-9.]+@sha256:[0-9a-f]+#FROM ${IMAGE}:${VERSION}@${DIGEST}#" \
  "$START9_DIR/Dockerfile"
grep -q "^FROM ${IMAGE}:${VERSION}@${DIGEST}\$" "$START9_DIR/Dockerfile" \
  || { echo "build-start9-s9pk: failed to rewrite Dockerfile FROM" >&2; exit 1; }

# --- build + verify the universal s9pk (make handles both arch tars) --------
echo "==> building s9pk (make) ..."
make -C "$START9_DIR"
S9PK="$START9_DIR/pearcircle-seeder.s9pk"
[ -f "$S9PK" ] || { echo "build-start9-s9pk: make produced no s9pk" >&2; exit 1; }
( cd "$START9_DIR" && sha256sum "pearcircle-seeder.s9pk" > "pearcircle-seeder.s9pk.sha256" )
echo "==> s9pk ready: $S9PK ($(du -h "$S9PK" | cut -f1))"

# --- also emit a v2 s9pk for StartOS 0.4.0+ --------------------------------
# 0.4.0's web UI refuses a v1 package outright: sideload.utils.ts sniffs the
# magic bytes (3b 3b 01 vs 3b 3b 02) and tells the operator the format is
# deprecated. The OS still installs v1 through `start-cli package install
# --sideload`, so v1 is not dead - but "sideload from the browser" is how a
# StartOS user expects to install a package we do not list in a marketplace.
#
# We do NOT hand-author a second package for that. StartOS ships a converter
# (`start-cli s9pk convert`, backed by S9pk::from_v1), which is how Start9
# migrated its own catalogue; a converted package keeps its 0.3.5-era
# procedures and gains " (Legacy)" on its title. So the v1 above stays the
# single source of truth and the v2 is derived from it.
#
# Needs the 0.4.x-era start-cli (the 0.3.5 SDK's `start-cli` cannot do this)
# and a packaging workspace, which holds the build signing key the converted
# package is signed with. Both are machine setup, not repo state - the key must
# never be committed. Create one with `start-cli s9pk init-workspace`.
V2_S9PK="$START9_DIR/pearcircle-seeder-v2.s9pk"
START9_WORKSPACE="${START9_WORKSPACE:-$HOME/.start9-workspace}"

# Resolve a start-cli that can convert. `start-cli --version` prints "StartOS
# CLI 0.3.5.1" for the old SDK and "start-cli 1.1.0" for the new one, so the
# leading token tells them apart without comparing version numbers.
_v2_cli=""
for _cand in "${START_CLI_V2:-}" start-cli-1.1.0 start-cli; do
  [ -n "$_cand" ] || continue
  command -v "$_cand" >/dev/null 2>&1 || continue
  if "$_cand" --version 2>/dev/null | grep -qE '^start-cli [1-9]'; then _v2_cli="$_cand"; break; fi
done

if [ -z "$_v2_cli" ] || [ ! -f "$START9_WORKSPACE/.startos/config.yaml" ]; then
  echo ""
  echo "  !! SKIPPING the v2 s9pk - StartOS 0.4.0 users will not be able to" >&2
  echo "  !! sideload this release from the web UI (CLI still works)." >&2
  # if/fi, not `[ ] && echo`: under `set -e` a false test would exit the script,
  # turning a skipped optional artifact into a failed release build.
  if [ -z "$_v2_cli" ]; then
    echo "  !!   missing: a 0.4.x start-cli (set START_CLI_V2, or install start-cli 1.x)" >&2
  fi
  if [ ! -f "$START9_WORKSPACE/.startos/config.yaml" ]; then
    echo "  !!   missing: a packaging workspace at $START9_WORKSPACE" >&2
  fi
  echo "  !!   fix: start-cli s9pk init-workspace $START9_WORKSPACE" >&2
  echo ""
else
  echo "==> converting to a v2 s9pk for StartOS 0.4.0+ ($_v2_cli) ..."
  # convert rewrites IN PLACE, so it operates on a copy - losing the v1 here
  # would strand every 0.3.5 box.
  cp -f "$S9PK" "$V2_S9PK"
  # Run from inside the workspace: the converter walks up from the CWD looking
  # for .startos, and signs with that workspace's build key.
  if ( cd "$START9_WORKSPACE" && "$_v2_cli" s9pk convert "$V2_S9PK" ); then
    # Trust the bytes, not the exit code: a v2 package starts 3b 3b 02.
    if [ "$(head -c 3 "$V2_S9PK" | od -An -tx1 | tr -d ' \n')" = "3b3b02" ]; then
      ( cd "$START9_DIR" && sha256sum "pearcircle-seeder-v2.s9pk" > "pearcircle-seeder-v2.s9pk.sha256" )
      echo "==> v2 s9pk ready: $V2_S9PK ($(du -h "$V2_S9PK" | cut -f1))"
    else
      rm -f "$V2_S9PK"
      echo "build-start9-s9pk: conversion reported success but the output is not a v2 s9pk" >&2
      exit 1
    fi
  else
    rm -f "$V2_S9PK"
    echo "build-start9-s9pk: v2 conversion failed" >&2
    exit 1
  fi
fi

echo ""
echo "==> Done. Review + commit the pinned start9/ files with the release:"
echo "      $START9_DIR/{manifest.yaml,Dockerfile,scripts/procedures/migrations.ts}"
echo "S9PK=$S9PK"
if [ -f "$V2_S9PK" ]; then echo "S9PK_V2=$V2_S9PK"; fi
