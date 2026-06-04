# Move live position off the Autobase oplog (bound circle growth)

## Goal
Stop persisting high-frequency `lastSeen` location updates as retained Autobase ops, so a circle's oplog (and therefore its linearize/apply cost) stops growing without bound. Cures the wedge class diagnosed in `rca/2026-06-04-lastseen-oplog-bloat.md`.

## Tier
T3. Position propagation is a core cross-peer feature, the change alters how a member's location reaches other members, and peers upgrade on their own schedule, so a mixed fleet must keep working throughout. Proposal + rollback + RCA readiness required; the RCA is already filed.

## Background
`lastSeen` is appended as `{type:'put', key:'lastSeen:{pubkey}', value}` on every accepted location update (`appendLastSeen` / `autoAppendSelfLastSeen`). The op is last-writer-wins on a fixed per-member key: only the latest value is ever read (`snapshotCircle` streams the `lastSeen:` prefix from the derived Hyperbee view, `src/bare.js:2160`). But the Autobase oplog is append-only, so every historical update is retained and replicated forever while the view stays tiny. On circle `VLRwUprk` this reached ~340k nodes (99.85% `lastSeen`), at which point `base.update()` no longer finished within the worklet's append/read timeouts. See the RCA for the full evidence.

`presence:{pubkey}` has the same shape and the same (lower-rate) unbounded-growth problem, so it is in scope.

## Scope

### Recommended design: ephemeral live position + bounded persisted last-known
1. **Live position over the swarm connection (no oplog write).** Add a per-circle Protomux channel (reusing the `openPairChannelsForCircle` infrastructure) on which each member broadcasts its current fix to connected circle peers. Recipients hold the latest per-member position in memory and render it. Real-time, zero oplog growth. This replaces the autobase write as the *live* path.
2. **Bounded persisted last-known for offline peers.** Ephemeral messages vanish when a peer is disconnected, and the blind seeder cannot relay them, so keep a bounded persisted last position so a peer coming online (or the seeder) can still serve "last known." Use a **single-writer per-member `lastSeen` Hypercore**, truncated to retain only the latest fix (or a tiny window). Single-writer LWW needs no consensus, and Hypercore supports clearing/truncating old blocks, so storage is O(1) per member instead of O(updates). The seeder replicates these cores as it does the bootstrap core.
3. **Read precedence** for a member's position: live ephemeral value > per-member last-known core > legacy autobase `lastSeen:` view (for not-yet-upgraded peers).

### Does not change
- Geofence transitions, trips, places, members, circle metadata: these are low-volume, genuinely-durable ops and stay in the autobase.
- Wire topic derivation, invite format, identity, pairing/admission.

### Alternatives considered (rejected as primary)
- **Keep lastSeen in the autobase, bound it via Autobase checkpoint/fast-forward truncation.** Truncating writer cores in a multi-writer base is exactly what the storage-reclamation attempt proved unsafe (corrupts the view). Kept as a possible secondary control for the *durable* ops, not the cure here.
- **Pure ephemeral, no persisted last-known.** Simplest, zero growth, but regresses the current "stale-but-present position when a peer is offline" behavior, which the blind seeder exists to provide. Rejected.

## Compat
This is the load-bearing section because peers do not upgrade together.

- **Two-phase rollout.**
  - *Phase 1 (interop):* upgraded peers DUAL-WRITE - they still append `lastSeen` to the autobase (so old peers, which only read the view, keep seeing them) AND publish live ephemerally + persist to the per-member core. Upgraded peers read by the precedence above. This ships safely into a mixed fleet but does NOT yet stop growth.
  - *Phase 2 (growth-stop):* once the fleet has upgraded, a flag flips off the autobase `lastSeen` write. This is the actual fix; it is gated behind fleet adoption because an old peer would otherwise stop seeing upgraded peers' positions.
- **Existing bloated circles are not shrunk by this change.** Dual-write only stops *future* growth (phase 2). A circle already at ~340k nodes stays wedged. Remediation (decided 2026-06-04): the owner re-creates the circle for a fresh empty autobase and re-invites members; an automated compaction tool was considered and rejected as not worth the complexity for the handful of affected circles. ABFG/`VLRwUprk` will be re-created by its owner.
- **Presence** migrates the same way.

## Verify
- `npm run verify` green; new `node` tests: per-member core retains only the latest fix after N updates (bounded); read-precedence resolver picks ephemeral > core > view; dual-write emits both during phase 1.
- Repro harness: after the change, a synthetic circle driven through tens of thousands of location updates keeps a flat oplog (the `tools/repro-vlrwuprk.js` instrumentation should show system length staying bounded), and `base.update()` stays fast.
- Device smoke: two upgraded devices see each other's live position over the ephemeral channel and the correct last-known after one goes offline; one upgraded + one old device still interoperate (phase 1).

## Rollback
- Phase 1 is additive (new channel + new core + dual-write); reverting restores autobase-only lastSeen, no peer-visible break.
- Phase 2 is a single flag; flip it back on to resume autobase writes if an interop problem surfaces.

## Open questions
- Persisted last-known: a dedicated per-member Hypercore vs a small fixed-size slot in the existing local store that is gossiped. Core is cleaner for seeder replication; evaluate plumbing cost.
- How aggressively to truncate the per-member core (latest-only vs a short trail for a breadcrumb view).
- Phase-2 trigger: an explicit version gate / capability handshake vs a manual fleet-wide flip once telemetry shows adoption.
- Should the durable ops (trips especially) also get checkpoint/truncation as a belt-and-suspenders bound, or is their volume low enough to ignore.
