#!/usr/bin/env bash
# Build the Windows installer for the PearCircle seeder-launcher.
#
# Packs the source, ships it to the win11 build VM, runs the remote
# PowerShell build (scripts/windows-remote-build.ps1), and retrieves the
# NSIS installer .exe with a sha256 sidecar.
#
# Usage:   scripts/build-windows.sh [version]      (default 0.1.0)
#
# Env overrides:
#   WINDOWS_VM_HOST       ssh target (default ben@192.168.50.157)
#   WINDOWS_VM_BUILD_DIR  build dir name on the VM (default pearcircle-seeder-windows)
#
# Requires locally: ssh, scp, tar, iconv, base64, and key-based SSH to the VM.
# Requires on the VM: Node + npm, NSIS (makensis), tar, internet access.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$LAUNCHER_DIR/.." && pwd)

VERSION="${1:-0.1.0}"
VERSION="${VERSION#v}"

WIN_HOST="${WINDOWS_VM_HOST:-ben@192.168.50.157}"
WIN_DIR="${WINDOWS_VM_BUILD_DIR:-pearcircle-seeder-windows}"

echo "==> Preflight: ssh $WIN_HOST"
if ! ssh -o ConnectTimeout=6 -o BatchMode=yes "$WIN_HOST" exit 2>/dev/null; then
  echo "    ERROR: cannot reach $WIN_HOST via key-based SSH." >&2
  exit 1
fi
echo "    OK"

# ---- Pack the source the Windows build needs -------------------------------
# The VM runs `npm install` against the repo-root package.json (worklet
# runtime deps) and the seeder-launcher package.json (esbuild + ui deps),
# so both manifests, src/, and seeder-launcher/ are shipped.
RELEASE_TAR=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$RELEASE_TAR"' EXIT
echo "==> Packing source tree..."
tar -czf "$RELEASE_TAR" -C "$REPO_ROOT" \
  --exclude='seeder-launcher/node_modules' \
  --exclude='seeder-launcher/dist' \
  package.json \
  package-lock.json \
  src \
  seeder-launcher
echo "    Tarball: $(du -sh "$RELEASE_TAR" | cut -f1)"

# ---- Copy to the VM --------------------------------------------------------
echo "==> Copying to ${WIN_HOST}:${WIN_DIR}.tar.gz ..."
scp -q "$RELEASE_TAR" "${WIN_HOST}:${WIN_DIR}.tar.gz"

# ---- Extract + build on the VM ---------------------------------------------
# robocopy /MIR against an empty dir wipes a prior build tree: plain
# Remove-Item -Recurse fails once node_modules nesting pushes paths past
# Windows' 260-char MAX_PATH.
echo "==> Running remote build (this takes several minutes)..."
PS_BLOCK=$(cat <<PSEOF
\$ErrorActionPreference = 'Stop'
\$target = Join-Path \$HOME '$WIN_DIR'
\$tarball = Join-Path \$HOME '$WIN_DIR.tar.gz'
if (Test-Path -LiteralPath \$target) {
  \$empty = New-Item -ItemType Directory -Force -Path (Join-Path \$env:TEMP ("wipe-" + [guid]::NewGuid()))
  try {
    & robocopy \$empty.FullName \$target /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -LiteralPath \$target -Force -Recurse
  } finally {
    Remove-Item -LiteralPath \$empty.FullName -Force -Recurse -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Path \$target | Out-Null
tar -xzf \$tarball -C \$target
Remove-Item -LiteralPath \$tarball
& (Join-Path \$target 'seeder-launcher\\scripts\\windows-remote-build.ps1') -Version '$VERSION' -RepoPath \$target
PSEOF
)
PS_B64=$(printf '%s' "$PS_BLOCK" | iconv -t UTF-16LE | base64 -w0)
ssh "$WIN_HOST" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $PS_B64"

# ---- Retrieve the installer ------------------------------------------------
EXE_NAME="PearCircleSeeder-Setup-${VERSION}.exe"
OUT_DIR="${LAUNCHER_DIR}/dist/windows"
mkdir -p "$OUT_DIR"
echo "==> Retrieving ${EXE_NAME} ..."
scp -q "${WIN_HOST}:${WIN_DIR}/seeder-launcher/dist/windows/${EXE_NAME}" "${OUT_DIR}/${EXE_NAME}"
( cd "$OUT_DIR" && sha256sum "$EXE_NAME" > "${EXE_NAME}.sha256" )

echo ""
echo "==> Done."
echo "    Installer : ${OUT_DIR}/${EXE_NAME}  ($(du -sh "${OUT_DIR}/${EXE_NAME}" | cut -f1))"
echo "    sha256    : $(cut -d' ' -f1 < "${OUT_DIR}/${EXE_NAME}.sha256")"
