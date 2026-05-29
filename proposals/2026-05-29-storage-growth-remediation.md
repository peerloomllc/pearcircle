# Storage growth remediation - bound the per-circle log and reclaim disk

**Status**: Draft 2026-05-29. Awaiting approval. Open questions unresolved (see end).

**Goal**: Stop the per-circle Autobase store from growing without bound (measured at ~1.05GB of app data on a long-running Android install, almost entirely the Corestore), and reclaim disk already consumed, without breaking replication or the wire protocol.

**Tier**: T2 overall. Phase 1 (write coalescing) is T1 - no wire change, no schema change, old and new peers fully interop, only the update *cadence* changes. Phase 2 (member-side block reclamation) is T2 - it touches local storage semantics (clearing Hypercore block data) and must be proven not to corrupt local reads, though it makes no wire change. Phase 3 is future/optional.

## Background

Measured on device D1 (release `com.pearcircle`, via `dumpsys diskstats`):

| Component | Size |
|-----------|------|
| App data (persistent) | ~1.05 GB |
| APK + native libs | 274 MB |
| WebView HTTP cache | 19 MB |
| Map tile cache (IndexedDB) | ~5 MB |

Confirmed via `run-as` on the debug build that the app-data footprint is essentially all Corestore (`files/pearcircle/store/db`, the RocksDB-backed Hypercore block store, hypercore 11 / corestore 7). The tile cache (capped 500MB, `src/ui/lib/tileCache.js`) and WebView cache are rounding errors. So the 1.5GB the user sees is the append-only P2P log, not cache.

Root cause, dominant on Android:

- The worklet appends one `lastSeen:{ourKey}` block per `location:update`, unconditionally after validation (`src/bare.js:1316`).
- Android's foreground service requests location every ~10s with NO movement gate (`PearCircleLocationService.kt`, `LocationRequest` interval 10s / fastest 5s, no `setMinUpdateDistanceMeters`). So a stationary, sharing Android phone appends ~6 blocks/min = ~8,600/day, per circle, forever. Over weeks across several circles this is the bulk of the 1GB.
- iOS grows slower (the native `distanceFilter` of 5m plus `pausesLocationUpdatesAutomatically` gate delivery), but is still unbounded while moving.
- Hypercore is append-only: a Hyperbee `put` to the same key appends a new block; the old ones are never reclaimed. Autobase keeps the full input oplog. The view materialization (Hyperbee b-tree) also grows.
- There is no member-side retention or compaction. `src/lib/tripRetention.js` deletes only *view* rows (14-day trips), not underlying blocks. `src/lib/seederRetention.js` (sidecar `receivedAt` + `core.clear(seq, seq+1)`) runs in seed mode only.

The byte-identical second `lastSeen` write (`src/bare.js:1833`) is NOT per-fix - it only fires when a place transition is detected, so it is a minor contributor.

Library reclamation surface (confirmed in installed deps): hypercore 11.29.0 exposes `clear(start, end)` (drops local block *data*, keeps the verifiable merkle tree), `truncate`, and `purge`. autobase 7.27.3 has fast-forward machinery (`forceFastForward`, `_gcWriters`, `_clearWriters`). The blind-seeder retention (proposal 2026-05-19, `seederRetention.js`) already proves the `core.clear` + sidecar + RocksDB-compaction pattern in production.

## Scope

Two axes: (A) stop the bleeding (reduce writes), (B) reclaim what is already on disk.

### Phase 1 - coalesce `lastSeen` writes (T1, ship first)

The fix for the growth rate. A stationary phone must not append thousands of identical-position blocks per day.

