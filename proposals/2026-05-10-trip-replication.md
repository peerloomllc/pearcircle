# Trip replication (per-member trip visibility)

**Status**: Approved 2026-05-10. All open questions resolved in favor of proposal defaults (Q1 per-circle granularity, Q2 publish-and-read asymmetry, Q3 add optional `label` to v:1, Q4 view-layer dedup by startTs). Implementation unblocked per Constitution §3.

**Goal**: Let circle members see each other's trips, not just their own. Today (commit 6a43733) trips live in the local Hyperbee under `trips:{pubkey}:{startTs}` and never replicate. MemberDetailSheet only surfaces a "View my trips" button on the self pin. This proposal extends the wire protocol so trips can replicate through the per-circle autobase under an opt-in policy.

**Tier**: T3. New replicated record kind = wire change. Old-code peers (running everything up through 317827e) and new-code peers must continue to interoperate; old peers' apply branch already silently drops unknown key prefixes (§3 final paragraph), so they remain forward-compatible read-only against trips, but write asymmetry exists. v1 remains the floor; the existing `v: 1` field convention is extended.

## Background

Trip recording (slice 1, commit 37dc5c1) records a polyline in memory while the user moves and persists the completed trip to local Hyperbee at `trips:{pubkey}:{startTs}`. Trip browsing (slice 2, commit 20842a4) surfaces those records in a list + detail view sheet from the self pin. CLAUDE.md notes: "trips are local-only by default."

The original TODO entry for this work:

> **Per-member trip visibility (T3 wire-protocol amendment).** Slice 2 ships self-only trips because trips currently live in the local Hyperbee, not the per-circle autobase. To let circle members see each other's trips: replicate `trips:` records through the autobase, decide on per-circle keying, define an opt-in/out policy per circle, settle a retention window, and amend the wire-protocol proposal accordingly. UI side: MemberDetailSheet would surface "Trips" for any member (not just self).

Privacy is the load-bearing constraint. Trip polylines reveal granular movement patterns that a circle member did not necessarily intend to share when they agreed to share live location. The default for replication MUST be opt-out: a user who upgrades to a new build that supports this should ship zero trips until they explicitly turn sharing on for at least one circle.

## Scope

In scope:

- New per-circle replicated key prefix `trip:{pubkey}:{startTs}` on the per-circle autobase view.
- Trip record schema: signed value carrying pubkey, startTs, endTs, polyline, distanceMeters, durationMs, maxSpeedMps, plus tombstone fields (`deleted`, `deletedAt`) for soft-delete.
- Local-only per-circle opt-in toggle: `trips:sharing:{circleId}` boolean in local Hyperbee. Default false on every circle. Worklet only appends trip records to circles where the toggle is true.
- Trip writes happen at trip-completion time (the existing `trip:completed` IPC event path in `bare.js` location:update handler) — for every circle where the toggle is true, append a trip record to that circle's autobase. The local Hyperbee write is unchanged.
- Apply branch in `bare.js` handles `trip:*` keys: signature verification, future-ts rejection, key/value pubkey match, view.put. No IPC event emit on apply (unlike `transition:applied`) — trip records are passive history, not real-time notifications.
- IPC: new method `trips:listForMember({ circleId, pubkey })` that scans the per-circle autobase view (not local Hyperbee) for `trip:{pubkey}:` prefix. Self-trips continue to come from the local `trips:list` IPC.
- IPC: new method `trips:sharing:get` / `trips:sharing:set` for the per-circle toggle, mirroring `sharing:set` shape.
- IPC: new method `trips:delete({ startTs, scope: 'local'|'circle'|'all' })` for user-driven deletion. Local-scope deletes the local Hyperbee row. Circle-scope writes the soft-delete tombstone to every circle's autobase where the trip exists. `all` does both.
- UI: MemberDetailSheet surfaces "Trips" button for any member when at least one trip exists for them in the current circle. Reuses the existing TripsView, parameterized by `{ ownerPubkey, source: 'local'|'circle:{id}' }`. TripDetailView likewise.
- UI: Settings → per-circle list with a "Share my trips" toggle per circle. Default off. Toggle on prompts a one-time confirmation surfacing the privacy posture ("Members of this circle will see your past 7 days of trips; toggle off any time to stop sharing future trips").
- UI: when toggling on, no backfill prompt for this proposal. Only trips completed after the toggle-on time get replicated. (Backfill is a follow-up if requested.)

