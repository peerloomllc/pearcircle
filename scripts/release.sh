#!/usr/bin/env bash
# Local release script (app-specific config in scripts/app.conf)
# Usage: ./scripts/release.sh [vX.Y.Z] [--retag] [--check-versions]
#
# Flags:
#   vX.Y.Z             Override the auto-detected version
#   --retag            Delete and recreate a stranded local tag from a failed run
#   --check-versions   Query GitHub and Zapstore versions and exit (no build)
#   --skip-play        Skip Google Play upload even if credentials are configured
#   --skip-nostr       Skip Nostr announcement even if selected
#   --skip-android     Skip Android APK/AAB build (auto-disables Play + Zapstore;
#                      a GitHub release re-attaches the previous APK)
#   --skip-ios         Skip iOS App Store build
#   --skip-mobile      Skip both Android and iOS builds (shorthand)
#   --skip-desktop     Skip the desktop watcher installers (a GitHub release
#                      then carries the previous ones forward)
#
# Required env vars (or set in scripts/.env):
#   KEYSTORE_PASSWORD            - release keystore password
#   KEY_PASSWORD                 - release key password
#   SIGN_WITH                    - Zapstore NSEC for signing
#
# Optional env vars:
#   KEYSTORE_FILE                - path to keystore (default: ~/keystore.jks)
#   KEY_ALIAS                    - key alias (default: from app.conf)
#   GITHUB_TOKEN                 - GitHub PAT (falls back to gh auth token)
#   GITHUB_REMOTE                - git remote name (default: github, then origin)
#   PLAY_SERVICE_ACCOUNT_JSON    - path to GCP service account JSON for Play upload
#   PLAY_TRACK                   - Play track: internal / alpha / beta / production
#                                  (default: alpha)
#   ASC_KEY_ID                 - App Store Connect API key ID
#   ASC_ISSUER_ID              - App Store Connect API issuer ID
#   ASC_PRIVATE_KEY_PATH       - Path to .p8 private key file
#   ASC_APP_ID                 - Numeric App Store app ID (from `asc apps list`)
#   ASC_APPLE_ID               - (legacy) Apple ID email for altool upload
#   ASC_APP_PASSWORD           - (legacy) App-specific password for altool upload
#   MAC_MINI_HOST              - Mac Mini SSH hostname (default: Tims-Mac-mini.local)
#   PLAY_QUOTA_PROJECT     - GCP project ID for Play API quota when using ADC
#                            (required if PLAY_SERVICE_ACCOUNT_JSON is not set;
#                             run 'gcloud projects list' to find your project ID)

set -euo pipefail

# Abort cleanly on Ctrl-C. Several best-effort build steps run as the
# condition of an `if` (so a failed build never blocks the release), which
# also means a SIGINT during one of them is otherwise swallowed and the
# script marches on past the interrupted build. This trap forces a clean
# abort from anywhere.
trap 'echo; echo "Interrupted (SIGINT) - aborting release."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared release helpers, one copy for every PeerLoom app, in the sibling repo
# peerloomllc/peerloom-release (proposals/2026-09-17-shared-release-library.md).
RELEASE_LIB="$REPO_ROOT/../peerloom-release/release-lib.sh"
if [ ! -f "$RELEASE_LIB" ]; then
  echo "error: $RELEASE_LIB not found - clone peerloomllc/peerloom-release beside this repo" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$RELEASE_LIB"

# Pin JDK 21 for the Android build. RN 0.81's Gradle plugin doesn't support
# JDK 25 (system default on Fedora 44), and Fedora's repos don't ship 21.
# Override by exporting JAVA_HOME before invoking this script.
if [ -z "${JAVA_HOME:-}" ] && [ -x "$HOME/.jdks/jdk-21.0.11+10/bin/java" ]; then
  export JAVA_HOME="$HOME/.jdks/jdk-21.0.11+10"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# Load app config and env
if [ -f "$SCRIPT_DIR/app.conf" ]; then
  set -a; source "$SCRIPT_DIR/app.conf"; set +a
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# Required app.conf keys, checked once, up front.
#
# Each of these used to carry a hard-coded default copied from whichever
# sibling app the script was forked from. That is how PearGuard came to
# announce itself as PearCal on Nostr, PearPetal as PearList, and how
# PearPetal would have named its APK pearlist-*.apk had app.conf ever lost a
# key. Dormant wrong defaults are still wrong defaults: fail here, where it
# costs nothing, instead of mid-release or after the announcement is public.
for _k in APP_NAME ARTIFACT_PREFIX XCODE_PROJECT; do
  if [ -z "${!_k:-}" ]; then
    echo "error: $_k is not set — check $SCRIPT_DIR/app.conf" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Helper: background jobs
#
# Step 7 uploads release assets as parallel background jobs. Any exit (a
# declined confirm, a failed upload, Ctrl-C) kills whatever is still running.
# ---------------------------------------------------------------------------
_BG_DIR=$(mktemp -d)
_BG_PIDS=()

_bg_kill_tree() {
  local _c
  for _c in $(pgrep -P "$1" 2>/dev/null); do _bg_kill_tree "$_c"; done
  kill "$1" 2>/dev/null || true
}

_bg_cleanup() {
  local _p
  for _p in "${_BG_PIDS[@]}"; do
    if kill -0 "$_p" 2>/dev/null; then _bg_kill_tree "$_p"; fi
  done
  rm -rf "$_BG_DIR"
}
trap _bg_cleanup EXIT