- **Worklet-side movement gate** in the `location:update` handler, before the `lastSeen` append (`src/bare.js:1316`): keep the last-appended position per circle; append only when the new fix is at least `LASTSEEN_MIN_MOVE_M` from it (proposed ~20m, tunable). Stationary devices append nothing. This is the universal fix because it covers Android too, where the native stream has no movement gate.
- **Decouple from detection**: the gate applies ONLY to the `lastSeen` append. The geofence classifier (`checkPlaceTransitions`) and the trip detector must still see every fix, so transitions and trip fidelity are unchanged. (Open question O4: confirm the trip polyline is built from the trip detector's own buffer, not from `lastSeen` history.)
- **No periodic heartbeat**: liveness is already the swarm-connected dot, not `lastSeen.ts` (2026-05-17 swarm-live-signal), and on-demand freshness is covered by the foreground one-shot (#63) plus the Tier 1 visit/self-region wakes (#64). So a pure movement gate is consistent with decisions already made; a stationary phone's `ts` going stale is the accepted posture.
- **Android native defense-in-depth**: add `setMinUpdateDistanceMeters` (~10m) to the FusedLocation request so the OS stops delivering ~10s stationary fixes at all, cutting wakeups and battery as well as writes. The worklet gate remains the authoritative cap.
- **Drop the redundant transition-path `lastSeen` write** (`src/bare.js:1833`) or fold it into the gate. Minor, but free.

Phase 1 stops growth. It does NOT shrink the existing 1GB - that needs Phase 2.

### Phase 2 - member-side block reclamation (T2, after a validation spike)

Generalize the seeder retention pattern to member devices to reclaim disk from superseded blocks.

- Once an input-oplog block is below the Autobase indexed/checkpoint frontier and has been applied to the local view, this device no longer needs the block *content* to maintain current state. `core.clear(seq, seq+1)` frees its disk while preserving the merkle tree (so the log stays verifiable and the length is unchanged).
- Reuse the `seederRetention.js` shape: a local sidecar tracking clearable seqs per core, a periodic sweep calling `core.clear`, then a RocksDB compaction to actually return space to the filesystem.
- Safety: clearing is local-only and makes no wire change. A peer that needs the cleared history fetches it from someone who retained it (another member, or a blind seeder) or fast-forwards to the snapshot. Each device manages its own disk independently.
- The load-bearing uncertainty is the Autobase safe-clear frontier (O1): what is the exact, supported way in autobase 7 to know "all ops up to seq S on writer W are applied and causally settled, so their blocks are safe to clear locally," and whether clearing them interferes with Autobase's own bookkeeping or fast-forward. This needs a spike against the Holepunch source before committing.

### Phase 3 - optional / future

- **Transition retention**: `transition:` rows are permanent by design. Old ones could be view-pruned + block-cleared with a seeder retaining history. Smaller than `lastSeen`, and changes the product (history horizon), so deferred.
- **View compaction**: reclaiming superseded Hyperbee b-tree nodes in the materialized view. Risky (b-tree node sharing means the current root can reference old blocks), likely needs Autobase support. Deferred.
- **Fast-forward-driven GC**: drive `autobase.forceFastForward` so removed writers' cores and pre-snapshot history get GC'd automatically. Investigate alongside O1.

Out of scope:

- Changing the wire protocol or any record schema.
- Reclaiming disk by wiping and re-syncing the Corestore - the identity keypair lives in the same store, so this strands the device's identity (the "never uninstall" rule). Not a remediation path.
- Touching the tile cache / WebView cache - they are already bounded and negligible here.

## Compat

- **Phase 1**: no wire/schema/IPC/topic change. `lastSeen` is last-writer-wins current position; fewer appends means peers see fewer intermediate positions and a pin that advances only on real movement (already the iOS behavior). Old-code and new-code peers fully interop. The only observable change is update cadence. T1.
- **Phase 2**: no wire change at all. `core.clear` drops local block data but preserves the merkle tree and log length, so replication and verification are unaffected for blocks this device still holds, and peers source missing history elsewhere. A device that cleared aggressively simply cannot serve that history to a lagging peer - which is what the always-on seeder is for. T2 because it touches local storage integrity and must be proven safe, not because it changes the wire.

## Design

### Phase 1 gate (illustrative)

```js
// per-circle: _lastAppendedPos.get(circleId) = { lat, lon }
'location:update': async ({ lat, lon, accuracy, ts, ... }) => {
  // classifier + trip detector run on EVERY fix (unchanged) ...
  for (const [circleId, base] of _circleBases) {
    if (!base.writable || !getCircleSharing(circleId).enabled) continue
    const prev = _lastAppendedPos.get(circleId)
    if (prev && haversineMeters(lat, lon, prev.lat, prev.lon) < LASTSEEN_MIN_MOVE_M) continue
    await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value })
    _lastAppendedPos.set(circleId, { lat, lon })
  }
}
```

The foreground one-shot path should bypass the gate (an explicit "refresh now" must always write), so opening the app still publishes a current fix even when stationary.

### Phase 2 sweep (illustrative, mirrors seederRetention)

```js
// member-side, per writable core in each circle's autobase:
//   localDb 'reclaim:clearable:{coreKey}:{paddedSeq}' sidecar of applied/settled seqs
//   periodic sweep: for each clearable seq below the safe frontier,
//     await core.clear(seq, seq + 1); drop the sidecar row
//   then trigger a RocksDB compaction on the store
```

The frontier query (O1) is the gating unknown; the rest reuses `seederRetention.js` directly.

## Verify

Per Constitution Section 5, `npm run verify` (jest + bundle builds) must pass.

New tests:

- `tests/lastSeenCoalesce.test.js` (Phase 1) - the gate skips an append within `LASTSEEN_MIN_MOVE_M` of the last appended position, appends when the move exceeds it, appends the first fix unconditionally, and the foreground one-shot bypasses the gate. The classifier and trip detector are invoked on every fix regardless of the gate.
- `tests/storageReclaim.test.js` (Phase 2) - sidecar tracks clearable seqs; the sweep calls `core.clear` for seqs below the frontier and not above it; current view state (`lastSeen`, `member`, `place`, recent `transition`) still reads correctly after a sweep (the critical safety assertion); a re-open of the store after clears still serves current state.

Manual smoke (D1 / D2 / iPhone):

1. **Growth rate (Phase 1)**: with sharing on and the phone stationary for an hour, confirm zero new `lastSeen` blocks (instrument the append count). Walk a route; confirm appends roughly track ~one per `LASTSEEN_MIN_MOVE_M` of travel. Confirm peers still see the pin move and geofence enter/exit still fire.
2. **Disk before/after (Phase 2)**: record `dumpsys diskstats` app-data size, run the reclaim sweep, confirm the store shrinks materially after compaction and the app still shows correct current locations, members, places, and recent transitions for every circle.
3. **Replication intact**: after a reclaim sweep, a fresh peer can still sync the circle to correct current state (sourced from a retained peer / seeder / fast-forward).
4. **Verify gate** green; build APK + `./scripts/ios-dev-install.sh`, validate on devices, wait for user sign-off before PR.

## Rollback

- **Phase 1**: trivially revertible - remove the gate, behavior returns to append-per-fix. No persisted state to migrate (the per-circle last-appended position is in-memory).
- **Phase 2**: `core.clear` is locally irreversible per block, but the data is re-fetchable from peers / the seeder, so the cost of a bad sweep is re-replication, not data loss. Disable the sweep (a flag) to stop reclamation immediately. The sidecar is local-only and can be dropped.

## Open questions

- **O1 (load-bearing, gates Phase 2)**: In autobase 7.27.3, what is the supported way to determine the safe-to-clear frontier per input core (all ops applied and causally settled below the indexed checkpoint), and does `core.clear` on those blocks interfere with Autobase bookkeeping or fast-forward? Needs a spike against the Holepunch source (the holepunch-p2p-architect skill) before committing. Until resolved, Phase 2 is design-only.
- **O2**: `LASTSEEN_MIN_MOVE_M` value. Proposed ~20m (above the iOS 5m `distanceFilter` so the gate is meaningful, below a city block). Tune on device against pin-smoothness vs write volume.
- **O3**: Should there be any maximum interval at which a stationary phone still writes one `lastSeen` (a slow heartbeat), or is pure movement-gating correct? Recommend pure movement-gating, since liveness is the swarm dot and freshness-on-open is the one-shot. Confirm no UI path silently depends on `lastSeen.ts` advancing.
- **O4**: Confirm the trip polyline is built from the trip detector's own point buffer and not from `lastSeen` history, so coalescing does not coarsen trips. If it does read `lastSeen`, feed the detector a separate ungated point stream.
- **O5**: Does `core.clear` alone return space to the filesystem on the RocksDB-backed corestore 7 store, or must we trigger an explicit compaction (and is there a supported API for that)? The wiki notes reclaim triggers RocksDB compaction; verify the trigger.
- **O6**: Reclamation cadence and battery - run the sweep on a generous interval (daily, like the seeder) and only while charging / idle, to keep it off the hot path.
