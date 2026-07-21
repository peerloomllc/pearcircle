// Drain-path tests for durable background trip capture (proposal
// 2026-07-18-background-trip-capture, Part C). The native durable fix log is
// modeled here as a plain ordered array of fixes; these assert that replaying it
// through the pure trip machine reconstructs the exact trip the live path would
// have produced, survives a worklet "restart" split mid-drive, and cannot
// duplicate an already-published span.

const {
  newTripState,
  stepTrip,
  replayTrip,
  settleStaleTrip,
  TRIP_ARMING_DURATION_MS,
  TRIP_COOLDOWN_DURATION_MS,
} = require('../src/lib/trip')

const baseLat = 40.0
const baseLon = -73.0
const stepDeg = 0.002 // ~222m/step, clears the 1m appendPoint dedup

function pointAt (i, ts, speed) {
  return { lat: baseLat + i * stepDeg, lon: baseLon + i * stepDeg, ts, speed }
}

// A synthetic drive: arm, run active past the min duration/distance, stop, then
// a trailing stationary fix well past the cooldown window to trigger finalize on
// the arrival path. Returns the ordered fix array.
function makeDrive (startTs = 1000) {
  const fixes = []
  // arming -> active: fast fixes across the arming window
  for (let i = 0; i <= 6; i++) {
    fixes.push(pointAt(i, startTs + i * 6000, 15)) // 36s of motion > 30s arming
  }
  // active: keep moving for another ~90s / plenty of distance
  for (let i = 7; i <= 20; i++) {
    fixes.push(pointAt(i, startTs + i * 6000, 15))
  }
  // stop: a low-speed fix enters cooldown
  const stopTs = startTs + 21 * 6000
  fixes.push(pointAt(20, stopTs, 0))
  // trailing fix past the cooldown window finalizes the trip on arrival
  fixes.push(pointAt(20, stopTs + TRIP_COOLDOWN_DURATION_MS + 1000, 0))
  return fixes
}

describe('replayTrip drain equivalence', () => {
  test('one-pass drain equals a live step-by-step run', () => {
    const fixes = makeDrive()
    // Live reference: step each fix, collect completed trips.
    let live = newTripState()
    const liveTrips = []
    for (const f of fixes) {
      const r = stepTrip(live, f)
      live = r.state
      if (r.completed) liveTrips.push(r.completed)
    }
    // Drain: one batch through replayTrip.
    const drained = replayTrip(newTripState(), fixes)
    expect(drained.completed).toEqual(liveTrips)
    expect(drained.completed).toHaveLength(1)
    expect(drained.state.phase).toBe('idle')
  })

  test('a drive split across two drains (worklet restart between) yields one identical trip', () => {
    const fixes = makeDrive()
    const whole = replayTrip(newTripState(), fixes).completed

    // Split mid-active. State carried across the split simulates rehydrating
    // the tripInFlight checkpoint after a restart.
    const cut = 12
    const first = replayTrip(newTripState(), fixes.slice(0, cut))
    expect(first.completed).toHaveLength(0)
    expect(first.state.phase).toBe('active')
    const second = replayTrip(first.state, fixes.slice(cut))

    expect(second.completed).toEqual(whole)
    expect(second.completed).toHaveLength(1)
  })

  test('re-draining an already-published span cannot duplicate the persisted trip', () => {
    // Idempotency is enforced at the persistence layer, not by replay refusing
    // to re-complete: a cursor that was never acked re-feeds the same span and
    // legitimately re-derives the same completed trip. Because the local put is
    // keyed on startTs (`trips:{pubkey}:{startTs}`) and the signed value is
    // identical, the second write lands on the same key -- one row, not two.
    // This models `_localDb.put(tripKey, ...)` in bare.js.
    const store = new Map()
    const persist = (trip) => store.set('trips:PK:' + trip.startTs, trip)

    const fixes = makeDrive()
    const first = replayTrip(newTripState(), fixes)
    expect(first.completed).toHaveLength(1)
    first.completed.forEach(persist)

    // Cursor not acked -> the exact same span drains again.
    const second = replayTrip(newTripState(), fixes)
    second.completed.forEach(persist)

    expect(store.size).toBe(1)
    expect(store.get('trips:PK:' + first.completed[0].startTs)).toEqual(first.completed[0])
  })
})

describe('settleStaleTrip', () => {
  test('finalizes an active trip abandoned mid-drive once the gap exceeds cooldown', () => {
    // Build an active trip, then never send the closing fixes.
    let s = newTripState()
    for (let i = 0; i <= 20; i++) {
      s = stepTrip(s, pointAt(i, 1000 + i * 6000, 15)).state
    }
    expect(s.phase).toBe('active')
    const lastTs = 1000 + 20 * 6000
    // A wake a cooldown-window later with no intervening fixes.
    const r = settleStaleTrip(s, lastTs + TRIP_COOLDOWN_DURATION_MS + 1)
    expect(r.completed).not.toBeNull()
    expect(r.completed.startTs).toBe(1000)
    expect(r.completed.endTs).toBe(lastTs)
    expect(r.state.phase).toBe('idle')
  })

  test('leaves a still-live trip untouched when the gap is under cooldown', () => {
    let s = newTripState()
    for (let i = 0; i <= 20; i++) {
      s = stepTrip(s, pointAt(i, 1000 + i * 6000, 15)).state
    }
    const lastTs = 1000 + 20 * 6000
    const r = settleStaleTrip(s, lastTs + 30_000)
    expect(r.completed).toBeNull()
    expect(r.state).toBe(s)
  })

  test('discards a stale arming that never became a trip', () => {
    let s = stepTrip(newTripState(), pointAt(0, 1000, 15)).state
    expect(s.phase).toBe('arming')
    const r = settleStaleTrip(s, 1000 + TRIP_COOLDOWN_DURATION_MS + 1)
    expect(r.completed).toBeNull()
    expect(r.state.phase).toBe('idle')
  })

  test('discards an abandoned trip that never cleared the min thresholds', () => {
    // Arm and just barely go active, then abandon immediately (short + close).
    let s = newTripState()
    s = stepTrip(s, pointAt(0, 1000, 15)).state
    s = stepTrip(s, { lat: baseLat, lon: baseLon, ts: 1000 + TRIP_ARMING_DURATION_MS, speed: 15 }).state
    expect(s.phase).toBe('active')
    const r = settleStaleTrip(s, 1000 + TRIP_ARMING_DURATION_MS + TRIP_COOLDOWN_DURATION_MS + 1)
    // Distance ~0 (both points identical) -> discarded, not a trip.
    expect(r.completed).toBeNull()
    expect(r.state.phase).toBe('idle')
  })
})
