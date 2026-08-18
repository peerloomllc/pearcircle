# PearCircle Seeder - macOS install

## Install

1. Download the latest `PearCircleSeeder-<version>.pkg` from the
   [releases page](https://github.com/peerloomllc/pearcircle/releases).
2. Double-click it and follow the installer.

The package is signed and notarized by Apple, so Gatekeeper allows it with no extra steps. The installer places the seeder under `/usr/local/lib/pearcircle-seeder`, adds a LaunchDaemon at `/Library/LaunchDaemons/com.pearcircle.seeder.plist`, and starts the background service right away.

It is a system LaunchDaemon rather than a per-user LaunchAgent so that seeding **keeps running when you log out**, which is the whole point of a seeder. It still runs under your own account (`UserName` in the plist), so its identity and circle enrollments stay in your `~/Library/Application Support` exactly as before. Installs made before 2026-08-17 used a LaunchAgent, which was killed at logout; upgrading removes that agent automatically.

## Open the monitoring UI

The UI is protected by an auth token. Find its URL in the seeder log:

```bash
grep 'UI at' "$HOME/Library/Application Support/PearCircle Seeder/seeder.log"
```

Open that URL in a browser to enroll circles and watch replication.

## Update

Download the newer `.pkg` and double-click it. The installer reloads the background service automatically. The seeder identity and circle enrollments under `~/Library/Application Support/PearCircle Seeder` are preserved.

## Uninstall

Easiest: open **Uninstall PearCircle Seeder** from `/Applications` (also in
Launchpad / Spotlight). It asks for an administrator password, lets you keep or
remove the seeder identity, and tears everything down.

From a terminal instead:

```bash
sudo bash /usr/local/lib/pearcircle-seeder/uninstall.sh          # keeps identity (prompts)
sudo bash /usr/local/lib/pearcircle-seeder/uninstall.sh --purge  # also wipes identity
```

Either path removes the seeder LaunchDaemon (and the legacy user LaunchAgent, if
this machine predates 2026-08-17), the program files under
`/usr/local/lib/pearcircle-seeder`, the root auto-updater LaunchDaemon
(`/Library/LaunchDaemons/com.pearcircle.seeder.updater.plist`) and its scratch
dir (`/Library/Application Support/PearCircle Seeder`), the `/Applications`
uninstaller, and any Desktop dashboard shortcut. The seeder identity and circle
enrollments at `~/Library/Application Support/PearCircle Seeder` are kept unless
you choose to remove them, so a reinstall stays the same seeder.

If the program files are already gone, remove the leftovers by hand:

```bash
sudo launchctl bootout system/com.pearcircle.seeder 2>/dev/null
sudo launchctl bootout system/com.pearcircle.seeder.updater 2>/dev/null
launchctl bootout gui/$(id -u)/com.pearcircle.seeder 2>/dev/null   # pre-2026-08-17 installs
rm -f ~/Library/LaunchAgents/com.pearcircle.seeder.plist           # pre-2026-08-17 installs
sudo rm -f /Library/LaunchDaemons/com.pearcircle.seeder.plist
sudo rm -f /Library/LaunchDaemons/com.pearcircle.seeder.updater.plist
sudo rm -rf /usr/local/lib/pearcircle-seeder "/Library/Application Support/PearCircle Seeder"
rm -rf "/Applications/Uninstall PearCircle Seeder.app" "$HOME/Desktop/PearCircle Seeder.app"
# Identity (skip to keep for reinstall):
rm -rf "$HOME/Library/Application Support/PearCircle Seeder"
```

## Build from source

Prereqs on the build Mac:

- macOS 12+ with Xcode command-line tools
- Node 20+ on PATH
- An Apple Developer ID Application certificate in the keychain (Team G79ALD29NA) to sign the binaries inside the package
- For a notarized package: a Developer ID Installer certificate plus a notarytool keychain profile named `pearcircle-seeder-notary`:
  ```bash
  xcrun notarytool store-credentials pearcircle-seeder-notary \
    --apple-id "<apple-id>" --team-id G79ALD29NA --password "<app-specific-password>"
  ```

Build from the repo root:

```bash
npm install
cd seeder-launcher && npm install

APP_SIGN_ID="Developer ID Application: <name> (G79ALD29NA)" \
PKG_SIGN_ID="Developer ID Installer: <name> (G79ALD29NA)" \
  bash scripts/build-pkg-macos.sh
```

Output: `seeder-launcher/dist/macos/PearCircleSeeder-<version>.pkg`.

Omitting `APP_SIGN_ID` and `PKG_SIGN_ID` still produces a `.pkg`, but it is unsigned - install it with `sudo installer -allowUntrusted -pkg <file> -target /`.

## Local development (any platform)

To iterate on the launcher without building a package:

```bash
cd seeder-launcher
npm install
npm run build:ui
node host/index.js --dev --no-open --port 8730
```

The host prints a `UI at` URL on startup.
