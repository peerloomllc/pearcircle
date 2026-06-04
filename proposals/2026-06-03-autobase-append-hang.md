# Autobase append-hang: worklet-wide freeze, recovery + dispatcher hardening

## Tier
T2. No wire-protocol, IPC envelope, or Hyperbee-key change. Adds (a) a
defensive timeout around the worklet write path and (b) a user-triggerable
local recovery that deletes and rebuilds a single circle's local Autobase
from already-replicated blocks. The recovery deletes local cores, so it is
destructive to *unreplicated* local writes — but a wedged base cannot
replicate anyway, and identity + circle membership survive. Flagged for a
review record before the recovery lands.

## Background — what was observed on-device
Diagnosed 2026-06-03 on a Pixel 7 running **GrapheneOS with sandboxed Google
Play**, release build, paired in the "Hudgins Family" circle (`FQzK6oGG`)
alongside a Pixel 9 (healthy) and a macOS seeder (`4b27003c`).

Symptoms reported: the Pixel 7's own location was frozen 4 days, peers saw it
4 days stale, and "View my trips" hung on "Loading…" forever.

Logcat (the worklet `mark()` stream, visible on release) established:

- **`trips:listFor` is not the bug.** On a fresh worklet it completes in
  under 3 ms and returns the user's 7 local trips:
  `trips:listFor:start → local-done {count:7} → base-done {count:0} → done`.
  (Diagnostic marks added in this branch, see Scope.)
- **The worklet wedges on the first append.** Across ~6 cold boots,
  `lastseen:first-write` **never once fired** on this device. The worklet
  emits its boot/connect marks, services a couple of early reads, then goes
  **completely silent ~13 s in** and never processes another IPC. The Pixel 9
  on identical code fires `lastseen:first-write` within ~8 s every boot.
- **One hung append freezes everything.** The IPC dispatcher
  (`src/bare.js`, `_ipcRead.on('data', …)`) processes each message with
  `await handler(...)` and **no timeout**. A `base.append()` that never
  resolves therefore blocks every subsequent IPC — `trips:listFor`,
  `circles:getAll` polling, all of it — which is why the whole UI eventually
  freezes, not just location.
- **Two corruption signals, same direction.** Appends hang, **and** a circle
  is missing locally: `pair:remote-open-no-base {cid:"VLRwUprk"}` — the
  Pixel 9 and seeder are in `VLRwUprk`, the Pixel 7's base for it is gone.
  Consistent with a corrupt / partially-cleared local Autobase writer core
  (cf. the storage-reclamation failure already documented as unsafe).

Conclusion: a **device-local Autobase write path is wedged** (not a code
regression — the Pixel 9 is fine on the same binary), and the worklet's
dispatcher has no isolation, so a single stuck base takes down the whole
backend.

## Problem statement
1. **No fault isolation.** A `base.append()` (or any handler) that never
   resolves silently freezes the entire worklet. There is no timeout, no
   error surfaced, no skip.
2. **No recovery.** A circle whose local Autobase is corrupt has no path back
   short of uninstalling — which is forbidden (wipes the Hyperbee identity
   and forces a fresh invite). We need an in-place rebuild.

## Scope

### Part A — Dispatcher / write-path hardening (ship first, broad value)
- Wrap the per-base `base.append(...)` in `location:update` (and the other
  write paths: `appendTransition`, `appendLastSeen`, `autoAppendMemberRow`,
  `autoAppendSelfLastSeen`, trip replication) in a bounded `Promise.race`
  with a timeout (proposed 8 s). On timeout: emit `append:timeout {circleId}`,
  skip that base, mark it degraded, and let the handler return so the
  dispatcher keeps moving.
- Surface a degraded base to the UI (e.g. a per-circle `needsRepair` flag in
  the `circles:getAll` snapshot) so the user gets a "This circle needs repair"
  affordance instead of a silent freeze.
- Keep the `trips:listFor` diagnostic marks added in this branch; they are
  cheap and were load-bearing for this diagnosis.

