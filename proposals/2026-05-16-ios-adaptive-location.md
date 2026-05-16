# iOS adaptive location (significant-change while idle, continuous while moving)

**Status**: Draft 2026-05-16. Awaiting approval.

**Goal**: Cut iOS background-battery drain by switching the location stack between Apple's significant-location-change (SLC) service while the user is idle and continuous high-accuracy updates only while a trip is in progress. Today the app runs continuous updates 24/7, which is the dominant cost reported by users.

**Tier**: T1. App-logic change inside the existing IPC surface and data model. No wire change, no new Hyperbee keys, no new replicated records. Proposal is non-mandatory under Constitution §3 but written here because the change reshapes when peers see fresh `lastSeen` updates and is worth explicit review.

## Background

`PearCircleLocationModule.swift:357-368` configures `CLLocationManager` for "always on, always Best accuracy" delivery. As of the bugfix landing alongside this proposal (T0), the knobs are tuned down to `kCLLocationAccuracyNearestTenMeters` + `pausesLocationUpdatesAutomatically = true`, which lets iOS coast the radio when the device is stationary. That alone is a large reduction but it still relies on iOS deciding to pause; the GPS chip continues to spin up at any small motion (a pocket shift, a passenger ride, a desk-side commute) and stays warm for the duration.

Apple's recommended posture for "share my location with friends" apps is the inverse: use SLC as the steady-state subscription (sub-1% battery cost, cell-tower triangulation, ~500m granularity, callbacks every few minutes when moving and silent when not), and only escalate to continuous high-accuracy delivery when the app actually needs the precision — i.e. during an active trip. CLCircularRegion monitoring stays on independently and continues to fire enter/exit callbacks at OS resolution, so the geofence layer is unaffected by which delivery mode is active.

The trip detection state machine (`src/lib/trip.js:1-21`) already knows when a trip is in progress: it has four phases (`idle`, `arming`, `active`, `cooldown`). The proposal hooks into those transitions to drive the location-manager mode.

## Scope

In scope:

- New native IPC: `PearCircleLocation.setMode("idle" | "tracking")` callable from the worklet. Mode determines whether `CLLocationManager` runs SLC-only or SLC + continuous high-accuracy.
- Native handler keeps SLC running in BOTH modes (so an SLC wake-up during `idle` reliably gives us a position to feed the trip detector); `tracking` mode adds `startUpdatingLocation()` on top.
- Worklet drives the mode: any `tripState.phase` transition into `arming` or `active` issues `setMode("tracking")`; transition into `idle` (after cooldown finalize) issues `setMode("idle")`.
- SLC callbacks deliver to the existing `locationManager(_:didUpdateLocations:)` path. The emitted JS event shape is unchanged (`PearCircleLocation:update`), so the worklet's `location:update` handler needs zero changes — it just receives updates less often while idle.
- `kCLLocationAccuracyNearestTenMeters` remains the accuracy floor in both modes. `tracking` mode can additionally bump to `kCLLocationAccuracyBestForNavigation` while inside the `active` phase if telemetry shows the polylines are too coarse for trip review. Decision deferred to verification, default = stay at NearestTenMeters.
- Heartbeat (`HEARTBEAT_CHECK_INTERVAL_MS = 15s`, `HEARTBEAT_STALE_MS = 30s` in `src/bare.js:2019-2043`) is unchanged. It is the load-bearing mechanism that keeps "Live" indicators fresh while SLC is silent.

Out of scope:

- Android. FusedLocationProvider has different battery characteristics and its own "priority" knob that should be tuned independently. Tracked separately.
- Replacing `CLCircularRegion` monitoring with anything else. Region monitoring stays as-is.
- Wake-from-force-quit semantics. SLC also wakes a force-quit app (same as region monitoring), which is a side benefit but not a new feature here.
- Changing the trip-detection thresholds in `src/lib/trip.js`. The `arming` phase already filters out noise; SLC's coarser cadence during idle does not change that contract because `tracking` mode escalates at the moment we suspect a trip might be starting.

## Compat

No wire-protocol or storage change. Old peers and new peers see identical `lastSeen` and `trip:*` records on the autobase. The visible cross-peer effect is timing:

- A peer running this build will publish fresher `lastSeen` while moving (continuous updates) and refreshed-by-heartbeat `lastSeen` while idle (15s heartbeat keeps the timestamp within `LIVE_THRESHOLD_MS = 60_000`, so the "Live" pill stays green).
- A peer running this build will publish a less frequent `lastSeen` while idle than today's build does. Today: every 10m of GPS jitter triggers a write. After: silent until motion is real, then heartbeat at the 30s cadence. Peers viewing the idle user see a `lastSeen` that updates every ~30s instead of every few seconds of GPS noise. This is desirable — fewer writes, less autobase churn, identical "Live" UX.

Mixed fleets are fine; this is a local energy-management change.

## Verify

1. Unit: extend `tests/` with a small harness around the trip-state machine that asserts the worklet emits `setMode("tracking")` on `idle -> arming` and `setMode("idle")` on `cooldown -> idle finalize`. Mock the native IPC.
2. Manual smoke on the iOS test devices (53071FDAP00038 owner / 4H65K7MFZXSCSWPR joiner):
   - Place both devices stationary, both on the same circle, sharing on. Confirm "Live" pill stays green on both for 10+ minutes (heartbeat path).
   - Walk owner device 200m+ at a sustained pace; confirm trip arms, escalates to `tracking` mode, polyline records, finalizes on stop.
   - Background the app, repeat the walk; confirm trip still arms and records (SLC wakes the worklet, trip detector escalates, continuous updates flow).
   - Cross a geofence boundary while in `idle` mode; confirm OS notification still fires (region monitoring is independent of the mode toggle).
3. Battery telemetry: ship a build with both `setMode` logging enabled and the iOS coldstart trace path (existing `coldstart.log` pipeline) extended to log mode transitions for the first hour. Compare iOS Settings → Battery → Last 24 Hours for the same user before/after.

## Rollback

Single-knob: a feature flag at the worklet boundary (`ADAPTIVE_LOCATION_MODE_ENABLED`, default true) that short-circuits the mode-driver to always-`tracking`, restoring today's behavior. Flip to false and rebuild if a regression appears. No peer-side coordination required since the wire is unchanged.

## Open questions

- Q1: Does `kCLLocationAccuracyNearestTenMeters` inside `active` mode produce trip polylines smooth enough for the trip-detail UI? If not, escalate to `kCLLocationAccuracyBestForNavigation` (~4-8x cost vs NearestTenMeters but still bounded to the trip window). Default: stay at NearestTenMeters, revisit on user feedback.
- Q2: Should `arming` phase use `tracking` mode (eager) or stay on SLC and only escalate on `active` (lazy)? Eager catches the first 30s of polyline; lazy saves battery on false starts (an arming that never promotes). Default: eager — the 30s arming window is short and losing the first 30s of a trip polyline would be visibly bad.
- Q3: Trip-completed transitions back to `idle` immediately or after a grace window? Today the state machine goes `active -> cooldown -> idle` with a 5min cooldown. Hooking the mode flip to the cooldown -> idle transition (not the active -> cooldown) gives us a free 5min buffer before stepping down. Default: step down on `cooldown -> idle`.
- Q4: Worth surfacing the active mode in the UI debug surface? A small "GPS: tracking" indicator on the dev screen would help diagnose user reports. Default: log-only for v1; add UI later if reports come in.
