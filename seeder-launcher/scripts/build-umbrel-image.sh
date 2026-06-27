#!/usr/bin/env bash
# Build + push the multi-arch Umbrel/Docker seeder image, version-stamped, and
# bump the seeder umbrel manifests (in-repo + optionally the two app stores) to
# the new version + manifest-list digest. All three manifests pin the SAME image
# tag + digest; umbrelOS keys "update available" off each store's own version:
# field, so a release must touch every store the seeder is listed in.
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
#   OFFICIAL_STORE_DIR  optional path to a local clone of the official-store fork
#               (peerloomllc/umbrel-apps). If set, the official pearcircle-seeder/
#               manifest is bumped on a FRESH per-release branch cut from upstream
#               getumbrel/umbrel-apps's default branch — the initial listing PR is
#               already merged, so every release needs a new update PR.
#   OFFICIAL_STORE_PR   1 = also commit, push the fork branch, and open/refresh the
#               update PR against getumbrel/umbrel-apps via `gh`. Default (unset):
#               bump the files only and print the exact git+gh commands to run
#               (outward-facing PR to a third-party repo stays opt-in).
#   OFFICIAL_UPSTREAM   upstream slug for the official store
#               (default getumbrel/umbrel-apps).
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

# ---------------------------------------------------------------------------
# Official getumbrel/umbrel-apps store (app id "pearcircle-seeder", no community
# prefix). The initial listing PR is merged, so each release needs a FRESH PR
# that bumps version + image-digest. Cut the branch from upstream's default
# branch (not the fork's possibly-stale default) so the diff is only our app.
# Bump is always safe + local; the push + PR is opt-in (OFFICIAL_STORE_PR=1).
# ---------------------------------------------------------------------------
OFFICIAL_UPSTREAM="${OFFICIAL_UPSTREAM:-getumbrel/umbrel-apps}"
bump_official_store () {
  local dir="$1" app="pearcircle-seeder" branch="pearcircle-seeder-v${VERSION}"
  ( # subshell: keep cd + remote tweaks out of the caller
    cd "$dir"
    # Ensure an upstream remote pointing at getumbrel so we branch from its tip.
    if ! git remote get-url upstream >/dev/null 2>&1; then
      git remote add upstream "https://github.com/${OFFICIAL_UPSTREAM}.git"
    fi
    git fetch -q upstream
    local base
    base="$(git remote show upstream 2>/dev/null | sed -n 's/.*HEAD branch: //p')"
    base="${base:-master}"
    # Fresh branch off upstream tip (reset if a same-version branch lingers from a re-run).
    git checkout -q -B "$branch" "upstream/${base}"
    bump_manifest "${app}/umbrel-app.yml" "${app}/docker-compose.yml"
    echo "==> official store: bumped ${app} to $VERSION on branch $branch (base upstream/$base)"

    if [ "${OFFICIAL_STORE_PR:-}" = 1 ]; then
      git add "${app}/umbrel-app.yml" "${app}/docker-compose.yml"
      git commit -q -m "pearcircle-seeder: update to ${VERSION}" || {
        echo "    (nothing to commit — manifest already at $VERSION)"; }
      git push -q -f origin "$branch"
      local pr
      pr="$(gh pr list --repo "$OFFICIAL_UPSTREAM" --head "$branch" --state open \
              --json url -q '.[0].url' 2>/dev/null || true)"
      if [ -n "$pr" ]; then
        echo "    refreshed existing PR: $pr"
      else
        gh pr create --repo "$OFFICIAL_UPSTREAM" --base "$base" --head "$branch" \
          --title "pearcircle-seeder: update to ${VERSION}" \
          --body "Bump PearCircle Seeder to ${VERSION} (image pinned to the multi-arch manifest-list digest)." \
          || echo "    WARNING: gh pr create failed — push landed, open the PR manually."
      fi
    else
      echo "    official-store PR NOT opened (set OFFICIAL_STORE_PR=1 to automate). To do it by hand:"
      echo "      cd $dir"
      echo "      git add ${app}/ && git commit -m 'pearcircle-seeder: update to ${VERSION}'"
      echo "      git push -f origin $branch"
      echo "      gh pr create --repo $OFFICIAL_UPSTREAM --base ${base:-master} --head $branch \\"
      echo "        --title 'pearcircle-seeder: update to ${VERSION}'"
    fi
  )
}
if [ -n "${OFFICIAL_STORE_DIR:-}" ] && [ -d "${OFFICIAL_STORE_DIR}/pearcircle-seeder" ]; then
  bump_official_store "$OFFICIAL_STORE_DIR"
else
  echo "==> official store NOT bumped (set OFFICIAL_STORE_DIR to a local clone of the"
  echo "    peerloomllc/umbrel-apps fork to auto-bump + stage the getumbrel update PR)."
fi
