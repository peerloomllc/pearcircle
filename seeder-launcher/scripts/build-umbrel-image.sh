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
#   GHCR_TOKEN  classic PAT with write:packages, used to log in to the registry
#               before pushing (skipped if already logged in). Put it in
#               scripts/.env; release.sh sources + exports that. Without it (and
#               without an existing `podman login`), the push fails fast.
#   GHCR_USER   registry login user (default peerloomllc)
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

# Authenticate to the registry BEFORE the (multi-arch, multi-minute) build so a
# missing credential fails fast instead of 403-ing at the very end. podman's
# login lives in $XDG_RUNTIME_DIR (a tmpfs wiped on reboot/logout), so don't
# assume an earlier manual `podman login` survived. Resolution order:
#   1. already logged in (manual `podman login`, or a prior run) -> reuse it
#   2. GHCR_TOKEN set (a classic PAT with write:packages, from scripts/.env)
#      -> log in as GHCR_USER (default: the org)
#   3. otherwise -> fail fast with guidance
# Only runs when actually pushing (PUSH=1).
GHCR_USER="${GHCR_USER:-peerloomllc}"
ensure_registry_login () {
  local host="${IMAGE%%/*}"   # ghcr.io
  # podman can probe an existing session; docker can't, so on docker we only
  # act when a token is given and otherwise trust an existing login.
  if [ "$ENGINE" = podman ] && podman login --get-login "$host" >/dev/null 2>&1; then
    echo "==> $host: using existing login ($(podman login --get-login "$host" 2>/dev/null))"
    return 0
  fi
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | "$ENGINE" login "$host" -u "$GHCR_USER" --password-stdin >/dev/null \
      && echo "==> $host: logged in as $GHCR_USER (GHCR_TOKEN)"
    return 0
  fi
  if [ "$ENGINE" = docker ]; then
    echo "==> $host: assuming an existing docker login (set GHCR_TOKEN to auto-login)"
    return 0
  fi
  echo "build-umbrel-image: not logged in to $host and GHCR_TOKEN is unset." >&2
  echo "  Add GHCR_TOKEN=<PAT with write:packages> to scripts/.env (it is sourced + exported)," >&2
  echo "  or run once: podman login $host -u $GHCR_USER" >&2
  exit 1
}
[ "$PUSH" = 1 ] && ensure_registry_login

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
    # The PR is cross-fork (our fork's branch -> upstream). gh needs the head
    # qualified as OWNER:branch, or it looks for the branch on the base repo and
    # fails with "No commits between ... / Head sha can't be blank". Derive the
    # fork owner from origin.
    local fork_owner
    fork_owner="$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[:/]([^/]+)/[^/]+$#\1#')"
    fork_owner="${fork_owner:-peerloomllc}"
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
      pr="$(gh pr list --repo "$OFFICIAL_UPSTREAM" --head "${fork_owner}:$branch" --state open \
              --json url -q '.[0].url' 2>/dev/null || true)"
      if [ -n "$pr" ]; then
        echo "    refreshed existing PR: $pr"
      else
        gh pr create --repo "$OFFICIAL_UPSTREAM" --base "$base" --head "${fork_owner}:$branch" \
          --title "pearcircle-seeder: update to ${VERSION}" \
          --body "Bump PearCircle Seeder to ${VERSION} (image pinned to the multi-arch manifest-list digest)." \
          || echo "    WARNING: gh pr create failed — push landed, open the PR manually."
      fi
    else
      echo "    official-store PR NOT opened (set OFFICIAL_STORE_PR=1 to automate). To do it by hand:"
      echo "      cd $dir"
      echo "      git add ${app}/ && git commit -m 'pearcircle-seeder: update to ${VERSION}'"
      echo "      git push -f origin $branch"
      echo "      gh pr create --repo $OFFICIAL_UPSTREAM --base ${base:-master} --head ${fork_owner}:$branch \\"
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
