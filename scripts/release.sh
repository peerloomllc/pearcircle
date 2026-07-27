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
#   --skip-desktop     Skip building all desktop seeder-launcher installers
#   --skip-linux       Skip Linux desktop builds (.deb + .AppImage)
#   --skip-windows     Skip Windows desktop build (.exe)
#   --skip-macos       Skip macOS desktop build (.pkg)
#   --skip-umbrel      Skip building + pushing the multi-arch Umbrel/Docker image
#   --skip-start9      Skip building the StartOS (Start9) .s9pk (auto-skips if the
#                      StartOS SDK toolchain is absent)
#   --skip-android     Skip Android APK/AAB build (auto-disables Play + Zapstore)
#   --skip-ios         Skip iOS App Store build
#   --skip-mobile      Skip both Android and iOS builds (shorthand)
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
# Helper: derive "owner/repo" from the git remote URL without gh CLI
# ---------------------------------------------------------------------------
_remote_slug() {
  local remote_url
  remote_url=$(git remote get-url "${GITHUB_REMOTE:-}" 2>/dev/null \
    || git remote get-url github 2>/dev/null \
    || git remote get-url origin 2>/dev/null \
    || echo "")
  if [ -z "$remote_url" ]; then
    echo ""
    return
  fi
  # Handle both SSH (git@github.com:owner/repo.git) and HTTPS forms
  local slug
  slug=$(printf '%s' "$remote_url" \
    | sed -E 's|.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$|\1|' \
    | sed 's/\.git$//')
  printf '%s' "$slug"
}

