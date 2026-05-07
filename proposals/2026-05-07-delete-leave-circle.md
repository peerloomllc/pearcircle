# Delete-circle (owner) and leave-circle (member)

**Status**: Approved 2026-05-07. Open questions resolved per the recommendations in §Open questions; approval record will land in `reviews/2026-05-07-delete-leave-circle.md` after the implementation slice ships. Subsequent protocol changes follow the Constitution §3 proposal gate.

**Goal**: Let an owner permanently tear down a circle they created (cascading a "circle deleted" tombstone to all peers) and let any member voluntarily leave a circle they joined (clean local-only departure with peer-side cleanup of their replicated rows).

**Tier**: T3. Protocol-breaking and security-sensitive: introduces two new wire concepts (`circle.deleted` field + new `left:{pubkey}` key) and changes apply-branch trust rules. v1 remains the floor; no peers have shipped beyond the two test devices.

## Scope

In scope:
- Owner-side circle teardown: a new `circle:delete` IPC, an additive `deleted: boolean` + `deletedAt: number` pair on the existing `circle` record, peer-side detection and local cleanup, refusal to mount a deleted circle from a stale invite link
- Member self-leave: a new `circle:leave` IPC, a new `left:{pubkey}` keyspace signed by the leaving member, peer-side filtering of the leaver's `member:` / `lastSeen:` / `presence:` / `transition:` rows
- Apply-branch additions for both
- UI: confirmation flows, post-delete / post-leave system messages, peer-side notifications

Out of scope:
- Owner-kicking-a-member (`removed:{pubkey}` already in the wire protocol, apply branch yet to be implemented; tracked as a separate slice)
- Identity migration across devices (separate Future / not v1 line)
- Hyperbee log compaction after a delete or leave (records pile up; can be addressed by the future retention sweep slice)

## Compat

Additive amendment to v1. Old peers do not exist in the wild — only the two test devices — so the only "compat" obligation is forward-compat for the v1 series:
- `circle.deleted` is optional. Records without it read as `deleted: false`. Identical to the `place:` soft-delete amendment (DECISIONS 2026-05-05).
- `left:{pubkey}` is a new keyspace. Old code never wrote it, so old → new replication is silently fine. New → old replication: old code ignores unknown keys, so the leaver's rows stay visible on old peers (the leaver appears stuck). Acceptable since "old" here means "the dev devices before the next install."

`v: 1` remains on every replicated row.

## Design

### 1. Owner tear-down

**Wire change**: extend the `circle` value with two optional fields, mirroring the `place:` soft-delete pattern (DECISIONS 2026-05-05):

```
circle: {
  id, name, ownerKey, createdAt, v: 1,
  deleted?: boolean,                    // tombstone marker
  deletedAt?: number                    // ms timestamp; reason field for UI surfacing
}
```

A delete is a fresh `view.put('circle', {...existing, deleted: true, deletedAt: Date.now()})` write, signed by the owner. Apply rule already restricts `circle:` to owner-write only — no apply-branch change other than passing through the new fields.

**Resolution**: There is only one writer of `circle:` (the owner), so concurrent writes don't race. The latest owner-append wins by linearization order. No LWW-on-`createdAt` is required (and we deliberately don't bump `createdAt` so the original creation timestamp is preserved for UI).

**Peer-side detection**:
- `circle:get` snapshot includes the `deleted` flag in the returned circle object
- `circles:getAll` filters or tags deleted circles (returns them with `deleted: true` so the UI can decide between "hide silently" or "show one-time notice then dismiss")
- A new `circle:deleted` worklet event fires on the apply branch when a `circle:` row arrives with `deleted: true`

