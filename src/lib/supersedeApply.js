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

// --- Retry rules for the owner's own post (proposal 2026-07-24) -------------
// The nudge is written INTO the old circle, which is the one structural
// weakness of the recreate flow: the circles owners recreate are overwhelmingly
// the wedged ones, and a wedged base is exactly what cannot be appended to. So
// the post fails on the exact circles that need it and the members never hear
// that the group moved. The failures split in two:
//
//   retryable   - the base is not writable YET, or the read/append hit its
//                 bound. A repair, a writer re-admission or simply a peer
//                 turning up fixes it, so we keep a pending row and try again.
//   terminal    - we are not the owner, or the new circle is gone. No amount of
//                 waiting changes the answer; retrying would spin forever.
const SUPERSEDE_RETRYABLE = new Set(['not_writable', 'append_timeout', 'append_failed', 'circle_unreadable'])

// Attempts before the automatic sweep gives up and leaves it to the owner's
// explicit "Notify members" tap (which resets the tally). At roughly one
// attempt per foreground this is days of trying, well past the point where an
// automatic retry is still plausibly the thing that will fix it.
const SUPERSEDE_MAX_ATTEMPTS = 30

function shouldRetrySupersede (reason, attempts = 0) {
  if (!SUPERSEDE_RETRYABLE.has(reason)) return false
  return attempts < SUPERSEDE_MAX_ATTEMPTS
}

// User-facing explanation for a failed post. Keep these in the user's terms:
// what happened, and what they should do instead. The invite always works, so
// every message points back at it.
function supersedeFailureMessage (reason) {
  switch (reason) {
    case 'not_writable':
    case 'circle_unreadable':
      return "The old circle's data is still stuck, so the move notice can't be posted into it yet. We'll keep trying. Send members the invite link in the meantime."
    case 'append_timeout':
    case 'append_failed':
      return "The move notice couldn't be posted into the old circle just now. We'll keep trying. Send members the invite link in the meantime."
    case 'not_owner':
      return 'Only the circle\'s owner can post the move notice.'
    default:
      return "The move notice couldn't be posted into the old circle. Send members the invite link instead."
  }
}

// Fold one post attempt into the pending-retry state. Returns the action the
// caller should take on its `supersede:pending:{oldCircleId}` row:
//   'clear' - forget it. Either the post landed, or it failed for a reason no
//             amount of waiting will change.
//   'keep'  - write `row` back: still owed, still worth retrying.
//   'none'  - nothing was pending and nothing should be.
// `manual` (the owner pressing Notify members) resets the attempt tally, so an
// explicit tap always buys a fresh run of automatic attempts.
function supersedePendingNext ({ prev = null, newCircleId, result, manual = false, now = Date.now() }) {
  if (result?.ok) return { action: prev ? 'clear' : 'none' }
  const attempts = manual ? 0 : ((prev?.attempts ?? 0) + 1)
  if (!shouldRetrySupersede(result?.reason, attempts)) return { action: prev ? 'clear' : 'none' }
  return {
    action: 'keep',
    row: { newCircleId, attempts, reason: result?.reason ?? null, since: prev?.since ?? now, v: 1 },
  }
}

module.exports = { shouldAcceptSupersede, shouldRetrySupersede, supersedePendingNext, supersedeFailureMessage, SUPERSEDE_RETRYABLE, SUPERSEDE_MAX_ATTEMPTS }