# ---------------------------------------------------------------------------
# Helper: resolve GITHUB_TOKEN without requiring `gh auth token` to work
# ---------------------------------------------------------------------------
_github_token() {
  # 1. Already set in environment / .env
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_TOKEN"
    return
  fi
  # 2. Try gh CLI (may fail when account is limited — that's fine)
  local tok
  tok=$(gh auth token 2>/dev/null || echo "")
  if [ -n "$tok" ]; then
    printf '%s' "$tok"
    return
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Helper: confirmation prompt — loops until y or n is entered
# Usage: _confirm "Question to ask"
# ---------------------------------------------------------------------------
_confirm() {
  local prompt="${1:-Continue?}"
  local _reply
  while true; do
    echo ""
    read -rp "    ${prompt} [y/N] " _reply
    echo ""
    case "$_reply" in
      [Yy]) return 0 ;;
      [Nn]|"")
        echo "Aborted."
        exit 0
        ;;
      *)
        echo "    Please enter y or n."
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version from GitHub releases (returns bare X.Y.Z or "")
# ---------------------------------------------------------------------------
_github_latest_version() {
  local token="$1" slug="$2"
  [ -z "$token" ] || [ -z "$slug" ] && echo "" && return
  curl -s \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${slug}/releases/latest" \
    2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name','').lstrip('v'))" \
    2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version published on Zapstore for this app.
# Queries the Nostr relay at wss://relay.zapstore.dev for kind 30063 events
# whose "i" tag matches the app's Android package name (identifier).
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_zapstore_latest_version() {
  local identifier="${1:-}"
  [ -z "$identifier" ] && echo "" && return

  # Build a NIP-01 REQ filter for kind 30063 events tagged with this app id
  local filter
  filter=$(python3 -c "
import json
req = ['REQ', 'sub1', {'kinds': [30063], '#i': ['${identifier}'], 'limit': 5}]
print(json.dumps(req))
")

  local version=""

  # --- Try websocat first (fastest) ---
  if command -v websocat &>/dev/null; then
    version=$(printf '%s\n' "$filter" \
      | timeout 10 websocat --no-close wss://relay.zapstore.dev 2>/dev/null \
      | python3 -c "
import sys, json
best = ()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        if isinstance(msg, list) and msg[0] == 'EOSE':
            break
        if isinstance(msg, list) and msg[0] == 'EVENT':
            ev = msg[2]
            tags = {t[0]: t[1] for t in ev.get('tags',[]) if len(t)>=2}
            ver = tags.get('version','')
            if ver:
                parts = tuple(int(x) for x in ver.lstrip('v').split('.') if x.isdigit())
                if parts > best:
                    best = parts
    except:
        pass
if best: print('.'.join(str(x) for x in best))
" 2>/dev/null || echo "")

  # --- Fallback: python3 websockets ---
  elif python3 -c "import websockets" 2>/dev/null; then
    version=$(python3 - "$identifier" <<'PYEOF' 2>/dev/null
import asyncio, json, sys
import websockets

async def query(identifier):
    uri = "wss://relay.zapstore.dev"
    req = json.dumps(["REQ", "sub1", {"kinds": [30063], "#i": [identifier], "limit": 5}])
    best = ()
    try:
        async with websockets.connect(uri, open_timeout=6, close_timeout=2) as ws:
            await ws.send(req)
            for _ in range(10):
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                    if isinstance(msg, list) and msg[0] == "EOSE":
                        break
                    if isinstance(msg, list) and msg[0] == "EVENT":
                        tags = {t[0]: t[1] for t in msg[2].get("tags", []) if len(t) >= 2}
                        ver = tags.get("version", "")
                        if ver:
                            parts = tuple(int(x) for x in ver.lstrip("v").split(".") if x.isdigit())
                            if parts > best:
                                best = parts
                except asyncio.TimeoutError:
                    break
    except Exception:
        pass
    if best:
        print(".".join(str(x) for x in best))

asyncio.run(query(sys.argv[1]))
PYEOF
    )
  else
    # No WebSocket tool available — emit a diagnostic on stderr, return empty
    echo "    (Note: install 'websocat' or 'pip install websockets' to enable Zapstore version lookup)" >&2
    echo ""
    return
  fi

  printf '%s' "${version:-}"
}

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Helper: obtain a Google Play API OAuth2 token.
# Tries gcloud application-default credentials first (no key file needed),
# then falls back to service account JSON if PLAY_SERVICE_ACCOUNT_JSON is set.
# Returns the token string or "" on failure.
# ---------------------------------------------------------------------------
_play_token() {
  local sa_json="${1:-}"

  # --- Path 1: service account JSON (preferred — no quota project needed) ---
  if [ -n "$sa_json" ] && [ -f "$sa_json" ]; then
    python3 - "$sa_json" <<'PYEOF' 2>/dev/null || echo ""
import sys, json, time, base64
from urllib.request import urlopen, Request
from urllib.parse import urlencode

svc = json.load(open(sys.argv[1]))
now = int(time.time())
header  = base64.urlsafe_b64encode(json.dumps({"alg":"RS256","typ":"JWT"}).encode()).rstrip(b'=')
payload = base64.urlsafe_b64encode(json.dumps({
    "iss": svc["client_email"],
    "scope": "https://www.googleapis.com/auth/androidpublisher",
    "aud": "https://oauth2.googleapis.com/token",
    "iat": now, "exp": now + 3600
}).encode()).rstrip(b'=')

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key(svc["private_key"].encode(), password=None)
    sig_input = header + b'.' + payload
    sig = base64.urlsafe_b64encode(key.sign(sig_input, padding.PKCS1v15(), hashes.SHA256())).rstrip(b'=')
    jwt = (sig_input + b'.' + sig).decode()
except ImportError:
    import subprocess, tempfile, os
    sig_input = (header + b'.' + payload).decode()
    with tempfile.NamedTemporaryFile(suffix='.pem', delete=False) as f:
        f.write(svc["private_key"].encode()); kp = f.name
    try:
        sig_bytes = subprocess.check_output(['openssl','dgst','-sha256','-sign',kp], input=sig_input.encode())
        sig = base64.urlsafe_b64encode(sig_bytes).rstrip(b'=').decode()
        jwt = sig_input + '.' + sig
    finally:
        os.unlink(kp)

data = urlencode({"grant_type":"urn:ietf:params:oauth:grant-type:jwt-bearer","assertion":jwt}).encode()
resp = json.loads(urlopen(Request("https://oauth2.googleapis.com/token", data=data)).read())
print(resp.get("access_token",""))
PYEOF
    return
  fi

  # --- Path 2: gcloud application-default credentials ---
  # The androidpublisher API requires x-goog-user-project on every request when
  # using ADC user credentials. Resolve project from PLAY_QUOTA_PROJECT or gcloud.
  if command -v gcloud > /dev/null 2>&1; then
    local proj
    proj="${PLAY_QUOTA_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo "")}"
    if [ -z "$proj" ]; then
      echo "ERROR: Cannot determine GCP quota project for Android Publisher API." >&2
      echo "  Set PLAY_QUOTA_PROJECT=<your-gcp-project-id> in scripts/.env" >&2
      echo "  or use PLAY_SERVICE_ACCOUNT_JSON instead of ADC." >&2
      echo ""
      return
    fi
    local tok
    tok=$(gcloud auth application-default print-access-token 2>/dev/null || echo "")
    if [ -n "$tok" ]; then
      printf '%s' "$tok"
      return
    fi
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch latest version published on Google Play for this app.
# Queries the configured PLAY_TRACK (default: production).
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_play_latest_version() {
  local package="${1:-}" sa_json="${2:-}" track="${3:-production}"
  [ -z "$package" ] && echo "" && return

  local token
  token=$(_play_token "$sa_json")
  [ -z "$token" ] && echo "" && return

  python3 - "$package" "$track" "$token" <<'PYEOF' 2>/dev/null || echo ""
import sys, json
from urllib.request import urlopen, Request

package = sys.argv[1]
track   = sys.argv[2]
token   = sys.argv[3]

url = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/tracks/{track}"
req = Request(url, headers={"Authorization": f"Bearer {token}"})
try:
    track_data = json.loads(urlopen(req).read())
    releases = track_data.get("releases", [])
    for status in ("completed", "inProgress", "halted", "draft"):
        for r in releases:
            if r.get("status") == status:
                print(r.get("name", ""))
                sys.exit(0)
except Exception:
    pass
PYEOF
}


# ---------------------------------------------------------------------------
# Helper: fetch the current live version from the Apple App Store.
# Uses the public iTunes Search API — no credentials required.
# Returns bare X.Y.Z or "".
# ---------------------------------------------------------------------------
_appstore_latest_version() {
  local bundle_id="${1:-${BUNDLE_ID:-com.pearcircle}}"

  # Preferred: asc CLI (sees all versions including in-review and TestFlight)
  if command -v asc &>/dev/null \
     && [ -n "${ASC_KEY_ID:-}" ] \
     && [ -n "${ASC_APP_ID:-}" ]; then
    if _asc_auth_linux 2>/dev/null; then
      local ver
      ver=$(asc versions list --app "$ASC_APP_ID" --output json 2>/dev/null \
        | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('data', data) if isinstance(data, dict) else data
if isinstance(items, list) and items:
    versions = [v.get('attributes', v).get('versionString', '') for v in items if v.get('attributes', v).get('versionString')]
    if versions:
        versions.sort(key=lambda v: tuple(int(x) for x in v.split('.') if x.isdigit()), reverse=True)
        print(versions[0])
" 2>/dev/null)
      if [ -n "$ver" ]; then
        echo "$ver"
        return
      fi
    fi
  fi

  # Fallback: iTunes Search API (only sees live App Store version)
  curl -sf --max-time 8 \
    "https://itunes.apple.com/lookup?bundleId=${bundle_id}" \
    2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
print(results[0].get('version', '') if results else '')
" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch the latest version tag published for the Umbrel/Docker seeder
# image on the ghcr registry. The package is public, so an anonymous pull
# token suffices (no GITHUB_TOKEN needed). Returns the highest X.Y.Z tag or "".
# build-umbrel-image.sh pushes ${IMAGE}:${VERSION} (no :latest), so we list all
# tags and pick the max semver.
# ---------------------------------------------------------------------------
_umbrel_latest_version() {
  local image="${1:-ghcr.io/peerloomllc/pearcircle-seeder}"
  local host="${image%%/*}"   # ghcr.io
  local repo="${image#*/}"    # peerloomllc/pearcircle-seeder

  local token
  token=$(curl -s --max-time 8 \
    "https://${host}/token?scope=repository:${repo}:pull" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" \
    2>/dev/null || echo "")
  [ -z "$token" ] && echo "" && return

  curl -s --max-time 8 \
    -H "Authorization: Bearer $token" \
    "https://${host}/v2/${repo}/tags/list" 2>/dev/null \
    | python3 -c "
import sys, json
try:
    tags = json.load(sys.stdin).get('tags', []) or []
except Exception:
    tags = []
best = ()
for t in tags:
    parts = tuple(int(x) for x in t.lstrip('v').split('.') if x.isdigit())
    if len(parts) == 3 and parts > best:
        best = parts
if best:
    print('.'.join(str(x) for x in best))
" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: fetch the version the live StartOS (Start9) community registry
# advertises — what StartOS users see as available. Distinct from the ghcr
# image tag above: the s9pk is built from that image, but the registry is served
# from the website and updated by a separate publish (release step 7b + a
# website PR merge), so it can lag the image. The marketplace protocol's
# GET /package/v0/latest returns {"pearcircle-seeder":"X.Y.Z"}.
# ---------------------------------------------------------------------------
_start9_latest_version() {
  local url="${1:-https://www.peerloomllc.com/package/v0/latest}"
  curl -fsS --max-time 10 "$url" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('pearcircle-seeder','') or '')" \
    2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Helper: authenticate asc CLI on the local (Linux) machine.
# Returns 1 if asc is not installed or the .p8 key file is missing.
# ---------------------------------------------------------------------------
_asc_auth_linux() {
  if ! command -v asc &>/dev/null; then
    echo "WARNING: asc CLI not installed on this machine. Skipping ASC operations."
    return 1
  fi
  local key_file="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  if [ ! -f "$key_file" ]; then
    echo "WARNING: API key file not found at $key_file"
    return 1
  fi
  asc auth login \
    --bypass-keychain \
    --name "${APP_NAME:-App}-CI" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$key_file" >/dev/null 2>&1
}

# Uses $REPO_ROOT so this works regardless of invocation directory.
# ---------------------------------------------------------------------------
_android_package_name() {
  local gradle_file="$REPO_ROOT/android/app/build.gradle"

  # 1. Try aapt on the most recently built APK (most authoritative)
  local apk="$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk"
  if [ -f "$apk" ] && command -v aapt &>/dev/null; then
    aapt dump badging "$apk" 2>/dev/null \
      | grep "^package:" \
      | sed -E "s/.*name='([^']+)'.*/\1/"
    return
  fi

  # 2. Parse applicationId from build.gradle
  if [ ! -f "$gradle_file" ]; then
    echo "    Warning: $gradle_file not found" >&2
    echo ""
    return
  fi

  grep -E 'applicationId' "$gradle_file" \
    | head -1 \
    | sed -E "s/.*applicationId[[:space:]]+['\"]([^'\"]+)['\"].*/\1/"
}

# ---------------------------------------------------------------------------
# Helper: the versionName baked into an APK, or "" if it cannot be read.
#
# Exists so a publish can assert the artifact really is the version being
# announced. Prefers aapt (same tool _android_package_name already relies on),
# falls back to the newest aapt2 in the Android SDK, and gives up quietly
# rather than guessing — callers treat "" as "unknown", not as a mismatch.
# ---------------------------------------------------------------------------
_apk_version_name() {
  local apk="$1"
  [ -f "$apk" ] || return 0

  local badging=""
  if command -v aapt &>/dev/null; then
    badging=$(aapt dump badging "$apk" 2>/dev/null || true)
  fi
  if [ -z "$badging" ]; then
    local aapt2
    aapt2=$(ls -1 "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)
    [ -n "$aapt2" ] && badging=$("$aapt2" dump badging "$apk" 2>/dev/null || true)
  fi
  [ -z "$badging" ] && return 0

  printf '%s' "$badging" \
    | grep -m1 "^package:" \
    | sed -E "s/.*versionName='([^']*)'.*/\1/"
}

# ---------------------------------------------------------------------------
# Helper: compare two X.Y.Z version strings.
# Prints "gt" / "lt" / "eq"
# ---------------------------------------------------------------------------
_ver_cmp() {
  python3 - "$1" "$2" <<'EOF'
import sys
a = tuple(int(x) for x in sys.argv[1].split("."))
b = tuple(int(x) for x in sys.argv[2].split("."))
print("gt" if a > b else ("lt" if a < b else "eq"))
EOF
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_PLAY=false
SKIP_NOSTR=false
SKIP_DESKTOP=false
SKIP_LINUX=false
SKIP_WINDOWS=false
SKIP_MACOS=false
SKIP_ANDROID=false
SKIP_IOS=false
SKIP_UMBREL=false
SKIP_START9=false

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    --skip-desktop) SKIP_DESKTOP=true ;;
    --skip-linux) SKIP_LINUX=true ;;
    --skip-windows) SKIP_WINDOWS=true ;;
    --skip-macos) SKIP_MACOS=true ;;
    --skip-umbrel) SKIP_UMBREL=true ;;
    --skip-start9) SKIP_START9=true ;;
    --skip-android) SKIP_ANDROID=true ;;
    --skip-ios) SKIP_IOS=true ;;
    --skip-mobile) SKIP_ANDROID=true; SKIP_IOS=true ;;
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
UMBREL_IMAGE="${UMBREL_IMAGE:-ghcr.io/peerloomllc/pearcircle-seeder}"
UMBREL_VERSION_CURRENT=$(_umbrel_latest_version "$UMBREL_IMAGE")
START9_REGISTRY_URL="${START9_REGISTRY_URL:-https://www.peerloomllc.com/package/v0/latest}"
START9_VERSION_CURRENT=$(_start9_latest_version "$START9_REGISTRY_URL")

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
echo "    Umbrel (ghcr): ${UMBREL_VERSION_CURRENT:-unknown} (${UMBREL_IMAGE})"
echo "    Start9 (reg) : ${START9_VERSION_CURRENT:-unknown} (registry: what StartOS users install)"

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
  echo ""
  if [ -n "$UMBREL_VERSION_CURRENT" ]; then
    echo "    Umbrel/ghcr query succeeded: $UMBREL_VERSION_CURRENT ($UMBREL_IMAGE)"
  else
    echo "    Umbrel/ghcr query returned nothing for $UMBREL_IMAGE — image may not be"
    echo "    published yet, the package may be private, or the registry was unreachable."
  fi
  exit 0
fi

if [ -n "${EXPLICIT_TAG:-}" ]; then
  GH_HAS_VERSION=false
  ZSP_HAS_VERSION=false
  PLAY_HAS_VERSION=false
  ASC_HAS_VERSION=false
  UMBREL_HAS_VERSION=false
  [ "$GH_VERSION" = "$APP_VERSION" ]           && GH_HAS_VERSION=true
  [ "$ZSP_VERSION_CURRENT" = "$APP_VERSION" ]  && ZSP_HAS_VERSION=true
  [ "$PLAY_VERSION_CURRENT" = "$APP_VERSION" ] && PLAY_HAS_VERSION=true
  [ "$ASC_VERSION_CURRENT"  = "$APP_VERSION" ] && ASC_HAS_VERSION=true
  [ "$UMBREL_VERSION_CURRENT" = "$APP_VERSION" ] && UMBREL_HAS_VERSION=true

  # Build a human-readable summary of what's already published
  _already=""
  $GH_HAS_VERSION     && _already="${_already}GitHub, "
  $ZSP_HAS_VERSION    && _already="${_already}Zapstore, "
  $PLAY_HAS_VERSION   && _already="${_already}Google Play, "
  $ASC_HAS_VERSION    && _already="${_already}App Store, "
  $UMBREL_HAS_VERSION && _already="${_already}Umbrel, "
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
  # Umbrel counts toward "all published" unless --skip-umbrel was passed.
  if ! $SKIP_UMBREL; then
    $UMBREL_HAS_VERSION || _all_have=false
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
        echo "    Skipping build — will publish existing GitHub release to Zapstore only."
        RELEASE_TAG="v${GH_VERSION}"
        APP_VERSION="$GH_VERSION"
        echo "    Using release tag: $RELEASE_TAG"
        ZAPSTORE_ONLY=true
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
# Desktop seeder installers (built in step 4d). Declared here so step 7's
# asset loop stays safe even when the build block is skipped (e.g. --retag).
DESKTOP_ARTIFACTS=()

# Play is available if either gcloud is authenticated or a SA JSON is present
_play_configured() {
  command -v gcloud > /dev/null 2>&1 \
    && gcloud auth application-default print-access-token > /dev/null 2>&1 \
    && return 0
  [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] \
    && return 0
  return 1
}
_play_configured && PUBLISH_PLAY=true

_appstore_configured() {
  # Mac Mini must be reachable for the xcodebuild archive+export step
  ssh -o ConnectTimeout=5 -o BatchMode=yes "${MAC_MINI_HOST:-Tims-Mac-mini.local}" exit 2>/dev/null || return 1
  # Prefer API key auth, fall back to legacy app-specific password
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
    return 0
  fi
  [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ] && return 0
  return 1
}
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

  # Desktop seeder-launcher installers (attached to the GitHub release)
  if $SKIP_DESKTOP; then
    echo "    - Desktop seeder installers (skipped via --skip-desktop)"
  else
    while true; do
      read -rp "    Build desktop seeder-launcher installers (Linux/Windows/macOS)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) SKIP_DESKTOP=false; echo "    ✓ Desktop seeder installers"; break ;;
        [Nn]) SKIP_DESKTOP=true;  echo "    ✗ Desktop seeder installers (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  # Umbrel / Docker seeder image (multi-arch, built + pushed to ghcr)
  if $SKIP_UMBREL; then
    echo "    - Umbrel/Docker seeder image (skipped via --skip-umbrel)"
  else
    while true; do
      read -rp "    Build + push the Umbrel/Docker seeder image (multi-arch, ghcr)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) SKIP_UMBREL=false; echo "    ✓ Umbrel/Docker seeder image"; break ;;
        [Nn]) SKIP_UMBREL=true;  echo "    ✗ Umbrel/Docker seeder image (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  # StartOS (Start9) .s9pk — needs the StartOS SDK toolchain; auto-skip without it.
  if $SKIP_START9; then
    echo "    - StartOS (Start9) s9pk (skipped via --skip-start9)"
  elif ! command -v start-sdk >/dev/null || ! command -v deno >/dev/null || ! command -v yq >/dev/null; then
    SKIP_START9=true
    echo "    - StartOS (Start9) s9pk (skipped — StartOS SDK toolchain not installed)"
  else
    while true; do
      read -rp "    Build the StartOS (Start9) s9pk? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) SKIP_START9=false; echo "    ✓ StartOS (Start9) s9pk"; break ;;
        [Nn]) SKIP_START9=true;  echo "    ✗ StartOS (Start9) s9pk (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
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
# The bundle commands are inlined rather than delegated to `npm run verify`
# because package.json's build:bare passes `--defer fs --defer path` and its
# build:bare:ios uses `--preset ios` where the release uses `--host ios-arm64
# --linked`. Those produce different bundles, so calling verify here would
# change what ships. Reconciling package.json is tracked separately.
# ---------------------------------------------------------------------------
echo "==> Running unit tests..."
npm test

