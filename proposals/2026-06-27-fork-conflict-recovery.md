# Fork-conflict recovery — catch hypercore conflicts and re-sync from the seeder instead of crash-looping

**Status**: Draft 2026-06-27. Not yet reviewed. Grounded in an on-device crash log from Benjamin's Pixel 7 (`PearCircle_log_275784395528.txt`, 17 identical aborts 2026-06-24 → 2026-06-27).

**Goal**: Stop a single forked hypercore from hard-crashing the worklet in a loop, and recover the affected circle by rebuilding its local cores and re-syncing the canonical history (the seeder being the most reliable holder of it). Reuse the existing `circle:repair` machinery rather than inventing a new recovery path.

**Tier**: T2. No new wire message and no new replicated record kind — recovery reuses the existing `circle:repair` rebuild (local) and the pair-channel `addWriter` re-admission (existing protocol). The new surface is local: a conflict detector, a route into `flagDegraded` → `circle:repair`, and a seeder-preferred re-sync hint. The data-integrity blast radius is circle-wide, so this is proposal-gated; the *prevention* half (writer-core rewind guard) is a sibling and is T3 (touches the replication durability invariant) — out of scope here, tracked separately.

## Background

### What happened

On Benjamin's Pixel 7 (GrapheneOS, `panther:16`), PearCircle crash-looped 17 times over three days. Every abort is the same, on the worklet's V8 thread (`mqt_v_js`):

```
I com.pearcircle: [hypercore] conflict detected in 2a97627776e4c1d3991fd4e80526fc10423a0867fd9b34c679774d518216db96 (writable=true,quorum=1)
E com.pearcircle: Uncaught Error: Closed
    at SessionState.close (hypercore/lib/session-state.js:191)
    at Hypercore.close (hypercore/index.js:487)
    at Core.closeAllSessions (hypercore/lib/core.js:897)
    at Core._onconflict (hypercore/lib/core.js:888)
    at async Core.checkConflict (hypercore/lib/core.js:660)
    at async Peer._handleData (hypercore/lib/replicator.js:1210)
    at async Peer.ondata (hypercore/lib/replicator.js:1201)
    at async Promise.all (index 3)
```

Sequence each launch: `init:done` (1 circle, `V7yrQFkw…`, the Hudgins Family circle) → peers connect (`6bc4c488`, `a8d7c22b`, `080fbd90`, seeder) → lastSeen replication starts → ~3s in, hypercore detects **two conflicting signatures at the same length** on core `2a976277…` and calls `_onconflict` → `closeAllSessions(new Error('Closed'))` tears down in-flight sessions → one rejection escapes through the replicator's `Promise.all` → the worklet has no `unhandledRejection` handler, so Bare aborts (SIGABRT). Process uptimes ranged 10s–207s depending on when a peer holding the conflicting copy connected.

### Root cause

`writable=true, quorum=1` means the forked core is **Benjamin's own member writer core**, not a peer's. A single-writer append-only core can only fork if its length went **backwards and then forward with different content** — i.e. it was truncated and re-appended. The most likely trigger is the RocksDB WAL loss from the boot-wedge crash family (see `project_wal_badalloc_wedge`) or a storage-reclaim truncate (see `project_storage_reclaim_unsafe`). The seeder and peers still hold the original pre-truncation branch, so every reconnect re-presents the canonical history, hypercore re-detects the contradiction, and the loop repeats.

Two distinct defects:

1. **No seatbelt.** A detected conflict is, by hypercore's design, a fatal integrity event. But the rejection leaks through the replicator's `Promise.all` and, with no global handler, takes down the whole worklet — every circle, not just the broken one. This is the crash loop.
2. **No recovery trigger for this failure mode.** We already have a strong recovery path (`circle:repair`, proposal 2026-06-03-autobase-append-hang), but it is only ever reached via *append/read timeouts* (`flagDegraded`). A fork conflict fires from the replicator, not from an append, so it never routes into recovery.

### Why the existing `circle:repair` already does the right thing

`circle:repair` (src/bare.js:1690) remounts the circle under a fresh corestore namespace (`rebuildGen+1`), which:

- gives this device **brand-new local writer/view/system cores** (a new writer key), so the forked gen-0 core is orphaned on disk and never advertised again;
- **re-applies from the bootstrap and re-syncs clean from the seeder** (its own comment, src/bare.js:3634);
- drops the device to read-only until an existing writer **re-admits it via the pair-channel `addWriter` flow** — the normal join-as-writer path;
- preserves identity, membership and history (the seeder/peers hold them).

That is precisely a seeder-based recovery. The fork-specific work is therefore mostly **detection and routing**, plus making the canonical-source preference explicit, plus closing the idempotency gaps below.

## Scope

In scope:

