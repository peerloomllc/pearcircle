const {
  newTripState,
  stepTrip,
  polylineDistanceMeters,
  TRIP_START_THRESHOLD_MPS,
  TRIP_ARMING_DURATION_MS,
  TRIP_COOLDOWN_DURATION_MS,
  TRIP_MIN_DURATION_MS,
  TRIP_MIN_DISTANCE_M,
} = require('../src/lib/trip')

// Helper: nudge lat/lon enough to clear the appendPoint sub-meter dedup.
// At ~111km/deg latitude, 0.001 degrees ~= 111m. We use 0.002 per step
// to comfortably clear the 1m threshold while keeping math simple.
const baseLat = 40.0
const baseLon = -73.0
const stepDeg = 0.002

function pointAt (i, ts, speed) {
  return { lat: baseLat + i * stepDeg, lon: baseLon + i * stepDeg, ts, speed }
}

describe('stepTrip state machine', () => {
  test('idle stays idle while not moving', () => {
    const r = stepTrip(newTripState(), pointAt(0, 1000, 0))
    expect(r.state.phase).toBe('idle')
    expect(r.completed).toBeNull()
  })

  test('idle -> arming on motion', () => {
    const r = stepTrip(newTripState(), pointAt(0, 1000, 5))
    expect(r.state.phase).toBe('arming')
    expect(r.state.armingStartTs).toBe(1000)
    expect(r.state.polyline).toEqual([[baseLat, baseLon, 1000]])
  })

  test('arming -> idle if motion stops before arming duration', () => {
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 1000, 5)).state
    s = stepTrip(s, pointAt(1, 5000, 0)).state
    expect(s.phase).toBe('idle')
  })

  test('arming -> active after sustained motion', () => {
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 1000, 5)).state
    // Just under the arming duration: still arming.
    s = stepTrip(s, pointAt(1, 1000 + TRIP_ARMING_DURATION_MS - 1, 5)).state
    expect(s.phase).toBe('arming')
    // Cross the threshold.
    s = stepTrip(s, pointAt(2, 1000 + TRIP_ARMING_DURATION_MS, 5)).state
    expect(s.phase).toBe('active')
    expect(s.startTs).toBe(1000)
  })

  test('active extends polyline on every update', () => {
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 0, 5)).state
    s = stepTrip(s, pointAt(1, TRIP_ARMING_DURATION_MS, 5)).state
    expect(s.phase).toBe('active')
    s = stepTrip(s, pointAt(2, TRIP_ARMING_DURATION_MS + 5000, 5)).state
    s = stepTrip(s, pointAt(3, TRIP_ARMING_DURATION_MS + 10000, 5)).state
    expect(s.polyline).toHaveLength(4)
  })

  test('active -> cooldown on stop', () => {
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 0, 5)).state
    s = stepTrip(s, pointAt(1, TRIP_ARMING_DURATION_MS, 5)).state
    s = stepTrip(s, pointAt(2, TRIP_ARMING_DURATION_MS + 5000, 0)).state
    expect(s.phase).toBe('cooldown')
    expect(s.cooldownStartTs).toBe(TRIP_ARMING_DURATION_MS + 5000)
  })

  test('cooldown -> active on resume', () => {
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 0, 5)).state
    s = stepTrip(s, pointAt(1, TRIP_ARMING_DURATION_MS, 5)).state
    s = stepTrip(s, pointAt(2, TRIP_ARMING_DURATION_MS + 5000, 0)).state
    expect(s.phase).toBe('cooldown')
    s = stepTrip(s, pointAt(3, TRIP_ARMING_DURATION_MS + 6000, 5)).state
    expect(s.phase).toBe('active')
    expect(s.cooldownStartTs).toBeNull()
  })

  test('cooldown -> completed once cooldown elapses (long enough trip)', () => {
    // Build a trip that will be long enough and far enough to keep.
    // We use 6 points 100m apart at 5 m/s; durations large enough to
    // pass the min-duration gate.
    let s = newTripState()
    let ts = 0
    s = stepTrip(s, pointAt(0, ts, 5)).state
    ts += TRIP_ARMING_DURATION_MS
    s = stepTrip(s, pointAt(1, ts, 5)).state
    ts += TRIP_MIN_DURATION_MS // pad active phase to satisfy duration gate
    s = stepTrip(s, pointAt(2, ts, 5)).state
    expect(s.phase).toBe('active')
    // Stop.
    ts += 1000
    s = stepTrip(s, pointAt(3, ts, 0)).state
    expect(s.phase).toBe('cooldown')
    // Cool down past the threshold.
    ts += TRIP_COOLDOWN_DURATION_MS
    const r = stepTrip(s, pointAt(3, ts, 0))
    expect(r.state.phase).toBe('idle')
    expect(r.completed).not.toBeNull()
    expect(r.completed.distanceMeters).toBeGreaterThan(TRIP_MIN_DISTANCE_M)
    expect(r.completed.durationMs).toBeGreaterThan(TRIP_MIN_DURATION_MS)
    expect(r.completed.startTs).toBe(0)
  })

  test('short trip is discarded (below min duration)', () => {
    // Sustained 5 m/s for arming + a tiny bit of active, then stop.
    let s = newTripState()
    let ts = 0
    s = stepTrip(s, pointAt(0, ts, 5)).state
    ts += TRIP_ARMING_DURATION_MS
    s = stepTrip(s, pointAt(1, ts, 5)).state
    expect(s.phase).toBe('active')
    ts += 1000 // only 1s of active
    s = stepTrip(s, pointAt(2, ts, 0)).state
    ts += TRIP_COOLDOWN_DURATION_MS
    const r = stepTrip(s, pointAt(2, ts, 0))
    expect(r.completed).toBeNull()
    expect(r.state.phase).toBe('idle')
  })

  test('tracks running max speed across phases and stashes on completed record', () => {
    let s = newTripState()
    expect(s.maxSpeedMps).toBe(0)
    let ts = 0
    // Idle -> arming. First point sets max from speed at entry.
    s = stepTrip(s, pointAt(0, ts, 6)).state
    expect(s.maxSpeedMps).toBe(6)
    // Arming step with a higher speed bumps the max.
    ts += 5000
    s = stepTrip(s, pointAt(1, ts, 12)).state
    expect(s.maxSpeedMps).toBe(12)
    // A lower-but-still-moving speed leaves the max untouched.
    ts += 5000
    s = stepTrip(s, pointAt(2, ts, 8)).state
    expect(s.maxSpeedMps).toBe(12)
    // Push past arming into active, with a new peak speed.
    ts += TRIP_ARMING_DURATION_MS
    s = stepTrip(s, pointAt(3, ts, 25)).state
    expect(s.phase).toBe('active')
    expect(s.maxSpeedMps).toBe(25)
    // Pad active phase past the min duration gate.
    ts += TRIP_MIN_DURATION_MS
    s = stepTrip(s, pointAt(4, ts, 18)).state
    expect(s.maxSpeedMps).toBe(25)
    // Active -> cooldown.
    ts += 1000
    s = stepTrip(s, pointAt(5, ts, 0)).state
    expect(s.phase).toBe('cooldown')
    // Cooldown elapses -> trip completes; max speed is on the record.
    ts += TRIP_COOLDOWN_DURATION_MS
    const r = stepTrip(s, pointAt(5, ts, 0))
    expect(r.completed).not.toBeNull()
    expect(r.completed.maxSpeedMps).toBe(25)
  })

  test('an unknown-speed fix during an active trip is ignored, not read as a stop', () => {
    // Get into 'active' with maxSpeedMps=15.
    let s = newTripState()
    let ts = 0
    s = stepTrip(s, pointAt(0, ts, 15)).state // idle -> arming, max=15
    ts += TRIP_ARMING_DURATION_MS
    s = stepTrip(s, pointAt(1, ts, 8)).state  // arming -> active, max stays 15
    expect(s.phase).toBe('active')
    expect(s.maxSpeedMps).toBe(15)
    // CLLocation's -1 sentinel (and the null native now sends in its place)
    // means "speed unknown", NOT "stopped". Routing it to cooldown is what let
    // the coarse cached fix on an SLC relaunch end a live drive.
    const before = s
    ts += 1000
    for (const unknown of [-1, null, undefined, NaN]) {
      ts += 1000
      s = stepTrip(s, pointAt(2, ts, unknown)).state
      expect(s.phase).toBe('active')
      expect(s).toBe(before)   // untouched, not merely equivalent
    }
    expect(s.maxSpeedMps).toBe(15)
  })

  test('an unknown-speed fix cannot reset an arming trip', () => {
    // The exact device sequence from the 2026-07-21 iPhone trace: the trip
    // rehydrates as 'arming' after a mid-drive kill, and the first fix iOS
    // delivers on relaunch is a coarse cached one with no speed.
    let s = newTripState()
    let ts = 0
    s = stepTrip(s, pointAt(0, ts, 12)).state
    expect(s.phase).toBe('arming')
    ts += 1000
    s = stepTrip(s, pointAt(1, ts, null)).state
    expect(s.phase).toBe('arming')
    // A REAL measured stop still ends it.
    ts += 1000
    s = stepTrip(s, pointAt(2, ts, 0)).state
    expect(s.phase).toBe('idle')
  })

  test('a fix that does not advance time is ignored', () => {
    // A cached fix carries its original CLLocation timestamp, so it can arrive
    // with a ts behind the polyline. Every arming/cooldown decision is a ts
    // subtraction, so letting the clock run backwards corrupts the windows.
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 10_000, 12)).state
    expect(s.phase).toBe('arming')
    const armed = s
    s = stepTrip(s, pointAt(1, 9_000, 12)).state   // older than the last point
    expect(s).toBe(armed)
    s = stepTrip(s, pointAt(1, 10_000, 12)).state  // same ts
    expect(s).toBe(armed)
    // Promotion still works off the real clock once time advances again.
    s = stepTrip(s, pointAt(1, 10_000 + TRIP_ARMING_DURATION_MS, 12)).state
    expect(s.phase).toBe('active')
    expect(s.startTs).toBe(10_000)
  })
})

describe('polylineDistanceMeters', () => {
  test('empty / single point is zero', () => {
    expect(polylineDistanceMeters([])).toBe(0)
    expect(polylineDistanceMeters([[40, -73, 0]])).toBe(0)
  })

  test('two points: roughly the haversine distance', () => {
    // 0.001 deg lat ~= 111m
    const d = polylineDistanceMeters([[40, -73, 0], [40.001, -73, 1000]])
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(115)
  })

  test('three collinear points sum correctly', () => {
    const d = polylineDistanceMeters([[40, -73, 0], [40.001, -73, 1], [40.002, -73, 2]])
    expect(d).toBeGreaterThan(210)
    expect(d).toBeLessThan(230)
  })
})
