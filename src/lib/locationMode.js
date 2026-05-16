// Adaptive iOS location mode driver (proposal 2026-05-16).
//
// The native CLLocationManager runs in one of two modes:
//   - "idle"     -> SLC only (cell-tower wakes, ~minutes apart)
//   - "tracking" -> SLC + continuous high-accuracy updates
//
// Mode is derived from the trip-detection state machine in src/lib/trip.js:
// while the user is idle we coast on SLC; the moment trip detection thinks
// a trip may be starting (phase = arming) we escalate; we step back down
// after the trip completes and the state machine returns to idle.
// Open question Q2 in the proposal is resolved eager (arming -> tracking).
// Open question Q3 is resolved step-down on cooldown -> idle.

function phaseToMode (phase) {
  return phase === 'idle' ? 'idle' : 'tracking'
}

// Returns the mode to emit, or null to skip. `lastMode` is whatever the
// caller last successfully emitted (null on cold start). The feature-flag
// short-circuit pins the desired mode to "tracking", matching pre-adaptive
// behavior so the worklet can disable the feature without removing the
// driver call site.
function nextEmittedMode (lastMode, phase, enabled) {
  const desired = enabled ? phaseToMode(phase) : 'tracking'
  if (desired === lastMode) return null
  return desired
}

module.exports = { phaseToMode, nextEmittedMode }
