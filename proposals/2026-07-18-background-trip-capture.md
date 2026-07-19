# Durable background trip capture: split capture from publish

## Goal
Make a trip get recorded and shared even when the user never opens the app during or after the drive. Today a trip only materializes if the Bare worklet stays alive across the whole drive plus its 5-minute cooldown and is continuously fed fast fixes. On a backgrounded iPhone that stream is unreliable, so no trip is created, nothing is written locally, and nothing replicates to peers or the seeder.

## Tier
T2. No wire-protocol change: the shared record stays the existing signed `trip:{pubkey}:{startTsPadded}` autobase key (proposal 2026-05-10) written through the existing `replicateTripToOptedInCircles` path, so an old-code peer and a new-code peer interoperate unchanged. What is new and persisted is device-local: a native on-disk fix log, an additive in-flight `_tripState` checkpoint in the local Hyperbee, and a new native→worklet IPC handoff for draining the log. New persisted fields and a new IPC shape put it in T2 per the constitution; there is no migration because every new store is local-only and absent-means-empty.

Amends the trip slice (2026-05-10) and builds on the adaptive-location work (2026-05-16 modes, 2026-05-21 idle-trap CoreMotion escalation, 2026-05-29 Visits). Does not touch lastSeen ephemerality (2026-06-04).

## Background — what was observed
Reported 2026-07-18 by Tim. Trip sharing is enabled on his daughter's iPhone. Neither he (viewing her) nor she (viewing herself) sees any trips, over an extended period across real drives.

Two facts pin the failure to **creation**, not sharing or discovery:

1. **He sees her live location and lastSeen on the map.** Her writer core replicates to him and to the macOS seeder, so core discovery and replication work. A shared trip is just another block on that same core (`openSeederWriterCore`, `src/bare.js:4506`, eager `core.download({ start: 0, end: -1 })`), so if a trip block existed it would reach him. None does.
2. **She sees no trips on her own app either.** Her own app reads the device-local `trips:{pubkey}` Hyperbee directly (`trips:listFor`, self branch, `src/bare.js:2131-2138`). An empty self view means the local store is empty. The trip is never created, so there is nothing to replicate, seed, or render.

### Why creation fails while location keeps working
lastSeen and trips have opposite fix requirements, and iOS backgrounding satisfies exactly one:

- **lastSeen** needs only a coarse, occasional fix. Significant-location-change and Visits (`startUpdatesNow`, `swift:572`/`:579`) wake the worklet every ~500m or on arrival, which is enough to write a fresh lastSeen. That is why her dot is alive.
- **A trip** needs the opposite: a continuous stream of `speed >= 4 m/s` fixes sustained 30s to arm, then held through the drive plus a 5-minute cooldown (`stepTrip`, `src/lib/trip.js:74-157`; thresholds `:25-29`). Continuous delivery only runs in `tracking` mode (`startUpdatingLocation` gated at `swift:580-582`); in `idle` mode only SLC and Visits run, delivering sparse fixes whose `speed` is usually 0 or the -1 unknown sentinel (`emitLocation`, `swift:811`) — which never arm a trip. This is the idle-trap the code already names (`src/bare.js:333-337`).

So the same coarse-wake path that keeps her location fresh starves trip detection.

### Two structural weaknesses behind that
- **The in-flight trip lives only in memory.** `_tripState` (`src/bare.js:317-323`) is reset to `newTripState()` on every worklet start; a mid-trip suspension or kill loses the whole polyline with no recovery. The comment in `trip.js:17-21` accepts this for the v1 slice.
- **Background fixes are not durably captured.** When JS is detached the native module keeps only the single newest fix (`pendingLocation = payload`, `swift:821-826`), flushed once at `startObserving` (`swift:165-171`). Region events are queued (`bufferedRegionEvents`), location fixes are not. So intermittent background wakes cannot be replayed into a trip after the fact.