# ---------------------------------------------------------------------------
# Helper: carry the desktop watcher installers forward from the latest release
# The website links to releases/latest for the watcher, so a release that
# skips the watcher builds re-attaches the previous ones. Fetches every
# PearCircleWatcher-* and pearcircle-watch_* asset that has a .sha256 sidecar
# into <dest-dir>, checks each hash and prints the paths of the files and
# their sidecars. Files keep their versioned names.
# Usage: _carry_forward_watcher <token> <slug> <dest-dir>
# ---------------------------------------------------------------------------
_carry_forward_watcher() {
  local token="$1" slug="$2" dest="$3"
  local api="${GITHUB_API:-https://api.github.com}"
  [ -z "$slug" ] && return 0
  local pairs
  pairs=$(curl -sL \
    ${token:+-H "Authorization: Bearer $token"} \
    -H "Accept: application/vnd.github+json" \
    "${api}/repos/${slug}/releases/latest" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
names = {a.get('name'): a.get('browser_download_url') for a in d.get('assets', [])}
for n in sorted(names):
    if n and (n.startswith('PearCircleWatcher-') or n.startswith('pearcircle-watch_')) and not n.endswith('.sha256') and names.get(n + '.sha256'):
        print(names[n] + ' ' + names[n + '.sha256'])
" 2>/dev/null) || return 0
  [ -z "$pairs" ] && return 0
  mkdir -p "$dest"
  local url sum name
  while read -r url sum; do
    name=$(basename "$url")
    curl -sfL -o "$dest/$name" "$url" || continue
    curl -sfL -o "$dest/$name.sha256" "$sum" || continue
    ( cd "$dest" && sha256sum -c --status "$name.sha256" ) || continue
    printf '%s\n%s\n' "$dest/$name" "$dest/$name.sha256"
  done <<< "$pairs"
}

# ---------------------------------------------------------------------------
# Helper: does the latest GitHub release carry an APK built for its own version?
# False for a release made with --skip-android, whose APK was carried forward.
# A failed query answers true, which keeps the pre-flight's old behavior.
# Usage: _github_latest_has_own_apk <token> <slug> <X.Y.Z>
# ---------------------------------------------------------------------------
_github_latest_has_own_apk() {
  local token="$1" slug="$2" version="$3"
  local api="${GITHUB_API:-https://api.github.com}"
  local names
  names=$(curl -sL \
    ${token:+-H "Authorization: Bearer $token"} \
    -H "Accept: application/vnd.github+json" \
    "${api}/repos/${slug}/releases/latest" 2>/dev/null \
    | python3 -c "
import sys, json
for a in json.load(sys.stdin).get('assets', []): print(a.get('name', ''))
" 2>/dev/null) || return 0
  [ -z "$names" ] && return 0
  printf '%s\n' "$names" | grep -qxF "${ARTIFACT_PREFIX:-pearcircle}-v${version}.apk"
}

# ---------------------------------------------------------------------------

# Uses $REPO_ROOT so this works regardless of invocation directory.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_PLAY=false
SKIP_NOSTR=false
SKIP_ANDROID=false
SKIP_IOS=false
SKIP_DESKTOP=false

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    --skip-android) SKIP_ANDROID=true ;;
    --skip-ios) SKIP_IOS=true ;;
    --skip-mobile) SKIP_ANDROID=true; SKIP_IOS=true ;;
    --skip-desktop) SKIP_DESKTOP=true ;;
    v[0-9]*.[0-9]*.[0-9]*)
      if [[ ! "$arg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: tag must be in format vX.Y.Z (got: $arg)"
        exit 1
      fi
      RELEASE_TAG="$arg"
      EXPLICIT_TAG="$arg"
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# A real release must run the reviewed, current shared library (release-lib.sh).
if ! $CHECK_VERSIONS_ONLY; then release_lib_require_current; fi

# ---------------------------------------------------------------------------
# Determine release tag — entirely local via git tags
# ---------------------------------------------------------------------------
if [ -z "$RELEASE_TAG" ]; then
  # Exclude any tag that exactly matches a version we might be retrying —
  # find the highest tag that already has at least one commit since it,
  # i.e. the most recent tag that is genuinely a prior release.
  LATEST=$(git tag --sort=-version:refname \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [ -z "$LATEST" ]; then
    RELEASE_TAG="v1.0.0"
    echo "==> No prior tags found, starting at $RELEASE_TAG"
  else
    IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
    RELEASE_TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"
    echo "==> Auto-detected next version: $RELEASE_TAG  (latest tag was $LATEST)"
  fi
fi
APP_VERSION="${RELEASE_TAG#v}"

# ---------------------------------------------------------------------------
# Handle --retag: clean up a stranded local tag from a failed previous run
# ---------------------------------------------------------------------------
if $RETAG; then
  if git tag | grep -q "^${RELEASE_TAG}$"; then
    echo "==> --retag: deleting stranded local tag $RELEASE_TAG..."
    git tag -d "$RELEASE_TAG"
    echo "    Done. Proceeding with fresh run for $RELEASE_TAG."
  else
    echo "==> --retag: local tag $RELEASE_TAG not found, nothing to clean up."
  fi
fi

if ! $CHECK_VERSIONS_ONLY; then
  _confirm "Release tag will be $RELEASE_TAG — proceed with build?"
fi

# ---------------------------------------------------------------------------
# Required credentials (skipped for --check-versions)
# ---------------------------------------------------------------------------
if ! $CHECK_VERSIONS_ONLY; then
  : "${KEYSTORE_PASSWORD:?Set KEYSTORE_PASSWORD or add it to scripts/.env}"
  : "${KEY_PASSWORD:?Set KEY_PASSWORD or add it to scripts/.env}"
  : "${SIGN_WITH:?Set SIGN_WITH (Zapstore NSEC) or add it to scripts/.env}"
  KEYSTORE_FILE="${KEYSTORE_FILE:-$HOME/keystore.jks}"
  KEY_ALIAS="${KEY_ALIAS:-${KEY_ALIAS_DEFAULT:-pearcircle}}"
  if [ ! -f "$KEYSTORE_FILE" ]; then
    echo "Error: keystore not found at $KEYSTORE_FILE"
    exit 1
  fi
fi

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Pre-flight: compare GitHub vs Zapstore versions to decide what needs doing
#
# Outcomes:
#   ZAPSTORE_ONLY=true   GitHub is ahead — skip build, publish existing release
#   ZAPSTORE_ONLY=false  Versions match (or both unknown) — full build + publish
#   exit 1               GitHub is behind Zapstore — something is wrong
# ---------------------------------------------------------------------------
ZAPSTORE_ONLY=false

# Resolve these early so the check can use them
REPO_SLUG=$(_remote_slug)
GH_TOKEN=$(_github_token)

# Read app identifier (Android package name) — used to query Zapstore relay.
# Falls back to the known hardcoded value if build.gradle can't be parsed.
ZSP_IDENTIFIER=$(_android_package_name)
if [ -z "$ZSP_IDENTIFIER" ]; then
  ZSP_IDENTIFIER="${BUNDLE_ID:-com.pearcircle}"
  echo "    App identifier: $ZSP_IDENTIFIER (hardcoded fallback)"
else
  echo "    App identifier: $ZSP_IDENTIFIER"
fi

echo "==> Checking published versions..."
GH_VERSION=$(_github_latest_version "$GH_TOKEN" "$REPO_SLUG")
ZSP_VERSION_CURRENT=$(_zapstore_latest_version "$ZSP_IDENTIFIER")
PLAY_VERSION_CURRENT=$(_play_latest_version "$ZSP_IDENTIFIER" "${PLAY_SERVICE_ACCOUNT_JSON:-}" "${PLAY_TRACK:-production}")
ASC_VERSION_CURRENT=$(_appstore_latest_version "${BUNDLE_ID:-com.pearcircle}")

echo "    GitHub       : ${GH_VERSION:-unknown}"
echo "    Zapstore     : ${ZSP_VERSION_CURRENT:-unknown}"
if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track)"
elif command -v gcloud > /dev/null 2>&1 \
     && gcloud auth application-default print-access-token > /dev/null 2>&1; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track, via gcloud)"
else
  echo "    Google Play  : (not configured)"
fi
if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (via ASC API - includes TestFlight/in-review)"
else
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (live only; iTunes lookup)"
fi

# --check-versions: print diagnostic info and exit without doing anything else
if $CHECK_VERSIONS_ONLY; then
  echo ""
  if [ -n "$ZSP_VERSION_CURRENT" ]; then
    echo "    Zapstore relay query succeeded for identifier: $ZSP_IDENTIFIER"
  else
    echo "    Zapstore relay query returned nothing for identifier: $ZSP_IDENTIFIER"
    echo "    This could mean:"
    echo "      - The app has not been published to Zapstore yet"
    echo "      - The identifier is wrong (check applicationId in build.gradle)"
    echo "      - websocat / websockets is not installed (relay query was skipped)"
    echo "      - The relay is temporarily unreachable"
    echo ""
    echo "    To test the relay manually:"
    echo "      echo '[\"REQ\",\"test\",{\"kinds\":[30063],\"#i\":[\"${ZSP_IDENTIFIER}\"],\"limit\":5}]' \\"
    echo "        | websocat --no-close wss://relay.zapstore.dev"
  fi
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    echo ""
    if [ -n "$PLAY_VERSION_CURRENT" ]; then
      echo "    Google Play query succeeded: $PLAY_VERSION_CURRENT"
    else
      echo "    Google Play query returned nothing — app may not be published yet,"
      echo "    or the service account lacks permissions on the production track."
    fi
  fi
  echo ""
  if [ -n "$ASC_VERSION_CURRENT" ]; then
    if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (via ASC API - includes TestFlight/in-review)"
    else
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (live release only)"
    fi
  else
    echo "    App Store query returned nothing - app may not be publicly released yet."
    if ! command -v asc &>/dev/null || [ -z "${ASC_KEY_ID:-}" ]; then
      echo "    Note: using iTunes lookup (live version only). Install asc + set ASC_KEY_ID"
      echo "    for richer queries that include TestFlight and in-review builds."
    fi
  fi
  exit 0
fi

if [ -n "${EXPLICIT_TAG:-}" ]; then
  GH_HAS_VERSION=false
  ZSP_HAS_VERSION=false
  PLAY_HAS_VERSION=false
  ASC_HAS_VERSION=false
  [ "$GH_VERSION" = "$APP_VERSION" ]           && GH_HAS_VERSION=true
  [ "$ZSP_VERSION_CURRENT" = "$APP_VERSION" ]  && ZSP_HAS_VERSION=true
  [ "$PLAY_VERSION_CURRENT" = "$APP_VERSION" ] && PLAY_HAS_VERSION=true
  [ "$ASC_VERSION_CURRENT"  = "$APP_VERSION" ] && ASC_HAS_VERSION=true

  # Build a human-readable summary of what's already published
  _already=""
  $GH_HAS_VERSION     && _already="${_already}GitHub, "
  $ZSP_HAS_VERSION    && _already="${_already}Zapstore, "
  $PLAY_HAS_VERSION   && _already="${_already}Google Play, "
  $ASC_HAS_VERSION    && _already="${_already}App Store, "
  _already="${_already%, }"   # strip trailing comma+space

  # Check if all configured destinations already have this version
  _all_have=true
  $GH_HAS_VERSION  || _all_have=false
  $ZSP_HAS_VERSION || _all_have=false
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    $PLAY_HAS_VERSION || _all_have=false
  fi
  if [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ]; then
    $ASC_HAS_VERSION || _all_have=false
  fi

  if $_all_have; then
    echo ""
    echo "    $RELEASE_TAG is already published on all configured destinations: $_already"
    echo "    Nothing to do unless you want to republish (e.g. to fix release notes)."
    echo ""
    while true; do
      read -rp "    Proceed to destination selection anyway? [y/n] " _reply
      case "$_reply" in
        [Yy]) break ;;
        [Nn]) echo "Aborted."; exit 0 ;;
        *) echo "    Please enter y or n." ;;
      esac
    done

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION && $ASC_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub and App Store but not on Zapstore — publishing to Zapstore only."
    ZAPSTORE_ONLY=true

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub but not on Zapstore or App Store — proceed to destination selection."

  elif ! $GH_HAS_VERSION; then
    echo ""
    # Deliberately not "running full build": this branch cannot promise that.
    # Destination selection recomputes NEEDS_BUILD afterwards, and the old
    # wording asserted an outcome decided later — which is what made the
    # skipped build silent in the v1.1.0 run. The build is now forced for an
    # unpublished version (see the NEEDS_BUILD block), so the two agree, but
    # the message still only states what is known at this point.
    echo "    $RELEASE_TAG does not exist on GitHub yet — a build will be required."
  fi

