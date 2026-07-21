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
    maxSpeedMps: 0,
  }
}

// A speed reading we can actually act on. Rejects null/undefined (native sends
// null when CLLocation reported its -1 unknown sentinel), non-finite values and
// any leftover negative. "Unknown" is NOT "stopped" -- see stepTrip.
function isKnownSpeed (speed) {
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
}

// Returns the higher of the running max and a candidate speed, ignoring
// non-finite, negative, and CLLocation's -1 unknown-speed sentinel.
function bumpMaxSpeed (current, candidate) {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) return current
  return candidate > current ? candidate : current
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
  // A fix with no usable speed carries NO information about whether the drive
  // is still going, so it must not move the machine at all. CLLocation reports
  // -1 for unknown, and the cached/coarse fix iOS delivers on an SLC relaunch
  // is exactly that; the old code read it as "stopped" and reset a rehydrated
  // arming trip on the first fix after every mid-drive kill (device trace
  // 2026-07-21). A REAL measured stop still demotes normally.
  if (!isKnownSpeed(speed)) return { state, completed: null }
  // Ignore a fix that does not advance time. A cached fix carries its original
  // (older) CLLocation timestamp, and every arming / cooldown decision below is
  // a ts subtraction, so letting the clock run backwards silently corrupts the
  // windows. Ordered replays (replayTrip) are unaffected.
  const last = lastActivityTs(state)
  if (last != null && ts <= last) return { state, completed: null }
  const moving = speed >= TRIP_START_THRESHOLD_MPS

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
          maxSpeedMps: bumpMaxSpeed(0, speed),
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
      const maxSpeedMps = bumpMaxSpeed(state.maxSpeedMps, speed)
      if (ts - state.armingStartTs >= TRIP_ARMING_DURATION_MS) {
        return {
          state: { ...state, phase: 'active', startTs: state.armingStartTs, polyline, maxSpeedMps },
          completed: null,
        }
      }
      return { state: { ...state, polyline, maxSpeedMps }, completed: null }
    }
    case 'active': {
      const polyline = appendPoint(state.polyline, lat, lon, ts)
      const maxSpeedMps = bumpMaxSpeed(state.maxSpeedMps, speed)
      if (!moving) {
        return {
          state: { ...state, phase: 'cooldown', cooldownStartTs: ts, polyline, maxSpeedMps },
          completed: null,
        }
      }
      return { state: { ...state, polyline, maxSpeedMps }, completed: null }
    }
    case 'cooldown': {
      if (moving) {
        // Brief stop is over; resume the same trip and keep extending
        // the polyline from the new point.
        const polyline = appendPoint(state.polyline, lat, lon, ts)
        const maxSpeedMps = bumpMaxSpeed(state.maxSpeedMps, speed)
        return {
          state: { ...state, phase: 'active', cooldownStartTs: null, polyline, maxSpeedMps },
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
            maxSpeedMps: state.maxSpeedMps,
          },
        }
      }
      // Still in cooldown; user is stopped, don't extend the polyline.
      // Speed is below threshold so maxSpeedMps doesn't move.
      return { state, completed: null }
    }
  }
  return { state, completed: null }
}

// The ts of the most recent activity in an in-flight trip: the last point
// added to the polyline, falling back to the arming/start anchor. Used to tell
// a trip that is still accumulating across background wakes from one whose drive
// actually ended while the worklet was suspended.
function lastActivityTs (state) {
  if (state.polyline && state.polyline.length > 0) {
    return state.polyline[state.polyline.length - 1][2]
  }
  return state.cooldownStartTs ?? state.startTs ?? state.armingStartTs ?? null
}

// Replay a batch of fixes (ORDERED BY ts) through stepTrip, starting from
// `state`. Returns the final state and every trip completed during the batch.
// Pure and ts-driven, so replaying the native durable fix log reconstructs the
// exact same trip(s) the live path would have, across worklet lifetimes. The
// caller persists each completed trip and checkpoints the returned state.
function replayTrip (state, fixes) {
  const completed = []
  for (const fix of fixes) {
    const r = stepTrip(state, fix)
    state = r.state
    if (r.completed) completed.push(r.completed)
  }
  return { state, completed }
}

// Finalize (or discard) an in-flight trip whose drive has clearly ended while
// the worklet was suspended -- the drain saw no further fixes, so stepTrip's
// arrival-triggered cooldown-elapse never fired. If the last activity is at
// least a cooldown-window behind `nowTs`, apply the SAME finalize decision the
// cooldown-elapse branch of stepTrip would (min duration/distance -> a trip or a
// discard); otherwise the trip is still live and is returned untouched so it can
// keep accumulating on the next wake. This is what lets a trip that spans
// several disjoint background wakes actually finalize on a later one, rather
// than waiting for a coincidental post-cooldown fix to arrive.
function settleStaleTrip (state, nowTs) {
  const last = lastActivityTs(state)
  if (last == null || nowTs - last < TRIP_COOLDOWN_DURATION_MS) {
    return { state, completed: null }
  }
  // Arming never promoted to a real trip: just reset.
  if (state.phase === 'arming' || state.phase === 'idle') {
    return { state: newTripState(), completed: null }
  }
  // active or cooldown: the drive is over. End at the cooldown anchor for a
  // trip already coasting, else at the last real point we captured.
  const endTs = state.phase === 'cooldown' ? state.cooldownStartTs : last
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
      maxSpeedMps: state.maxSpeedMps,
    },
  }
}

module.exports = {
  newTripState,
  stepTrip,
  replayTrip,
  settleStaleTrip,
  lastActivityTs,
  isKnownSpeed,
  polylineDistanceMeters,
  TRIP_START_THRESHOLD_MPS,
  TRIP_ARMING_DURATION_MS,
  TRIP_COOLDOWN_DURATION_MS,
  TRIP_MIN_DURATION_MS,
  TRIP_MIN_DISTANCE_M,
}
