#!/usr/bin/env bash
# Build + push the multi-arch Umbrel/Docker seeder image, version-stamped, and
# bump the in-repo umbrel manifest (and optionally the separate community app
# store repo) to the new version + manifest-list digest.
#
# Usage:   scripts/build-umbrel-image.sh [version]
#
# Version resolution: arg > release git tag (vX.Y.Z) > seeder-launcher
# package.json. The version is passed as the SEEDER_VERSION build-arg so the
# container reports its real version (dashboard "update available" + the
# seeder:status the launcher exposes) — without it the in-container
# build-host-sea.sh can't read git (.dockerignore excludes .git) and would
# stamp package.json's stale version.
#
# Env:
#   IMAGE       image repo (default ghcr.io/peerloomllc/pearcircle-seeder)
#   PLATFORMS   build platforms (default linux/amd64,linux/arm64)
#   PUSH        1 = build + push (default); 0 = build only
#   STORE_DIR   optional path to a local clone of the community app store repo
#               (peerloom-umbrel-app-store); if set, its app manifest is bumped
#               too (commit + push it yourself to publish).
#
# arm64 on an amd64 host needs qemu-user-static (binfmt) for the runtime apt
# step; the heavy builder stage runs natively (see the Dockerfile).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${IMAGE:-ghcr.io/peerloomllc/pearcircle-seeder}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$( (git describe --tags --abbrev=0 2>/dev/null || true) | sed 's/^v//' )"
fi
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('./seeder-launcher/package.json').version" 2>/dev/null || echo 0.0.0)"
fi
TAG="${IMAGE}:${VERSION}"

# Prefer podman (its --manifest builds a list in one shot); fall back to docker buildx.
if command -v podman >/dev/null 2>&1; then ENGINE=podman
elif command -v docker >/dev/null 2>&1; then ENGINE=docker
else echo "build-umbrel-image: need podman or docker" >&2; exit 1
fi

echo "==> building $TAG  platforms=$PLATFORMS  SEEDER_VERSION=$VERSION  engine=$ENGINE  push=$PUSH"

if [ "$ENGINE" = podman ]; then
  podman manifest rm "$TAG" 2>/dev/null || true
  podman build --platform="$PLATFORMS" --manifest "$TAG" \
    --build-arg SEEDER_VERSION="$VERSION" \
    -f seeder-launcher/umbrel/Dockerfile .
  [ "$PUSH" = 1 ] && podman manifest push --all "$TAG" "docker://$TAG"
else
  docker buildx build --platform "$PLATFORMS" \
    --build-arg SEEDER_VERSION="$VERSION" \
    -f seeder-launcher/umbrel/Dockerfile \
    -t "$TAG" "$([ "$PUSH" = 1 ] && echo --push || echo --load)" .
fi

DIGEST=""
if [ "$PUSH" = 1 ] && command -v skopeo >/dev/null 2>&1; then
  DIGEST="$(skopeo inspect "docker://$TAG" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["Digest"])' 2>/dev/null || true)"
fi
echo "==> ${PUSH:+pushed }$TAG${DIGEST:+  digest=$DIGEST}"

# Bump the in-repo manifest (source of truth). `^version:` won't touch
# `manifestVersion:`. The image is pinned to the manifest-list digest so Umbrel
# pulls the right arch automatically.
bump_manifest () {
  local appyml="$1" composeyml="$2"
  sed -i "s/^version: .*/version: \"$VERSION\"/" "$appyml"
  if [ -n "$DIGEST" ]; then
    sed -i "s#image: ${IMAGE}:.*#image: ${IMAGE}:${VERSION}@${DIGEST}#" "$composeyml"
  else
    sed -i "s#image: ${IMAGE}:.*#image: ${IMAGE}:${VERSION}#" "$composeyml"
  fi
}
bump_manifest seeder-launcher/umbrel/umbrel-app.yml seeder-launcher/umbrel/docker-compose.yml
echo "==> bumped in-repo seeder-launcher/umbrel manifest to $VERSION"

if [ -n "${STORE_DIR:-}" ] && [ -d "${STORE_DIR}/peerloom-pearcircle-seeder" ]; then
  bump_manifest "${STORE_DIR}/peerloom-pearcircle-seeder/umbrel-app.yml" \
                "${STORE_DIR}/peerloom-pearcircle-seeder/docker-compose.yml"
  echo "==> bumped community store at $STORE_DIR — commit + push it to publish"
else
  echo "==> community store NOT bumped (set STORE_DIR to a local clone to auto-bump)."
  echo "    Otherwise set the PeerLoom store's pearcircle-seeder to:"
  echo "      version: \"$VERSION\""
  echo "      image:   ${IMAGE}:${VERSION}${DIGEST:+@$DIGEST}"
fi
