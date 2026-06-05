# Seeder update awareness + one-click apply

## Goal
Make a PearCircle blind seeder keep itself current with minimal operator effort. A seeder should (a) know its own version, (b) learn when a newer release exists, (c) tell the operator where they actually look - the mobile app and the localhost UI - and (d) apply the update with a single click, preserving its identity + enrollments. No more "find out by accident, then hand-download from GitHub."

## Tier
T3. It adds a self-updating install path (the seeder downloads + executes a platform installer - a real security surface), adds a version field to the seeder->member wire surface (mixed fleet: old seeders report no version), and is the gating dependency for fleet convergence (e.g. the lastseen-ephemeral phase-2 cutover only engages once every member - including seeders' circles - is on a new-enough build). Proposal + rollback + a clear trust boundary for the downloaded payload are required.

## Background
The seeder runs unattended as a background service on an always-on machine: launchd `KeepAlive` (macOS), an NSSM `LocalSystem` service (Windows), or a `Restart=always` systemd user unit (Linux). Operators rarely open its localhost monitoring UI (`127.0.0.1:8730`).

Today there is **no update mechanism at all**:
- The seeder does not expose its own version anywhere (`seeder:status` returns `{ pubkey, uptime, totalBytesReplicated }`; `seeder-launcher/host/routes.js` `/api/status` just forwards it; the UI shows no version).
- `scripts/release.sh` already publishes every desktop installer (`.pkg` / `.exe` / `.deb` / `.AppImage`) plus `.sha256` sidecars to **GitHub Releases**, and bumps the git tag. But nothing consumes that.
- Operators discover updates by accident and hand-download from the releases page.

This is load-bearing for the rest of the P2P roadmap: features roll out across a fleet that upgrades on its own schedule (lastseen-ephemeral is explicitly two-phase for this reason). A seeder that never updates is a permanent old member that, for its circles, can hold a convergence gate open or miss protocol changes.

## Decisions (2026-06-05)
- **Update channel: the GitHub Releases API.** The seeder polls `api.github.com/repos/<owner>/<repo>/releases/latest`, compares the tag to its running version, and pulls the matching per-platform asset + `.sha256`. Zero new infra - this is exactly where `release.sh` already publishes - and GitHub is not PeerLoom-operated, so it fits the "no servers" principle (self-hosted optional services are wanted, but none is *needed* here). Trade-off accepted: depends on GitHub reachability; the seeder degrades to "couldn't check" silently.
- **Automation: one-click apply, operator-gated.** Notify, then a single "Update now" action downloads the verified asset, stops the service, swaps the payload, and restarts - never a silent fleet-wide auto-deploy, so a bad release can't propagate unattended.
- **Notification surfaces: the mobile app's seeder list AND the localhost UI banner.** The operator looks at the phone, so the phone is the primary surface; the localhost banner covers the case where they do open the UI.

## Scope

### In scope
1. **Version, stamped + exposed.** Embed the build version (from `seeder-launcher/package.json` / the git tag) into the host bundle at build time (`build-host-sea.sh`). Expose it through `seeder:status` -> `/api/status` -> the localhost UI, and report it to circle members over the existing **seeder-admission channel** (a new additive field/message) so the phone can show it.
2. **Update check (GitHub Releases API).** A background poll in the host process (hourly, cached, failure-tolerant) that resolves the latest release tag, selects this platform's asset, and exposes `{ currentVersion, latestVersion, updateAvailable, assetUrl, sha256Url }` via a new authenticated `/api/update` route + the WebSocket snapshot.
3. **Notification surfaces.**
   - *Localhost UI:* an "Update available -> Update now" banner in `seeder-launcher/ui` `App.jsx`.
   - *Mobile app:* the seeder list shows each seeder's version and an "update available / out of date" flag, fed by the version reported over the admission channel. (Determining "newer exists" can be done app-side against the same GitHub API, or relayed from the seeder's own check.)
4. **One-click apply.** A new authenticated `POST /api/update/apply` on the host that: downloads the platform asset + `.sha256`, verifies the hash (macOS additionally relies on the notarized `.pkg` + Gatekeeper), then runs the platform install + service restart, preserving the data dir (identity + enrollments live in the OS data dir, untouched by reinstall):
   - *Windows:* the NSSM service already runs as `LocalSystem` and the NSIS installer has a stop -> swap -> re-register -> start upgrade path; the service can drive its own update.
   - *Linux AppImage:* user-owned payload swap + `systemctl --user restart` - no root needed.
   - *macOS `.pkg` / Linux `.deb`:* need root, which is the known blocker (`installer -pkg` / `dpkg -i` both need sudo, and the seeder runs unprivileged). See Open questions - the likely answer is a small privileged updater helper installed once at first install.

### Does not change
- The blind-seeder protocol, encryption, admission/revocation semantics, retention. Only an additive version field rides the admission channel.
- Mobile-app self-update (Play / Zapstore / App Store handle that). This proposal surfaces seeder versions in the app and may later extend the same "peer is out of date" visibility to member peers, but the app's own update path is out of scope.