echo "==> Building UI bundle..."
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --loader:.js=jsx --loader:.css=text --loader:.png=dataurl \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle

echo "==> Building Bare bundle..."
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle

if $PUBLISH_APP_STORE; then
  echo "==> Building iOS Bare bundle..."
  node_modules/.bin/bare-pack --host ios-arm64 --linked src/bare.js -o assets/bare-ios.bundle
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
# 4e. Generate .sha256 sidecars for the mobile artifacts
# ---------------------------------------------------------------------------
for _artifact in "$APK_NAME" "$AAB_NAME"; do
  [ -z "$_artifact" ] && continue
  [ -f "$_artifact" ] || continue
  ( cd "$REPO_ROOT" && sha256sum "$_artifact" > "${_artifact}.sha256" )
  echo "    sha256  $(cut -d' ' -f1 < "${_artifact}.sha256")  $_artifact"
done

echo ""
_BUILD_SUMMARY=""
if [ -n "$APK_NAME" ]; then _BUILD_SUMMARY="APK ($APK_SIZE)"; fi
if $PUBLISH_PLAY    && [ -n "$AAB_NAME" ]; then
  _BUILD_SUMMARY="${_BUILD_SUMMARY:+$_BUILD_SUMMARY, }AAB ($AAB_SIZE)"
fi
[ -z "$_BUILD_SUMMARY" ] && _BUILD_SUMMARY="desktop installers only (no mobile artifacts)"
_confirm "$_BUILD_SUMMARY look correct — proceed with release notes?"

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
echo "==> Generating release notes from git log..."

PREV_TAG=$(git tag --sort=-version:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | grep -v "^${RELEASE_TAG}$" \
  | head -1 || echo "")

if [ -n "$PREV_TAG" ]; then
  LOG_RANGE="${PREV_TAG}..HEAD"
  echo "    Commits since $PREV_TAG"
else
  LOG_RANGE="HEAD"
  echo "    No previous tag — including all commits"
fi

# Resolve repo slug for optional GitHub API enrichment
REPO_SLUG=$(_remote_slug)
GH_TOKEN=$(_github_token)

# Build an associative array: merge-commit sha -> PR number (best-effort)
declare -A PR_NUM_FOR_SHA
if [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
  # Pull PR numbers from merge commit subjects that look like
  # "Merge pull request #123 from …" (GitHub's default merge message)
  while IFS='|' read -r sha subject; do
    if [[ "$subject" =~ Merge\ pull\ request\ #([0-9]+) ]]; then
      PR_NUM_FOR_SHA["$sha"]="${BASH_REMATCH[1]}"
    fi
  done < <(git log "$LOG_RANGE" --merges --format="%H|%s")
fi

FEAT_LINES=""
FIX_LINES=""
OTHER_LINES=""

# Helper: strip conventional commit prefix (feat:, fix:, etc.) from a title,
# returning just the description. Handles optional scope e.g. feat(ui): ...
_strip_prefix() {
  printf '%s' "$1" | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//'
}

# Helper: categorise a title into feat / fix / other
_category() {
  if [[ "$1" =~ ^feat(\([^\)]*\))?!?: ]]; then
    echo "feat"
  elif [[ "$1" =~ ^fix(\([^\)]*\))?!?: ]]; then
    echo "fix"
  else
    echo "other"
  fi
}

# Helper: append an entry to the right bucket.
# Usage: _add_entry "<raw title>" "<optional summary>"
_add_entry() {
  local raw_title="$1"
  local summary="$2"
  local cat
  cat=$(_category "$raw_title")
  local clean_title
  clean_title=$(_strip_prefix "$raw_title")

  local entry="- **${clean_title}**"
  [ -n "$summary" ] && entry="${entry}: ${summary}"
  entry="${entry}\n"

  case "$cat" in
    feat)  FEAT_LINES="${FEAT_LINES}${entry}" ;;
    fix)   FIX_LINES="${FIX_LINES}${entry}" ;;
    *)     OTHER_LINES="${OTHER_LINES}${entry}" ;;
  esac
}