**Owner-side flow** (`circle:delete` IPC):
1. Verify caller is the owner (compare `_identity.publicKey` with stored circle's `ownerKey`)
2. Append the deleted-circle write
3. Wait briefly (~2s) for replication-ack — best effort; no guarantee but improves reach to currently-connected peers
4. Locally: leave the Hyperswarm topic, close the autobase, delete `circles:joined:{circleId}` from the local Hyperbee, fire a `circle:deleted` event for the UI

**Peer-side flow** (on receiving the deleted-circle write):
1. Apply branch updates the view; emits `circle:deleted` event
2. RN forwards to UI; UI shows a one-time notification ("Circle 'Foo' was deleted by owner")
3. UI calls a new `circle:cleanup-deleted` IPC after user dismissal, which performs the same local-cleanup steps as the owner side

**Stale invite enforcement**:
- `circle:join` mounts the autobase, awaits initial sync (`base.update()`), then checks `circle.deleted`
- If true, refuses to proceed: error message "This circle has been deleted by the owner."
- The autobase namespace + local `circles:joined` row are not persisted on this failure path

**No-rejoin semantic**: the `circle.deleted` tombstone is permanent in the autobase view. Even if someone shares an old invite link and a third party tries to join, the autobase boots, syncs, sees the tombstone, refuses. The owner cannot "undelete" — recreating the circle generates a fresh `circleId`, distinct namespace, distinct invite.

### 2. Member self-leave

**Wire change**: new replicated keyspace.

```
left:{pubkey} → { pubkey, leftAt: number, v: 1 }   (signed by pubkey)
```

**Apply rule**: `left:{pubkey}` is self-write only. The apply branch verifies the signature against `pubkey` and rejects writes where the writing core's identity ≠ `value.pubkey`. Mirrors the existing rule for `lastSeen:` and `transition:`.

**Peer-side semantics**:
- On every read that produces a member-shaped view (`circles:getAll` snapshot, `circle:get` snapshot, place-list filtering by writability), apply this filter:
  > A member with `left:{pubkey}` is hidden if `left.leftAt > member.joinedAt`. Rejoin is signaled by a fresh `member:{pubkey}` write whose `joinedAt > left.leftAt`.
- Hidden members' `lastSeen` / `presence` rows are not surfaced to the UI either
- Their historical `transition:` rows stay visible (they're past events; hiding them would rewrite history)

**Member-side flow** (`circle:leave` IPC):
1. Append signed `left:{ourKey}` write
2. Wait briefly (~2s) for replication-ack
3. Locally: leave the Hyperswarm topic, close the autobase, delete `circles:joined:{circleId}`, fire a `circle:left` event

**Owner case**: an owner CAN self-leave (if for some reason they want to). The circle continues with remaining writers; the owner's `member:` is filtered out client-side. The `ownerKey` stays on the `circle:` record for posterity but no future owner-only operations will succeed because the owner isn't online. To fully tear down a circle they own, the owner uses `circle:delete` (§1) instead of `circle:leave`. UI should steer owners toward delete by default — leave is for non-owners.

**Re-invite after leave**: existing flow works without protocol changes. Any current member can issue a fresh invite (DECISIONS 2026-05-03 admin model). The leaver pastes it, mounts the autobase (already cached locally if not deleted; fresh otherwise), `addWriter` adds them back, fresh `member:` write with new `joinedAt > left.leftAt`. Filter rule above resolves them as current.

### 3. Apply-branch summary

| Record | Apply rule |
|---|---|
| `circle` | Owner-write only (existing). Pass through `deleted`/`deletedAt` if present. Emit `circle:deleted` event when `deleted: true` lands. |
| `left:{pubkey}` | New. Self-write only: signature verifies against `pubkey`, key segment matches `value.pubkey`. Emit `member:left` event for UI on apply. |

### 4. UI surfaces

- **Settings sheet** gains a new "Circles" entry (a small list rendered inline; not the full circle-management view that was deferred). Each row: circle name + small "Leave circle" button. Owner sees a "Delete circle" button instead.
- **Confirmation flow**: two-tap, similar to the place-delete pattern. First tap arms ("Tap again to delete circle" / "Tap again to leave"), second tap commits, 4s auto-disarm.
- **Post-delete on owner**: toast "Circle 'Foo' deleted." Settings sheet refreshes; circle is gone from the dropdown.
- **Post-delete on peer**: notification "Circle 'Foo' was deleted by its owner. It's been removed from your circles." One-tap dismissal triggers `circle:cleanup-deleted`.
- **Post-leave on member**: toast "Left circle 'Foo'." Settings sheet refreshes; circle is gone from the dropdown.
- **Post-leave on remaining peers**: subtle toast "Alice left circle 'Foo'." (Optional; can be silent in v1 if it feels noisy.)
- **Stale-invite join**: existing JoinView error path with the new "This circle has been deleted by the owner." message.

### 5. Hyperswarm topic teardown

Both flows leave the Hyperswarm topic. The worklet's `_topicToCircle` map removes the entry; the `swarm.leave(topic)` call detaches. No protocol coordination needed — peers detect the disconnection naturally.

## Verify

- `tests/circle.test.js` extended: a delete write makes the circle read as `deleted: true`; a `left:` write filters the leaver from a snapshot; rejoin restores them.
- `tests/sign.test.js`: signature verification path for `left:{pubkey}` (cross-pubkey writes rejected).
- `tests/invite.test.js`: no change (invite link grammar unchanged).
- `npm run verify` stays green.
- Manual two-device smoke:
  - D1 (owner) creates circle, D2 joins, both see each other. D1 deletes. D2 receives the "deleted" notice, local state cleans up. D1's invite link no longer joins (refused with the deleted message).
  - D1 + D2 in a circle. D2 (non-owner) leaves. D1's roster drops D2; D2's circle list drops the circle. D1 re-invites D2 with a fresh invite — D2 rejoins, both see each other again.

## Rollback

The protocol is on two test devices. Rollback paths:
1. **Pre-merge**: revert the branch.
2. **Post-merge, pre-test-device-install**: revert + force-stop both test devices, no install of the bad APK.
3. **Post-install, broken in field**: code revert; field-clear local state by manually clearing app data on both devices (acceptable cost for two test devices); re-pair from scratch.

Once peers ship publicly, future protocol changes follow the standard amendment path.

## Open questions

1. **Should owner-leave be allowed at all?** Currently designed to permit it (owner just appears as filtered-out from the member list while `circle.ownerKey` continues to point at them). Risks: stranded circle with no live owner = no one can `circle:delete` it later. Possible alternative: force owners to `circle:delete` instead of `circle:leave`, surfacing a UI nudge. **Recommendation**: allow it for symmetry, but the UI's settings entry shows "Delete circle" for owner / "Leave circle" for non-owner so the discoverable path is delete-when-owner.

2. **Replication wait window**: 2s is pulled from intuition. Real-world: if the owner's only peer is offline at delete time, the tombstone lands on no one until next swarm meet. Should `circle:delete` block longer (5s? 10s?) and/or surface "Couldn't reach all peers — they'll see the deletion next time they sync"? **Recommendation**: 2s with a non-blocking note in the toast: "Some peers may not see this until they next open the app."

3. **Filter rule in `circle:get` snapshot**: do we filter the leaver's rows in the worklet (cleaner UI surface) or in the UI render path (cheaper, lets the UI choose to show a "left" badge if desired)? **Recommendation**: filter in the worklet's snapshot helpers (`snapshotCircle`, `circle:get`, `circles:getAll`); keep render path simple. UI can add a "left X days ago" indicator later by surfacing the `left:` row separately if useful.

4. **Cleanup sweep**: after a `left:` is replicated, the leaver's `member:`/`lastSeen:`/`presence:`/`transition:` rows are hidden but persist in the underlying log. Same as `place:` soft-delete (DECISIONS 2026-05-05) — a future retention sweep can prune. **Recommendation**: defer to that future sweep; don't add per-record cleanup machinery here.

5. **Owner-tear-down before a peer ever connects**: the owner deletes; the deletion replicates to no one because no peer is online or paired. The owner's local state is gone. A peer with a stale invite link tries to join later — their autobase mounts on the bootstrap key, syncs whatever's reachable, but the owner is gone and the deletion is gone with them. The peer sees a half-formed circle and joins it? **Recommendation**: this is degenerate but real. Fix by keeping the owner's delete-write on a tombstone hypercore until a peer has confirmed receipt — out of scope for this proposal; flag as a follow-up. The TODO acknowledged a sibling concern in the cold-start delay item; same root cause (replication propagation latency).
