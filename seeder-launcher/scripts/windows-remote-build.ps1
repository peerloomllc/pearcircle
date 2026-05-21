# PearCircle Seeder - Windows build (runs on the build VM).
#
# Invoked by scripts/build-windows.sh over SSH. Assembles the install
# payload (bundled Node runtime, esbuilt host, bare.exe, worklet tree,
# pruned node_modules, UI) and compiles the NSIS installer.
#
#   windows-remote-build.ps1 -Version <x.y.z> -RepoPath <extracted source root>
#
# Requires on the VM: Node + npm, NSIS (makensis), tar, internet access.

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$RepoPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # speeds up Invoke-WebRequest
$NodeVersion = '22.20.0'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Error $msg; exit 1 }

# Wipe a directory tree that may contain paths past Windows' 260-char
# MAX_PATH (deep node_modules nesting). robocopy mirrors an empty dir into
# the target, shortening every path, after which the root removes cleanly.
function Remove-Tree-Long([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $empty = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("wipe-" + [guid]::NewGuid()))
  try {
    & robocopy $empty.FullName $Path /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -LiteralPath $Path -Force -Recurse
  } finally {
    Remove-Item -LiteralPath $empty.FullName -Force -Recurse -ErrorAction SilentlyContinue
  }
}

$repo     = (Resolve-Path $RepoPath).Path
$launcher = Join-Path $repo 'seeder-launcher'
$winDir   = Join-Path $launcher 'installer\windows'
if (-not (Test-Path $launcher)) { Fail "seeder-launcher not found under $repo" }

# --- 1. Install dependencies -------------------------------------------------
Step "npm install (repo root - worklet runtime deps + bare-runtime-win32-x64)"
Push-Location $repo
& npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail "repo-root npm install failed ($LASTEXITCODE)" }
Pop-Location

Step "npm install (seeder-launcher - esbuild, preact, ws)"
Push-Location $launcher
& npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail "seeder-launcher npm install failed ($LASTEXITCODE)" }
Pop-Location

# --- 2. Build the UI bundle --------------------------------------------------
Step "build UI bundle"
Push-Location $launcher
& node ui\build.js
if ($LASTEXITCODE -ne 0) { Fail "ui build failed ($LASTEXITCODE)" }
Pop-Location

# --- 3. esbuild the host into a single CJS file ------------------------------
Step "bundle host (esbuild)"
Push-Location $launcher
& npx esbuild host/index.js --bundle --platform=node --target=node20 --format=cjs --outfile=dist/host-bundled.js
if ($LASTEXITCODE -ne 0) { Fail "host bundle failed ($LASTEXITCODE)" }
Pop-Location

# --- 4. Fetch the pinned Node.js runtime for Windows -------------------------
Step "stage Node.js $NodeVersion (win-x64)"
$nodePkg  = "node-v$NodeVersion-win-x64"
$cacheDir = Join-Path $launcher 'dist\cache'
$nodeExe  = Join-Path $cacheDir "$nodePkg\node.exe"
if (-not (Test-Path $nodeExe)) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $zip = Join-Path $cacheDir "$nodePkg.zip"
  $url = "https://nodejs.org/dist/v$NodeVersion/$nodePkg.zip"
  Write-Host "downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $cacheDir -Force
  Remove-Item $zip
}
if (-not (Test-Path $nodeExe)) { Fail "node.exe missing after extract: $nodeExe" }

# --- 5. Locate the bare runtime ----------------------------------------------
$bareExe = Join-Path $repo 'node_modules\bare-runtime-win32-x64\bin\bare.exe'
if (-not (Test-Path $bareExe)) {
  Fail "bare.exe not found at $bareExe - is bare-runtime-win32-x64 installed?"
}

# --- 6. Assemble the payload -------------------------------------------------
Step "assemble payload"
$stage   = Join-Path $launcher 'dist\windows\stage'
$payload = Join-Path $stage 'payload'
Remove-Tree-Long $stage
New-Item -ItemType Directory -Force -Path $payload, (Join-Path $payload 'ui\dist') | Out-Null

