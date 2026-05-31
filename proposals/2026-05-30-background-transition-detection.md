# Background transition detection — persist classification + proximity-rank OS regions

**Status**: Draft 2026-05-30. Awaiting approval.

**Goal**: Stop silently dropping geofence enter/exit events that happen while an iPhone is suspended or force-quit. Two changes: (1) persist each place's `inside`/`outside` classification to the local Hyperbee so the JS classifier can recover a crossing on the first fix after a wake instead of re-baselining to nothing, and (2) rank the ≤19 OS-monitored CLCircularRegions by proximity to the user instead of Hyperbee insertion order, so the places a user actually visits are the ones the OS watches in the background.

**Tier**: T2. No wire-format change (recovered transitions are the existing `transition:{ts}:{pubkey}:{placeId}` record, unchanged). But it adds a new persisted local Hyperbee key (`geofence:{circleId}:{placeId}`) and it has a cross-peer effect: new-code senders will emit enter/exit records they previously dropped, so peers receive transitions they did not before. Per Constitution §2 ("new persisted fields", "cross-peer effect"), that is T2. It is not protocol-breaking or security-critical, so not T3. Region ranking on its own is T0/T1 (local native-bridge behavior, no persisted or replicated change) and rides along here because it shares the root cause.

## Background

The 2026-05-30 on-device session surfaced this: a circle member (iPhone) drove Home → Scooters → Home over a day. The viewer (Android, D1) saw "Left Home 12:18" but never "Arrived Scooters 12:41", never "Left Scooters ~20:10", never "Arrived Home ~20:50". Yet her map pin DID advance to a position near Scooters with a "Today 20:09" timestamp. Life360 showed every one of those transitions.

The pin moving while no transition fired is the tell: her phone woke, got a fix, wrote a `lastSeen` (pin moves), but emitted no enter/exit. That is a detection failure on the sender, not a delivery failure. Three confirmed causes:

1. **Classification state is in-memory only and resets to `null` on every cold boot.** `lastClassification` (inside/outside per place) lives in the `_circlePlaces` Map (`src/bare.js:253-268`); `trackPlace` initialises it to `null` and it is never persisted. Every worklet relaunch (force-quit, or iOS killing+relaunching the worklet) starts every place at `null`.

2. **`classify()` with `prev === null` fires no transition** — it silently establishes a baseline (`src/lib/geofence.js:35-42`). This is correct on genuine first-ever observation (no spurious enter on install), but after a cold boot it means the FIRST fix after any wake can never recover a crossing that happened while the app was dead. The 20:09 wake near Scooters re-baselined to `outside` and emitted nothing; the real exit was lost.

3. **The JS classifier only runs on `location:update`** (`checkPlaceTransitions`, `src/bare.js:1834`), which does not fire while iOS suspends the app. So the only thing that can catch a background crossing is OS-level CLCircularRegion monitoring — but the worklet sends at most 20 regions (`REGIONS_HARD_CAP`, `src/bare.js:287,299`), the iOS side reserves one for the self-region leaving 19 for places, and they are chosen by **Map insertion order, not proximity** (`pushRegionsToShell`, comment at `src/bare.js:278-280`: "Phase 3 will rotate based on distance ... once a real >20-place user complains"). A user in two circles (Hudgins Family + ABFG) shares one 19-slot budget across both. If Scooters/Home are not in the first 19 inserted, the OS is not monitoring them, so nothing fires in the background regardless of permission state.

Note the OS region path already handles cold boot correctly on its own: `applyRegionEvent(null, 'exit')` returns `deduped: false` and appends (`src/lib/geofence.js:62-67`). The gap is (a) the region may not be registered (cause 3), and (b) when it is not, the JS-on-wake fallback cannot recover the crossing (causes 1+2). This proposal closes both.

Deeper architectural context (not solved here): Life360 computes crossings server-side from the uploaded location stream with durable per-user state, so a gappy stream still yields complete history. PearCircle computes them on-device with ephemeral state, and the blind seeder (2026-05-19) deliberately cannot read location, so it cannot do server-side detection. Persisting classification is the on-device equivalent of "durable per-user state" — it is the closest serverless analogue to what makes Life360 complete.