else
  # -------------------------------------------------------------------------
  # Auto-detected version — compare latest published versions to decide route.
  # -------------------------------------------------------------------------
  if [ -n "$GH_VERSION" ] && [ -n "$ZSP_VERSION_CURRENT" ]; then
    CMP=$(_ver_cmp "$GH_VERSION" "$ZSP_VERSION_CURRENT")
    case "$CMP" in
      gt)
        echo ""
        echo "==> GitHub ($GH_VERSION) is ahead of Zapstore ($ZSP_VERSION_CURRENT)."
        # A release made with --skip-android is ahead of Zapstore on purpose: its
        # APK was carried forward from an older version, so there is nothing new to
        # publish there. Build the next version instead of the Zapstore shortcut,
        # which would stop at the artifact/version mismatch check.
        if ! _github_latest_has_own_apk "$GH_TOKEN" "$REPO_SLUG" "$GH_VERSION"; then
          echo "    v$GH_VERSION has no APK of its own (made with --skip-android) - proceeding with full build for next version."
        else
          echo "    Skipping build — will publish existing GitHub release to Zapstore only."
          RELEASE_TAG="v${GH_VERSION}"
          APP_VERSION="$GH_VERSION"
          echo "    Using release tag: $RELEASE_TAG"
          ZAPSTORE_ONLY=true
        fi
        ;;
      lt)
        echo ""
        echo "ERROR: Zapstore ($ZSP_VERSION_CURRENT) is ahead of GitHub ($GH_VERSION)."
        echo "       This should not happen. Check both platforms before proceeding."
        echo "       To override, pass the version explicitly: ./scripts/release.sh v${ZSP_VERSION_CURRENT}"
        exit 1
        ;;
      eq)
        echo "    Versions match ($GH_VERSION) — proceeding with full build for next version."
        ;;
    esac

  elif [ -n "$GH_VERSION" ] && [ -z "$ZSP_VERSION_CURRENT" ]; then
    echo ""
    echo "    Zapstore version unknown (app may not be listed yet or API unavailable)."
    echo ""
    if [ "$GH_VERSION" = "$APP_VERSION" ]; then
      echo "    GitHub already has $GH_VERSION — a full build would create a duplicate."
      echo ""
      echo "    Options:"
      echo "      y = publish existing GitHub release ($GH_VERSION) to Zapstore only"
      echo "      n = run full build for next version ($(
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            echo "v${_ma}.${_mi}.$((_pa + 1))"
          ))"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Using existing GitHub release $RELEASE_TAG — Zapstore publish only."
            break ;;
          [Nn])
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            RELEASE_TAG="v${_ma}.${_mi}.$((_pa + 1))"
            APP_VERSION="${RELEASE_TAG#v}"
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    else
      echo "    Cannot determine if Zapstore is up to date."
      echo ""
      echo "    Options:"
      echo "      y = force publish GitHub release $GH_VERSION to Zapstore now"
      echo "      n = proceed with full build for $RELEASE_TAG"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Force-publishing GitHub release $RELEASE_TAG to Zapstore."
            break ;;
          [Nn])
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    fi

  else
    echo "    Could not determine one or both versions — proceeding with normal flow."
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Destination selection — ask which targets to publish to before any build
# work starts. Skipped in ZAPSTORE_ONLY mode (destinations are implied).
# ---------------------------------------------------------------------------
PUBLISH_GITHUB=true
PUBLISH_ZAPSTORE=true
PUBLISH_NOSTR=true
PUBLISH_PLAY=false
PUBLISH_APP_STORE=false
PUBLISH_FAILED=false   # set to true if any selected publish step fails
# Desktop watcher installers: asked for below, built in the background after
# step 4 and attached to the GitHub release only.
BUILD_WATCHER=false
WATCHER_PID=""
WATCHER_ARTIFACTS=()
# Soft state: the binary was uploaded to App Store Connect successfully
# but the review-submission step could not run because the build is
# still processing (5-15 min after upload, opaque from our side). The
# binary IS available, the Nostr / Zapstore / GitHub announcements
# remain valid; only the in-script auto-submission deferred. Surfaces
# as a reminder at the end of the run, not as a publish failure.
APP_STORE_DEFERRED=false
# Default off. The destination-selection block below flips it on when any
# selected target needs an artifact (GitHub / Zapstore / Play / App Store).
# In ZAPSTORE_ONLY mode the selection block is skipped because we're
# publishing an existing GitHub release to Zapstore -- no build needed.
NEEDS_BUILD=false

_play_configured && PUBLISH_PLAY=true

_appstore_configured && PUBLISH_APP_STORE=true

# Force-disable destinations whose source platform was skipped. Play and
# Zapstore both depend on the Android build; the App Store on the iOS build.
if $SKIP_ANDROID; then
  PUBLISH_ZAPSTORE=false
  PUBLISH_PLAY=false
fi
if $SKIP_IOS; then
  PUBLISH_APP_STORE=false
fi