### Part B — Per-circle local rebuild (`circle:repair`)
New worklet IPC `circle:repair {circleId}`:
1. Close the circle's Autobase and remove it from `_circleBases`.
2. Delete only that circle's local namespace cores (writer + view) from the
   corestore. Local DB rows (identity, `circles:joined:{id}`, sharing
   prefs, local `trips:`) are untouched.
3. Re-mount via `mountCircleAutobase` from the stored bootstrap +
   encryption key.
4. Re-join the swarm topic / rely on the existing connection so the seeder
   (and any online writer) re-replicates the full history into the fresh
   view.
5. Re-establish self as a writer (re-request / re-fetch the `addWriter`
   op) so appends work again.

Guard: refuse (or warn) when no seeder/writer is currently reachable for the
circle, since the rebuild discards any unreplicated local writes — acceptable
for a wedged base (those writes are stuck regardless), but the user should
not nuke a healthy base with no peer to refill it.

Trigger: user-initiated from the degraded-circle affordance in Part A. Auto-
repair on `append:timeout` is deferred (open question) to avoid a rebuild
loop masking a deeper bug.

## Root cause — still open
Why the local writer core wedges `append()` in Autobase 7.25.1 is not yet
pinned down (corrupt oplog? linearizer stall waiting on a missing
referenced node? a half-applied storage-reclaim?). Part B recovers the
device regardless of the precise cause; the root cause needs a focused
Autobase-level investigation (the holepunch-p2p-architect skill is the right
tool) before we can claim prevention. The missing `VLRwUprk` base is the best
lead — capture that device's corestore state before repairing it.

## Verify
- `npm run verify` green.
- New `node` test: a handler whose `append` never resolves → the timeout
  fires, the handler returns, and a *subsequent* IPC still dispatches
  (proves the dispatcher no longer wedges).
- Device smoke on the wedged Pixel 7: trigger `circle:repair`, confirm
  `lastseen:first-write` fires, own location refreshes, trips loads, and the
  missing `VLRwUprk` base re-mounts.
- Regression on the Pixel 9: appends and the normal path unchanged (timeout
  never fires under healthy latency).

## Rollback
Part A is additive (timeout wrapper + a snapshot flag) — single-commit
revert. Part B is a new IPC never called automatically; leaving it unused is
inert, and a failed repair leaves the base no worse (still wedged).

## On-device validation status (2026-06-03)
Part A and Part B are implemented (commits on `feature/autobase-append-hang-recovery`) and unit-tested (`tests/appendTimeout.test.js`: a never-resolving append times out, fast path ok, rejection != timeout). A combined build (this branch + the location fallback) was installed on Benjamin's Pixel 7 as v1.0.12.

Observed: the worklet stays **responsive** — `trips:listFor` completed (7 local trips) at +53s on a boot where the old build would have hung. No freeze.

Not yet observed on-device: an actual `append:timeout` -> `circle:degraded` -> Repair-button -> `circle:repair` (nukeTip) cycle. Blocked by the device's location stack: the fused `getCurrentLocation` one-shot **fires but its callback never returns** on this GrapheneOS + sandboxed-Play device, so the last-known fallback (which only runs in the null/failure callback) never emits a `location:update`, and the auto-appends early-return because the member/lastSeen rows already exist. With no append attempted, the wedge never manifests and the circle is never flagged for repair, so the Repair button never appears. This is an environmental block, not a logic gap.

Follow-up that unblocks validation AND fixes the location fallback for real: add a hard timeout to `requestSingleFix` so that if `getCurrentLocation` hasn't called back within ~8s, cancel it (CancellationToken) and emit `getLastKnownLocation`. Today the fallback is unreachable whenever the fused provider hangs (exactly this device). Belongs on the location branch.

## Open questions
- Auto-repair on repeated `append:timeout`, or always user-triggered?
- Should `circle:repair` snapshot the corrupt cores aside (for later root-
  cause) rather than delete, given storage cost?
- Is 8 s the right append timeout, given autobase append can legitimately
  await a linearization on a slow device? Tune on-device.
