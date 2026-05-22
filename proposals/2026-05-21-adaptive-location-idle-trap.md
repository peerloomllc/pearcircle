# iOS adaptive location: close the idle-trap so trip starts escalate promptly

**Status**: Draft 2026-05-21. Awaiting approval.

**Goal**: Make an iPhone leave `idle` (SLC-only) for `tracking` (continuous) the moment a trip actually starts, instead of staying blind until roughly 500m of movement has accumulated. Do it without bringing back the 24/7 GPS drain the 2026-05-16 adaptive design removed.

**Tier**: T1. App-logic plus a native CoreMotion subscription, inside the existing data model. No wire change, no new Hyperbee keys, no new replicated records, so old-code and new-code peers talk identically. Proposal is optional under Constitution §3 (T1); written because it amends the proposal-governed 2026-05-16 adaptive-location design and changes when a moving member's first fresh `lastSeen` reaches peers.

## Background

The 2026-05-16 adaptive-location design (`proposals/2026-05-16-ios-adaptive-location.md`) runs `CLLocationManager` in two modes: `idle` (significant-location-change only) while the trip detector is idle, and `tracking` (SLC plus continuous high-accuracy) while a trip is arming, active, or in cooldown. The worklet drives the mode from `tripState.phase`, recomputed in the `location:update` handler via `nextEmittedMode` (`src/lib/locationMode.js`, `src/bare.js`).

Two things have since gone wrong with that design:

1. **The heartbeat it relied on was removed.** The 2026-05-16 proposal calls the 15s heartbeat "load-bearing" for keeping an idle device's `lastSeen` timestamp fresh while SLC is silent. The 2026-05-17 swarm-live-signal change removed the heartbeat; the swarm-connected dot now carries the "is this peer live" signal. The freshness-display job is covered, but the periodic republish is gone.

2. **The idle-trap.** This is the real defect. In `idle` mode continuous updates are off, so `location:update` fires only on Apple's SLC events (~500m granularity). The trip detector (`stepTrip`) runs only inside the `location:update` handler, and the mode is recomputed only there. So once the device is `idle` the trip detector is starved: it gets no samples until the device has already moved ~500m and SLC finally delivers a fix. Consequences:
   - A trip shorter than ~500m is never detected. No escalation, no polyline, the member's pin never moves for its duration.
   - A longer trip is detected ~500m late, and for that first leg the member shows stale to everyone else.
   - The escalation is self-defeating: `idle` to `tracking` is gated on trip detection, but trip detection is gated on the samples only `tracking` produces.

A genuinely stationary device staying on its last position is fine and intended: the swarm dot shows it is online, and a stationary device's position is not stale. The defect is specifically blindness to motion that begins while `idle`. The becoming-a-writer `lastSeen` backfill (PR #55) is a separate gap (a device joining a circle while idle) and does not address this.

## Approach

Add two escalation triggers that do not depend on the trip detector, so the device leaves `idle` the moment there is real reason to:

1. **Foreground escalation.** While the app is foregrounded, pin `tracking`. The user is looking at the map; continuous GPS is affordable (bounded by how long the app stays open, screen already on) and is what makes "I opened PearCircle to see where everyone is" show fresh positions, including the user's own. On backgrounding, hand control back to the trip-phase driver.

2. **Motion escalation.** Subscribe to CoreMotion activity (`CMMotionActivityManager`). On a transition from stationary to a moving activity (walking, running, cycling, automotive) with adequate confidence, escalate to `tracking`. CoreMotion runs on the always-on motion coprocessor at negligible battery cost and is Apple's intended low-power "did the device start moving" signal. It feeds the trip detector the continuous samples it needs to arm a trip, closing the trap, and works while the app is foregrounded or running in the background.

The trip-phase driver remains the step-down authority: when the app is backgrounded, CoreMotion reports stationary, and the trip detector is back to `idle`, return to `idle` mode.

## Scope

In scope:

