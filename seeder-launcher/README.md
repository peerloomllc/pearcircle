# PearCircle Seeder Launcher

Desktop launcher for the PearCircle blind-seeder worklet. Spawns the seed-mode worklet via the bare-runtime CLI, serves a localhost monitoring UI, and ships as a one-click macOS `.pkg` (Linux + Windows installers follow once the Mac shape is validated). See `proposals/2026-05-19-blind-seeder-peers.md` at the repo root for the protocol design.

## What it does

- Runs `bare src/bare.js --seed` as a long-lived subprocess.
- Pipes JSON-newline IPC over the subprocess's stdin/stdout (same envelope BareKit uses on mobile).
- Binds `http://127.0.0.1:8730`, serves a small preact UI + REST/WebSocket bridge.
- Persists identity + per-circle enrollments to a per-OS data directory (Hyperbee on disk).
- Auto-starts at login via a LaunchAgent (macOS); survives logout.

## Architecture

```
Browser (http://127.0.0.1:8730/?t=<token>)
   |
   |  HTTP /api/*   +  WebSocket /ws
   v
Node host (pearcircle-seeder, Node SEA single binary)
   |
   |  JSON-newline IPC over stdin/stdout
   v
bare-runtime CLI → src/bare.js (seed mode)
   |
   |  encrypted Autobase blocks via Hyperswarm
   v
peers (PearCircle members for circles this seeder is enrolled in)
```

Identity layout under the data directory:

```
~/Library/Application Support/PearCircle Seeder/  (macOS)
  store/             Hyperbee on disk: identity:seeder, seeder:enrolled:{id}, seeder:retention:{id}
  auth.token         32-byte hex bearer for the localhost API
  seeder.log         host + worklet log, rotates at 5MB
  launchd.log        captured stdout/stderr of the LaunchAgent
```

## Install (macOS)

### Interim: unsigned .pkg (v0)

Until a Developer ID Installer cert + notarytool keychain profile are in place, the build emits an unsigned `.pkg` that Gatekeeper refuses to open via double-click. Install it from a terminal:

```bash
sudo installer -allowUntrusted -pkg PearCircleSeeder-0.1.0.pkg -target /
```

The post-install script writes `~/Library/LaunchAgents/com.pearcircle.seeder.plist`, chowns it to your user, and runs `launchctl asuser <uid> launchctl load` so the daemon starts in your login session immediately. Open `~/Library/Application Support/PearCircle Seeder/seeder.log` and copy the `UI at` URL (it includes the auth token).

### Final: notarized .pkg (planned)

Once the operator prereqs land:
1. Generate a Developer ID Installer cert at developer.apple.com → Certificates and install in the keychain on the Mac mini.
2. `xcrun notarytool store-credentials pearcircle-seeder-notary --apple-id "<your-id>" --team-id G79ALD29NA --password "<app-specific>"`.

Then build with `APP_SIGN_ID="..." PKG_SIGN_ID="..." bash scripts/build-pkg-macos.sh`. Users double-click the `.pkg` and Gatekeeper allows it.

## Consume a seed invite

1. On a PearCircle member device, open the circle's Settings -> Seeders -> Mint seed invite. Copy the resulting `https://peerloomllc.com/circle/seed?...` URL.
2. In the launcher UI's "Enroll a new circle" panel, paste the invite and click Enroll.
3. On the member device, approve the announcement prompt ("A new seeder wants to join circle X. Approve?").
4. The launcher UI's status panel ticks the byte counter as encrypted blocks replicate.

## Configure retention

Each enrolled circle has a per-circle retention dropdown in the UI (Forever / 30 days / 7 days / 24 hours). Selecting a non-Forever value writes a `seeder:retention:{circleId}` row in the local Hyperbee; the worklet's daily sweep drops Hypercore blocks older than the threshold. Defaults to Forever (no pruning).

## Revoke a seeder

Revocation is owned by members, not the seeder. On any PearCircle member device for that circle, open Settings -> Seeders -> Revoke. The seeder's swarm connection is dropped within one peer event; the launcher UI shows the circle as no longer connecting.

To leave a circle voluntarily from the seeder side (drop the local enrollment row without revocation), use the "Leave" button on the launcher UI's circle row. Members will still see the historical `seeder:{pubkey}` admission row in their autobase view until they revoke explicitly.

## Update

v0 is manual reinstall. Download the new `.pkg` and double-click; the post-install script handles `launchctl unload` + reload. Identity and enrollment state in the data directory are preserved across updates.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.pearcircle.seeder.plist
rm ~/Library/LaunchAgents/com.pearcircle.seeder.plist
sudo rm -rf /usr/local/lib/pearcircle-seeder
rm -rf "~/Library/Application Support/PearCircle Seeder"
```

The last `rm` drops the seeder's identity and all enrollments. To remove just the daemon while keeping the seeder identity, skip the last line; reinstall will pick the existing identity back up.

## Build from source (Mac mini)

Prereqs:
- macOS 12+, Xcode CLT
- Node 20+ on PATH (for the build host — the .pkg payload bundles its own Node 22 LTS, downloaded from nodejs.org on first build into `dist/cache/`)
- Apple Developer ID Application certificate in the keychain, Team G79ALD29NA (signs `node` + `bare` inside the payload; without it both are ad-hoc signed and the install requires `-allowUntrusted`)
- For the fully-notarized .pkg: also a Developer ID Installer cert and a notarytool keychain profile saved as `pearcircle-seeder-notary`:
  ```bash
  xcrun notarytool store-credentials pearcircle-seeder-notary \
    --apple-id "<your-apple-id>" --team-id G79ALD29NA --password "<app-specific-password>"
  ```

Build steps from the repo root:

```bash
# Install repo + launcher deps (must be on macOS so the darwin bare runtime drops)
npm install
cd seeder-launcher && npm install && cd ..

# Build (unsigned .pkg, daemon binaries signed with Developer ID Application)
cd seeder-launcher
APP_SIGN_ID="Developer ID Application: <your name> (G79ALD29NA)" \
  bash scripts/build-pkg-macos.sh

# Or fully notarized once you have the installer cert:
APP_SIGN_ID="Developer ID Application: <your name> (G79ALD29NA)" \
PKG_SIGN_ID="Developer ID Installer: <your name> (G79ALD29NA)" \
  bash scripts/build-pkg-macos.sh
```

Output: `seeder-launcher/dist/macos/PearCircleSeeder-0.1.0.pkg` (~210MB).

## Dev round-trip (any platform)

For local iteration without the .pkg pipeline:

```bash
# In one shell — repo root
cd seeder-launcher
npm install
npm run build:ui
node host/index.js --dev --no-open --port 8730
```

The host spawns `node ../node_modules/bare/bin/bare ../src/bare.js --seed` and serves the UI. Open the `UI at` URL printed to stdout.

Phase 1 smoke (identity persists across two boots):

```bash
bash seeder-launcher/scripts/seed-cli-smoke.sh
```

## Status / what's missing

v0 ships:
- macOS `.pkg` only (Linux + Windows installers in v1)
- Polling-based UI snapshots every 5s (worklet does not yet emit `seeder:connected` / `seeder:disconnected` / `seeder:bytes` events — backfill tracked in pearcircle proper)
- `seeder:enroll` currently surfaces `not-yet-implemented` on the launcher branch's base; real enrollment lands when blind-seeder-peers slices 3c + 3d merge to master (see TODO.md)
- Single-instance only (port 8730 is hard-coded; second instance fails to bind)
- Manual update via reinstall (no auto-updater)
