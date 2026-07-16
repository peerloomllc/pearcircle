// Staged-repair retry + escalation (proposal 2026-07-16-repair-foreground-retry).
//
// circle:repair rebuilds a circle under a fresh corestore namespace (gen+1). If
// that mount can't be built in-process it is "staged": the old base stays
// mounted and the rebuild is retried on the next app foreground. That retry
// exists because the Bare worklet outlives the UI — swiping the app away does
// not restart it, so "reopen the app to finish" only came true after a
// force-stop.
//
// Retrying forever is no better. The wedges that lose the mount race are
// generally in the replicated data (bloated oplog, forked view), and those do
// not heal between foregrounds; each attempt just burns a mount timeout at
// launch. So we count failures and, past a threshold, stop retrying and tell
// the user to leave and rejoin from a fresh invite.
//
// This is the pure decision, kept out of bare.js so it is unit-testable. The
// counter lives in the existing circleRepairing:{id} value (additive field —
// old code ignores it, and a value written without it reads back as 0).

// Total failed mount attempts tolerated before escalating: the original
// circle:repair plus two foreground retries.
const REPAIR_MAX_ATTEMPTS = 3

// Failed-mount count from a persisted circleRepairing:{id} value. Anything
// missing or malformed (including a value written before this proposal) is 0,
// which costs at most a fresh set of retries — never a spurious escalation.
function repairAttempts (value) {
  const n = value?.attempts
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

// True once the persisted value says we've given up. Read back on boot so an
// escalated circle shows leave-and-rejoin immediately rather than spinning.
function repairEscalated (value) {
  return value?.escalated === true || repairAttempts(value) >= REPAIR_MAX_ATTEMPTS
}

// The next circleRepairing:{id} value after a mount attempt fails.
function recordRepairFailure (value, now) {
  const attempts = repairAttempts(value) + 1
  return {
    ts: Number.isFinite(now) ? now : 0,
    attempts,
    escalated: attempts >= REPAIR_MAX_ATTEMPTS,
  }
}

// Whether a foreground should retry this circle's staged mount. Not staged =>
// nothing to do. Escalated => we've established it won't converge. In flight =>
// a prior foreground is still inside the mount race; retrying would stack
// concurrent mounts of the same circle on a fast background/foreground toggle.
function shouldRetryStagedRepair ({ staged, escalated, inFlight } = {}) {
  return staged === true && escalated !== true && inFlight !== true
}

module.exports = {
  REPAIR_MAX_ATTEMPTS,
  repairAttempts,
  repairEscalated,
  recordRepairFailure,
  shouldRetryStagedRepair,
}