Out of scope:

- Auto-retention / TTL pruning. Trips accumulate; user manually deletes via the per-trip "delete" affordance. Roughly 500-1000 bytes per trip; 1000 trips fits in ~1MB. If real-world growth becomes a problem, a follow-up adds a worklet-side prune at e.g. 90 days.
- Backfill on toggle-on. The per-circle toggle is "future trips only" to keep the privacy commitment legible.
- Trip "edit" semantics. Trips are append-only + soft-delete; we never mutate a polyline.
- Cross-circle deduplication. If user is in 3 circles all sharing trips, the same trip appends to each circle's autobase. ~3x storage cost is acceptable for v1; a deduplicated single-record-with-acl model is much more complex and not justified yet.
- Driving-safety annotations on trips (harsh braking, phone use). Separate v2+ feature.

## Compat

The proposal is **additive** to the v1 wire protocol:

- New replicated key prefix `trip:` in the per-circle autobase view. Old peers' apply branches silently drop unknown prefixes (§3 final paragraph: "Other prefixes silently dropped"). So old peers + new peers interoperate:
  - New writes from a new peer to old peers: old peer's apply ignores them. View doesn't grow on the old peer; new peer's view does grow. Asymmetric storage, no replication errors.
  - Old peers don't write trips. New peers reading from old peers' autobase see no trips for them. UI shows the empty-state.
  - No version bump on `circle.v` or any existing record. New `trip:*` records carry `v: 1` as the floor.
- New local-only Hyperbee key `trips:sharing:{circleId}`. Default-false interpretation handles old peers (no such row = no sharing).
- No invite-link grammar change. No swarm-topic change. No IPC envelope change beyond the new method names listed above.

The version field on trip records stays at 1 for this proposal. Future shape changes (e.g. adding altitude or barometric pressure for the flight-detection follow-up) can amend additively.

## Design

### Trip record schema

Replicated, signed value at `trip:{pubkey}:{startTs}`:

```js
{
  pubkey: hex,                     // matches the writer; verified
  startTs: number,                 // ms epoch, matches the key suffix; verified
  endTs: number,                   // ms epoch, > startTs
  polyline: [[lat, lon], ...],     // 2-tuples; sampled at trip-step intervals
  distanceMeters: number,
  durationMs: number,
  maxSpeedMps: number,
  label?: string,                  // optional user-supplied name; receivers fall back to formatTripDate when absent
  deleted?: boolean,               // soft-delete tombstone
  deletedAt?: number,              // ms epoch
  v: 1,
  // sig added by signValue()
}
```

`startTs` is the canonical id (matches the existing local schema), so the key is `trip:{pubkey}:{startTs}` with `startTs` rendered as a fixed-width zero-padded decimal so that lexicographic prefix scans return chronological order (oldest first). Reverse scan (newest first) by reversing the iteration.

Apply branch in `applyCircleNodes`:

```js
if (op.key.startsWith('trip:')) {
  const incoming = op.value
  if (!verifyValue(incoming)) continue
  if (typeof incoming.startTs !== 'number') continue
  if (typeof incoming.pubkey !== 'string') continue
  if (incoming.startTs > Date.now() + FUTURE_TS_TOLERANCE_MS) continue
  // Key/value pubkey + startTs match check: rules out a writer
  // forging another member's trip under a key with their pubkey.
  const tail = op.key.slice('trip:'.length)
  const firstColon = tail.indexOf(':')
  if (firstColon < 0) continue
  const keyPubkey = tail.slice(0, firstColon)
  const keyStartTs = tail.slice(firstColon + 1)
  if (keyPubkey !== incoming.pubkey) continue
  if (keyStartTs !== String(incoming.startTs).padStart(13, '0')) continue
  await view.put(op.key, incoming)
  continue
}
```

