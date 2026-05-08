// Motion-state inference from GPS speed.
//
// Speed is in m/s as reported by Android Location.getSpeed() and iOS
// CLLocation.speed. CLLocation reports -1 for unknown; we treat any
// negative or non-finite reading as no-information and return null so
// the UI can render nothing rather than a stale guess.
//
// Four buckets, picked to cover the v1 use case without ACTIVITY_RECOGNITION:
//   - still:   speed < 0.5 m/s    (~1.1 mph) - standing, GPS drift
//   - walking: 0.5 - 4 m/s        (~9 mph)   - walking through cycling pace
//   - driving: 4 - 70 m/s          (~157 mph) - car, transit
//   - flying:  speed >= 70 m/s                - plane (or high-speed train)
//
// Bands deliberately collapse running and cycling into walking; the
// permission-gated activity APIs are the escalation path if that
// granularity ever matters.
//
// `flying` is a speed-only first pass: at 70 m/s (~252 km/h) we catch
// most planes from takeoff plus high-speed trains. The proper
// "actually a plane" detection wants altitude (CLLocation.altitude /
// Location.getAltitude) plus a road-graph check, queued under the
// "Flight detection" Future TODO line. Until then a member on a
// Shinkansen will read as "flying" and that's an acceptable false-
// positive for the v1 pass.

const STILL_THRESHOLD_MPS = 0.5
const DRIVING_THRESHOLD_MPS = 4
const FLYING_THRESHOLD_MPS = 70

function motionState (speed) {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) {
    return null
  }
  if (speed < STILL_THRESHOLD_MPS) return 'still'
  if (speed < DRIVING_THRESHOLD_MPS) return 'walking'
  if (speed < FLYING_THRESHOLD_MPS) return 'driving'
  return 'flying'
}

module.exports = { motionState, STILL_THRESHOLD_MPS, DRIVING_THRESHOLD_MPS, FLYING_THRESHOLD_MPS }
