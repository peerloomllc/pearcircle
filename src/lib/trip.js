// Trip detection state machine.
//
// Driven by the speed and (lat, lon, ts) on every location:update.
// State machine with four phases:
//
//   idle      - no trip in progress
//   arming    - sustained-motion candidate; waits TRIP_ARMING_DURATION_MS
//               before promoting to a real trip. Throws away brief
//               speed spikes (red light to a sprint and back).
//   active    - trip in progress; every location:update extends the
//               polyline.
//   cooldown  - was active, speed has dropped below threshold. If
//               motion resumes within TRIP_COOLDOWN_DURATION_MS we
//               stay on the same trip (red light, gas station, brief
//               stop). If the cooldown elapses we finalize the trip.
//
// Trips below TRIP_MIN_DURATION_MS or TRIP_MIN_DISTANCE_M are discarded
// at finalize time. Trips that crash (worklet restart mid-active) lose
// their in-flight polyline; that's acceptable for the v1 slice -- the
// state lives only in memory and isn't worth a checkpoint to disk on
// every update. Slice 2 (the history UI) can revisit if it matters.

const { haversineMeters } = require('./geofence')

const TRIP_START_THRESHOLD_MPS = 4         // walking-fast threshold; same as motion's driving cutoff
const TRIP_ARMING_DURATION_MS = 30_000     // sustain motion this long before counting as a trip
const TRIP_COOLDOWN_DURATION_MS = 5 * 60_000 // tolerate this much idle mid-trip before ending
const TRIP_MIN_DURATION_MS = 60_000        // discard trips shorter than 1 minute
const TRIP_MIN_DISTANCE_M = 100            // discard trips shorter than 100m

function newTripState () {
  return {
    phase: 'idle',
    armingStartTs: null,
    startTs: null,
    polyline: [],
    cooldownStartTs: null,
  }
}

// Extend the polyline if the new point is meaningfully different from
// the last one. Sub-meter additions are GPS noise and would inflate the
// distance estimate without adding anything visual.
function appendPoint (polyline, lat, lon, ts) {
  const last = polyline.length > 0 ? polyline[polyline.length - 1] : null
  if (last && haversineMeters(last[0], last[1], lat, lon) < 1) return polyline
  return polyline.concat([[lat, lon, ts]])
}

function polylineDistanceMeters (polyline) {
  let total = 0
  for (let i = 1; i < polyline.length; i++) {
    total += haversineMeters(
      polyline[i - 1][0], polyline[i - 1][1],
      polyline[i][0], polyline[i][1],
    )
  }
  return total
}

// Pure step function: takes current state + new location point,
// returns { state, completed }. `completed` is the finalized trip
// record when this step caused the trip to end (caller persists it),
// otherwise null. State is freshly returned each call so callers can
// freely overwrite their stored reference.
function stepTrip (state, { lat, lon, ts, speed }) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof ts !== 'number') {
    return { state, completed: null }
  }
  const moving = typeof speed === 'number' && Number.isFinite(speed) && speed >= TRIP_START_THRESHOLD_MPS

  switch (state.phase) {
    case 'idle': {
      if (!moving) return { state, completed: null }
      return {
        state: {
          phase: 'arming',
          armingStartTs: ts,
          startTs: null,
          polyline: [[lat, lon, ts]],
          cooldownStartTs: null,
        },
        completed: null,
      }
    }
    case 'arming': {
      if (!moving) {
        // Speed dropped before the arming window elapsed -- not a trip.
        return { state: newTripState(), completed: null }
      }
      const polyline = appendPoint(state.polyline, lat, lon, ts)
      if (ts - state.armingStartTs >= TRIP_ARMING_DURATION_MS) {
        return {
          state: { ...state, phase: 'active', startTs: state.armingStartTs, polyline },
          completed: null,
        }
      }
      return { state: { ...state, polyline }, completed: null }
    }
    case 'active': {
      const polyline = appendPoint(state.polyline, lat, lon, ts)
      if (!moving) {
        return {
          state: { ...state, phase: 'cooldown', cooldownStartTs: ts, polyline },
          completed: null,
        }
      }
      return { state: { ...state, polyline }, completed: null }
    }
    case 'cooldown': {
      if (moving) {
        // Brief stop is over; resume the same trip and keep extending
        // the polyline from the new point.
        const polyline = appendPoint(state.polyline, lat, lon, ts)
        return {
          state: { ...state, phase: 'active', cooldownStartTs: null, polyline },
          completed: null,
        }
      }
      if (ts - state.cooldownStartTs >= TRIP_COOLDOWN_DURATION_MS) {
        const endTs = state.cooldownStartTs
        const distanceMeters = polylineDistanceMeters(state.polyline)
        const durationMs = endTs - state.startTs
        if (durationMs < TRIP_MIN_DURATION_MS || distanceMeters < TRIP_MIN_DISTANCE_M) {
          return { state: newTripState(), completed: null }
        }
        return {
          state: newTripState(),
          completed: {
            startTs: state.startTs,
            endTs,
            polyline: state.polyline,
            distanceMeters,
            durationMs,
          },
        }
      }
      // Still in cooldown; user is stopped, don't extend the polyline.
      return { state, completed: null }
    }
  }
  return { state, completed: null }
}

module.exports = {
  newTripState,
  stepTrip,
  polylineDistanceMeters,
  TRIP_START_THRESHOLD_MPS,
  TRIP_ARMING_DURATION_MS,
  TRIP_COOLDOWN_DURATION_MS,
  TRIP_MIN_DURATION_MS,
  TRIP_MIN_DISTANCE_M,
}