No IPC emit. Receivers pull via `trips:listForMember` when the UI surfaces.

### Soft-delete

Same LWW-on-{lastWrite-wins-by-newer-deletedAt-or-bigger-row} pattern as `place:{id}` (proposal amendment 2026-05-05). To delete: re-write the same key with `deleted: true` and `deletedAt: Date.now()`. To undelete: re-write without `deleted` (sign + put; the apply branch's `view.put` overwrites).

Renderer / `trips:listForMember` filter out `deleted: true` rows by default. A future "deleted trips" UI surface can scan with the filter relaxed.

### Per-circle opt-in

Local Hyperbee:

```
trips:sharing:{circleId} → { enabled: boolean, enabledAt?: number, v: 1 }
```

Default: row absent = `enabled: false`. Worklet reads on every `trip:completed` write path; only appends to autobase for circles with `enabled: true`.

Toggling off: stops future appends. Past appended trips remain in each peer's autobase view (we can't unwrite them; we can only soft-delete with the user's intent). UI on toggle-off prompts: "Stop sharing future trips with this circle. Trips already shared stay visible to members. Soft-delete past shared trips?" — yes path runs the scoped `trips:delete` over the circle's autobase.

### Backfill posture

Toggling sharing on does not backfill past trips. Only future trips replicate. Settings copy makes this explicit: "Members of this circle will see trips you take starting now."

A follow-up could add a "Share my last N days of trips" backfill button if real users ask for it. Not in this proposal.

### UI surfaces

MemberDetailSheet:
- Replace the existing "View my trips" self-only button with a generic "Trips" button visible on any member's sheet when at least one non-deleted `trip:{pubkey}:` row exists in the currently-scoped circle view.
- Self pin still shows the local-only-trips view (existing path) UNLESS the user is viewing the sheet inside a specific circle scope where they've opted in — in which case both local and replicated trips converge to the same list (the deduplication is by startTs since the same trip exists in both local and replicated stores).

TripsView (existing):
- New optional props: `ownerPubkey`, `circleId`. If both absent → self + local. If both present → that pubkey's trips inside that circle. Existing self path is the no-args case.

TripDetailView (existing):
- Same parameterization. Pulls the trip from local Hyperbee for self, or from the per-circle view for any other member.

Settings:
- New "Trip sharing" section. Lists every circle. Toggle per circle. Default off. Toggle-on prompts confirmation copy. Toggle-off prompts soft-delete-past confirmation.

### Storage estimate

A typical 20-minute drive yields ~120 polyline points at the 10s sample cadence ≈ 1.5KB per polyline (decimal-encoded). Add metadata: ~1.8KB per trip. 100 trips per user per circle ≈ 180KB per user per circle. A circle of 5 sharing members ≈ 900KB of trip data in that circle's autobase view. Acceptable.

## Verify

Per Constitution §5, `npm run verify` (jest + bundle build) must pass.

New tests:

- `tests/tripReplicate.test.js`: apply branch for `trip:*` accepts well-formed signed records, rejects:
  - unsigned values
  - mismatched key/value pubkey
  - mismatched key/value startTs
  - future-stamped (> now + 5min) values
  - missing required fields (polyline, endTs, distanceMeters)
- `tests/tripSharingToggle.test.js`: worklet's `trip:completed` write path:
  - default (no sharing rows): only local Hyperbee write happens, no autobase append
  - one circle sharing-on: local Hyperbee write + one autobase append
  - multiple circles sharing-on: local Hyperbee write + N autobase appends
  - sharing-on but worklet not writable on that circle (just joined, no addWriter yet): autobase append fails silently, doesn't crash the path
- `tests/tripDelete.test.js`: `trips:delete` scope flag:
  - `local` deletes local Hyperbee row only
  - `circle` writes soft-delete tombstone to every per-circle autobase containing the trip, leaves local row alone
  - `all` does both
- `tests/tripDedup.test.js`: view-layer dedup by `startTs`:
  - same trip in two circles surfaces once in the merged list
  - one circle deletes (tombstone) and the other doesn't → still hidden (any tombstone wins, mirrors how a deleted place hides everywhere it appears)
  - distinct trips with the same `pubkey` but different `startTs` are not deduped

Manual two-device smoke:

- D1 + D2 paired, sharing-on for D1 in the test circle. D1 records a trip; D2's MemberDetailSheet for D1 surfaces "Trips" and the new trip appears within a few seconds.
- D1 toggles sharing-off (without past-delete). D1 records a second trip. D2 sees the first trip still but not the second.
- D1 deletes the first trip with scope: 'circle'. D2's list updates within a few seconds; the soft-delete propagates.
- D1 deletes locally only. D2 still sees the trip (replicated row alive).

## Rollback

Pure additive in the wire schema, so rolling forward and back is safe at the data layer:

- Reverting the code: trips already replicated in autobase views stay there. New-code peers continue to see them until they too revert. Old peers ignored them anyway. No corruption.
- The `trips:sharing:{circleId}` local rows remain readable but unused after revert. Cosmetic.

If the design itself proves wrong post-ship (e.g., privacy default was too loose, retention too small), follow-up proposals can:
- Amend the v: 1 schema additively (new optional fields).
- Add new IPC methods.
- Bump to v: 2 for any change that would break old-peer interop, with a migration plan attached.

## RCA readiness

The Constitution §6 RCA requirement attaches to any T3 change that breaks in prod or in the release pipeline. To pre-empt:

- The privacy default (opt-out per circle) is the most fragile assumption. A code path that accidentally enables sharing or skips the gate would be a P0. The worklet check has exactly one site (the `trip:completed` handler) and is gated by `_localDb.get('trips:sharing:' + circleId)`. Tests cover both the default-false and explicit-true cases.
- Signature verification is the second-most fragile. The apply branch reuses the existing `verifyValue` helper; same pattern as `lastSeen`, `transition`, `place`. If a regression breaks signature checks generally, it breaks all replicated records, so PearCircle's existing manual smoke catches it (transitions / lastSeen would fail visibly first).
- The forward-compat claim ("old peers silently ignore unknown prefixes") is enforced by the existing apply branch's prefix-match if/continue chain. A regression that crashes on unknown prefixes would break the entire P2P layer; impossible to ship without noticing.

## Open questions (resolved 2026-05-10)

1. ~~**Per-trip share toggle in the UI?**~~ **Resolved:** per-circle is the v1 default. Per-trip is deferred unless a real user asks. No `circleIds[]` field baked into the schema (would have made future flexibility easier; we accept that a per-trip slice would need a v:1 additive field later).
2. ~~**Visibility to writers-without-trips.**~~ **Resolved:** asymmetric is correct. Sharing is "I publish; whoever's in the circle reads" — matches lastSeen / transitions today (you can read others' locations without sharing your own when your own sharing toggle is off).
3. ~~**Trip "name" field.**~~ **Resolved:** add optional `label: string` to v:1 now. Additive, costs nothing if unused, lets a future UI slice ship labels without another wire change.
4. ~~**Cross-circle aggregation in the UI.**~~ **Resolved:** dedup by startTs in the view layer. TripsView groups duplicates so the user sees each trip once even if it lives in multiple per-circle autobases. Added to the verify list (see below).
5. **Delete propagation latency.** Soft-delete tombstones replicate at the same rate as any autobase write. If a peer is offline for a week, they'll see the original trip on reconnect, then the tombstone arrives and the UI flips. Acceptable, matches the existing place-soft-delete behavior.