### Trust boundary
The downloaded payload is executed, so integrity matters. Boundary: HTTPS to GitHub + the published `.sha256`, scoped to the official repo's releases, plus macOS notarization (Gatekeeper verifies the `.pkg`). Windows/Linux artifacts are unsigned today, so HTTPS+sha256-from-the-same-release is the integrity guarantee. A signed release manifest (or signing the Windows/Linux artifacts) is a future hardening, required before any non-operator-gated automation.

## Compat
- **Old seeders report no version.** The mobile app shows "version unknown - update recommended" for a seeder that predates slice 1. The admission-channel version field is additive and optional, so old members/seeders interoperate unchanged.
- **Old seeders lack the apply route.** The operator updates such a seeder manually once; from then on it self-updates. No fleet coordination needed.
- The update check is fail-open (a GitHub outage just means "couldn't check", never a block on replication).

## Verify
- `npm run verify` green; new `node` tests: version comparison / asset selection from a GitHub releases JSON fixture; "updateAvailable" computed correctly across equal / older / newer / malformed tags; sha256 verification rejects a tampered asset.
- Seeder smoke: a seeder reports its version over `seeder:status` and to a connected member; the member-side surfaces "update available" against a stubbed latest version.
- Per-platform apply smoke (manual, on a real host per platform): "Update now" downloads + verifies + swaps + restarts, and the seeder comes back with the **same** pubkey + enrollments (data dir preserved) on the new version.
- Negative: a sha256 mismatch aborts the apply and leaves the running service untouched.

## Rollback
Entirely additive. Disable the background check with a config flag (`config:updateCheck.enabled=false`); the apply route is operator-gated, so nothing self-applies. Reverting the slices restores the current manual-download flow with no peer-visible change.

## Slice plan
- **Slice 1 - version visibility (shipped, PR #82):** stamp the build version; expose it via `seeder:status` + `/api/status` + the localhost UI; report it over the seeder-admission channel; the mobile app shows each seeder's version.
- **Slice 2 - update check + notification (shipped, PR #82):** the host's GitHub-Releases poll + `/api/update` + WS snapshot; the localhost "Update available" banner; the mobile app's "update available / out of date" flag (the phone fetches the latest tag itself). Notify-only. Shared pure logic in `src/lib/seederUpdateCheck.js` (numeric compare + **arch-aware** asset selection). Validated against the live repo.
- **Slice 3a - apply core + self-apply (shipped, PR #82):** `seeder-launcher/host/updateApply.js` - download the chosen asset, **verify it against the release `.sha256` sidecar** (a tampered/wrong asset is rejected and nothing is installed), then dispatch to a per-platform applier. `POST /api/update/apply` + a stateful `UpdateApplier` + the localhost "Update now" button. The no-privilege Linux-AppImage self-apply (swap + `systemctl --user restart`) and the Windows command plan are implemented; macOS `.pkg` / Linux `.deb` raise `NeedsHelperError` so the route falls back to a verified download until 3b. Tested incl. the integrity boundary; the real v1.0.10 AppImage was downloaded + verified end-to-end on Linux.
- **Slice 3b - privileged helper + per-platform apply on-device (pending):** the install-once root helper (decided: macOS `LaunchDaemon`; Linux a root-owned updater + polkit action) so `.pkg`/`.deb` apply one-click without re-prompting sudo, wired into the installers (`build-pkg-macos.sh` / `postinstall-macos.sh` / the `.deb` postinst). Plus on-device validation of every applier: macOS `.pkg` (Mac mini), Windows service self-apply (Windows VM), Linux AppImage on an installed systemd service. Security-critical; the helper must re-verify the payload and authenticate the request from the unprivileged host.

## Open questions
- **macOS / Linux-deb privilege (decided 2026-06-05: install-once helper).** A small privileged updater installed at first install (macOS `LaunchDaemon` running as root; Linux a polkit action or root-owned updater dropped by the `.deb` postinst) so subsequent updates apply one-click without re-prompting sudo. The remaining design work (slice 3b) is scoping it tightly: the helper re-verifies the payload (sha256 + macOS notarization), accepts an apply request only from the local unprivileged host, and does nothing else.
- **Where the "newer exists" decision lives** for the mobile surface: the phone querying the GitHub API itself, vs. relaying the seeder's own check result over the admission channel (works even when the phone has no GitHub access, but trusts the seeder's claim).
- **Version skew between seeder-launcher (`0.1.0`) and the mobile app (`1.0.x`).** They are built and released together by `release.sh` under one git tag; align the seeder-launcher version to the release tag so "latest" is unambiguous.
- **Reaching a seeder the app admits but isn't currently connected to** - the version/flag is only as fresh as the last connection. Acceptable (it is advisory), but note it.