## Scope

In scope:

- **Persist classification.** A new local-only Hyperbee key `geofence:{circleId}:{placeId}` on `_localDb`, value `{ classification: 'inside'|'outside', ts, v: 1 }`. Written whenever `lastClassification` flips (in `checkPlaceTransitions` and `handleRegionEvent`). Read back into `_circlePlaces[].lastClassification` during place hydration on boot, before the first `location:update`.
- **Recover on first post-wake fix.** With a restored prior classification, the existing `classify()` call fires the enter/exit that the in-memory reset previously swallowed. No new code path — it is the existing classifier finally having a real `prev`.
- **Proximity-rank OS regions.** `pushRegionsToShell` (`src/bare.js:296-314`) sorts candidate places by haversine distance to the device's last known position (ascending) before applying the 20-cap, so the nearest places win the slots. Falls back to insertion order when no position is known yet (cold boot before first fix). Re-pushed when the device moves a meaningful distance, debounced (reuse `schedulePushRegionsToShell`).
- **Tests** (`tests/`): classification persists and restores across a simulated worklet restart; a restored `inside` + a now-`outside` fix fires exactly one `exit`; region ranking puts nearest-N within the cap and drops the farthest; ranking is stable (no churn) when the device has not moved.
- **Verify gate** (`npm run verify`) green, then build APK + `./scripts/ios-dev-install.sh`, validate the Home→away→Home cycle on D1/D2/iPhone, wait for user sign-off before PR (project convention).

Out of scope:

- **The ~10-minute first-delivery lag** the user observed (fresh `lastSeen` taking minutes to reach a viewer). That is a replication / co-presence latency problem, not detection; separate writeup. Flagged here only to keep the two from entangling.
- **Recovered-transition timestamp accuracy.** A crossing recovered on wake carries the wake time, not the true crossing time (see Open questions Q1). We accept approximate timing in v1; the record being present beats it being absent.
- **Force-quit with Always revoked.** If a user (Leah) force-quits AND has not granted Always, neither OS regions nor wakes fire; no code fix reaches that. Surface it as an operational checklist item (verify Always per device), not a code change.
- **Android GeofencingClient.** Android already streams via the foreground service; the JS classifier runs continuously there. The persist-classification half still helps Android across process death, but no native region work is needed.
- **>19-region rotation strategy beyond proximity** (e.g. predictive, time-of-day). Proximity is the simple correct default; refine later only if a real user exceeds it meaningfully.

## Compat

- **Wire format unchanged.** Recovered transitions are ordinary `transition:` records under the locked v1 wire protocol. An old-code peer applies and renders them exactly as it does any transition. A new-code sender simply emits more of them than before.
- **New persisted key is local-only.** `geofence:{circleId}:{placeId}` lives on `_localDb` (the same store as `trips:` / `trips:sharing:`), never replicated, never signed, never on the wire. No peer ever sees it. An old-code build that later reads the same `_localDb` ignores the unknown prefix.
- **Mixed fleet.** New sender + any reader: reader gets the recovered enter/exit as a normal transition. Old sender + any reader: unchanged (keeps dropping background crossings — no regression, just no improvement until that device updates). Region ranking is purely sender-local and invisible to peers.
- **No migration.** On first boot after the update, `geofence:` keys are absent, so every place restores to `null` exactly as today — the first session re-establishes baselines silently (no spurious mass-enter), and persistence takes effect from the first flip onward.
- **Freshness gate interaction.** A recovered transition with an old wake-time `ts` may be older than `TRANSITION_FRESHNESS_MS` (10 min) and so suppress its notification on the receiver, but the record still lands in the history feed (`src/bare.js` apply path `view.put`s regardless of the `fresh` gate). That is strictly better than today (vanished entirely). See Q1.

## Design

### Persisted classification store

