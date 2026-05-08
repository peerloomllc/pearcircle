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
