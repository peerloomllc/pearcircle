// Adaptive iOS location-mode driver (proposals 2026-05-16, 2026-05-21).
//
// The native CLLocationManager runs in one of two modes:
//   - "idle"     -> SLC only (cell-tower wakes, ~500m apart)
//   - "tracking" -> SLC + continuous high-accuracy updates
//
// The 2026-05-16 design derived the mode from trip-detection phase
// alone. That left the "idle-trap": in "idle" mode location:update
// fires only on ~500m SLC events, the trip detector runs only inside
// that handler, so a trip starting while idle wasn't detected until
// ~500m in -- and trip detection was the sole escalation path.
//
// 2026-05-21 adds two escalations that do not depend on the trip
// detector, so the device leaves "idle" the moment there is real
// reason to:
//   - app foreground: the user is looking at the map; continuous GPS
//     is affordable and is what makes an opened app show fresh pins.
//   - recent motion: CoreMotion reported the device started moving.
//     The worklet folds the Q3 grace window into this input, so a
//     brief stop doesn't flap the radio between modes.

function phaseToMode (phase) {
  return phase === 'idle' ? 'idle' : 'tracking'
}

// Desired mode given the three escalation inputs. "tracking" whenever
// the app is foregrounded, motion was detected recently, or the trip
// detector is past idle; "idle" only when all three are quiet.
function desiredMode ({ phase, appForeground, recentMotion } = {}) {
  if (appForeground || recentMotion) return 'tracking'
  return phaseToMode(phase)
}

// Returns the mode to emit, or null to skip. `lastMode` is whatever the
// caller last successfully emitted (null on cold start). `inputs` is the
// { phase, appForeground, recentMotion, locationStarted } escalation
// snapshot. The feature-flag short-circuit pins the desired mode to
// "tracking", matching pre-adaptive behavior so the worklet can disable
// the feature without removing the driver call site.
//
// `locationStarted` guards a cold-start trap: the native startUpdatesNow
// only begins continuous delivery when its mode is "tracking", so an
// "idle" emitted before location has started (e.g. from an app:state
// event that lands before native startUpdates) would make it skip
// startUpdatingLocation() and the device would get no GPS fix at all.
// So "idle" is suppressed until the first location:update confirms
// continuous delivery is up; escalations to "tracking" are always safe.
// A missing `locationStarted` is treated as started (no gating), so
// callers that don't track it are unaffected.
function nextEmittedMode (lastMode, inputs, enabled) {
  const desired = enabled ? desiredMode(inputs) : 'tracking'
  if (desired === lastMode) return null
  if (desired === 'idle' && inputs?.locationStarted === false) return null
  return desired
}

module.exports = { phaseToMode, desiredMode, nextEmittedMode }