if ! $CHECK_VERSIONS_ONLY; then
  echo "==> Select publish destinations for $RELEASE_TAG:"
  if $ZAPSTORE_ONLY; then
    echo "    (FYI: GitHub release for $RELEASE_TAG already exists -- Zapstore can publish from that without a fresh build.)"
  fi
  echo ""

  # GitHub
  while true; do
    read -rp "    Publish to GitHub Releases? [Y/n] " _r
    case "${_r:-y}" in
      [Yy]) PUBLISH_GITHUB=true;  echo "    ✓ GitHub"; break ;;
      [Nn]) PUBLISH_GITHUB=false; echo "    ✗ GitHub (skipped)"; break ;;
      *) echo "    Please enter y or n." ;;
    esac
  done

  # Desktop watcher installers ship on the GitHub release only.
  if $PUBLISH_GITHUB; then
    if $SKIP_DESKTOP; then
      echo "    - Desktop watcher (skipped via --skip-desktop, previous installers carried forward)"
    else
      while true; do
        read -rp "    Build the desktop watcher (Linux, Windows, macOS)? [Y/n] " _r
        case "${_r:-y}" in
          [Yy]) BUILD_WATCHER=true;  echo "    ✓ Desktop watcher"; break ;;
          [Nn]) BUILD_WATCHER=false; echo "    ✗ Desktop watcher (previous installers carried forward)"; break ;;
          *) echo "    Please enter y or n." ;;
        esac
      done
    fi
  fi

  # Zapstore (skipped automatically when Android build is skipped — Zapstore
  # is an Android-only store)
  if $SKIP_ANDROID; then
    echo "    - Zapstore (skipped via --skip-android)"
  else
    while true; do
      read -rp "    Publish to Zapstore? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_ZAPSTORE=true;  echo "    ✓ Zapstore"; break ;;
        [Nn]) PUBLISH_ZAPSTORE=false; echo "    ✗ Zapstore (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  # Google Play
  if $SKIP_ANDROID; then
    echo "    - Google Play (skipped via --skip-android)"
  elif _play_configured; then
    while true; do
      read -rp "    Publish to Google Play (${PLAY_TRACK:-production} track)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_PLAY=true;  echo "    ✓ Google Play"; break ;;
        [Nn]) PUBLISH_PLAY=false; echo "    ✗ Google Play (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_PLAY=false
    echo "    - Google Play (not configured — run 'gcloud auth application-default login' to enable)"
  fi

  # Apple App Store
  if $SKIP_IOS; then
    echo "    - Apple App Store (skipped via --skip-ios)"
  elif _appstore_configured; then
    while true; do
      read -rp "    Publish to Apple App Store? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_APP_STORE=true;  echo "    ✓ Apple App Store"; break ;;
        [Nn]) PUBLISH_APP_STORE=false; echo "    ✗ Apple App Store (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_APP_STORE=false
    echo "    - Apple App Store (not configured - set ASC_KEY_ID + ASC_ISSUER_ID + ASC_APP_ID, or legacy ASC_APPLE_ID + ASC_APP_PASSWORD; ensure ${MAC_MINI_HOST:-Tims-Mac-mini.local} is reachable)"
  fi

  # Nostr announcement
  if $SKIP_NOSTR; then
    PUBLISH_NOSTR=false
    echo "    - Nostr (skipped via --skip-nostr)"
  else
    while true; do
      read -rp "    Post release announcement to Nostr? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_NOSTR=true;  echo "    ✓ Nostr"; break ;;
        [Nn]) PUBLISH_NOSTR=false; echo "    ✗ Nostr (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  echo ""

  # Bail out if nothing selected
  if ! $PUBLISH_GITHUB && ! $PUBLISH_ZAPSTORE && ! $PUBLISH_NOSTR && ! $PUBLISH_PLAY && ! $PUBLISH_APP_STORE; then
    echo "No destinations selected. Aborted."
    exit 0
  fi

  # Determine if a build is needed. Zapstore alone does NOT trigger a
  # build because the Zapstore publish step can pull the artifact from
  # an existing GitHub release (the ZAPSTORE_ONLY path). GitHub / Play /
  # App Store all need a fresh local artifact, so any of those force a
  # build regardless of ZAPSTORE_ONLY hint.
  if $PUBLISH_GITHUB || $PUBLISH_PLAY || $PUBLISH_APP_STORE; then
    NEEDS_BUILD=true
  fi

  # ...but the Zapstore shortcut is only valid when republishing a version that
  # ALREADY exists on GitHub. A version GitHub has never seen has never been
  # built, so there is no artifact for any destination to publish.
  #
  # Without this, declining GitHub/Play/App Store left NEEDS_BUILD=false and
  # skipped the entire build phase INCLUDING the app.json version bump — after
  # the script had already printed "$RELEASE_TAG does not exist on GitHub yet".
  # Zapstore then fell back to whatever stale APK was on disk and published it:
  # the run that intended v1.1.0 shipped v1.0.25 to the relay (2026-07-24).
  #
  # Compared against $GH_VERSION directly rather than $GH_HAS_VERSION, which is
  # only assigned on the explicit-tag path. An empty $GH_VERSION (the GitHub
  # query failed) also forces a build, which is the safe direction: build
  # needlessly rather than publish something stale.
  if [ "${GH_VERSION:-}" != "$APP_VERSION" ] && ! $NEEDS_BUILD; then
    NEEDS_BUILD=true
    echo ""
    echo "    Note: $RELEASE_TAG is not published on GitHub, so there is no"
    echo "    existing artifact to republish — building it."
  fi

  # Google Play requires an AAB — warn if Play is selected alongside APK targets
  if $PUBLISH_PLAY; then
    echo "    Note: Google Play requires AAB format. Both APK and AAB will be built."
    echo ""
  fi
fi

if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 0. Update app.json version and versionCode
# ---------------------------------------------------------------------------
echo "==> Updating app.json to $APP_VERSION..."
APP_VERSION="$APP_VERSION" node -e "
  const fs = require('fs');
  const f = 'app.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = process.env.APP_VERSION;
  const [major, minor, patch] = v.split('.').map(Number);
  const versionCode = major * 1000000 + minor * 1000 + patch;
  j.expo.version = v;
  if (!j.expo.android) j.expo.android = {};
  j.expo.android.versionCode = versionCode;
  if (!j.expo.ios) j.expo.ios = {};
  const prevBuild = parseInt(j.expo.ios.buildNumber || '1', 10);
  j.expo.ios.buildNumber = String(prevBuild + 1);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('Updated app.json to ' + v + ' (versionCode: ' + versionCode + ', iOS buildNumber: ' + j.expo.ios.buildNumber + ')');
"

# Derive APP_VERSION_CODE from the version string for Gradle
IFS='.' read -r _vmaj _vmin _vpat <<< "$APP_VERSION"
APP_VERSION_CODE=$(( _vmaj * 1000000 + _vmin * 1000 + _vpat ))
export APP_VERSION_CODE

# Sync iOS version into project.pbxproj so xcodebuild picks up the right values
_ios_build_number=$(node -p "require('./app.json').expo.ios.buildNumber")
sed -i \
  "s/CURRENT_PROJECT_VERSION = [0-9][0-9]*/CURRENT_PROJECT_VERSION = ${_ios_build_number}/g; \
   s/MARKETING_VERSION = [0-9][0-9.]*;/MARKETING_VERSION = ${APP_VERSION};/g" \
  "${XCODE_PROJECT:-ios/PearCircle.xcodeproj/project.pbxproj}"

echo "    Version     : $(node -p "require('./app.json').expo.version")"
echo "    versionCode : $(node -p "require('./app.json').expo.android.versionCode")"
echo "    iOS build   : $(node -p "require('./app.json').expo.ios.buildNumber")"
_confirm "app.json version looks correct — proceed with bundle builds?"

# ---------------------------------------------------------------------------
# 1. Canonical verify gate (tests + all bundles)
#
# Constitution §5 gate: the unit tests run first and a red suite aborts the
# release via set -e, then every bundle the release ships is rebuilt.
#
# The bundle commands are inlined rather than delegated to `npm run verify`,
# but package.json's build:bare and build:bare:ios run exactly these commands
# (reconciled 2026-09-17, byte-identical output), so verify checks the bundles
# that ship. build:bare:ios-sim is the Simulator variant (ios preset) and is
# never used here.
# ---------------------------------------------------------------------------
echo "==> Running unit tests..."
npm test

echo "==> Building UI bundle..."
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --loader:.js=jsx --loader:.css=text --loader:.png=dataurl \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle

echo "==> Building Bare bundle..."
node_modules/.bin/bare-pack --linked --defer fs --defer path src/bare.js -o assets/bare-universal.bundle

if $PUBLISH_APP_STORE; then
  echo "==> Building iOS Bare bundle..."
  node_modules/.bin/bare-pack --host ios-arm64 --linked --defer fs --defer path src/bare.js -o assets/bare-ios.bundle
fi

