// Motion-state inference from GPS speed.
//
// Speed is in m/s as reported by Android Location.getSpeed() and iOS
// CLLocation.speed. CLLocation reports -1 for unknown; we treat any
// negative or non-finite reading as no-information and return null so
// the UI can render nothing rather than a stale guess.
//
// Three buckets, picked to cover the v1 use case without ACTIVITY_RECOGNITION:
//   - still:   speed < 0.5 m/s   (~1.1 mph) - standing, GPS drift
//   - walking: 0.5 - 4 m/s       (~9 mph)   - walking through cycling pace
//   - driving: speed >= 4 m/s                - car, transit
//
// Bands deliberately collapse running and cycling into walking; the
// permission-gated activity APIs are the escalation path if that
// granularity ever matters.

const STILL_THRESHOLD_MPS = 0.5
const DRIVING_THRESHOLD_MPS = 4

function motionState (speed) {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) {
    return null
  }
  if (speed < STILL_THRESHOLD_MPS) return 'still'
  if (speed < DRIVING_THRESHOLD_MPS) return 'walking'
  return 'driving'
}

module.exports = { motionState, STILL_THRESHOLD_MPS, DRIVING_THRESHOLD_MPS }
