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

module.exports = { circleIsDeleted, memberHiddenByLeft }
