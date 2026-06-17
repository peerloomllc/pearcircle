// Apply-branch decision for the owner-signed `supersede:{newCircleId}` record
// (proposal 2026-06-17-circle-recreate-export-import slice 3). The record is
// the migration nudge an owner posts into the OLD circle, carrying the new
// circle's invite. It is accepted only when:
//   - it is well-formed (newCircleId/invite/ownerKey strings, numeric postedAt),
//   - postedAt is not implausibly in the future,
//   - the key segment matches the signed newCircleId (no key/value mismatch),
//   - the embedded ownerKey equals the circle's ownerKey (only the owner's
//     migration notice counts - no other writer can forge a "we moved"), and
//   - the signature verifies against that ownerKey (verifySig), and
//   - it is newer than any existing record for the same key (LWW on postedAt).
//
// Pure: the caller resolves `ownerKey` (from the circle row) and `existing`
// (the current view value) and passes a `verifySig` closure, so the rule set
// is unit-testable without an Autobase. Mirrors shouldAcceptSeederRow.

function shouldAcceptSupersede ({ keyNew, incoming, ownerKey, existing, now, futureToleranceMs = 0, verifySig }) {
  if (!incoming || typeof incoming !== 'object') return false
  if (typeof incoming.newCircleId !== 'string') return false
  if (typeof incoming.invite !== 'string') return false
  if (typeof incoming.ownerKey !== 'string') return false
  if (typeof incoming.postedAt !== 'number') return false
  if (typeof now === 'number' && incoming.postedAt > now + futureToleranceMs) return false
  if (keyNew !== incoming.newCircleId) return false
  if (typeof ownerKey !== 'string' || incoming.ownerKey !== ownerKey) return false
  if (typeof verifySig === 'function' && !verifySig(incoming)) return false
  if (existing && typeof existing.postedAt === 'number' && incoming.postedAt <= existing.postedAt) return false
  return true
}

module.exports = { shouldAcceptSupersede }