# 6a. Top-level binaries + installer resources.
Copy-Item $nodeExe                                     (Join-Path $payload 'node.exe')
Copy-Item $bareExe                                     (Join-Path $payload 'bare.exe')
Copy-Item (Join-Path $launcher 'dist\host-bundled.js') (Join-Path $payload 'host-bundled.js')
Copy-Item (Join-Path $winDir 'nssm.exe')               (Join-Path $payload 'nssm.exe')
Copy-Item (Join-Path $winDir 'open-ui.vbs')            (Join-Path $payload 'open-ui.vbs')
Copy-Item (Join-Path $winDir 'AppIcon.ico')            (Join-Path $payload 'AppIcon.ico')

# 6b. Worklet JS tree (repo src/ minus the mobile WebView UI and tests).
$worklet = Join-Path $payload 'worklet'
& robocopy (Join-Path $repo 'src') $worklet /E /XD ui /XF *.test.js /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "robocopy worklet failed ($LASTEXITCODE)" }

# 6c. node_modules for the worklet. Skip the mobile/dev giants on copy,
#     then prune the wildcard families and foreign-platform prebuilds.
#     bare-runtime-* is dropped entirely - the host runs the bare.exe at
#     the payload root, so the bundled copy is dead weight.
$wmn = Join-Path $worklet 'node_modules'
$xd  = @('react-native','@react-native','react-native-bare-kit','expo','@expo',
         'jest','@jest','@babel','@types','esbuild','@esbuild','metro','@metro',
         '@maplibre','bare-pack','eslint',
         'bare-runtime-darwin-arm64','bare-runtime-darwin-x64',
         'bare-runtime-linux-arm64','bare-runtime-linux-x64',
         'bare-runtime-win32-arm64','bare-runtime-win32-x64')
& robocopy (Join-Path $repo 'node_modules') $wmn /E /XD $xd /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "robocopy node_modules failed ($LASTEXITCODE)" }

# Prune the wildcard package families that the exact-name /XD missed.
# Remove-Tree-Long handles deep trees: expo-modules-autolinking nests
# Kotlin sources past MAX_PATH, which plain Remove-Item cannot delete.
Get-ChildItem -Path $wmn -Directory -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^(react-native-|expo-|jest-|babel-|metro|eslint)'
} | ForEach-Object { Remove-Tree-Long $_.FullName }

# Prune native prebuilds for every platform except win32-x64.
Get-ChildItem -Path $wmn -Recurse -Directory -Filter prebuilds -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem -Path $_.FullName -Directory |
    Where-Object { $_.Name -ne 'win32-x64' } | ForEach-Object { Remove-Tree-Long $_.FullName }
}

# 6d. UI.
Copy-Item (Join-Path $launcher 'ui\index.html')     (Join-Path $payload 'ui\index.html')
Copy-Item (Join-Path $launcher 'ui\dist\app.js')    (Join-Path $payload 'ui\dist\app.js')
Copy-Item (Join-Path $launcher 'ui\dist\style.css') (Join-Path $payload 'ui\dist\style.css')

# --- 7. Compile the NSIS installer ------------------------------------------
Step "compile NSIS installer"
Copy-Item (Join-Path $winDir 'installer.nsi') (Join-Path $stage 'installer.nsi')

$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $makensis) {
  foreach ($c in @("$env:ProgramFiles\NSIS\makensis.exe",
                    "${env:ProgramFiles(x86)}\NSIS\makensis.exe")) {
    if (Test-Path $c) { $makensis = $c; break }
  }
}
if (-not $makensis) { Fail "makensis not found - install NSIS on the build VM" }

Push-Location $stage
& $makensis "/DVERSION=$Version" installer.nsi
if ($LASTEXITCODE -ne 0) { Fail "makensis failed ($LASTEXITCODE)" }
Pop-Location

# --- 8. Collect the output ---------------------------------------------------
$outName = "PearCircleSeeder-Setup-$Version.exe"
$built   = Join-Path $stage $outName
if (-not (Test-Path $built)) { Fail "installer not produced: $built" }

$distDir = Join-Path $launcher 'dist\windows'
$final   = Join-Path $distDir $outName
Move-Item -Force $built $final

$hash = (Get-FileHash -Algorithm SHA256 -Path $final).Hash.ToLower()
$size = '{0:N1} MB' -f ((Get-Item $final).Length / 1MB)
Write-Host "`n==> built  $final  ($size)" -ForegroundColor Green
Write-Host "==> sha256 $hash"