# Process merge commits (treated as PRs) oldest-first
while IFS= read -r sha; do
  [[ -z "$sha" ]] && continue

  SUBJECT=$(git log -1 --format="%s" "$sha")
  BODY=$(git log -1 --format="%b" "$sha")

  # Derive a clean title ---------------------------------------------------
  TITLE="$SUBJECT"

  # Strip GitHub's boilerplate "Merge pull request #N from branch" prefix
  if [[ "$TITLE" =~ ^Merge\ pull\ request\ #[0-9]+\ from\ (.+)$ ]]; then
    BRANCH_TITLE="${BASH_REMATCH[1]}"
    # Try to get the real PR title from the API if we have a token
    PR_NUM="${PR_NUM_FOR_SHA[$sha]:-}"
    if [ -n "$PR_NUM" ] && [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
      API_TITLE=$(curl -sf \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${REPO_SLUG}/pulls/${PR_NUM}" \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" \
        2>/dev/null || echo "")
      [ -n "$API_TITLE" ] && TITLE="$API_TITLE"
    fi
    # Fallback: humanise the branch name
    if [[ "$TITLE" == "$SUBJECT" ]]; then
      TITLE=$(printf '%s' "$BRANCH_TITLE" \
        | sed -E 's|^[^/]+/||; s/[-_]/ /g')
    fi
  fi

  # Extract summary from commit body (honours "## Summary" section) --------
  SUMMARY=""
  if [ -n "$BODY" ]; then
    SUMMARY=$(printf '%s' "$BODY" \
      | awk '/^## Summary/{f=1;next} /^## /{if(f)exit} f && /\S/{print}')
    if [ -z "$SUMMARY" ]; then
      SUMMARY=$(printf '%s' "$BODY" \
        | awk 'NF{p=1} p && /^$/{exit} p{print}')
    fi
  fi

  # Skip summary if it's a duplicate of the title (with or without prefix)
  if [ -n "$SUMMARY" ]; then
    CLEAN_TITLE=$(_strip_prefix "$TITLE")
    CLEAN_SUMMARY=$(_strip_prefix "$SUMMARY")
    if [ "$CLEAN_SUMMARY" = "$CLEAN_TITLE" ] || [ "$SUMMARY" = "$TITLE" ]; then
      SUMMARY=""
    fi
  fi

  _add_entry "$TITLE" "$SUMMARY"
done < <(git log "$LOG_RANGE" --merges --format="%H" --reverse)

# Collect non-merge commits made directly on the branch (--first-parent
# excludes commits that arrived via merged PRs, avoiding near-duplicates)
while IFS='|' read -r sha subject; do
  [[ -z "$subject" ]] && continue
  _add_entry "$subject" ""
done < <(git log "$LOG_RANGE" --no-merges --first-parent --format="%H|%s")

# Assemble final notes ------------------------------------------------------
NOTES="## What's Changed\n\n"

if [ -z "$FEAT_LINES" ] && [ -z "$FIX_LINES" ] && [ -z "$OTHER_LINES" ]; then
  NOTES="${NOTES}No commits since last release.\n"
else
  [ -n "$FEAT_LINES" ] && NOTES="${NOTES}### ✨ Improvements\n\n${FEAT_LINES}\n"
  [ -n "$FIX_LINES"  ] && NOTES="${NOTES}### 🐛 Bug Fixes\n\n${FIX_LINES}\n"
  [ -n "$OTHER_LINES" ] && NOTES="${NOTES}### 🔧 Other\n\n${OTHER_LINES}\n"
fi

printf "%b" "$NOTES" > release_notes.md
sed -i 's/\*\*//g' release_notes.md
echo "    Opening release notes in vi for review/editing..."
vi release_notes.md
echo "--- Release notes ---"
cat release_notes.md
echo "---"
_confirm "Release notes look good?"

# Auto-populate iOS metadata release notes if the directory exists
if [ -d "$REPO_ROOT/metadata/ios/en-US" ]; then
  cp release_notes.md "$REPO_ROOT/metadata/ios/en-US/release_notes.txt"
  echo "    Updated metadata/ios/en-US/release_notes.txt"
fi

# Same notes into the two app-store manifests. Both were fossilised on their
# first-release text while this script faithfully bumped their VERSION every
# time, so anyone updating from either store was told they were installing the
# first release. Start9's registry republishes the field, so it was served, not
# just stored. Both files are already in _bump_paths, so the rewrite rides the
# existing release commit.
#
# A hard failure, deliberately: it runs before the tag, the build and any
# publish, so aborting here costs nothing, and a warning that scrolls past in a
# long release log is exactly how this class of bug keeps happening.
echo "==> Writing release notes into the app-store manifests..."
if ! node "$REPO_ROOT/seeder-launcher/scripts/write-store-release-notes.js" release_notes.md; then
  echo "ERROR: could not write the store release notes - fix this before releasing," >&2
  echo "       or the stores will advertise the previous version's notes again." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 5b. Build the desktop seeder-launcher installers
#
# Moved to run after release-notes editing: the slow, best-effort desktop
# builds now run unattended once the notes are finalized. Still gated on
# NEEDS_BUILD (no desktop build for a Zapstore-only republish) and SKIP_DESKTOP.
# Best-effort: each platform builds independently and a failure (Mac mini
# unreachable, missing signing certs, build script not yet on this branch) is
# logged and skipped, never blocking the mobile release.
# Whatever builds is appended to DESKTOP_ARTIFACTS and uploaded with the
# GitHub release in step 7.
# ---------------------------------------------------------------------------
if $NEEDS_BUILD; then
if $SKIP_DESKTOP; then
  echo "==> Skipping desktop seeder-launcher builds (--skip-desktop)."
else
  echo ""
  echo "==> Building desktop seeder-launcher installers..."
  _SLV="${RELEASE_TAG#v}"
  _SL="$REPO_ROOT/seeder-launcher"

  if $SKIP_LINUX; then
    echo "--> Linux    (skipped via --skip-linux)"
  else
    echo "--> Linux    (.deb + .AppImage, built locally)"
    ( cd "$_SL" && npm install --no-audit --no-fund --loglevel=error ) \
      > /tmp/pearcircle-build-linux.log 2>&1 || true
    if bash "$_SL/scripts/build-linux.sh" "$_SLV" >> /tmp/pearcircle-build-linux.log 2>&1; then
      for _f in "$_SL/dist/linux/pearcircle-seeder_${_SLV}_amd64.deb" \
                "$_SL/dist/linux/pearcircle-seeder_${_SLV}_arm64.deb" \
                "$_SL/dist/linux/PearCircleSeeder-x86_64.AppImage" \
                "$_SL/dist/linux/PearCircleSeeder-aarch64.AppImage"; do
        if [ -f "$_f" ]; then DESKTOP_ARTIFACTS+=("$_f"); fi
      done
      echo "    Linux build OK."
    else
      echo "    WARNING: Linux seeder build failed, skipping it. Log: /tmp/pearcircle-build-linux.log"
    fi
  fi

  if $SKIP_WINDOWS; then
    echo "--> Windows  (skipped via --skip-windows)"
  else
    echo "--> Windows  (.exe, cross-built locally - no VM)"
    # The Windows installer is a cross-build: makensis runs on Linux/macOS and
    # every payload binary is prebuilt. Ensure the seeder-launcher deps
    # (esbuild) are present - the Linux stage's install above is skippable via
    # --skip-linux - and force in the win32 bare runtime, an optional npm dep
    # gated to os=win32 that a normal install on a non-Windows host skips.
    ( cd "$_SL" && npm install --no-audit --no-fund --loglevel=error
      cd "$REPO_ROOT" && npm install bare-runtime-win32-x64 --os=win32 --cpu=x64 \
        --force --no-save --no-audit --no-fund --loglevel=error ) \
      > /tmp/pearcircle-build-windows.log 2>&1 || true
    if bash "$_SL/scripts/build-windows-local.sh" "$_SLV" >> /tmp/pearcircle-build-windows.log 2>&1; then
      _f="$_SL/dist/windows/PearCircleSeeder-Setup-${_SLV}.exe"
      if [ -f "$_f" ]; then DESKTOP_ARTIFACTS+=("$_f"); fi
      echo "    Windows build OK."
    else
      echo "    WARNING: Windows seeder build failed, skipping it. Log: /tmp/pearcircle-build-windows.log"
    fi
  fi

  if $SKIP_MACOS; then
    echo "--> macOS    (skipped via --skip-macos)"
  else
    echo "--> macOS    (.pkg, built on the Mac mini)"
    if APP_SIGN_ID="${MACOS_APP_SIGN_ID:-}" PKG_SIGN_ID="${MACOS_PKG_SIGN_ID:-}" \
         bash "$_SL/scripts/build-macos-remote.sh" "$_SLV" > /tmp/pearcircle-build-macos.log 2>&1; then
      _f="$_SL/dist/macos/PearCircleSeeder-${_SLV}.pkg"
      if [ -f "$_f" ]; then DESKTOP_ARTIFACTS+=("$_f"); fi
      echo "    macOS build OK."
    else
      echo "    WARNING: macOS seeder build failed, skipping it. Log: /tmp/pearcircle-build-macos.log"
    fi
  fi

  # .sha256 sidecars, matching the mobile artifacts from step 4c.
  for _f in "${DESKTOP_ARTIFACTS[@]}"; do
    ( cd "$(dirname "$_f")" && sha256sum "$(basename "$_f")" > "$(basename "$_f").sha256" )
  done

  if [ ${#DESKTOP_ARTIFACTS[@]} -gt 0 ]; then
    echo "==> Desktop installers built (${#DESKTOP_ARTIFACTS[@]}):"
    for _f in "${DESKTOP_ARTIFACTS[@]}"; do
      echo "    - $(basename "$_f")  ($(du -sh "$_f" | cut -f1))"
    done
  else
    echo "==> No desktop installers produced (all skipped or failed); mobile release continues."
  fi
fi
fi # end NEEDS_BUILD (desktop installers)

# ---------------------------------------------------------------------------
# 5c. Build + push the multi-arch Umbrel/Docker seeder image (amd64 + arm64)
#
# Independent of NEEDS_BUILD: the image only needs the version/tag, not the
# mobile artifacts, so it tracks the destination-selection prompt (SKIP_UMBREL)
# directly and still runs for Zapstore-only or desktop-only releases.
#
# Best-effort like the desktop builds: a failure (no podman, not logged in to
# ghcr, qemu-user-static missing for the arm64 runtime step) is logged and
# skipped, never blocking the release. On success build-umbrel-image.sh pushes
# the manifest list, version-stamps it (SEEDER_VERSION build-arg), and bumps the
# in-repo seeder-launcher/umbrel manifest to the new version + manifest-list
# digest. The seeder is listed in two stores, each keyed off its own version:
# field, so both need bumping per release:
#   UMBREL_STORE_DIR     local clone of the PeerLoom community app store
#                        (peerloom-umbrel-app-store) — bumped in place; commit +
#                        push that repo yourself to publish.
#   UMBREL_OFFICIAL_DIR  local clone of the official-store fork
#                        (peerloomllc/umbrel-apps) — bumped on a fresh per-release
#                        branch off upstream getumbrel/umbrel-apps; with
#                        UMBREL_OFFICIAL_PR=1 it also pushes + opens/refreshes the
#                        getumbrel update PR via `gh` (else it prints the commands).
# ---------------------------------------------------------------------------
if $SKIP_UMBREL; then
  echo "==> Skipping Umbrel/Docker image build."
else
  echo ""
  echo "==> Building + pushing the multi-arch Umbrel/Docker seeder image (amd64 + arm64)..."
  echo "    Live milestones below — 'STEP N/M' = building, 'Copying blob' = pushing to ghcr."
  echo "    Full log: /tmp/pearcircle-build-umbrel.log"
  # Stream milestone lines so this isn't a silent multi-minute spinner, while
  # tee keeps the full log. PIPESTATUS[0] is the builder's real exit (grep/awk
  # after it never mask a build failure); set +e so the pipeline can't abort us.
  set +e
  STORE_DIR="${UMBREL_STORE_DIR:-}" \
  OFFICIAL_STORE_DIR="${UMBREL_OFFICIAL_DIR:-}" \
  OFFICIAL_STORE_PR="${UMBREL_OFFICIAL_PR:-}" \
    bash "$REPO_ROOT/seeder-launcher/scripts/build-umbrel-image.sh" "${RELEASE_TAG#v}" 2>&1 \
    | tee /tmp/pearcircle-build-umbrel.log \
    | grep --line-buffered -E '^==>|STEP [0-9]+/|Copying (blob|config)|Writing manifest|bumped |official store|refreshed |nothing to commit|WARNING|[Ee]rror' \
    | awk '{ print "      " $0; fflush() }'
  _umbrel_status=${PIPESTATUS[0]}
  set -e
  if [ "$_umbrel_status" -eq 0 ]; then
    echo "    Umbrel image OK ($(grep -oE 'digest=sha256:[0-9a-f]+' /tmp/pearcircle-build-umbrel.log | tail -1)). Log: /tmp/pearcircle-build-umbrel.log"
    echo "    In-repo umbrel manifest bumped — review + commit it with the release."
    [ -n "${UMBREL_STORE_DIR:-}" ] && echo "    Community store at $UMBREL_STORE_DIR bumped — commit + push that repo to publish."
    if [ -n "${UMBREL_OFFICIAL_DIR:-}" ]; then
      if [ "${UMBREL_OFFICIAL_PR:-}" = 1 ]; then
        echo "    Official store: update PR pushed/refreshed — see $(grep -oE 'https://github.com/getumbrel/umbrel-apps/pull/[0-9]+' /tmp/pearcircle-build-umbrel.log | tail -1) (or the log)."
      else
        echo "    Official store: branch bumped at $UMBREL_OFFICIAL_DIR — set UMBREL_OFFICIAL_PR=1 to auto-open the PR, or follow the printed commands in the log."
      fi
    fi
  else
    echo "    WARNING: Umbrel image build/push failed, skipping it. Log: /tmp/pearcircle-build-umbrel.log"
  fi
fi

# ---------------------------------------------------------------------------
# 5d. Build the StartOS (Start9) universal .s9pk (x86_64 + aarch64)
#
# Runs after 5c because it pins the Start9 package to the freshly-pushed
# pearcircle-seeder:${VERSION} manifest list (resolving its digest from ghcr).
# Best-effort like the other packagers: any failure is logged and skipped,
# never blocking the release. Auto-skips cleanly when the StartOS SDK toolchain
# is absent (the s9pk build needs start-sdk + deno + yq, unlike the podman-only
# Umbrel image). On success it writes seeder-launcher/start9/pearcircle-seeder
# .s9pk (added to the release assets below — it's the target of the website
# registry's /package/v0/pearcircle-seeder.s9pk redirect) and pins the in-repo
# start9/ manifest + Dockerfile to the new version for you to commit. The website
# community registry is refreshed AFTER the GitHub release exists (step 7b).
# ---------------------------------------------------------------------------
START9_S9PK=""
if $SKIP_START9; then
  echo "==> Skipping StartOS (Start9) s9pk build."
elif ! command -v start-sdk >/dev/null || ! command -v deno >/dev/null || ! command -v yq >/dev/null; then
  echo "==> Skipping StartOS s9pk build (StartOS SDK toolchain not found: needs start-sdk + deno + yq)."
else
  echo ""
  echo "==> Building StartOS (Start9) universal s9pk (x86_64 + aarch64)..."
  echo "    Full log: /tmp/pearcircle-build-start9.log"
  set +e
  bash "$REPO_ROOT/seeder-launcher/scripts/build-start9-s9pk.sh" "${RELEASE_TAG#v}" 2>&1 \
    | tee /tmp/pearcircle-build-start9.log \
    | grep --line-buffered -E '^==>|^\s*!!|STEP [0-9]+/|Copying (blob|config)|save \+ normalize|packing |verify|s9pk ready|WARNING|[Ee]rror' \
    | awk '{ print "      " $0; fflush() }'
  _start9_status=${PIPESTATUS[0]}
  set -e
  if [ "$_start9_status" -eq 0 ]; then
    START9_S9PK="$REPO_ROOT/seeder-launcher/start9/pearcircle-seeder.s9pk"
    echo "    Start9 s9pk OK ($(du -h "$START9_S9PK" | cut -f1)). Log: /tmp/pearcircle-build-start9.log"
    echo "    In-repo start9/ manifest + Dockerfile pinned to ${RELEASE_TAG#v} — review + commit with the release."
  else
    START9_S9PK=""
    echo "    WARNING: Start9 s9pk build failed, skipping it. Log: /tmp/pearcircle-build-start9.log"
  fi
fi

# ---------------------------------------------------------------------------
# 5e. Generate .sha256 sidecars for the desktop artifacts, then the final gate
#
# The desktop, Umbrel and Start9 builds above are slow and best-effort, so
# their checksums and the last look at the full asset list happen here rather
# than at step 4e. This is the last confirm before anything irreversible: step
# 6 commits and step 6b pushes the tag. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
for _artifact in "${DESKTOP_ARTIFACTS[@]:-}"; do
  [ -z "$_artifact" ] && continue
  [ -f "$_artifact" ] || continue
  case "$_artifact" in
    *.sha256|*.yml|*.yaml) continue ;;   # sidecars and update manifests
  esac
  [ -f "${_artifact}.sha256" ] && continue          # the builder already made one
  ( cd "$(dirname "$_artifact")" && sha256sum "$(basename "$_artifact")" > "$(basename "$_artifact").sha256" )
  echo "    sha256  $(cut -d' ' -f1 < "${_artifact}.sha256")  $(basename "$_artifact")"
done

echo ""
_RELEASE_SUMMARY=""
[ -n "${APK_NAME:-}" ] && _RELEASE_SUMMARY="APK (${APK_SIZE:-?})"
if $PUBLISH_PLAY && [ -n "${AAB_NAME:-}" ]; then
  _RELEASE_SUMMARY="${_RELEASE_SUMMARY:+$_RELEASE_SUMMARY, }AAB (${AAB_SIZE:-?})"
fi
if [ "${#DESKTOP_ARTIFACTS[@]}" -gt 0 ]; then
  _RELEASE_SUMMARY="${_RELEASE_SUMMARY:+$_RELEASE_SUMMARY, }${#DESKTOP_ARTIFACTS[@]} desktop artifact(s)"
fi
[ -n "${START9_S9PK:-}" ] && _RELEASE_SUMMARY="${_RELEASE_SUMMARY:+$_RELEASE_SUMMARY, }Start9 .s9pk"
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
  [ ${#DESKTOP_ARTIFACTS[@]} -gt 0 ] && _have_upload=true
  [ -n "${START9_S9PK:-}" ] && [ -f "$START9_S9PK" ] && _have_upload=true
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
# Step 0 rewrites app.json + the Xcode project, and the seeder store steps
# rewrite the Start9 manifest/migrations/Dockerfile pins and the Umbrel
# manifest/compose pins. Nothing ever committed them, so the tag was cut from a
# tree still carrying the PREVIOUS version: master permanently declared the
# version before the one that shipped, and the tag did not contain the version
# it names.
#
# Committing here (before the tag) makes the tag actually contain its version.
#
# Explicit allowlist, never `git add -A`. A release run leaves plenty of other
# dirt in the tree: the .apk/.aab/.sha256 sidecars at the repo root, generated
# release_notes.md, seeder-launcher/deno.lock. And should assets/*.bundle ever
# stop being gitignored, `add -A` would bake a build output that can lag its own
# source into the release commit.
_bump_paths=(
  app.json
  "${XCODE_PROJECT:-ios/PearCircle.xcodeproj/project.pbxproj}"
  seeder-launcher/start9/manifest.yaml
  seeder-launcher/start9/Dockerfile
  seeder-launcher/start9/scripts/procedures/migrations.ts
  seeder-launcher/umbrel/umbrel-app.yml
  seeder-launcher/umbrel/docker-compose.yml
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
echo ""
echo "    Remote : $GIT_REMOTE"
echo "    Tag    : $RELEASE_TAG"
echo "    Branch : $(git rev-parse --abbrev-ref HEAD)"
echo "    Commit : $(git rev-parse --short HEAD)  $(git log -1 --format='%s')"
_confirm "Push branch $(git rev-parse --abbrev-ref HEAD) + tag $RELEASE_TAG to $GIT_REMOTE? (This cannot be undone without a force-delete)"

# The bump commit has to reach the remote too, or the pushed tag points at a
# commit nobody else has.
_branch="$(git rev-parse --abbrev-ref HEAD)"
git push "$GIT_REMOTE" "$_branch" \
  && echo "    Pushed $_branch to $GIT_REMOTE" \
  || echo "    WARNING: branch push failed - push $_branch manually so the tag resolves." >&2

# Create the local tag here — as late as possible, only after all confirmations
echo "==> Tagging and pushing $RELEASE_TAG..."
git tag "$RELEASE_TAG" 2>/dev/null \
  && echo "    Created local tag" \
  || echo "    Tag already exists locally"

git push "$GIT_REMOTE" "$RELEASE_TAG" \
  && echo "    Pushed tag to $GIT_REMOTE" \
  || echo "    Tag already on remote"

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
# Desktop seeder-launcher installers from step 4d (best-effort; empty when
# --skip-desktop was passed or every platform failed to build).
for _d in "${DESKTOP_ARTIFACTS[@]}"; do
  RELEASE_ASSETS+=("$_d")
  [ -f "${_d}.sha256" ] && RELEASE_ASSETS+=("${_d}.sha256")
done
# StartOS .s9pk from step 5d (best-effort). Uploaded under the tag so the
# website registry's /package/v0/pearcircle-seeder.s9pk redirect resolves.
if [ -n "${START9_S9PK:-}" ] && [ -f "$START9_S9PK" ]; then
  RELEASE_ASSETS+=("$START9_S9PK")
  [ -f "${START9_S9PK}.sha256" ] && RELEASE_ASSETS+=("${START9_S9PK}.sha256")
  # The v2 package for StartOS 0.4.0+, converted from the v1 above by the same
  # build script. 0.4.0's web UI refuses a v1 s9pk on a magic-byte check, so
  # without this asset a 0.4.0 user has to fall back to the CLI to sideload.
  # Absent when the build machine lacks the 0.4.x start-cli or a packaging
  # workspace, which that script says loudly.
  _s9pk_v2="${START9_S9PK%.s9pk}-v2.s9pk"
  if [ -f "$_s9pk_v2" ]; then
    RELEASE_ASSETS+=("$_s9pk_v2")
    [ -f "${_s9pk_v2}.sha256" ] && RELEASE_ASSETS+=("${_s9pk_v2}.sha256")
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

# Map extension -> content type for the REST upload. The REST API requires
# an explicit content type; gh CLI infers it.
_asset_content_type() {
  case "$1" in
    *.apk)    echo "application/vnd.android.package-archive" ;;
    *.aab)    echo "application/octet-stream" ;;
    *.s9pk)   echo "application/octet-stream" ;;
    *.sha256) echo "text/plain" ;;
    *)        echo "application/octet-stream" ;;
  esac
}

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

  # Build a name -> existing-asset-id map so we can replace assets in
  # place if the release already had them (re-runs and ZAPSTORE_ONLY
  # path). Upload-by-name will 422 otherwise.
  EXISTING_ASSETS_JSON=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(json.dumps({a['name']: a['id'] for a in d.get('assets', []) or []}))
" 2>/dev/null || echo "{}")

  # --- Upload each asset in order ---
  for _asset in "${RELEASE_ASSETS[@]}"; do
    _ctype=$(_asset_content_type "$_asset")
    _basename=$(basename "$_asset")
    # If an asset with this name already exists on the release, delete it
    # first so the upload-by-name below doesn't 422 with already_exists.
    _existing_id=$(printf '%s' "$EXISTING_ASSETS_JSON" \
      | python3 -c "
import sys, json
m = json.load(sys.stdin)
print(m.get('$_basename', ''))" 2>/dev/null || echo "")
    if [ -n "$_existing_id" ]; then
      echo "==> Replacing existing $_basename (asset id $_existing_id)..."
      curl -s -X DELETE \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${REPO_SLUG}/releases/assets/${_existing_id}" \
        > /dev/null
    fi
    echo "==> Uploading $_basename ($_ctype)..."
    UPLOAD_RESP_FILE=$(mktemp)
    curl \
      -X POST \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: $_ctype" \
      "${UPLOAD_URL}?name=${_basename}" \
      --data-binary "@${_asset}" \
      --progress-bar \
      -o "$UPLOAD_RESP_FILE" 2>&1
    UPLOAD_RESP=$(cat "$UPLOAD_RESP_FILE"); rm -f "$UPLOAD_RESP_FILE"

    UPLOAD_ERROR=$(printf '%s' "$UPLOAD_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
    if [ -n "$UPLOAD_ERROR" ]; then
      echo ""
      echo "ERROR: Upload of $_basename failed:"
      printf '%s\n' "$UPLOAD_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$UPLOAD_RESP"
      echo ""
      echo "The GitHub release was created but $_basename was not attached."
      echo "You can upload it manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
      exit 1
    fi
    echo "    Uploaded successfully."
  done

else
  # Fallback: gh CLI (requires working auth). gh accepts multiple positional
  # asset paths and infers content type from extension.
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  gh release create "$RELEASE_TAG" "${RELEASE_ASSETS[@]}" \
    --title "$RELEASE_TAG" \
    --notes-file release_notes.md
fi

# ---------------------------------------------------------------------------
# 7b. Refresh the StartOS community registry on the website
#
# Runs only after the release + s9pk asset are live (above), because the
# registry metadata advertises this version and _redirects points at this tag's
# asset. Gated on WEBSITE_DIR and a successful Start9 build (START9_S9PK).
# Best-effort. With WEBSITE_REGISTRY_PR=1 it commits, pushes a branch, and
# opens + squash-merges the website PR (Cloudflare deploys on merge to main);
# otherwise it regenerates the files and prints the git/gh commands to run.
#   WEBSITE_DIR          dedicated clone of the website repo
#   WEBSITE_REGISTRY_PR  1 = auto commit + PR + merge (deploy); else print steps
# ---------------------------------------------------------------------------
if [ -n "${START9_S9PK:-}" ] && [ -f "$START9_S9PK" ] && [ -n "${WEBSITE_DIR:-}" ]; then
  echo ""
  echo "==> Refreshing StartOS community registry on the website..."
  if S9PK="$START9_S9PK" WEBSITE_DIR="$WEBSITE_DIR" \
     WEBSITE_REGISTRY_PR="${WEBSITE_REGISTRY_PR:-}" \
       bash "$REPO_ROOT/seeder-launcher/scripts/publish-start9-registry.sh" "${RELEASE_TAG#v}"; then
    :
  else
    echo "    WARNING: registry publish step failed — refresh the website registry manually."
  fi
elif [ -n "${START9_S9PK:-}" ] && [ -z "${WEBSITE_DIR:-}" ]; then
  echo "    (StartOS registry not refreshed — set WEBSITE_DIR to a website clone, and WEBSITE_REGISTRY_PR=1 to auto-deploy.)"
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

# ---------------------------------------------------------------------------
# 8. Install zsp if needed
# ---------------------------------------------------------------------------
if $PUBLISH_ZAPSTORE && ! command -v zsp &>/dev/null; then
  echo "==> Installing zsp..."
  ZSP_URL=$(curl -s https://api.github.com/repos/zapstore/zsp/releases/latest \
    | grep browser_download_url | grep linux-amd64 | cut -d '"' -f 4)
  mkdir -p "$HOME/.local/bin"
  curl -sL "$ZSP_URL" -o "$HOME/.local/bin/zsp"
  chmod +x "$HOME/.local/bin/zsp"
  export PATH="$HOME/.local/bin:$PATH"
fi

# ---------------------------------------------------------------------------
# 9. Publish to Zapstore
# ---------------------------------------------------------------------------
if $PUBLISH_ZAPSTORE; then
echo "==> Publishing to Zapstore..."

# Resolve token for zsp
EXPORT_TOKEN="${GH_TOKEN:-}"
if [ -z "$EXPORT_TOKEN" ]; then
  EXPORT_TOKEN=$(gh auth token 2>/dev/null || echo "")
fi

# --- Pre-step: link Android signing certificate to Nostr identity ---
# zsp needs to know your APK signing cert to prove app ownership.
# This is a one-time operation per keystore — if already linked it's a no-op.
# We extract the DER certificate from the keystore and pass it to zsp identity.
ZSP_P12_FILE=$(mktemp --suffix=.p12)
echo "==> Linking signing certificate to Nostr identity..."
if keytool -importkeystore \
    -srckeystore "$KEYSTORE_FILE" \
    -srcalias "$KEY_ALIAS" \
    -srcstorepass "$KEYSTORE_PASSWORD" \
    -srckeypass "$KEY_PASSWORD" \
    -destkeystore "$ZSP_P12_FILE" \
    -deststoretype PKCS12 \
    -deststorepass "$KEYSTORE_PASSWORD" \
    -noprompt 2>/dev/null; then
  if SIGN_WITH="$SIGN_WITH" KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
      zsp identity --link-key "$ZSP_P12_FILE"; then
    echo "    Certificate linked to Nostr identity."
  else
    echo "    Certificate link returned non-zero (may already be linked — continuing)."
  fi
else
  echo "    Warning: could not convert keystore to PKCS12 — skipping identity link."
  echo "    zsp may prompt interactively."
fi
rm -f "$ZSP_P12_FILE"

# --- Resolve release version and notes for Zapstore ---
# Try to pull from the GitHub release first (handles the case where a prior
# run already published to GitHub, so the canonical data lives there).
# Falls back to what we generated locally this run.
ZSP_VERSION=""
ZSP_NOTES=""

if [ -n "$EXPORT_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  echo "    Checking GitHub for existing release $RELEASE_TAG..."
  GH_RELEASE=$(curl -s \
    -H "Authorization: Bearer $EXPORT_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}" \
    2>/dev/null || echo "")

  GH_RELEASE_ERR=$(printf '%s' "$GH_RELEASE" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
    2>/dev/null || echo "")

  if [ -z "$GH_RELEASE_ERR" ]; then
    ZSP_VERSION=$(printf '%s' "$GH_RELEASE" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name','').lstrip('v'))" \
      2>/dev/null || echo "")
    ZSP_NOTES=$(printf '%s' "$GH_RELEASE" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" \
      2>/dev/null || echo "")
    [ -n "$ZSP_VERSION" ] && echo "    Using GitHub release data (version: $ZSP_VERSION)"
  else
    echo "    GitHub release not found or inaccessible ($GH_RELEASE_ERR) — using local data"
  fi
fi

# Fall back to locally generated values
if [ -z "$ZSP_VERSION" ]; then
  ZSP_VERSION="$APP_VERSION"
  echo "    Using local version: $ZSP_VERSION"
fi
if [ -z "$ZSP_NOTES" ] && [ -f release_notes.md ]; then
  ZSP_NOTES=$(cat release_notes.md)
  echo "    Using local release notes"
fi

# Write resolved notes to a temp file for zsp
ZSP_NOTES_FILE=$(mktemp)
printf '%s' "$ZSP_NOTES" > "$ZSP_NOTES_FILE"

echo ""
echo "    Version : $ZSP_VERSION"
echo "    Notes   : $(head -3 "$ZSP_NOTES_FILE" | tr '\n' ' ')..."

# Refuse to publish an artifact that is not the version being announced.
# zsp will happily upload whatever APK it is pointed at and label it with
# $ZSP_VERSION, which is exactly how v1.0.25 went to the relay as v1.1.0.
# The APK's own versionName is the ground truth, so check it before the
# confirm rather than trusting the filename or the intent of the run.
_ZSP_APK=""
if [ -f "$REPO_ROOT/${APK_NAME:-}" ]; then
  _ZSP_APK="$REPO_ROOT/${APK_NAME}"
elif [ -f "$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk" ]; then
  _ZSP_APK="$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk"
fi
if [ -n "$_ZSP_APK" ]; then
  _ZSP_APK_VERSION=$(_apk_version_name "$_ZSP_APK")
  if [ -z "$_ZSP_APK_VERSION" ]; then
    echo "    Warning: could not read the APK's versionName (no aapt/aapt2) —"
    echo "             publishing $(basename "$_ZSP_APK") unverified."
  elif [ "$_ZSP_APK_VERSION" != "$ZSP_VERSION" ]; then
    echo ""
    echo "ERROR: artifact/version mismatch — refusing to publish."
    echo "    About to announce : $ZSP_VERSION"
    echo "    APK actually is   : $_ZSP_APK_VERSION"
    echo "    APK               : $_ZSP_APK"
    echo ""
    echo "    This is the v1.0.25-published-as-v1.1.0 failure. The APK on disk is"
    echo "    stale, which means the build phase did not run for this version."
    echo "    Re-run and accept the build, or delete the stale APK."
    exit 1
  else
    echo "    Artifact : $(basename "$_ZSP_APK") (versionName $_ZSP_APK_VERSION ✓)"
  fi
fi

_confirm "Publish $RELEASE_TAG to Zapstore?"

# Always patch zapstore.yaml to inject local release notes so the Nostr
# event content is populated regardless of GitHub availability.
# Also inject release_source if we have a local APK (avoids GitHub download).
ZAPSTORE_YAML_BAK=$(mktemp)
cp zapstore.yaml "$ZAPSTORE_YAML_BAK"

LOCAL_APK=""
if [ -f "$REPO_ROOT/${APK_NAME:-}" ]; then
  LOCAL_APK="$REPO_ROOT/${APK_NAME}"
elif [ -f "$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk" ]; then
  LOCAL_APK="$REPO_ROOT/android/app/build/outputs/apk/release/app-release.apk"
fi

python3 - "$ZSP_NOTES_FILE" "${LOCAL_APK}" <<PYEOF
import sys, re
notes_file = sys.argv[1]
local_apk  = sys.argv[2]
txt = open('zapstore.yaml').read()
# Remove any existing release_notes / release_source lines
txt = re.sub(r'^release_notes:.*\n', '', txt, flags=re.MULTILINE)
txt = re.sub(r'^release_source:.*\n', '', txt, flags=re.MULTILINE)
# Prepend both fields
header = f"release_notes: {notes_file}\n"
if local_apk:
    header += f"release_source: {local_apk}\n"
txt = header + txt
open('zapstore.yaml', 'w').write(txt)
PYEOF

if [ -n "$LOCAL_APK" ]; then
  echo "    zapstore.yaml patched with local APK and release notes"
else
  echo "    zapstore.yaml patched with release notes"
fi

# Use --overwrite-release when republishing an already-existing version
ZSP_OVERWRITE=""
if [ -n "${EXPLICIT_TAG:-}" ]; then
  ZSP_OVERWRITE="--overwrite-release"
fi

if APP_VERSION="$ZSP_VERSION" GITHUB_TOKEN="$EXPORT_TOKEN" SIGN_WITH="$SIGN_WITH" \
    zsp publish -y zapstore.yaml ${ZSP_OVERWRITE}; then
  echo ""
  echo "==> Release $RELEASE_TAG complete."
else
  echo ""
  PUBLISH_FAILED=true
  echo "ERROR: Zapstore publish failed."
  echo ""
  echo "Manual retry:"
  echo "  source scripts/.env \\"
  echo "    && APP_VERSION=$ZSP_VERSION GITHUB_TOKEN=<token> SIGN_WITH=\"\$SIGN_WITH\" \\"
  echo "    ~/.local/bin/zsp publish --overwrite-release -y zapstore.yaml"
  echo ""
  echo "==> Release $RELEASE_TAG partially complete (GitHub release created, Zapstore skipped)."
fi

# Always restore original zapstore.yaml
mv "$ZAPSTORE_YAML_BAK" zapstore.yaml
echo "    zapstore.yaml restored."

rm -f "$ZSP_NOTES_FILE"

else
  echo ""
  echo "==> Skipping Zapstore publish (not selected)."
fi # end PUBLISH_ZAPSTORE

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
if ! $PUBLISH_PLAY; then
  echo ""
  echo "==> Skipping Google Play upload (not selected)."
else
  echo ""
  echo "==> Uploading to Google Play Store..."

  PLAY_TRACK="${PLAY_TRACK:-alpha}"
  PLAY_PACKAGE="${BUNDLE_ID:-com.pearcircle}"

  # Locate the AAB — prefer versioned copy, fall back to Gradle output
  PLAY_AAB=""
  if [ -n "${AAB_NAME:-}" ] && [ -f "$REPO_ROOT/$AAB_NAME" ]; then
    PLAY_AAB="$REPO_ROOT/$AAB_NAME"
  elif [ -f "$REPO_ROOT/android/app/build/outputs/bundle/release/app-release.aab" ]; then
    PLAY_AAB="$REPO_ROOT/android/app/build/outputs/bundle/release/app-release.aab"
  fi

  if [ -z "$PLAY_AAB" ]; then
    echo "    ERROR: No AAB found. Run with Google Play selected to build the AAB."
    echo "    Skipping Google Play upload."
  else
    PLAY_AAB_SIZE=$(du -sh "$PLAY_AAB" | cut -f1)
    echo "    Package : $PLAY_PACKAGE"
    echo "    Track   : $PLAY_TRACK"
    echo "    AAB     : $PLAY_AAB ($PLAY_AAB_SIZE)"
    echo "    Version : $APP_VERSION"
    _confirm "Upload $RELEASE_TAG to Google Play ($PLAY_TRACK track)?"

    # --- Obtain OAuth2 Bearer token (gcloud or SA JSON) ---
    # Determine the quota header in the parent shell BEFORE calling _play_token.
    # (_play_token runs in a subshell via $(...) so any variables it sets are lost.)
    # SA JSON tokens don't need x-goog-user-project; ADC user tokens do.
    PLAY_QUOTA_HDR=()
    if [ -z "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] || [ ! -f "${PLAY_SERVICE_ACCOUNT_JSON:-/dev/null}" ]; then
      _adc_proj="${PLAY_QUOTA_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo "")}"
      [ -n "$_adc_proj" ] && PLAY_QUOTA_HDR=(-H "x-goog-user-project: ${_adc_proj}")
    fi

    PLAY_TOKEN=$(_play_token "${PLAY_SERVICE_ACCOUNT_JSON:-}")

    if [ -z "$PLAY_TOKEN" ]; then
      echo "    ERROR: Failed to obtain Google OAuth2 token."
      echo "    Run 'gcloud auth application-default login' or set PLAY_SERVICE_ACCOUNT_JSON."
    else
      echo "    OAuth2 token obtained${_adc_proj:+ (quota project: ${_adc_proj})}."

      BASE_URL="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}"

      # --- Step 1: Create edit ---
      EDIT_RESP=$(curl -s \
        -X POST \
        -H "Authorization: Bearer $PLAY_TOKEN" \
        "${PLAY_QUOTA_HDR[@]}" \
        -H "Content-Type: application/json" \
        "${BASE_URL}/edits" \
        -d '{}')
      EDIT_ID=$(printf '%s' "$EDIT_RESP" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")

      if [ -z "$EDIT_ID" ]; then
        echo "    ERROR: Failed to create Play edit."
        printf '%s\n' "$EDIT_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$EDIT_RESP"
      else
        echo "    Edit created: $EDIT_ID"

        # --- Step 2: Upload AAB ---
        echo "    Uploading AAB..."
        UPLOAD_RESP_FILE=$(mktemp)
        curl \
          -X POST \
          -H "Authorization: Bearer $PLAY_TOKEN" \
          "${PLAY_QUOTA_HDR[@]}" \
          -H "Content-Type: application/octet-stream" \
          "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PLAY_PACKAGE}/edits/${EDIT_ID}/bundles?uploadType=media" \
          --data-binary "@${PLAY_AAB}" \
          --progress-bar \
          -o "$UPLOAD_RESP_FILE" 2>&1
        UPLOAD_RESP=$(cat "$UPLOAD_RESP_FILE"); rm -f "$UPLOAD_RESP_FILE"

        VERSION_CODE=$(printf '%s' "$UPLOAD_RESP" \
          | python3 -c "import sys,json; print(json.load(sys.stdin).get('versionCode',''))" \
          2>/dev/null || echo "")
        UPLOAD_ERR=$(printf '%s' "$UPLOAD_RESP" \
          | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
          2>/dev/null || echo "")

        if [ -n "$UPLOAD_ERR" ]; then
          echo "    ERROR: AAB upload failed: $UPLOAD_ERR"
          printf '%s\n' "$UPLOAD_RESP" | python3 -m json.tool 2>/dev/null

          # Discard the edit to avoid leaving a dangling draft
          curl -sf -X DELETE \
            -H "Authorization: Bearer $PLAY_TOKEN" \
            "${PLAY_QUOTA_HDR[@]}" \
            "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
          echo "    Edit discarded."
        else
          echo "    APK uploaded (versionCode: $VERSION_CODE)"

          # --- Step 3: Assign AAB to track with release notes ---
          # Fit the release notes into Play's 500-char limit on a LINE
          # boundary. `head -c 500` cut mid-word and could leave a dangling
          # markdown heading as the last thing a Play user reads.
          # See RELEASE-PIPELINE.md §3.
          PLAY_NOTES_TEXT=""
          _play_notes_src=""
          if [ -f "${ZSP_NOTES_FILE:-}" ]; then
            _play_notes_src="$ZSP_NOTES_FILE"
          elif [ -f release_notes.md ]; then
            _play_notes_src="release_notes.md"
          fi
          if [ -n "$_play_notes_src" ]; then
            PLAY_NOTES_TEXT=$(NOTES_SRC="$_play_notes_src" python3 -c '
import os, sys

LIMIT = 500
out, used = [], 0
with open(os.environ["NOTES_SRC"], encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        cost = len(line) + 1
        if used + cost > LIMIT:
            break
        out.append(line)
        used += cost
# Drop a heading left dangling at the end with nothing under it
while out and out[-1].lstrip().startswith("#"):
    out.pop()
sys.stdout.write("\n".join(out).strip())
')
          fi

          TRACK_BODY=$(python3 -c "
import json, sys
notes = '''${PLAY_NOTES_TEXT}'''
body = {
  'track': '${PLAY_TRACK}',
  'releases': [{
    'name': '${APP_VERSION}',
    'versionCodes': ['${VERSION_CODE}'],
    'status': 'completed',
    'releaseNotes': [{'language': 'en-US', 'text': notes}]
  }]
}
print(json.dumps(body))
")
          TRACK_RESP=$(curl -s \
            -X PUT \
            -H "Authorization: Bearer $PLAY_TOKEN" \
            "${PLAY_QUOTA_HDR[@]}" \
            -H "Content-Type: application/json" \
            "${BASE_URL}/edits/${EDIT_ID}/tracks/${PLAY_TRACK}" \
            -d "$TRACK_BODY")
          TRACK_ERR=$(printf '%s' "$TRACK_RESP" \
            | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
            2>/dev/null || echo "")

          if [ -n "$TRACK_ERR" ]; then
            PUBLISH_FAILED=true
            echo "    ERROR: Track assignment failed: $TRACK_ERR"
            curl -sf -X DELETE \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${PLAY_QUOTA_HDR[@]}" \
              "${BASE_URL}/edits/${EDIT_ID}" > /dev/null 2>&1 || true
            echo "    Edit discarded."
          else
            echo "    Assigned to $PLAY_TRACK track."

            # --- Step 4: Commit edit ---
            COMMIT_RESP=$(curl -s \
              -X POST \
              -H "Authorization: Bearer $PLAY_TOKEN" \
              "${PLAY_QUOTA_HDR[@]}" \
              "${BASE_URL}/edits/${EDIT_ID}:commit")
            COMMIT_ERR=$(printf '%s' "$COMMIT_RESP" \
              | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" \
              2>/dev/null || echo "")

            if [ -n "$COMMIT_ERR" ]; then
              PUBLISH_FAILED=true
              echo "    ERROR: Commit failed: $COMMIT_ERR"
              echo "    The edit has NOT been committed — no changes made to Play Store."
              printf '%s\n' "$COMMIT_RESP" | python3 -m json.tool 2>/dev/null
            else
              echo ""
              echo "==> Google Play upload complete."
              echo "    Track    : $PLAY_TRACK"
              echo "    Version  : $APP_VERSION ($VERSION_CODE)"
              echo "    View at  : https://play.google.com/console/app/${PLAY_PACKAGE}/releases"
            fi
          fi
        fi
      fi
    fi
  fi
fi # end PUBLISH_PLAY

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
  echo "    Syncing repo to $MAC_MINI (including freshly built bundles)..."
  rsync -az --rsync-path=/opt/homebrew/bin/rsync \
    --exclude='.git' --exclude='node_modules' --exclude='android' \
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

      BUILD_ID=$(asc builds info --app "$ASC_APP_ID" --version "$APP_VERSION" --latest --output json 2>/dev/null \
        | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    item = d.get('data', d) if isinstance(d, dict) else d
    if isinstance(item, list):
        item = item[0] if item else {}
    print(item.get('id', ''))
except Exception:
    print('')" 2>/dev/null || echo "")

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

        # Step 4a: attach build to version (idempotent — re-attaching the
        # same build is a no-op).
        echo "    Attaching build to version..."
        asc versions attach-build --version-id "$VERSION_ID" --build "$BUILD_ID" >/dev/null 2>&1 || \
          echo "    (attach may have already been done — continuing)"

        # Step 4b: create a review submission
        echo "    Creating review submission..."
        SUBMISSION_ID=$(asc review submissions-create --app "$ASC_APP_ID" --platform IOS --output json 2>/dev/null \
          | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    item = d.get('data', d) if isinstance(d, dict) else d
    print(item.get('id', ''))
except Exception:
    print('')" 2>/dev/null || echo "")

        if [ -z "$SUBMISSION_ID" ]; then
          echo "    WARNING: could not create review submission (maybe one already exists)."
          echo "    List in-progress submissions: asc review submissions-list --app $ASC_APP_ID"
          PUBLISH_FAILED=true
        else
          echo "    Submission ID : $SUBMISSION_ID"

          # Step 4c: add the version to the submission.
          # Surface the actual error if items-add fails -- the most common
          # cause is the build missing usesNonExemptEncryption; Info.plist
          # now declares ITSAppUsesNonExemptEncryption=false so new builds
          # come with the flag, but old builds need a one-time asc builds
          # update --build-id <id> --uses-non-exempt-encryption=false.
          echo "    Adding version to submission..."
          ITEMS_ERR=$(asc review items-add \
            --submission "$SUBMISSION_ID" \
            --item-type appStoreVersions \
            --item-id "$VERSION_ID" 2>&1) || {
              if echo "$ITEMS_ERR" | grep -q "already"; then
                echo "    (item already in the submission, continuing)"
              else
                echo "    WARNING: items-add failed:"
                printf '      %s\n' "$ITEMS_ERR"
                echo "    Common fix:"
                echo "      asc builds update --build-id $BUILD_ID --uses-non-exempt-encryption=false"
                echo "      then re-run items-add + submissions-submit"
                PUBLISH_FAILED=true
              fi
            }

          # Step 4d: submit
          echo "    Submitting $SUBMISSION_ID for review..."
          if asc review submissions-submit --id "$SUBMISSION_ID" --confirm; then
            echo "    Submitted for review."

            # ── Step 5: Check review status ──
            echo ""
            echo "==> Checking review status..."
            asc review status --app "$ASC_APP_ID" || true
            echo ""
            echo "    Monitor status:    asc review status --app $ASC_APP_ID"
            echo "    Diagnose issues:   asc review doctor --app $ASC_APP_ID"
          else
            echo "    WARNING: submissions-submit failed."
            echo "    Retry: asc review submissions-submit --id $SUBMISSION_ID --confirm"
            PUBLISH_FAILED=true
          fi
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
if ! $PUBLISH_NOSTR; then
  echo ""
  echo "==> Skipping Nostr announcement (not selected)."
elif $PUBLISH_FAILED; then
  echo ""
  echo "==> Skipping Nostr announcement — one or more publish steps failed."
else
  echo ""
  echo "==> Posting release announcement to Nostr..."

  # Ensure nak is available
  if ! command -v nak &>/dev/null; then
    echo "    nak not found — downloading..."
    NAK_URL=$(curl -s https://api.github.com/repos/fiatjaf/nak/releases/latest \
      | python3 -c "import sys,json; assets=json.load(sys.stdin).get('assets',[]); \
        url=[a['browser_download_url'] for a in assets if 'linux-amd64' in a['name'] and not a['name'].endswith('.sha256')]; \
        print(url[0] if url else '')" 2>/dev/null)
    if [ -z "$NAK_URL" ]; then
      echo "    ERROR: Could not find nak release for linux-amd64. Skipping Nostr step."
      echo "    Install manually: https://github.com/fiatjaf/nak/releases"
    else
      mkdir -p "$HOME/.local/bin"
      curl -sL "$NAK_URL" -o "$HOME/.local/bin/nak"
      chmod +x "$HOME/.local/bin/nak"
      export PATH="$HOME/.local/bin:$PATH"
      echo "    nak installed."
    fi
  fi

  if command -v nak &>/dev/null; then
    # Zapstore Nostr identity
    ZAPSTORE_HEX="78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d"
    ZAPSTORE_NPUB="npub10r8xl2njyepcw2zwv3a6dyufj4e4ajx86hz6v4ehu4gnpupxxp7stjt2p8"

    # Build the "what's new" body from the release notes, PRESERVING the
    # section grouping (Improvements / Bug Fixes / Other) and filling up to a
    # character budget.
    #
    # This replaces the old `head -3`, which took the first three bullets in
    # file order, threw the headings away, and so announced a twelve-PR release
    # as three uncategorised lines while the GitHub release told the full story.
    # See RELEASE-PIPELINE.md §4.
    NOSTR_NOTE_BUDGET="${NOSTR_NOTE_BUDGET:-900}"
    BULLETS=""
    NOTES_SRC=""
    if [ -n "${ZSP_NOTES_FILE:-}" ] && [ -f "${ZSP_NOTES_FILE:-}" ]; then
      NOTES_SRC="$ZSP_NOTES_FILE"
    elif [ -f release_notes.md ]; then
      NOTES_SRC="release_notes.md"
    fi
    if [ -n "$NOTES_SRC" ]; then
      BULLETS=$(NOTES_SRC="$NOTES_SRC" BUDGET="$NOSTR_NOTE_BUDGET" python3 -c '
import os, re, sys

BULLET = "• "
ELLIPSIS = "…"
ITEM_MAX = 120          # a single overlong bullet is trimmed, not dropped

src = os.environ["NOTES_SRC"]
budget = int(os.environ["BUDGET"])

# Parse the notes into [(heading, [items])] in file order. Headings keep their
# emoji so the Nostr note reads the same as the GitHub release.
groups = []
with open(src, encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        m = re.match(r"^#{2,4}\s+(.*)$", line)
        if m:
            title = m.group(1).strip()
            # The document title line is not a section heading
            if title.lower().startswith("what"):
                continue
            groups.append((title, []))
            continue
        m = re.match(r"^\s*[-*]\s+(.+)$", line)
        if m:
            item = m.group(1).replace("**", "").strip()
            if not item:
                continue
            if len(item) > ITEM_MAX:
                cut = item[:ITEM_MAX].rsplit(" ", 1)[0].rstrip(",.;:")
                item = cut + ELLIPSIS
            if not groups:
                groups.append((None, []))
            groups[-1][1].append(item)

out, used, dropped = [], 0, 0
for heading, items in groups:
    kept = []
    for item in items:
        cost = len(BULLET) + len(item) + 1
        if dropped == 0 and used + cost <= budget:
            kept.append(BULLET + item)
            used += cost
        else:
            dropped += 1
    if not kept:
        continue          # never emit a heading with nothing under it
    if heading:
        out.append(heading)
        used += len(heading) + 1
    out.extend(kept)

if dropped:
    out.append("%s%sand %d more" % (BULLET, ELLIPSIS, dropped))

sys.stdout.write("\n".join(out))
')
    fi

    NOTE_CONTENT="${APP_NAME} ${RELEASE_TAG} is out!"$'\n\n'"${APP_TAGLINE:-}"

    if [ -n "$BULLETS" ]; then
      NOTE_CONTENT+=$'\n\n'"What's new:"$'\n'"${BULLETS}"
    fi

    NOTE_CONTENT+=$'\n\n'"${APP_WEBSITE:-}"$'\n\n'"nostr:${ZAPSTORE_NPUB}"$'\n\n'"${NOSTR_HASHTAGS:-}"

    NOSTR_RELAYS=(
      wss://relay.damus.io
      wss://nos.lol
      wss://relay.primal.net
      wss://relay.nostr.net
    )

    # Write note to temp file and open in vi for editing
    NOSTR_DRAFT=$(mktemp /tmp/nostr-note-XXXXXX.txt)
    printf '%s' "$NOTE_CONTENT" > "$NOSTR_DRAFT"
    echo "    Opening note in vi for review/editing..."
    vi "$NOSTR_DRAFT"
    NOTE_CONTENT=$(cat "$NOSTR_DRAFT")
    rm -f "$NOSTR_DRAFT"

    echo "    Final content:"
    echo "$NOTE_CONTENT" | sed 's/^/      /'
    echo ""
    echo "    Relays: ${NOSTR_RELAYS[*]}"

    _confirm "Post this note to Nostr?"

    if nak event --sec "$SIGN_WITH" -k 1 -c "$NOTE_CONTENT" \
        -p "$ZAPSTORE_HEX" \
        "${NOSTR_RELAYS[@]}"; then
      echo "    Nostr announcement posted."
    else
      echo "    WARNING: Nostr publish failed (non-fatal — release is already complete)."
    fi
  fi
fi # end PUBLISH_NOSTR

# ---------------------------------------------------------------------------
# 13. Close-out summary and deferred-action reminders
#
# Every publish step is best-effort past the tag push: a Zapstore outage sets
# PUBLISH_FAILED rather than aborting, so an already-created GitHub release is
# never stranded. That makes a final ledger worth printing, because a partial
# release otherwise scrolls past unnoticed. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
echo ""
echo "==> $APP_NAME $RELEASE_TAG"
_report() { printf '    %-14s %s\n' "$1" "$2"; }
$PUBLISH_GITHUB    && _report "GitHub"    "published" || _report "GitHub"    "skipped"
$PUBLISH_ZAPSTORE  && _report "Zapstore"  "published" || _report "Zapstore"  "skipped"
$PUBLISH_PLAY      && _report "Google Play" "published" || _report "Google Play" "skipped"
$PUBLISH_APP_STORE && _report "App Store" "uploaded"  || _report "App Store" "skipped"
$PUBLISH_NOSTR     && _report "Nostr"     "announced" || _report "Nostr"     "skipped"

if $PUBLISH_FAILED; then
  echo ""
  echo "    WARNING: at least one publish step failed. Scroll up for which."
  echo "    Re-run with --retag to redo the release in place once fixed."
fi

# ---------------------------------------------------------------------------
# 13b. Deferred-action reminders
#
# Surfaces anything the script couldn't auto-complete but isn't actually a
# failure. Today that's the App Store review submission when Apple is still
# processing the uploaded binary (5-15 min). Re-run the manual asc commands
# once processing finishes.
# ---------------------------------------------------------------------------
if $APP_STORE_DEFERRED; then
  echo ""
  echo "==> Reminder: App Store review submission deferred"
  echo "    The IPA uploaded successfully but Apple was still processing"
  echo "    the build when the script checked. Once processing completes"
  echo "    (5-15 min after upload, watch the email or App Store Connect),"
  echo "    submit for review with:"
  echo ""
  echo "      asc versions list --app $ASC_APP_ID --version $APP_VERSION"
  echo "      asc builds info --app $ASC_APP_ID --version $APP_VERSION --latest"
  echo "      asc versions attach-build --version-id <VID> --build <BID>"
  echo "      asc review submissions-create --app $ASC_APP_ID --platform IOS"
  echo "      asc review items-add --submission <SID> --item-type appStoreVersions --item-id <VID>"
  echo "      asc review submissions-submit --id <SID> --confirm"
fi