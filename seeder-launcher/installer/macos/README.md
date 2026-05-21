# PearCircle Seeder - macOS install

## Install

1. Download the latest `PearCircleSeeder-<version>.pkg` from the
   [releases page](https://github.com/peerloomllc/pearcircle/releases).
2. Double-click it and follow the installer.

The package is signed and notarized by Apple, so Gatekeeper allows it with no extra steps. The installer places the seeder under `/usr/local/lib/pearcircle-seeder`, adds a LaunchAgent at `~/Library/LaunchAgents/com.pearcircle.seeder.plist`, and starts the background service in your login session right away.

## Open the monitoring UI

The UI is protected by an auth token. Find its URL in the seeder log:

```bash
grep 'UI at' "$HOME/Library/Application Support/PearCircle Seeder/seeder.log"
```

Open that URL in a browser to enroll circles and watch replication.

## Update

Download the newer `.pkg` and double-click it. The installer reloads the background service automatically. The seeder identity and circle enrollments under `~/Library/Application Support/PearCircle Seeder` are preserved.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.pearcircle.seeder.plist
rm ~/Library/LaunchAgents/com.pearcircle.seeder.plist
sudo rm -rf /usr/local/lib/pearcircle-seeder
rm -rf "$HOME/Library/Application Support/PearCircle Seeder"
```

The last line removes the seeder identity and all enrollments. Skip it to keep the identity for a later reinstall.

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