- **Conflict detection.** Attach a listener for hypercore `'conflict'` on the cores backing each circle's Autobase (primary), plus a **scoped** `unhandledRejection` / `uncaughtException` handler in `src/bare.js` as a backstop (matching only the conflict / `"Closed"` signature; re-throw everything else so real bugs still surface). Maintain a `discoveryKey → circleId` map (populated at mount) so a conflict — which logs only the discoveryKey, as seen above — can be attributed to the right circle.
- **Route into recovery, do not crash.** On a circle-attributable conflict, call `flagDegraded(circleId, 'conflict')` so the circle shows `needsRepair` and stops appending, exactly as a wedged base does today. The rest of the app stays alive.
- **Seeder-preferred re-sync.** When `circle:repair` rebuilds, ensure the rebuilt base prefers the seeder connection as the source for the re-synced cores (the seeder is the most reliable holder of the original, longest-replicated branch). This is a *hint*, not an authority grant — see Non-goals and Open question 2.
- **Auto-vs-prompt policy.** Decide whether a detected fork auto-triggers `circle:repair` or only flags `needsRepair` and lets the user tap "Repair" (today's manual model). Default in this draft: **auto-flag, manual repair**, to avoid surprising data churn and to keep parity with the append-hang UX. (Open question 1.)
- **Observability.** `conflict:detected {circleId, discoveryKey, writable, quorum}`, `conflict:routed-to-repair`, `conflict:seatbelt-caught` (backstop fired), `circle:repair:seeder-preferred`.

Out of scope (siblings, tracked separately):

- **Prevention (the real fix).** A writer-core **rewind guard**: on boot, before the worklet writes, detect whether the network holds a *longer* copy of this device's own core and adopt it rather than appending at a rewound tip; plus durability ordering so a block never reaches peers before it is durably flushed locally (continues `bugfix/store-wal-flush-maintenance`). This is what stops forks from happening at all and is T3. Recovery without prevention just heals the same wound repeatedly.
- **Circle-wide fork eviction.** If the forked core stays in the autobase writer set, other members replicating it among themselves can still conflict (Open question 3). A full fix may need to evict/replace the poisoned writer core across the circle, which is a larger protocol question.
- Making the seeder an authoritative conflict arbiter. Explicitly rejected — see Non-goals.

## Non-goals

- **The seeder is not promoted to a source of truth.** It holds verified *copies*, not signing authority, and it obeys the same one-value-per-index rule as every node. We use it as the preferred *recovery source* because it reliably holds the original branch, not as a judge that overrides cryptographic integrity. "Take the already-replicated original" is safe; "take whatever the seeder has" would spread corruption if the seeder ever held the forked branch first.
- Not every circle has a seeder; recovery must still work peer-to-peer, with the seeder as a preference when present.

## Compat

No wire change, no persisted-schema change, no new replicated record. The detector, the seatbelt, and the routing are local. Re-admission uses the existing pair-channel `addWriter` path. Mixed-version circles are unaffected: an old peer sees a repaired device re-join as a new writer, which is already a supported flow. Rollback = revert the commit; the conflict reverts to crashing (status quo ante), no state to unwind.

## Verify

- `npm run verify` green.
- **Repro harness (node):** extend the existing `tools/repro-*.js` pattern to force a writer-core fork (append, truncate below the replicated tip, re-append divergent content, replicate against a peer holding the original) and assert: (a) without the fix the worklet-equivalent aborts; (b) with the fix the conflict is caught, the circle is flagged `needsRepair`, and the process stays up.
- **On-device, the actual failing circle:** rebuild the Pixel 7 debug build on this branch, install with `install -r` (same keystore), launch `com.pearcircle.debug`. Expect: app opens, the Hudgins Family circle shows `needsRepair` instead of crash-looping; tap Repair → `circle:repair` rebuilds, `circle:repaired` fires, the device re-syncs from the macOS seeder and re-admits as a writer; no further `conflict detected` aborts across several restarts. Confirm the other circles were never affected.
- Two-device smoke per the verify gate: pair, share location, geofence enter/exit notification on the receiver.

## Rollback

Revert the single commit. The `'conflict'` listener, the scoped `unhandledRejection` backstop, the routing, and the seeder-preference hint all go away; behavior returns to today's (fatal). No peer-visible or persisted state changes.

## Open questions

1. **Auto-repair or manual?** Auto-triggering `circle:repair` on a detected fork is less for the user to do, but a fork that recurs (e.g. seeder also holds the bad branch) would auto-rebuild on a loop. Draft default is auto-flag + manual repair. Decision needed.
2. **What if the rebuilt base re-downloads the forked branch?** Both branches are validly signed; hypercore cannot tell "canonical" from "forked" by signature alone, only that they conflict. The rebuilt gen+1 base pulls the writer core fresh from the network — if a peer offers the forked branch before the seeder offers the original, the conflict can recur. The seeder-preference hint mitigates this but does not guarantee it. Do we need to pin the rebuilt base to the seeder's copy until it has the full original branch, and explicitly refuse the conflicting offer?
3. **Circle-wide scope.** `circle:repair` heals *this device*. The forked gen-0 writer core is still referenced by the circle's writer set, so two other members could conflict on it independently. Does recovery need to propagate a "this writer core is poisoned, replace it" signal across the circle, and is that a wire change (escalating to T3)?
4. **Detection hook.** Confirm the cleanest attach point for the `'conflict'` event across the cores Autobase opens on demand (per-core listener via a corestore `core-open`-style hook vs relying on the scoped `unhandledRejection` backstop as primary). Implementation detail, but it decides how much we depend on the catch-all.

## Relationship to other work

- Reuses `circle:repair` / `flagDegraded` / `_degradedCircles` / `needsRepair` from **2026-06-03-autobase-append-hang**.
- Recovery re-admission reuses the pair-channel `addWriter` flow and intersects **2026-06-11-seeder-readmit** (resume replication to a re-admitted seeder).
- The prevention sibling continues **bugfix/store-wal-flush-maintenance** and the lessons in `project_wal_badalloc_wedge` / `project_storage_reclaim_unsafe`.
