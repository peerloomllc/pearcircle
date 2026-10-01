# Android adaptive location (low-power while idle, GPS only while moving)

**Status**: Draft 2026-09-30. Awaiting approval.

**Goal**: Stop the GPS from running all day on Android. Use a low-power location request while the phone is still, and turn on high-accuracy GPS only while the app is open, the phone is moving or a trip is in progress. iOS has done this since PR #57.

**Tier**: T1. Native and shell changes inside the existing IPC surface. No wire change, no new Hyperbee keys, no new replicated records. Written because it changes how fast an idle Android member's position and arrive/leave alerts reach the circle.

## Background

Measured on Tim's Pixel 9 Pro (GrapheneOS with sandboxed Play services, release 1.1.2), `dumpsys batterystats` over a 9h on-battery window, about half of it screen-off:

| | |
|---|---|
| PearCircle share | 544 of 2577 mAh (21%), top app |
| GPS on | 9h 5m of 9h 6m |
| GNSS power, all apps | 422 mAh |
| CPU time | 2h 38m |
| Wifi scans blamed | 3264 |

A user on a GrapheneOS Pixel 7 reports PearCircle using half their battery.

The wake lock leak fixed in PR #224 explains part of the CPU time. The GPS is the largest single cost. `PearCircleLocationService.startFusedUpdates` requests `PRIORITY_HIGH_ACCURACY` every 10s, and the platform path (`startPlatformUpdates`, no GMS) streams `GPS_PROVIDER` every 10s. Both run 24/7 from the foreground service. `setMinUpdateDistanceMeters(10f)` cuts delivered fixes but does not power the GNSS chip down, so the chip stays on even when the phone sits on a desk. Every fix also wakes the worklet, which accounts for some of the CPU time.

The worklet already has a platform-neutral mode driver (`runLocationModeDriver` in `src/bare.js`, decision logic in `src/lib/locationMode.js`). It emits `location:mode:set` with `idle` or `tracking` from three inputs: trip phase, app foreground and recent motion. `app/index.tsx` drops the event on Android (`Platform.OS !== 'ios'`), so Android never leaves full-power tracking.

Android has one difference that matters: arrive/leave alerts. iOS registers OS regions (`setMonitoredRegions`). Android has no OS geofences; the worklet checks each streamed fix against Place radii. Fewer fixes while idle would mean late or missed alerts, so idle mode on Android must add OS geofences.

## Approach

Reuse the worklet's mode driver as-is and give Android a native side for each of its inputs.

1. **`setMode` on Android.** `PearCircleLocationModule.setMode("idle" | "tracking")` re-requests location updates in the service:
   - `tracking`: today's request, unchanged (`PRIORITY_HIGH_ACCURACY`, 10s, 10m).
   - `idle`, fused: `PRIORITY_BALANCED_POWER_ACCURACY` (wifi and cell, about 100m, no GPS), 5 min interval, 50m minimum distance.
   - `idle`, platform (no GMS): `NETWORK_PROVIDER` at 5 min if the device has one; otherwise `PASSIVE_PROVIDER` only, so the app receives fixes other apps request and never powers GPS itself.
2. **Motion signal without a new permission.** Use `Sensor.TYPE_SIGNIFICANT_MOTION`, a one-shot wake-up sensor on the low-power sensor hub. It needs no runtime permission and no Play services, so it works on GrapheneOS with or without sandboxed Play. Each trigger emits `motion:changed { moving: true }` into the worklet and re-arms the sensor. If it has not fired for `MOTION_QUIET_MS` (default 3 min), native emits `moving: false`, and the worklet's existing `MOTION_GRACE_MS` window handles the step-down. Devices without the sensor emit nothing, so the trip phase and foreground inputs still drive the mode.
3. **OS geofences for idle.** Remove the iOS-only filter on the existing region push and register each tracked Place natively:
   - fused: `GeofencingClient` with enter/exit transitions, delivered through a `BroadcastReceiver` into the existing region-event path that iOS uses (including the queue for events that fire before the worklet is up).
   - platform: `LocationManager.addProximityAlert` per Place, which the system server runs without GMS.
   - The worklet keeps checking streamed fixes in `tracking` mode. When both an OS event and a fix report one crossing, the `region:enter` / `region:exit` handlers already drop the second through each Place's `lastClassification`, as on iOS. The handler comment names Android `GeofencingClient` as the planned Phase 2 of that path.
4. **Shell wiring.** Allow `location:mode:set` and the region push on Android in `app/index.tsx`, and forward the new motion event the way iOS forwards CoreMotion.

## Scope

In scope:

- `setMode`, significant-motion and geofence registration in `PearCircleLocationModule.kt` / `PearCircleLocationService.kt`, plus a geofence `BroadcastReceiver` in the manifest.
- Shell gates in `app/index.tsx`.
- Mode-transition lines in the existing trip trace so a battery report can be matched to time in each mode.

Out of scope:

- Trip detector thresholds in `src/lib/trip.js`.
- The worklet's CPU and network use while idle (swarm keepalives, replication). That is a separate profiling item in `TODO.md`.
- Any change to what gets written to `lastSeen` or how often. The worklet's 20m write gate is unchanged.
- Activity Recognition (`ACTIVITY_RECOGNITION` permission plus GMS). See Q1.

## Compat

No wire or storage change. Old and new peers exchange identical records. What other members see changes:

- An idle Android member's position updates every 5 min at about 100m accuracy instead of every 10s. Their pin does not move while they sit still either way.
- The first fresh fix of a trip arrives once significant motion fires (usually a few tens of seconds of walking or driving) instead of immediately.
- Arrive/leave alerts for an idle Android member come from the OS geofence. Android documents typical geofence latency as up to about 2 min, and longer when the device is stationary in Doze.

Mixed fleets are fine; this is a local energy change.

## Verify

1. Unit: the existing `locationMode` tests already cover the driver. Add cases for the Android motion stream (repeated `moving: true`, then quiet, then step-down after the grace window).
2. Emulator (rule 15): mode switches on foreground and background (`dumpsys location` shows the request priority change), `adb emu geo fix` crosses a Place in idle and fires the transition through the geofence path. The emulator has no significant-motion sensor, so motion is checked on hardware.
3. TCL: carry it on a walk from idle; confirm significant motion fires, the mode goes to `tracking`, the trip arms and records, and the pin moves on the other device. Cross a Place boundary while idle and confirm the alert fires on the receiving device.
4. Battery, Pixel 9 Pro: reset batterystats at full charge and compare a normal day against the table above. Targets: GPS on time close to time spent moving or in the app, and PearCircle no longer the top app.

## Rollback

`ADAPTIVE_LOCATION_MODE_ENABLED` already pins `tracking` everywhere. An Android-only flag beside it pins `tracking` on Android alone. With either set, behavior is today's. No peer coordination needed.

## Open questions

- Q1: Significant-motion sensor or Activity Recognition? Activity Recognition gives explicit still/moving transitions but needs the `ACTIVITY_RECOGNITION` permission, an onboarding prompt and Play services, so it does nothing on de-Googled phones. Lean: significant motion only.
- Q2: Idle cadence. 5 min balanced-power with a 50m minimum distance is the default. Shorter keeps idle positions fresher at some cost.
- Q3: Should idle mode keep the foreground notification? The service must stay in the foreground to receive location while backgrounded, so yes. Only the request inside it changes.
- Q4: Battery bar. What result on the Pixel counts as fixed? Default: PearCircle under 5% of a normal day's drain.
