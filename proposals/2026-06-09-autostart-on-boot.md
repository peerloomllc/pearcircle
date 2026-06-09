# Autostart on boot and update - resume background sharing without reopening the app

**Status**: DRAFT 2026-06-09. Filed in response to issue #89 ("Does not autostart" - GrapheneOS, Android 16, v1.0.13: after a reboot or an app update the background service does not come back until the app is opened manually). Android-only.

**Goal**: After a device reboot or an in-place app update, automatically resume background location sharing for users who have sharing enabled in at least one circle, without requiring them to reopen the app.

**Tier**: T2. No wire-protocol change, no new replicated record, no IPC shape change. It is a process-lifecycle change: a new boot/update `BroadcastReceiver`, the `RECEIVE_BOOT_COMPLETED` permission, and a way to bring up the Bare worklet headlessly (without `MainActivity`). The load-bearing risk is local data integrity (the Hyperbee/Autobase store must never be opened twice in one process), so this proposal carries an RCA-readiness section despite being T2.

## Background

The worklet is the P2P backend - it owns the identity keypair, the per-circle Autobase, and the Hyperswarm topics. Today it is created **only inside the Activity's React tree**: `startWorklet()` at `app/index.tsx:376` runs when the `Index` component mounts, which happens when `MainActivity` launches.

The native `PearCircleLocationService` (foreground, type `location`) keeps the **process** alive while the Activity is backgrounded, and forwards fixes to the worklet via `PearCircleLocationModule.instance?.emitToJs()`. The service's own comment is explicit (`PearCircleLocationService.kt:35`): "When the React context is gone ... the emit is a silent no-op", and `onStartCommand` notes (line 76) "Cold-start-from-boot is a separate slice."

So the current state after a reboot or update is:

- No `RECEIVE_BOOT_COMPLETED` permission and no receiver for `BOOT_COMPLETED` or `MY_PACKAGE_REPLACED` exist in the manifest. Nothing is triggered.
- Even if a receiver started the FGS, there would be **no worklet** to receive fixes (no Activity = no React context = `instance` null). Location would be collected into a dead bridge: no Hyperswarm, no replication, no actual sharing.

This is why issue #89 reproduces for every Android user who reboots, not just GrapheneOS. It is not a missing manifest line; it is that the worklet lifecycle is bound to the Activity.

iOS is out of scope and already covered differently: iOS has no boot broadcast, but the OS relaunches a force-quit app for region/SLC/visit location events (proposals 2026-05-16, 2026-05-30), which brings the React context and worklet back. The Android gap has no equivalent free relaunch.

## Scope

In scope (Android):

- **Headless worklet host.** A `HeadlessJsTaskService` plus a registered headless JS task that starts the worklet and the location IPC plumbing **without** mounting the WebView UI. The task reuses the existing `startWorklet()` singleton and the location-module wiring already in `app/index.tsx`, factored so both the Activity path and the headless path call one shared bootstrap. Within one process the JS module registry is shared, so the `_workletStarted` / `_worklet` singleton (`app/index.tsx:297`) guarantees one worklet whether the Activity or the headless task starts it first.
- **Boot/update receiver.** A `BroadcastReceiver` for `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`. On receipt it checks a natively-readable "should autostart" gate (below); if set, it starts the FGS, which (or alongside which) the headless task brings up the worklet.
- **Native-readable autostart gate.** The shell already knows whether sharing is enabled anywhere (`anyEnabled` on `sharing:changed`, `app/index.tsx:624`). Mirror that boolean into `SharedPreferences` (e.g. `autostart_enabled`) whenever it changes, so the receiver can decide whether to spin anything up **before** paying to start the JS context. Default false until the worklet has run once and reported sharing state.
- **Manifest**: add `RECEIVE_BOOT_COMPLETED`; declare the receiver (`exported="true"`, the boot/update actions) and the `HeadlessJsTaskService`.
- **FGS-start hardening.** Wrap the boot-time `startForegroundService` in the documented Android 12+ background-start exemption path and catch `ForegroundServiceStartNotAllowedException` so a refusal logs and no-ops instead of crashing.
- **Verify + tests** per Constitution Section 5.

Out of scope:

- **iOS.** Covered by region/SLC/visit relaunch; no boot concept. No change.
- **Autostart after a fresh install that was never opened, or after a force-stop.** Android holds such apps in the "stopped state" and delivers them no broadcasts (including `BOOT_COMPLETED`) until the user launches the app once. This is an OS rule we cannot bypass; documented, not fixed.
- **Direct-boot / pre-unlock start** (`LOCKED_BOOT_COMPLETED`). The Hyperbee store lives in credential-encrypted storage and is unreadable until first unlock, so we wait for `BOOT_COMPLETED`.
- **Any change to what is replicated or how peers talk.** Purely local lifecycle.

## Compat

- **No wire effect.** Old and new peers are indistinguishable on the swarm. No record kind added, no apply-rule change, no migration.
- **Old build on a device**: behaves as today (manual reopen). New build: autostarts when the gate is set.
- **Downgrade**: an older build simply lacks the receiver; the leftover `SharedPreferences` key is inert.

## Design

### Shared bootstrap, two entry points

Factor the worklet + location bring-up out of the `Index` component into a module-level `ensureBackendStarted()` that is idempotent on the existing singleton:

```
ensureBackendStarted():
  if _workletStarted: return            // singleton guard (already present)
  await startWorklet()                  // opens identity, Autobase, swarm
  wire location-module IPC + notification scheduling   // the non-UI parts of Index's effects
```

