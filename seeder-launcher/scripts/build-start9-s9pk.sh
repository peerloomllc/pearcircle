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
#   WEBSITE_DIR  optional clone of the website repo. If set, regenerate the
#                /package/v0 registry metadata into it and bump _redirects to the
#                new release tag. Commit + push + merge to main yourself to
#                deploy (Cloudflare deploys on merge to main).
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

# --- optional: regenerate website registry metadata + bump _redirects -------
if [ -n "${WEBSITE_DIR:-}" ]; then
  if [ -d "$WEBSITE_DIR" ]; then
    echo "==> regenerating registry metadata into $WEBSITE_DIR ..."
    OUT_DIR="$WEBSITE_DIR" SKIP_S9PK=1 bash "$START9_DIR/registry/build-registry.sh" "$S9PK"
    if [ -f "$WEBSITE_DIR/_redirects" ]; then
      sed -i -E "s#(releases/download/)v[0-9.]+(/pearcircle-seeder\.s9pk)#\1v${VERSION}\2#" \
        "$WEBSITE_DIR/_redirects"
      echo "    _redirects s9pk target bumped to v$VERSION"
    fi
    echo "    Website registry updated — commit + push + merge to main to deploy."
  else
    echo "    WARNING: WEBSITE_DIR=$WEBSITE_DIR not found — skipping registry regen." >&2
  fi
fi

echo ""
echo "==> Done. Review + commit the pinned start9/ files with the release:"
echo "      $START9_DIR/{manifest.yaml,Dockerfile,scripts/procedures/migrations.ts}"
echo "S9PK=$S9PK"
