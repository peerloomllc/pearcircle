# Trip replication review

Approved 2026-05-10 (Tim, in-session). Proposal at `proposals/2026-05-10-trip-replication.md`. Shipped across two commits:

- **79533ab** wire side — apply branch for `trip:{pubkey}:{startTsPadded}`, per-circle `trips:sharing:{circleId}` toggle, trips:listFor / listForMember / sharing:get / sharing:set / delete IPCs, and `src/lib/tripWire.js` (pure helpers + 24 jest cases covering apply rules, sharing predicate, view-layer dedup with tombstone-wins).
- **4bb04b2** UI side — Settings → Trip sharing collapsible with per-circle toggles and confirm sheets; MemberDetailSheet "View N trips" affordance on any member when trips exist; TripsView + TripDetailView parameterized by ownerPubkey; trip delete action (scope='all') with Trash icon in detail header.

Wire schema additive (new `trip:` prefix; old peers' apply branch silently drops it per existing fallthrough; v1 floor preserved). Privacy default is opt-out per circle, no backfill on enable, soft-delete tombstones honor no-resurrection. View-layer dedup keys by `(pubkey, startTs)` so the same trip replicated to multiple circles surfaces once; any tombstone wins, including hiding the local copy.

`npm run verify` clean: 185 tests pass (was 161), all bundles build. Manual smoke: Settings UI renders correctly on D1 (Pixel) with both circles defaulting to "Off". Cross-device replication trial (D1 toggle on → record trip → D2 sees in MemberDetailSheet) is the next interactive step.