- **Activity path**: `Index` mounts -> `ensureBackendStarted()` (as today) -> also renders the WebView UI.
- **Headless path**: boot/update receiver -> `HeadlessJsTaskService` -> registered task -> `ensureBackendStarted()`. No WebView. If the user later opens the app, `Index` mounts, the singleton is already up, the UI just attaches.

Because HeadlessJS and the Activity share one `ReactHost` / JS runtime per process, there is exactly one `_worklet` and therefore one writer on the Autobase. The FGS keeps the process (and thus the worklet) alive after the headless task's own callback returns.

### Receiver and gate

```
onReceive(BOOT_COMPLETED | MY_PACKAGE_REPLACED):
  if not SharedPreferences.autostart_enabled: return
  if not hasLocationPermission(): return
  try: PearCircleLocationService.start(ctx)   // FGS; brings up headless task
  catch ForegroundServiceStartNotAllowedException: log, return
```

The gate is written by the shell on every `sharing:changed` and on `ready`, mirroring `anyEnabled`. This keeps the boot path from starting an FGS (and showing the ongoing notification) for someone who has sharing off everywhere.

### Single-writer safety

The one hazard worth the RCA section: two worklets opening the same Autobase writer core would corrupt the local view (see the storage-reclaim finding, DECISIONS 2026-05-29 / memory). Mitigations:

1. The JS singleton (`_workletStarted`) is the primary guard - one process, one worklet.
2. A process-level start lock around `ensureBackendStarted()` so a near-simultaneous Activity-mount and headless-task cannot both pass the guard.
3. The headless task and Activity never run in separate processes (no `android:process` on the service/receiver), so they share the runtime and the guard actually applies.

## Verify

Per Constitution Section 5, `npm run verify` (jest + bundle builds) green.

New/changed tests:

- `tests/backendBootstrap.test.js` - `ensureBackendStarted()` is idempotent: a second call (simulating Activity-after-headless) does not create a second worklet and does not reopen the store; the start lock serializes concurrent callers.
- A test that the shell writes the `autostart_enabled` mirror on `sharing:changed` (true when `anyEnabled`, false otherwise) and on global stop.

Manual smoke (Android; D2/Pixel and a second device):

1. **Reboot resume**: with sharing on in a circle, reboot the phone, do **not** open the app. Within a short window the ongoing notification reappears and a co-online peer sees the device's `lastSeen` refresh. Pull the store and confirm one writer, no view corruption.
2. **Update resume**: `adb install -r` a new build over a running one (sharing on). Confirm the service comes back without opening the app.
3. **Sharing-off gate**: stop sharing everywhere, reboot. No notification, no FGS, no worklet. Battery clean.
4. **Stopped-state caveat**: fresh install, reboot before ever opening. Confirm no autostart (expected), then open once, reboot again, confirm autostart now works.
5. **Permission revoked**: revoke location, reboot. Receiver no-ops (no crash), no FGS.
6. **GrapheneOS**: repeat 1-3 on a GrapheneOS device; confirm `RECEIVE_BOOT_COMPLETED` is honored and the FGS survives as expected.
7. **Verify gate** green; build APK, install, validate on device, wait for user sign-off before PR (project convention).

## Rollback

Trivially reversible. Remove the receiver, the permission, and the `HeadlessJsTaskService` declaration; behavior reverts to manual-reopen. No persisted data shape changed (the `SharedPreferences` flag is inert without the receiver). No store migration, nothing baked into blocks.

## RCA readiness

- **Double-open store corruption** (the real risk): bounded by the JS singleton + process-level start lock + single-process guarantee. The most important test is smoke #1's "one writer, no corruption" check.
- **Battery / notification on every boot**: gated on `autostart_enabled`; off-sharing users get nothing.
- **FGS-start refusal** on some OEM/version: caught and logged, never a crash; the user can still resume by opening the app.
- **GrapheneOS**: no extra boot restriction beyond AOSP; users may disable per-app autostart, which is their choice and degrades to today's behavior.
- **Stopped-state**: documented limitation, not a regression - it is current behavior for the never-opened and force-stopped cases.

A `DECISIONS.md` row records: the worklet may be hosted headlessly via HeadlessJS for boot/update resume; single-writer integrity is preserved by the per-process singleton + start lock; autostart is gated on a natively-readable sharing flag; fresh-install/force-stop autostart is an OS-imposed non-goal.

## Open questions

- **Q1: HeadlessJS task vs a native-hosted Bare worklet in the service?** Recommend HeadlessJS - it reuses the existing JS IPC plumbing and shares the `_worklet` singleton, where a native host would duplicate the dispatch/notification layer and reintroduce the double-open risk across a native/JS boundary.
- **Q2: Where does the autostart gate live - `SharedPreferences` mirror, or read AsyncStorage's store natively?** Recommend a small `SharedPreferences` mirror written by the shell; it is the cleanest native-readable signal and avoids coupling to AsyncStorage internals.
- **Q3: Should `MY_PACKAGE_REPLACED` autostart even if the app was backgrounded-not-open at update time?** Recommend yes when the gate is set; the update broadcast itself clears the stopped state, so it is the right moment to resume.
- **Q4: Any delay/backoff after `BOOT_COMPLETED` before starting the FGS** (to let the network and location stack settle)? Recommend a short fixed delay, tuned on device, rather than starting in the boot storm.