- Native CoreMotion subscription in `PearCircleLocationModule.swift` (`CMMotionActivityManager.startActivityUpdates`), gated on `isActivityAvailable()`.
- `NSMotionUsageDescription` added to `app.json` infoPlist plus an onboarding permission ask. CoreMotion activity needs the Motion and Fitness permission; the 2026-05-03 motion decision anticipated this key but it is not currently in `app.json`.
- App-lifecycle (foreground/background) wired into the mode decision.
- The mode decision generalized from "trip phase only" to "trip phase OR foreground OR recent motion", with new trigger points so the mode can change without waiting on a `location:update` (today the driver only runs inside that handler).
- Fix the stale `pausesLocationUpdatesAutomatically` comment in `PearCircleLocationModule.swift`, which still cites the removed 15s heartbeat.

Out of scope:

- Deep-background trip detection while the app is suspended. iOS suspends a backgrounded app; CoreMotion live updates and timers do not run while suspended. SLC stays the floor that wakes a suspended app (~500m). A CoreMotion query on that wake (`queryActivityStarting`) could narrow the residual gap; deferred to a follow-up.
- Android. FusedLocationProvider already streams while stationary and has no idle-trap.
- Re-introducing any periodic `lastSeen` republish or heartbeat. The swarm-live-signal design stands, and a republish does not detect a trip.
- Trip-detector threshold changes in `src/lib/trip.js`.

## Compat

No wire-protocol or storage change. Old and new peers exchange identical `lastSeen` and `trip:*` records. The visible cross-peer effect is timing: a member on this build publishes their first fresh `lastSeen` near the start of a trip rather than ~500m in, and a foregrounded member publishes continuously. Mixed fleets are unaffected; this is a local energy-management change. Battery: foreground continuous is bounded by app-open time, CoreMotion activity monitoring is sub-1%, and the net change against the 2026-05-16 baseline is the subject of the Verify battery check.

## Verify

1. Unit: extend the `locationMode` tests so the driver emits `tracking` on foreground-enter and on a stationary-to-moving transition, and `idle` only when backgrounded, stationary, and trip-phase idle. Mock the native lifecycle and motion inputs.
2. Manual smoke on the iOS test devices (53071FDAP00038 owner, 4H65K7MFZXSCSWPR joiner):
   - From a stationary `idle` state, walk a short loop under 500m and return. Confirm the trip arms and the member's pin moves on the other device. Today it would not.
   - Background the app, repeat the short walk. Confirm motion escalation still fires while the app runs in the background and the trip records.
   - Open the app stationary; confirm `tracking` engages and the own-pin position is fresh.
   - Cross a geofence boundary in `idle`; confirm enter/exit still fires (region monitoring is mode-independent).
3. Battery: with mode-transition logging on the existing `coldstart.log` path, compare iOS Settings, Battery, Last 24 Hours before and after on a normal-use day. The escalation must not materially regress the 2026-05-16 battery win.

## Rollback

The existing `ADAPTIVE_LOCATION_MODE_ENABLED` flag still pins `tracking` always (today's safe behavior). The foreground and motion escalations each sit behind their own check so either can be disabled independently; with both off the behavior is exactly the 2026-05-16 design. No peer-side coordination, wire unchanged.

## Open questions

- Q1: Does the native module escalate on motion directly, or emit a motion event and leave the worklet the sole mode authority? Worklet-authority keeps one decision site and stays unit-testable in `locationMode`; native-direct is fewer IPC hops. Lean: worklet-authority, since the mode logic is already worklet-side.
- Q2: Foreground/background signal from native `UIApplication` notifications or the RN `AppState` already wired in `app/index.tsx`? Lean: reuse the shell `AppState`, one less native surface.
- Q3: Step-down timing. Return to `idle` immediately once backgrounded, stationary, and trip-idle, or after a short grace window to avoid flapping when the user briefly backgrounds the app mid-activity? Lean: a ~2min grace window, or lean on the trip cooldown already in place.
- Q4: CoreMotion confidence threshold and smoothing. Which activities count as moving and at what confidence, mirroring the smoothing the 2026-05-03 `isMoving` decision specified. Default: walking, running, cycling, automotive at medium-or-higher confidence, requiring N consistent samples.
- Q5: Battery acceptance bar. What regression against the 2026-05-16 baseline is acceptable before the foreground escalation is narrowed (for example to active-map-screen only)? Default: revisit only if the Verify battery check shows a material regression.
