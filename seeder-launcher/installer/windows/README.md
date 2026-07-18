# PearCircle Seeder - Windows install

## Install

1. Download the latest `PearCircleSeeder-Setup-<version>.exe` from the
   [releases page](https://github.com/peerloomllc/pearcircle/releases).
2. Run it. The installer is not yet signed, so Windows SmartScreen shows a "Windows protected your PC" notice - click **More info**, then **Run anyway**.
3. Follow the installer.

The installer places the files under `C:\Program Files\PearCircle Seeder`, registers a `PearCircleSeeder` Windows service (auto-start, runs as LocalSystem), and starts it right away. Because it runs as a machine service, one seeder serves the whole computer and its data lives under `C:\ProgramData\PearCircle Seeder`.

## Open the dashboard

Open **PearCircle Seeder** from the Start Menu. It opens the monitoring UI (`http://127.0.0.1:8730`) in your browser with the API token filled in - use it to enroll circles and watch replication.

## Update

The seeder checks GitHub Releases hourly and surfaces a newer version in the monitoring dashboard (and in the mobile app's seeder list). Click **Update now** to apply it one-click: the LocalSystem service (already privileged) downloads the new `Setup.exe`, verifies its SHA-256 against the release's `.sha256` sidecar, and runs it silently (`/S`). The installer stops the old service, overwrites the files - silent mode shows no UI and never launches the browser - re-registers the service, and starts it again. It is launched detached (via WMI) so the service stop the installer itself triggers can't reap it mid-swap. The integrity boundary is HTTPS to GitHub plus the release `.sha256` (Windows artifacts are unsigned).

You can still update by hand: run the newer `PearCircleSeeder-Setup-<version>.exe`. Either way the seeder identity and circle enrollments under `C:\ProgramData\PearCircle Seeder` are preserved.

## Uninstall

Uninstall **PearCircle Seeder** from Settings > Apps > Installed apps, or run `Uninstall.exe` in the install folder. This stops and removes the service and deletes the program files.

The data directory `C:\ProgramData\PearCircle Seeder` is left in place so a reinstall keeps the seeder identity. Delete that folder by hand for a full wipe.

## Build from source

The Windows installer is a cross-build: every binary in the payload is a
prebuilt Windows artifact (`node.exe` from nodejs.org, `bare.exe` from the
`bare-runtime-win32-x64` npm package, `nssm.exe` checked into the repo), the
worklet is cross-packed with `bare-pack --host win32-x64`, and the only compile
step is `makensis`. Nothing has to *run* on Windows, so you can build it two
ways.

### On Linux / macOS - no VM (recommended)

`makensis` runs natively on Linux/macOS and the stock MUI2 + nsExec plugins the
installer uses ship with it, so the whole thing builds locally.

Prereqs:

- Node.js and npm
- NSIS (`makensis`) - Fedora: `dnf install mingw32-nsis`; Debian/Ubuntu: `apt install nsis`; macOS: `brew install makensis`
- `curl`, `tar`, `unzip`

One-time: the `bare-runtime-win32-x64` package is an optional npm dep gated to
`os=win32`, so a normal `npm install` on a non-Windows host *skips* it. Force it
into the repo `node_modules` once:

```bash
npm install bare-runtime-win32-x64 --os=win32 --cpu=x64 --force --no-save
```

Then build:

```bash
cd seeder-launcher
bash scripts/build-windows-local.sh          # or: bash scripts/build-windows-local.sh 0.1.0
```

The installer lands in `seeder-launcher/dist/windows/` with a `.sha256` sidecar.

### On a Windows build VM (original path)

Prereqs on the VM (Windows 10 or 11): Node.js + npm, NSIS (`makensis`), `tar`
(built in on Windows 10+), and key-based SSH from the build host.

```bash
cd seeder-launcher
bash scripts/build-windows.sh          # or: bash scripts/build-windows.sh 0.1.0
```

`build-windows.sh` packs the source, ships it to the VM (`WINDOWS_VM_HOST`,
default `ben@192.168.50.157`), runs `scripts/windows-remote-build.ps1` there,
and retrieves the installer to `seeder-launcher/dist/windows/`.

Either way the installer is currently unsigned, so SmartScreen warns on first
run. Authenticode signing is a later step.