The 2026-05-21 CoreMotion escalation is meant to lift the app into `tracking` promptly when driving starts (`startActivityUpdatesIfAvailable`, `swift:583-586`), but it depends on the worklet being awake and getting live motion callbacks. A suspended app gets those only after some other wake (SLC/Visit) boots it, and nothing durable bridges the gap before escalation or across a re-suspension mid-drive.

## Design principle
Split the two jobs the current design conflates:

- **Capture the drive** must be reliable, so move it to **native**, which iOS keeps alive and relaunches for location far more dependably than the worklet stays running. Native durably persists the background fix stream on its own, with zero worklet involvement.
- **Publish the trip** can be **deferred and opportunistic**. Whenever the worklet next runs — any background wake, not just a manual open — it drains the persisted fixes through the existing `stepTrip` machine, finalizes completed trips, and appends the signed block. Her worklet already wakes often (the live-location proof), so publication happens without her ever opening the app. The seeder then makes it available to Tim.

The irreducible requirement shrinks from "worklet alive through the whole drive" to "worklet runs at least once sometime after the drive" — which is already true for any device showing a live location.

Native stays a **dumb durable buffer**, not a second trip algorithm. There is exactly one trip state machine (`trip.js`), run by the worklet over replayed fixes. `stepTrip` is driven entirely by each fix's `ts`, not wall-clock, so replaying a buffered sequence reconstructs the identical trip.

## Scope

### Part A — Trip lifecycle observability (do first)
The exact break point is still inferred. Before changing capture, make it measurable, the way `coldstart.log` made cold start measurable (CLAUDE.md).

- Emit a durable trip trace: every mode transition (`idle`/`tracking`), arming start and abort, active/cooldown enter, finalize (with duration/distance and the discard reason when below the `MIN` thresholds), and each `replicateTripToOptedInCircles` outcome per circle (`appended` / `not-writable` / `gate-off`).
- Write it to `FileSystem.documentDirectory/trips.log` via the same shell path as the cold-start trace, pullable with `xcrun devicectl ... copy from ... Documents/trips.log`.
- This confirms on Tim's daughter's device whether the trip never arms (idle-trap: density problem) or arms then dies mid-flight (durability problem), and it is the acceptance instrument for Parts B–D.

### Part B — Durable native fix capture
- Replace the single-slot `pendingLocation` with a bounded, append-only on-disk fix log in the native module: each entry `{ lat, lon, ts, speed, accuracy }`. Written on **every** `didUpdateLocations`, whether or not JS is attached, in both adaptive modes.
- Bound by a drain cursor, not by blind truncation: the worklet reports the highest `ts` it has drained; native drops entries at or below the acked cursor. Un-drained span stays small for a device that wakes often; cap by age (drop entries older than trip retention) as a backstop so a never-draining device cannot grow the file unbounded — and log that drop, no silent cap.
- On `startObserving` and on a new `location:flushBuffer` IPC, native hands the worklet the un-drained slice (ordered by `ts`) instead of a single fix.

### Part C — Opportunistic worklet drain + in-flight checkpoint
- On worklet boot hydration and on every attach / `app:state active`, drain the native slice through `stepTrip`, in `ts` order, resuming from a persisted in-flight state.
- Persist `_tripState` to a local-only Hyperbee key `tripInFlight:{pubkey}` on each meaningful transition (arming→active, active↔cooldown, and every N appended points), and rehydrate it on boot instead of always `newTripState()`. This lets a trip that spans several disjoint background wakes accumulate across worklet lifetimes and finalize on a later wake.
- Completion is unchanged downstream: a finalized trip takes the existing local `trips:{pubkey}:{startTs}` put (`src/bare.js:2029-2040`) and the existing `replicateTripToOptedInCircles` append (`:2042`, `:2389-2420`), both gates and `base.writable` still enforced. After a successful drain, ack the drain cursor back to native (Part B).
- Idempotency: keying the finalized trip on `startTs` means re-draining an already-published span cannot create a duplicate — the autobase apply already rejects overwrites (`tripApplyDecision`, `tripWire.js`), and the local put is last-writer-identical.

