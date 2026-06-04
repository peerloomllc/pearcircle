# RCA: circle wedge from unbounded lastSeen oplog growth

- **Date:** 2026-06-04
- **Tier:** T2 (data-model / replication; no wire break, but cross-peer effect)
- **Status:** Root cause confirmed. Fix proposal: `proposals/2026-06-04-lastseen-ephemeral.md`.
- **Related:** `proposals/2026-06-03-autobase-append-hang.md` (recovery, root cause was left open there), `proposals/2026-05-29-*` storage-growth / lastSeen coalescing.

## Summary
A circle's per-circle Autobase grew large enough that `base.update()` (the linearize/apply pass that every append and every view read runs through) stopped completing within the worklet's time budget. The dispatcher then timed out appends and reads, flagged the circle `needsRepair`, and the "strong repair" rebuild re-replicated the same oversized history and re-wedged. The growth is almost entirely `lastSeen` location updates retained in the append-only oplog. This is not data corruption.

## Impact
- Circle `VLRwUprk` ("ABFG") became unusable: the owning device's location froze (reported as ~4 days stale), "View my trips" hung, and the whole worklet went unresponsive because the IPC dispatcher serializes on the stuck handler.
- Spread across devices: a previously-healthy Pixel 9 also wedged on this circle once it had replicated the full history. Any device that fully syncs the circle is affected.
- The recovery shipped in `2026-06-03-autobase-append-hang` (timeouts, `needsRepair`, `circle:repair`) kept the UI responsive but could not cure the circle: rebuild re-imports the bloat.
- Scope-limited: only this long-lived, heavily-used circle crossed the threshold. Other circles on the same devices (e.g. "Hudgins Family") are healthy.

## Root cause
`lastSeen` is written as an Autobase op `{type:'put', key:'lastSeen:{pubkey}', value}` on every accepted location update (`src/bare.js` `appendLastSeen` / `autoAppendSelfLastSeen`, via `safeAppend`). Autobase's oplog is append-only: each write to the fixed per-member key is retained forever, even though only the latest value per key is ever read (the derived Hyperbee view stays small). The log therefore grows without bound in proportion to location-update volume, while the view does not.

Linearization/apply cost scales with the oplog, not the view. Once the oplog reaches hundreds of thousands of nodes, `base.update()` takes longer than the dispatcher's append/read timeouts on a mobile device, so it reads as a hang.

### Evidence (2026-06-04)
Reproduced deterministically off the live circle with `tools/repro-vlrwuprk.js`: it joins the swarm from an invite, re-replicates from the seeder into a fresh corestore, mounts the base, and instruments the linearizer. Read-only (never appends).

- System core ~340,000 nodes; founder writer `5ca09b` alone at 163,559 blocks; two other writers at ~22k and ~43k.
- Op tally of the linearized nodes: **99.85% `lastSeen:`** (27,743 of 27,784 applied in a partial-sync run), the remainder transitions (23), places (5), members (3), seeder (2), circle (1).
- At the wedge: **zero stuck Hypercore reads** (not waiting on a missing/un-replicated block), event loop free with timers firing on schedule (not CPU-bound or deadlocked), `caughtup=true`, `fastForwardTo=null`, `_runForceFastForward` never called. `update()` is simply parked in `_drain` because the pass is too large to finish.
- Non-deterministic by sync completeness, which is the signature of a volume threshold rather than a corrupt op: a ~298k-node partial sync converged via a single fast-forward; a ~340k-node full sync wedged.

Autobase 7.27.3 (matches the app's `node_modules` and the local source mirror used to interpret `_drain`).

### What it is NOT (hypotheses falsified)
- Not a poisoned/corrupt op or a missing referenced block (zero stuck reads).
- Not local-disk corruption and not a half-applied storage reclamation: storage reclamation never shipped to production and the affected device was only ever on production releases. A full fresh-namespace rebuild that re-syncs from peers re-wedges, proving the cause lives in the shared replicated history, not local storage.
- Not device-specific: the same history wedges any device that fully replicates it.

## Contributing factors
- High-frequency ephemeral state (`lastSeen`, also `presence`) was modeled as durable ops in a permanent multi-writer consensus log. The data is last-writer-wins on a tiny fixed key set, so none of the history has lasting value, yet all of it is retained and replicated.
- Append/read cost is invisible in normal testing: it scales with cumulative write volume over the life of a circle, so a fresh test circle never reproduces it. The failure is a slow-burn that only appears after weeks of real use.
- The 2026-05-29 lastSeen coalescing reduced the write *rate* but not the unbounded *total*: the log still grows forever, just slower.
- No telemetry on oplog size, so the growth was invisible until a circle crossed the hang threshold in the field.

## Preventive controls (not "be more careful")
1. **Remove the unbounded source.** Stop persisting high-frequency `lastSeen` (and presence) as retained Autobase ops. Relocate live position to a mechanism whose storage is bounded: ephemeral exchange over the swarm connection, and/or a per-member core that can be truncated to the latest fix. Tracked in `proposals/2026-06-04-lastseen-ephemeral.md`.
2. **Bound the log even for legitimately retained data.** Adopt Autobase checkpoint/fast-forward truncation so indexed history below the confirmed point can be dropped, capping linearize/apply cost regardless of age.
3. **Detection before the cliff.** Emit an oplog-size metric (system core length and per-writer length) at boot and on a slow timer; warn well before the hang threshold so a circle can be migrated/compacted proactively instead of discovered wedged.
4. **Keep the recovery, change its promise.** The `2026-06-03` timeout + `needsRepair` machinery stays (it keeps the worklet responsive), but the UI must not present rebuild as a cure for a size-wedge, because it cannot be. Until the fix lands, the honest remedy for an already-bloated circle is owner re-creation (a fresh empty autobase); document that.

## Action items
- [ ] Land the lastSeen-ephemeral fix proposal (`proposals/2026-06-04-lastseen-ephemeral.md`) - the actual cure.
- [ ] Add oplog-size telemetry + a pre-threshold warning (control 3).
- [ ] Update `proposals/2026-06-03-autobase-append-hang.md` "Root cause - still open" to point here.
- [ ] Decide migration/compaction story for existing bloated circles (owner re-create vs an automated compaction).
- [ ] Keep `tools/repro-vlrwuprk.js` as the reusable reproduction for any future wedged circle.