# ---------------------------------------------------------------------------
# 2. Native project preparation
#
# android/ is checked into this repo, so there is nothing to regenerate here.
# The step holds the slot: PearList and PearPetal gitignore android/ and run
# `expo prebuild --clean` at this point to apply the release-signing config
# plugin. Keeping the number reserved is what lets the pipeline checker tell
# "this app has no prebuild" apart from "this app runs prebuild in the wrong
# place". See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
echo "==> Native project: android/ is checked in, no prebuild needed."

# ---------------------------------------------------------------------------
# 3. Build signed release APK (and AAB if publishing to Google Play)
# ---------------------------------------------------------------------------
APK_NAME=""
APK_SIZE=""
AAB_NAME=""
AAB_SIZE=""

# ABIs baked into the standalone APK (GitHub asset + Zapstore upload).
#
# zsp uploads the APK to cdn.zapstore.dev with a hardcoded 5-minute *total*
# HTTP deadline (internal/blossom/client.go, newSecureHTTPClient(5*time.Minute))
# and no flag or env var to raise it. A universal 4-ABI APK is ~392MB, which
# needs >10.5 Mbps sustained upstream to clear that deadline and otherwise dies
# mid-body with "context deadline exceeded". x86/x86_64 are emulator-only and
# account for ~192MB of that; arm64-v8a alone builds to ~128MB.
#
# The AAB is deliberately NOT filtered -- Play splits per device, so carrying
# every ABI there costs users nothing.
APK_ABIS="${APK_ABIS:-arm64-v8a}"

if $SKIP_ANDROID; then
  echo "==> Skipping Android APK/AAB build (--skip-android)."
else
  echo "==> Building signed release APK (ABIs: $APK_ABIS)..."
  (
    export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
    cd android && ./gradlew assembleRelease -q -PreactNativeArchitectures="$APK_ABIS"
  )

  if $PUBLISH_PLAY; then
    echo "==> Building signed release AAB for Google Play..."
    (
      export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
      cd android && ./gradlew bundleRelease -q
    )
  fi

  # ---------------------------------------------------------------------------
  # 4. Copy artifacts with version names
  # ---------------------------------------------------------------------------
  APK_NAME="${ARTIFACT_PREFIX:-pearcircle}-${RELEASE_TAG}.apk"
  cp android/app/build/outputs/apk/release/app-release.apk "$APK_NAME"
  APK_SIZE=$(du -sh "$APK_NAME" | cut -f1)
  echo "==> Built APK: $APK_NAME  ($APK_SIZE)"

  if $PUBLISH_PLAY; then
    AAB_NAME="${ARTIFACT_PREFIX:-pearcircle}-${RELEASE_TAG}.aab"
    cp android/app/build/outputs/bundle/release/app-release.aab "$AAB_NAME"
    AAB_SIZE=$(du -sh "$AAB_NAME" | cut -f1)
    echo "==> Built AAB: $AAB_NAME  ($AAB_SIZE)"
  fi
fi

# ---------------------------------------------------------------------------
# 4d. Start the desktop watcher installers in the background
#
# They start only now because the Windows build fetches a runtime into
# node_modules, which Gradle reads during step 3, and they reuse the UI
# bundle step 1 built. They run one after another (each script stages into
# watch-desktop/dist), alongside the release-notes review, and step 5d
# collects them. A failed platform is logged and skipped, never blocking the
# mobile release. macOS signs and notarizes on the Mac mini.
# ---------------------------------------------------------------------------
WATCHER_LOG=/tmp/pearcircle-build-watcher.log
_watcher_builds() {
  local _v="${RELEASE_TAG#v}" _t
  export WATCH_SKIP_UI_BUILD=1
  for _t in linux-x86_64 linux-arm64 windows macos; do
    echo "=== $_t"
    if case "$_t" in
         linux-x86_64) LINUX_ARCH=x86_64 bash watch-desktop/scripts/build-linux.sh "$_v" ;;
         linux-arm64)  LINUX_ARCH=arm64 bash watch-desktop/scripts/build-linux.sh "$_v" ;;
         windows)      bash watch-desktop/scripts/build-windows.sh "$_v" ;;
         macos)        bash watch-desktop/scripts/build-macos.sh "$_v" ;;
       esac; then
      echo "$_t ok" >> "$_BG_DIR/watcher.status"
    else
      echo "$_t FAILED" >> "$_BG_DIR/watcher.status"
    fi
  done
}
if $BUILD_WATCHER; then
  echo "==> Starting the desktop watcher builds in the background (log: $WATCHER_LOG)..."
  ( cd "$REPO_ROOT" && _watcher_builds ) > "$WATCHER_LOG" 2>&1 < /dev/null &
  WATCHER_PID=$!
  _BG_PIDS+=("$WATCHER_PID")
fi

# ---------------------------------------------------------------------------
# 4e. Generate .sha256 sidecars for the mobile artifacts
# ---------------------------------------------------------------------------
release_write_checksums

fi # end NEEDS_BUILD

# ---------------------------------------------------------------------------
# 5. Generate release notes from git log / merge commits
#
# Strategy (no gh pr list needed):
#   a) Find the commit that the previous vX.Y.Z tag points to.
#   b) Walk git log from that point to HEAD.
#   c) Each merge commit (two parents) is treated as a merged PR.
#      - The merge commit subject becomes the PR title.
#      - Lines after a blank line in the commit body become the summary,
#        honouring the "## Summary" section if present (same as before).
#   d) Non-merge commits are grouped under "Other commits" as a bullet list.
#
# If GITHUB_TOKEN is available we attempt to enrich merge-commit titles with
# the real PR title from the GitHub API, but this is purely cosmetic and the
# script continues without it if the API call fails.
# ---------------------------------------------------------------------------
release_write_notes

# Seeder builds and store publishing were removed on 2026-10-14: PeerLoom
# Seeder (peerloomllc/peerloom-seeder) is now the one seeder for every app.