```js
// write — on every classification flip (checkPlaceTransitions + handleRegionEvent)
await _localDb.put('geofence:' + circleId + ':' + placeId, {
  classification: next,           // 'inside' | 'outside'
  ts,                             // observation time of the flip
  v: 1,
})

// restore — during place hydration on boot, before first location:update
const row = await _localDb.get('geofence:' + circleId + ':' + placeId)
const restored = row?.value?.classification
_circlePlaces.set(key, { ...state, lastClassification: restored ?? null })
```

`trackPlace` keeps its existing "preserve across rename/move" behaviour; restore only fills `null` slots from disk, it never overwrites an in-session value.

### Recovery flow (the missed exit)

1. Member is inside Scooters; a flip wrote `geofence:{c}:{scooters} = inside`.
2. App is suspended/force-quit. RAM state is gone.
3. Worklet relaunches (SLC/visit/self-region wake). Hydration restores `lastClassification = 'inside'` for Scooters from `_localDb`.
4. First `location:update` (the 20:09 fix) arrives outside the radius. `classify(dist, radius, 'inside')` returns `kind: 'exit'`.
5. `appendTransition(...,'exit', ts)` fires. The exit is recovered (with approximate `ts`, see Q1). The flip persists `outside`.

Without step 3 this is exactly today's silent re-baseline.

### Region ranking

`pushRegionsToShell` collects candidate regions as now, but sorts by `haversineMeters(devLat, devLon, state.lat, state.lon)` ascending before the `REGIONS_HARD_CAP` slice, using the device's last known position. No known position → current insertion order (boot transient, corrected on first fix). A meaningful device move re-triggers `schedulePushRegionsToShell` so the monitored set follows the user. The self-region reservation on the iOS side is unchanged.

## Verify

Per Constitution §5, `npm run verify` (jest + bundle builds) must pass. New tests listed under Scope. Manual smoke: pair D1/D2/iPhone, walk/drive a Home → Scooters → Home cycle with the iPhone backgrounded (and a separate run force-quit), confirm enter+exit for each leg reach D1, and confirm proximity ranking by adding >19 places across both circles and checking the near ones are the monitored set (`getMonitoredRegions`, `src/bare.js` native bridge).

## Rollback

Clean. The feature is additive and local:

- Revert the code: new builds stop reading/writing `geofence:` keys. Existing keys become inert data on `_localDb` (nothing reads them). No replicated state, no circle-orphaning, no migration to undo.
- Region ranking revert restores insertion-order selection; no persisted effect.
- Already-emitted recovered transitions are normal records and survive harmlessly.

## Open questions

- **Q1: Timestamp of a recovered transition.** Wake-time `ts` is wrong (the crossing happened earlier) and can trip the 10-min notification freshness gate. Options: (a) ship wake-time `ts`, accept approximate history + suppressed notification, record still present (recommended for v1, simplest, strictly better than today); (b) if the wake fix's reverse-geocode or a buffered location sample gives a better estimate, use it; (c) carry a separate `detectedAt` vs `crossedAt`. Recommend (a) now, revisit if users complain the times look off.
- **Q2: Should the OS region path also persist?** It already recovers on cold boot via `applyRegionEvent(null,...)`, so persistence is not required for it — but persisting keeps the JS and OS paths' dedup state consistent across boots (prevents a post-boot OS event and a JS event double-firing). Recommend persisting from both paths (already in scope).
- **Q3: Re-rank trigger distance.** What device move distance should re-push the region set? Proposed: reuse the self-region radius (120m) or the `lastSeen` min-move gate (20m). Tune on device; too tight churns native calls, too loose leaves the user outside their monitored set after a short drive.
- **Q4: Restore races hydration.** Must guarantee `geofence:` restore completes before the first `location:update` is processed, or the first fix re-baselines before the restore lands. Gate `checkPlaceTransitions` on a "places hydrated" flag, mirroring the existing init ordering.
- **Q5: Stale persisted classification.** If a place's coords/radius changed while the app was dead, the restored classification may be wrong. `trackPlace` already preserves across move; confirm the persisted value is re-evaluated on the first fix rather than trusted blindly (it is — the first `classify()` recomputes distance and corrects).
