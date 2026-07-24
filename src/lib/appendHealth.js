// When is a circle actually broken? (proposal 2026-07-24-degraded-false-positive)
//
// `safeAppend` bounds every writer append at 10s so a wedged Autobase cannot
// freeze the serial IPC dispatcher. That bound is right. What was wrong was the
// consequence: a single miss flagged the circle degraded, which persisted, and
// which nothing but a manual repair could clear - while itself suppressing the
// appends that would have proved the circle healthy.
//
// The first append after a mount is slow BY DESIGN: Autobase blocks it until
// Hyperswarm discovery flushes, ~1.8s when peers answer at once and ~66s when
// they do not. Measured on the Pixel 9 on 2026-07-24, two boots 34 minutes
// apart took 10.9s and 9.4s for that first write - one condemned the circle
// permanently, the other was fine. That is a stopwatch, not a diagnosis.
//
// These are the pure rules. The worklet holds the state; this decides.

// Consecutive timeouts (after the first-attempt exemption) before a circle is
// called broken. Roughly 40s of sustained failure with the 10s bound.
const APPEND_FAILS_BEFORE_DEGRADE = 3

// While degraded, allow one probe append per interval instead of skipping them
// all. Recovery has to be reachable, but a wedged base must never accumulate
// hung appends - one per minute per circle satisfies both.
const DEGRADED_PROBE_INTERVAL_MS = 60_000

// Should this append be attempted at all? Healthy circles always proceed;
// degraded ones proceed only when the probe interval has elapsed.
function shouldAttemptAppend ({ degraded = false, lastProbeAt = 0, now = Date.now(), probeIntervalMs = DEGRADED_PROBE_INTERVAL_MS } = {}) {
  if (!degraded) return { attempt: true, probe: false }
  if (now - lastProbeAt < probeIntervalMs) return { attempt: false, probe: false }
  return { attempt: true, probe: true }
}

// Fold an append's outcome into the circle's health. Returns what the caller
// should do:
//   degrade      - flag the circle broken (streak reached)
//   clearDegrade - it wrote, so it is not broken, whatever we thought
//   streak       - the new consecutive-timeout count to store
//   firstSlow    - the exempt first attempt timed out; mark it, do not condemn
//
// `firstAttemptDone` tracks the first ATTEMPT since the mount, not the first
// success: exempting until a success would mean a base that never writes is
// never condemned.
function nextAppendHealth ({ ok, timedOut, degraded = false, streak = 0, firstAttemptDone = false, threshold = APPEND_FAILS_BEFORE_DEGRADE } = {}) {
  if (ok) {
    return { degrade: false, clearDegrade: degraded === true, streak: 0, firstSlow: false, firstAttemptDone: true }
  }
  // A rejection (base closed mid-flight) is not evidence of a wedge; it was
  // never evidence before this proposal either.
  if (!timedOut) {
    return { degrade: false, clearDegrade: false, streak, firstSlow: false, firstAttemptDone: true }
  }
  if (!firstAttemptDone) {
    return { degrade: false, clearDegrade: false, streak: 0, firstSlow: true, firstAttemptDone: true }
  }
  const next = streak + 1
  return { degrade: next >= threshold && !degraded, clearDegrade: false, streak: next, firstSlow: false, firstAttemptDone: true }
}

module.exports = {
  shouldAttemptAppend,
  nextAppendHealth,
  APPEND_FAILS_BEFORE_DEGRADE,
  DEGRADED_PROBE_INTERVAL_MS,
}