### Part D — Escalation hardening (conditional on Part A)
If the trace shows the idle-trap (trip never arms because `tracking` is entered too late or not at all), harden the path from a driving signal to continuous delivery: escalate to `tracking` on the first automotive/high-speed signal after an SLC/Visit wake, and hold the continuous session through the drive so the process stays alive. This is a tightening of 2026-05-21, not a new mechanism, and it is only worth doing if the trace proves density — not durability — is the gap. Kept separate so B/C can ship and be measured first.

### Out of scope
- **Deriving trips from replicated lastSeen breadcrumbs.** Tempting because that trail already reaches Tim, but lastSeen is movement-gated (20m) and being made ephemeral (2026-06-04), so it is lossy and transient — wrong foundation for a durable trip. Rejected.
- **Porting `stepTrip` to Swift.** Two implementations would drift. Native stays a dumb buffer.
- **Android parity in this proposal.** Android's FGS keeps the worklet alive far more consistently (GrapheneOS FGS survives swipe), so the durability gap is iOS-first. The native log is worth mirroring on Android later but is not required to fix the reported case; note the asymmetry rather than block on it.
- **Changing any trip threshold** (`TRIP_*` in `trip.js`). Tuning arming/cooldown is a separate on-device question.

## Compat
Peer-invisible. The shared artifact is the unchanged `trip:{pubkey}:{startTsPadded}` block; old peers and the seeder replicate it exactly as today. Every new store — the native fix log, `tripInFlight:{pubkey}`, the drain cursor — is device-local and never crosses the wire. An old-code worklet reading a device that has a new native log simply ignores it (it only reads via the new drain IPC); a new-code worklet on a device with no log or no checkpoint finds them absent and behaves as today (fresh `newTripState()`, single-fix flush). No migration.

## Verify
- `npm run verify` green.
- New `node` tests over the drain path (native replaced by an in-memory fake log):
  - A buffered sequence of dense fast fixes drained in one pass produces exactly the trip `stepTrip` produces live (equivalence).
  - A drive split across two drains — worklet "restart" between them, in-flight state rehydrated from `tripInFlight:{pubkey}` — finalizes one trip identical to the un-split run.
  - Re-draining an already-published span (cursor not yet acked, then re-fed) produces no duplicate local put and no second append.
  - The age backstop drops (and logs) entries older than retention; the drain cursor truncates at/below the ack.
- New `jsdom` test: none required (no UI change) beyond confirming the self trip list renders a trip that arrived purely via a drain.
- Device smoke on the **daughter's iPhone** (the reproduction), with `trips.log` pulled before and after:
  - Baseline: a real drive with the app never foregrounded produces no trip (reproduce), and `trips.log` shows whether it was density or durability.
  - After B/C: the same never-foregrounded drive yields a trip that appears in her self view on next background wake and replicates to Tim via the seeder. Confirmed from the trace's finalize + `appended` lines and Tim's device showing the trip.
- Seeder availability check: with her phone then powered off, Tim still loads the trip (served from the macOS seeder), proving the publish-then-offline path.

## Rollback
Parts are independently revertible. A is additive logging. B is one native class plus an IPC message; reverting restores the single-slot `pendingLocation`. C is guarded by the presence of the drain IPC and the checkpoint key; reverting the worklet side falls back to live-only `_tripState` and leaves harmless local `tripInFlight:` / native-log files that nothing reads. No wire or peer state to unwind.

## Open questions
- **Native log format and store.** Append-only file vs a small SQLite/UserDefaults ring. Leaning flat append file for crash-simplicity; decide during Part B.
- **Drain cadence.** Drain on every attach/foreground is clearly right; whether to also drain on each SLC-wake background run (more timely publish, more background work) should be set from Part A's observed wake frequency on her device.
- **Cursor ack durability.** If the worklet appends the trip but dies before acking the cursor, the next drain re-derives the same trip — idempotent by `startTs`, so correct but slightly wasteful. Acceptable; note it rather than add a second commit phase.
- **Part D necessity.** Entirely gated on Part A. If the trace shows trips do arm once the process is awake, D is unnecessary and B/C alone close the gap.