# ---------------------------------------------------------------------------
# 5d. Collect the desktop watcher installers started in step 4d
# ---------------------------------------------------------------------------
if [ -n "$WATCHER_PID" ]; then
  echo ""
  echo "==> Waiting for the desktop watcher builds..."
  wait "$WATCHER_PID" || true
  sed 's/^/    /' "$_BG_DIR/watcher.status" 2>/dev/null || true
  grep -q FAILED "$_BG_DIR/watcher.status" 2>/dev/null \
    && echo "    WARNING: some watcher builds failed and are left out. Log: $WATCHER_LOG"
  _WV="${RELEASE_TAG#v}"
  _WD="$REPO_ROOT/watch-desktop/dist"
  for _f in "$_WD/PearCircleWatcher-${_WV}-x86_64.AppImage" \
            "$_WD/pearcircle-watch_${_WV}_amd64.deb" \
            "$_WD/PearCircleWatcher-${_WV}-aarch64.AppImage" \
            "$_WD/pearcircle-watch_${_WV}_arm64.deb" \
            "$_WD/PearCircleWatcher-Setup-${_WV}.exe" \
            "$_WD/PearCircleWatcher-${_WV}-arm64.dmg"; do
    [ -f "$_f" ] || continue
    ( cd "$_WD" && sha256sum "$(basename "$_f")" > "$(basename "$_f").sha256" )
    WATCHER_ARTIFACTS+=("$_f")
    echo "    - $(basename "$_f")  ($(du -sh "$_f" | cut -f1))"
  done
  [ ${#WATCHER_ARTIFACTS[@]} -gt 0 ] || echo "    No watcher installers built; the previous ones will be carried forward."
fi

# ---------------------------------------------------------------------------
# 5e. Final gate before publishing
#
# The last look at the full asset list. This is the last confirm before
# anything irreversible: step 6 commits and step 6b pushes the tag. See
# RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
echo ""
_RELEASE_SUMMARY=""
[ -n "${APK_NAME:-}" ] && _RELEASE_SUMMARY="APK (${APK_SIZE:-?})"
if $PUBLISH_PLAY && [ -n "${AAB_NAME:-}" ]; then
  _RELEASE_SUMMARY="${_RELEASE_SUMMARY:+$_RELEASE_SUMMARY, }AAB (${AAB_SIZE:-?})"
fi
if [ ${#WATCHER_ARTIFACTS[@]} -gt 0 ]; then
  _RELEASE_SUMMARY="${_RELEASE_SUMMARY:+$_RELEASE_SUMMARY, }${#WATCHER_ARTIFACTS[@]} desktop watcher installer(s)"
fi
[ -z "$_RELEASE_SUMMARY" ] && _RELEASE_SUMMARY="no artifacts"
_confirm "$_RELEASE_SUMMARY ready to publish?"

# ---------------------------------------------------------------------------
# Phase D — publishing starts here. Nothing below this line is undoable.
# ---------------------------------------------------------------------------
# Precheck: if every build platform was skipped, there's nothing to upload.
# Disable the GitHub step (and thus the tag push) rather than push a tag
# for an empty release.
if $PUBLISH_GITHUB; then
  _have_upload=false
  [ -n "${APK_NAME:-}" ] && [ -f "$APK_NAME" ] && _have_upload=true
  [ ${#WATCHER_ARTIFACTS[@]} -gt 0 ] && _have_upload=true
  if ! $_have_upload; then
    echo ""
    echo "==> No artifacts to upload — skipping GitHub release step."
    echo "    (All build platforms were skipped via --skip-* flags.)"
    PUBLISH_GITHUB=false
  fi
fi

if $PUBLISH_GITHUB; then

# Determine the remote to push to
GIT_REMOTE="${GITHUB_REMOTE:-}"
if [ -z "$GIT_REMOTE" ]; then
  if git remote | grep -q '^github$'; then
    GIT_REMOTE="github"
  else
    GIT_REMOTE="origin"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Commit the version bumps this run made, BEFORE tagging
# ---------------------------------------------------------------------------
# Step 0 rewrites app.json + the Xcode project. Nothing ever committed them,
# so the tag was cut from a tree still carrying the PREVIOUS version: master
# permanently declared the version before the one that shipped, and the tag
# did not contain the version it names.
#
# Committing here (before the tag) makes the tag actually contain its version.
#
# Explicit allowlist, never `git add -A`. A release run leaves plenty of other
# dirt in the tree: the .apk/.aab/.sha256 sidecars at the repo root, generated
# release_notes.md. And should assets/*.bundle ever
# stop being gitignored, `add -A` would bake a build output that can lag its own
# source into the release commit.
_bump_paths=(
  app.json
  "${XCODE_PROJECT:-ios/PearCircle.xcodeproj/project.pbxproj}"
)
_bump_existing=()
for _p in "${_bump_paths[@]}"; do [ -e "$_p" ] && _bump_existing+=("$_p"); done
if [ ${#_bump_existing[@]} -gt 0 ] \
   && [ -n "$(git status --porcelain -- "${_bump_existing[@]}")" ]; then
  echo "==> Committing version bumps for $APP_VERSION..."
  git add -- "${_bump_existing[@]}"
  git commit -q -m "chore(release): $APP_VERSION" \
    && echo "    Committed $(git diff --name-only HEAD~1 HEAD | wc -l) file(s)" \
    || echo "    WARNING: version-bump commit failed - the tag will not contain them." >&2
else
  echo "==> No uncommitted version bumps to record (already committed)."
fi

# ---------------------------------------------------------------------------
# 6b. Push branch and tag
# ---------------------------------------------------------------------------
release_push_and_tag

# ---------------------------------------------------------------------------
# 7. Create GitHub release and upload assets
# ---------------------------------------------------------------------------
echo "==> Creating GitHub release $RELEASE_TAG..."

GH_TOKEN=$(_github_token)   # re-resolve in case env changed

# Assemble the asset list. Each binary is accompanied by its .sha256 sidecar
# so downloaders can verify integrity without a separate checksums file.
RELEASE_ASSETS=()
if [ -n "$APK_NAME" ] && [ -f "$APK_NAME" ]; then
  RELEASE_ASSETS+=("$APK_NAME")
  [ -f "${APK_NAME}.sha256" ] && RELEASE_ASSETS+=("${APK_NAME}.sha256")
fi
if $PUBLISH_PLAY && [ -n "$AAB_NAME" ] && [ -f "$AAB_NAME" ]; then
  RELEASE_ASSETS+=("$AAB_NAME")
  [ -f "${AAB_NAME}.sha256" ] && RELEASE_ASSETS+=("${AAB_NAME}.sha256")
fi
# A release made with --skip-android carries the previous APK forward, so the
# releases/latest page the website links to still has the Android app on it.
if $SKIP_ANDROID; then
  _CARRIED=$(_carry_forward_apk "$GH_TOKEN" "$REPO_SLUG" "$(mktemp -d)")
  if [ -n "$_CARRIED" ]; then
    while IFS= read -r _c; do RELEASE_ASSETS+=("$_c"); done <<< "$_CARRIED"
    echo "==> Carrying forward $(basename "$(printf '%s\n' "$_CARRIED" | head -1)") from the previous release."
  else
    echo "==> WARNING: no APK carried forward - this release will have no Android download."
  fi
fi
for _w in "${WATCHER_ARTIFACTS[@]}"; do
  RELEASE_ASSETS+=("$_w")
  [ -f "${_w}.sha256" ] && RELEASE_ASSETS+=("${_w}.sha256")
done
# Without watcher installers of its own, the release carries the previous ones
# forward, so the website's releases/latest link keeps a desktop download.
if [ ${#WATCHER_ARTIFACTS[@]} -eq 0 ]; then
  _CARRIED=$(_carry_forward_watcher "$GH_TOKEN" "$REPO_SLUG" "$(mktemp -d)")
  if [ -n "$_CARRIED" ]; then
    while IFS= read -r _c; do RELEASE_ASSETS+=("$_c"); done <<< "$_CARRIED"
    echo "==> Carrying forward $(( $(printf '%s\n' "$_CARRIED" | wc -l) / 2 )) desktop watcher installer(s) from the previous release."
  else
    echo "==> No desktop watcher installers to carry forward."
  fi
fi
echo ""
echo "    Repo   : ${REPO_SLUG:-unknown}"
echo "    Tag    : $RELEASE_TAG"
echo "    Assets :"
for _a in "${RELEASE_ASSETS[@]}"; do
  echo "             - $_a ($(du -sh "$_a" | cut -f1))"
done
_confirm "Create public GitHub release $RELEASE_TAG and upload ${#RELEASE_ASSETS[@]} assets?"

if [ -n "$GH_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  # --- Create the release via REST API ---
  echo "    Calling GitHub API for repo: $REPO_SLUG"
  RELEASE_RESP=$(curl -s \
    -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${REPO_SLUG}/releases" \
    -d "$(python3 -c "
import sys, json
body = open('release_notes.md').read()
print(json.dumps({'tag_name': '${RELEASE_TAG}', 'name': '${RELEASE_TAG}', 'body': body, 'draft': False, 'prerelease': False}))
")")

  # Check for API-level errors before proceeding. The most common one is
  # the release already existing for this tag (user re-running with the
  # same RELEASE_TAG, or ZAPSTORE_ONLY mode where the release is the
  # whole reason we're here). Detect that case specifically and treat
  # it as success: fetch the existing release's upload_url so the asset
  # loop below can attach / replace assets idempotently.
  API_ERROR=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
    2>/dev/null || echo "")
  ALREADY_EXISTS=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for e in d.get('errors', []) or []:
    if e.get('code') == 'already_exists' and e.get('field') == 'tag_name':
        print('1'); break
" 2>/dev/null || echo "")

  if [ "$ALREADY_EXISTS" = "1" ]; then
    echo "    GitHub release $RELEASE_TAG already exists -- fetching it to update assets."
    EXISTING_RESP=$(curl -s \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}")
    EXISTING_ERROR=$(printf '%s' "$EXISTING_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
    if [ -n "$EXISTING_ERROR" ]; then
      echo ""
      echo "ERROR: could not fetch existing release: $EXISTING_ERROR"
      exit 1
    fi
    RELEASE_RESP="$EXISTING_RESP"
    API_ERROR=""
  fi

  if [ -n "$API_ERROR" ]; then
    echo ""
    echo "ERROR: GitHub API returned an error:"
    printf '%s\n' "$RELEASE_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RELEASE_RESP"
    echo ""
    echo "The tag has been pushed. Once your GitHub account is restored you can"
    echo "create the release manually, or re-run this script with:"
    echo "  ./scripts/release.sh $RELEASE_TAG"
    exit 1
  fi

  UPLOAD_URL=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['upload_url'].split('{')[0])")

  # Several at a time with one progress line (shared library).
  if ! release_upload_assets "$UPLOAD_URL" "${RELEASE_ASSETS[@]}"; then
    echo ""
    echo "ERROR: The GitHub release was created but ${#RELEASE_UPLOAD_FAILED[@]} file(s) were not attached."
    echo "You can upload them manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
    exit 1
  fi

else
  # Fallback: gh CLI (requires working auth). gh accepts multiple positional
  # asset paths and infers content type from extension.
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  gh release create "$RELEASE_TAG" "${RELEASE_ASSETS[@]}" \
    --title "$RELEASE_TAG" \
    --notes-file release_notes.md
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

# ---------------------------------------------------------------------------
# 8. Install zsp if needed
# ---------------------------------------------------------------------------
release_install_zsp

# ---------------------------------------------------------------------------
# 9. Publish to Zapstore
# ---------------------------------------------------------------------------
release_publish_zapstore

# ---------------------------------------------------------------------------
# 10. Upload to Google Play Store
#
# Uses the Google Play Developer API (Publishing API v3) directly via curl.
# Uploads AAB format (required for new Play apps since Aug 2021).
# Requires PLAY_SERVICE_ACCOUNT_JSON (path to GCP service account JSON).
#
# Flow: obtain OAuth2 token → create edit → upload AAB → assign to track
#       with release notes → commit edit.
# ---------------------------------------------------------------------------
release_upload_play

# ---------------------------------------------------------------------------
# 11. Build, upload, and submit iOS App Store build
#
# Phase 1 (Mac Mini via SSH): Sync repo, archive with xcodebuild, export IPA,
#   upload to App Store Connect (asc CLI preferred, altool fallback).
# Phase 2 (Linux, asc only): Apply metadata, submit for App Review, check status.
#
# Auth: API key (ASC_KEY_ID/ASC_ISSUER_ID/ASC_APP_ID) preferred;
#   falls back to legacy ASC_APPLE_ID/ASC_APP_PASSWORD for altool.
# ---------------------------------------------------------------------------
if ! $PUBLISH_APP_STORE; then
  echo ""
  echo "==> Skipping Apple App Store upload (not selected)."
else
  echo ""
  echo "==> Building and uploading to Apple App Store..."

  MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
  MAC_MINI_REPO_PATH="${MAC_MINI_REPO_PATH:-peerloomllc/pearcircle}"

  # ── Step 1: Sync repo to Mac Mini ──
  release_check_mac_space "$MAC_MINI"
  echo "    Syncing repo to $MAC_MINI (including freshly built bundles)..."
  rsync -az --rsync-path=/opt/homebrew/bin/rsync \
    --exclude='.git' --exclude='node_modules' --exclude='android' \
    --exclude='/watch-desktop/dist' --exclude='/seeder-launcher/dist' \
    --exclude='/*.apk' --exclude='/*.aab' --exclude='/*.AppImage' --exclude='/*.deb' --exclude='/*.exe' \
    --exclude='/*.dmg' --exclude='/*.ipa' --exclude='/*.sha256' --exclude='/*.blockmap' --exclude='/latest*.yml' \
    "$REPO_ROOT/" "${MAC_MINI}:${MAC_MINI_REPO_PATH}/"
  echo "    Sync complete."
  echo ""

  # ── Step 1b: pod install on Mac Mini ──
  # Keep Pods/Manifest.lock in sync with Podfile.lock before xcodebuild
  # archive. Without this, xcodebuild's "[CP] Check Pods Manifest.lock"
  # phase fails with "The sandbox is not in sync with the Podfile.lock"
  # whenever the Podfile changed since the last archive on the Mac.
  # UTF-8 locale is required: CocoaPods' UnicodeNormalize crashes
  # under SSH's default C locale. Mirrors scripts/ios-dev-install.sh.
  echo "    Running pod install on $MAC_MINI..."
  ssh "$MAC_MINI" "bash -lc 'cd ${MAC_MINI_REPO_PATH}/ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install'" \
    | sed -e '/^Analyzing dependencies/d' -e '/^Downloading dependencies/d' -e '/^Generating Pods project/d' -e '/^Integrating client project/d' -e '/^Sending stats/d' -e '/^Pod installation complete/d'
  echo ""

  # ── Determine auth mode ──
  USE_ASC_REMOTE=false
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
    USE_ASC_REMOTE=true
    echo "    Auth mode : API key (asc CLI)"
    echo "    Key ID    : ${ASC_KEY_ID}"
    echo "    App ID    : ${ASC_APP_ID}"
  else
    echo "    Auth mode : app-specific password (altool, legacy)"
    echo "    Apple ID  : ${ASC_APPLE_ID:-not set}"
  fi
  echo "    Host      : $MAC_MINI"
  echo "    Team ID   : ${ASC_TEAM_ID:-G79ALD29NA}"
  _confirm "Archive, export, and upload to App Store Connect on $MAC_MINI?"

  # ── Step 2: SSH to Mac Mini - archive, export, upload ──
  if $USE_ASC_REMOTE; then
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_KEY_ID='${ASC_KEY_ID}'
      export ASC_ISSUER_ID='${ASC_ISSUER_ID}'
      export ASC_APP_ID='${ASC_APP_ID}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    "
  else
    # Legacy altool path
    _asc_id="${ASC_APPLE_ID//\'/\'\\\'\'}"
    _asc_pw="${ASC_APP_PASSWORD//\'/\'\\\'\'}"
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_APPLE_ID='${_asc_id}'
      export ASC_APP_PASSWORD='${_asc_pw}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    "
  fi

  echo ""
  echo "==> Upload complete. Build is processing on App Store Connect."

  # ── Step 3: Apply metadata (Linux-side, asc only) ──
  METADATA_DIR="$REPO_ROOT/metadata/ios"
  if $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ] && command -v asc &>/dev/null; then
    echo ""
    echo "==> Applying App Store metadata from metadata/ios/..."

    VERSION_DIR="$METADATA_DIR/version/${APP_VERSION}"
    DEFAULT_DIR="$METADATA_DIR/version/default"

    # Ensure the App Store version record exists (required for pull/apply).
    # A freshly uploaded build does NOT auto-create the version record.
    if _asc_auth_linux; then
      VERSION_EXISTS=$(asc versions list --app "$ASC_APP_ID" --version "$APP_VERSION" --output json 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data', d if isinstance(d,list) else [])))" 2>/dev/null || echo 0)
      if [ "${VERSION_EXISTS:-0}" = "0" ]; then
        echo "    App Store version ${APP_VERSION} does not exist yet — creating..."
        PRIOR_VERSION=$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
          | python3 -c "
import json, sys
from functools import cmp_to_key
d = json.load(sys.stdin)
items = d.get('data', d if isinstance(d, list) else [])
def ver(x):
    v = x.get('attributes', {}).get('versionString') or x.get('versionString', '')
    try: return tuple(int(p) for p in v.split('.'))
    except: return (0,)
target = tuple(int(p) for p in '${APP_VERSION}'.split('.') if p.isdigit())
priors = [x for x in items if ver(x) < target]
priors.sort(key=ver, reverse=True)
if priors:
    print(priors[0].get('attributes', {}).get('versionString') or priors[0].get('versionString', ''))
" 2>/dev/null)
        if [ -n "$PRIOR_VERSION" ]; then
          echo "    Copying metadata from prior version ${PRIOR_VERSION}..."
          if asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" --copy-metadata-from "$PRIOR_VERSION"; then
            echo "    Created version ${APP_VERSION}."
          else
            echo "    WARNING: versions create failed — metadata apply will likely fail."
          fi
        else
          echo "    No prior version found — creating ${APP_VERSION} without metadata copy."
          asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" || \
            echo "    WARNING: versions create failed."
        fi
      fi
    fi

    # Bootstrap: if no canonical .json files exist anywhere, pull current state
    # from App Store Connect to seed metadata/ios/version/default/.
    if ! find "$METADATA_DIR" -name '*.json' -type f 2>/dev/null | grep -q .; then
      echo "    No canonical metadata found — bootstrapping from App Store Connect..."
      if _asc_auth_linux && asc metadata pull --app "$ASC_APP_ID" --version "$APP_VERSION" --dir "$METADATA_DIR"; then
        PULLED_DIR="$METADATA_DIR/version/${APP_VERSION}"
        if [ -d "$PULLED_DIR" ] && [ ! -d "$DEFAULT_DIR" ]; then
          mkdir -p "$DEFAULT_DIR"
          cp "$PULLED_DIR"/*.json "$DEFAULT_DIR/" 2>/dev/null || true
          echo "    Seeded $DEFAULT_DIR from pulled metadata."
        fi
        # Remove the pulled versioned dir so the whatsNew-injection step below
        # regenerates it from default/.
        rm -rf "$PULLED_DIR"
      else
        echo "    WARNING: metadata bootstrap pull failed — skipping metadata apply."
        DEFAULT_DIR=""
      fi
    fi

    # Create versioned metadata with whatsNew from release notes
    if [ -n "$DEFAULT_DIR" ] && [ -d "$DEFAULT_DIR" ] && [ ! -d "$VERSION_DIR" ]; then
      mkdir -p "$VERSION_DIR"
      for f in "$DEFAULT_DIR"/*.json; do
        WHATS_NEW=""
        if [ -f "$REPO_ROOT/release_notes.md" ]; then
          WHATS_NEW=$(cat "$REPO_ROOT/release_notes.md")
        fi
        python3 -c "
import json, sys, re
with open('$f') as fh:
    data = json.load(fh)
# Strip emojis — App Store rejects non-ASCII symbols in whatsNew
notes = sys.stdin.read().strip()
data['whatsNew'] = re.sub(r'[^\x00-\x7F\u00C0-\u024F\u2014\u2019\u2018\u201C\u201D]+\s*', '', notes)
with open('${VERSION_DIR}/$(basename "$f")', 'w') as out:
    json.dump(data, out)
" <<< "$WHATS_NEW"
        echo "    Created ${VERSION_DIR}/$(basename "$f")"
      done
    fi

    if _asc_auth_linux; then
      echo "    Dry run:"
      asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
        --dir "$METADATA_DIR" --dry-run || true
      echo ""
      _confirm "Apply this metadata to version ${APP_VERSION}?"
      if asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
           --dir "$METADATA_DIR"; then
        echo "    Metadata applied."
      else
        echo "    WARNING: Metadata apply failed (non-fatal)."
      fi
    fi
  elif $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ]; then
    echo "    Metadata directory found but asc not available on Linux - skipping."
  fi

  # ── Step 4: Submit for App Review (Linux-side, asc only) ──
  # asc 1.1.1's `publish appstore --submit` requires --ipa even when the
  # build is already uploaded (used to allow attach-by-version). Use the
  # lower-level commands instead: look up the build by version, attach it
  # to the version record, create a review submission, add the version
  # as a submission item, then submit.
  if $USE_ASC_REMOTE && command -v asc &>/dev/null; then
    echo ""
    echo "==> Submit for App Store review"
    echo "    Note: builds typically take 5-15 minutes to process after upload."
    echo "    If the build is still processing, submission will fail - retry later."
    _confirm "Submit version ${APP_VERSION} for App Store review?"

    if _asc_auth_linux; then
      echo "    Looking up version + build IDs..."
      # Apple normalizes trailing .0 in App Store versions (1.0.0 -> 1.0).
      # Try the exact string first, then the normalized form, then fall
      # back to "any version in PREPARE_FOR_SUBMISSION" so a manually
      # created version record still matches when versionString differs.
      _versions_lookup() {
        asc versions list --app "$ASC_APP_ID" --version "$1" --output json 2>/dev/null \
          | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    items = d.get('data', d) if isinstance(d, dict) else d
    print(items[0]['id'] if items else '')
except Exception:
    print('')" 2>/dev/null
      }
      VERSION_ID=$(_versions_lookup "$APP_VERSION")
      if [ -z "$VERSION_ID" ]; then
        # 1.0.0 -> 1.0 normalization
        _normalized=$(echo "$APP_VERSION" | sed 's/\.0$//')
        if [ "$_normalized" != "$APP_VERSION" ]; then
          echo "    Exact match for $APP_VERSION not found, trying $_normalized..."
          VERSION_ID=$(_versions_lookup "$_normalized")
        fi
      fi

      # Wait for Apple to finish processing the upload: attaching or submitting
      # before then fails and leaves an empty review submission behind. Matches
      # the build number too, since build numbers repeat across versions.
      _BUILD_INFO=$(_asc_wait_for_build "$APP_VERSION" "${_ios_build_number:-}")
      BUILD_ID="${_BUILD_INFO%% *}"
      if [ -n "$BUILD_ID" ] && [ "${_BUILD_INFO##* }" != "VALID" ]; then
        echo "    Build is ${_BUILD_INFO##* } on App Store Connect, not VALID."
        BUILD_ID=""
      fi

      if [ -z "$VERSION_ID" ] || [ -z "$BUILD_ID" ]; then
        echo "    NOTE: could not find version-id ($VERSION_ID) or build-id ($BUILD_ID)."
        echo "    Likely the build hasn't finished processing yet. Wait 5-15 min then retry."
        echo "    Manual flow once processing completes:"
        echo "      asc versions attach-build --version-id <VID> --build <BID>"
        echo "      asc review submissions-create --app $ASC_APP_ID --platform IOS"
        echo "      asc review items-add --submission <SID> --item-type appStoreVersions --item-id <VID>"
        echo "      asc review submissions-submit --id <SID> --confirm"
        # Deferred, not failed: the binary uploaded fine; the
        # review-submission step is just waiting on Apple's
        # processing pipeline. Downstream announcements remain valid.
        APP_STORE_DEFERRED=true
      else
        echo "    Version : $VERSION_ID"
        echo "    Build   : $BUILD_ID"

        # Step 4a: attach build to version (already-attached counts as success).
        _ATTACHED=true
        _asc_attach_build "$VERSION_ID" "$BUILD_ID" || { _ATTACHED=false; PUBLISH_FAILED=true; APP_STORE_FAILED=true; }

        if $_ATTACHED; then
          release_submit_for_review "$VERSION_ID" || true
        else
          echo "    Skipping submission (see the attach error above)."
        fi
      fi
    else
      echo "    WARNING: asc auth failed on Linux. Submit manually via App Store Connect."
    fi
  else
    echo "    Build will appear in TestFlight within a few minutes."
    echo "    Submit for review manually via App Store Connect."
  fi
fi # end PUBLISH_APP_STORE

# ---------------------------------------------------------------------------
# 12. Post release announcement to Nostr
#
# Signs a kind:1 note with the Zapstore NSEC (SIGN_WITH) and broadcasts it
# to a set of well-known relays. Downloads nak if not already installed.
# ---------------------------------------------------------------------------
release_post_nostr

# ---------------------------------------------------------------------------
# 13. Close-out summary and deferred-action reminders
#
# Every publish step is best-effort past the tag push: a Zapstore outage sets
# PUBLISH_FAILED rather than aborting, so an already-created GitHub release is
# never stranded. That makes a final ledger worth printing, because a partial
# release otherwise scrolls past unnoticed. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
release_summary
release_summary_end

# ---------------------------------------------------------------------------
# 13b. Deferred-action reminders
#
# Surfaces anything the script couldn't auto-complete but isn't actually a
# failure. Today that's the App Store review submission when Apple is still
# processing the uploaded binary (5-15 min). Re-run the manual asc commands
# once processing finishes.
# ---------------------------------------------------------------------------
release_deferred_reminders
