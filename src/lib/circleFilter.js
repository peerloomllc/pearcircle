// Pure filter helpers for the delete-circle / leave-circle amendments
// (proposal 2026-05-07). Co-located with the other tiny lib modules
// (geofence, motion, sign) so the worklet's snapshot helpers can import
// without dragging in autobase / hyperbee plumbing, and so the rules
// are unit-testable in isolation.

// Owner tear-down tombstone check. Soft-delete pattern same as
// `place:` rows (DECISIONS 2026-05-05): an owner-write with
// `deleted: true` marks the circle as torn down. Records without the
// field are alive (additive amendment).
function circleIsDeleted (circle) {
  return circle != null && circle.deleted === true
}

// Self-leave filter. A `left:{pubkey}` row hides the matching member
// when its leftAt strictly beats the member-row's joinedAt. Rejoin is
// a fresh `member:` write whose joinedAt > left.leftAt, which flips the
// member back to visible without needing to delete the left row.
//
//   leftAt non-number             - no tombstone, never hide
//   joinedAt non-number            - no member yet, hide if left exists
//   leftAt > joinedAt              - leave is newer, hide
//   leftAt <= joinedAt (rejoin)    - member is newer, show
function memberHiddenByLeft (leftAt, joinedAt) {
  if (typeof leftAt !== 'number') return false
  if (typeof joinedAt !== 'number') return true
  return leftAt > joinedAt
}

// Owner-kick filter (proposal 2026-05-03 §3). A `removed:{pubkey}` row
// hides the matching member while its `ts` strictly beats the member
// row's joinedAt -- the same rule as memberHiddenByLeft. Removal is
// reversible: a rejoin writes a fresh `member:` row whose joinedAt beats
// removed.ts and flips the member back to visible; the owner kicking
// again writes a newer removed.ts that re-hides them.
//
//   removedAt non-number     - no tombstone, never hide
//   joinedAt non-number      - no member row, hide if removed exists
//   removedAt > joinedAt     - kick is newer, hide
//   removedAt <= joinedAt    - rejoin is newer, show
function memberHiddenByRemoved (removedAt, joinedAt) {
  if (typeof removedAt !== 'number') return false
  if (typeof joinedAt !== 'number') return true
  return removedAt > joinedAt
}

// Owner-kick admission rule (proposal 2026-05-03 §3). A `removed:{pubkey}`
// row is owner-write-only: the apply branch accepts it only when the
// authoring writer is the autobase bootstrap key (the owner), the value
// carries a string pubkey, and the key suffix matches that pubkey so a
// writer cannot tombstone an unrelated key. Any non-owner append is
// dropped. The hide itself is reversible -- see memberHiddenByRemoved.
function shouldAcceptRemovedRow ({ fromHex, bootstrapHex, keyPubkey, value }) {
  if (typeof fromHex !== 'string' || typeof bootstrapHex !== 'string') return false
  if (fromHex !== bootstrapHex) return false
  if (!value || typeof value.pubkey !== 'string') return false
  if (keyPubkey !== value.pubkey) return false
  return true
}

module.exports = { circleIsDeleted, memberHiddenByLeft, memberHiddenByRemoved, shouldAcceptRemovedRow }
