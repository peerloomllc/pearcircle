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
//
// `sinceBootMs` guards the wake-up deadlock (measured on a real drive,
// 2026-07-22). Every escalation input is derived from in-memory state, and iOS
// gives each background wake a brand-new process, so a freshly relaunched
// worklet always computes phase=idle + foreground=false + recentMotion=false and
// emits "idle" within a second of booting. That calls stopUpdatingLocation,
// which is the very thing holding the app's background-execution assertion open,
// so the app is suspended and terminated before it can learn anything. It is a
// deadlock: staying awake requires a detected trip, and detecting a trip
// requires staying awake. On a 22-minute drive it produced 4 wakes, 17 fixes,
// all of them 40-117m SLC-grade with no usable speed, and no trip.
//
// So "idle" is also suppressed for the first MODE_BOOT_GRACE_MS of a worklet's
// life: the wake itself is evidence something moved, and a bounded window of
// real GPS is what buys CoreMotion time to report and the trip machine time to
// arm. Cost is bounded to wakes that actually happen, and a parked phone is not
// woken at all (SLC only fires on ~500m moves). Escalations to "tracking" are
// unaffected, as always.
const MODE_BOOT_GRACE_MS = 90_000

function nextEmittedMode (lastMode, inputs, enabled) {
  const desired = enabled ? desiredMode(inputs) : 'tracking'
  if (desired === lastMode) return null
  if (desired === 'idle' && inputs?.locationStarted === false) return null
  if (desired === 'idle' && typeof inputs?.sinceBootMs === 'number' &&
      inputs.sinceBootMs < MODE_BOOT_GRACE_MS) return null
  return desired
}

module.exports = { phaseToMode, desiredMode, nextEmittedMode, MODE_BOOT_GRACE_MS }
