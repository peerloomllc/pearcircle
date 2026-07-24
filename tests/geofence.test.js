const { haversineMeters, classify, isFixUsable, applyRegionEvent, selectNearestRegions, regionAppendDecision, clampPlaceRadius, MIN_PLACE_RADIUS_M, MAX_PLACE_RADIUS_M, ACCURACY_CEILING_M, DWELL_FIXES } = require('../src/lib/geofence')

// Thread prev-classification + dwell through a sequence of fixes, exactly as
// checkPlaceTransitions does. Each entry is [distance, accuracy?]; returns the
// per-fix { classification, kind } results.
function runFixes (radius, seq, startPrev = null) {
  let prev = startPrev
  let dwell = { pending: null, count: 0 }
  return seq.map(([d, acc]) => {
    const r = classify(d, radius, prev, acc, dwell)
    prev = r.classification
    dwell = r.dwell
    return { classification: r.classification, kind: r.kind }
  })
}

describe('haversineMeters', () => {
  test('zero distance for identical points', () => {
    expect(haversineMeters(40, -120, 40, -120)).toBeCloseTo(0, 3)
  })

  test('symmetric', () => {
    const a = haversineMeters(37.42342, -122.08453, 40.0, -130.0)
    const b = haversineMeters(40.0, -130.0, 37.42342, -122.08453)
    expect(a).toBeCloseTo(b, 6)
  })

  test('one degree latitude is ~111 km', () => {
    expect(haversineMeters(0, 0, 1, 0) / 1000).toBeCloseTo(111, 0)
  })

  test('one degree longitude at the equator is ~111 km', () => {
    expect(haversineMeters(0, 0, 0, 1) / 1000).toBeCloseTo(111, 0)
  })

  test('one degree longitude at 60N is ~55 km (cos(60) = 0.5)', () => {
    expect(haversineMeters(60, 0, 60, 1) / 1000).toBeCloseTo(55.6, 0)
  })

  test('SF to NY is ~4130 km', () => {
    // Approximate values - Golden Gate Park to Central Park.
    const km = haversineMeters(37.7694, -122.4862, 40.7829, -73.9654) / 1000
    expect(km).toBeGreaterThan(4100)
    expect(km).toBeLessThan(4200)
  })
})

describe('classify state machine', () => {
  test('return shape includes classification, kind, and dwell', () => {
    expect(classify(50, 100, null)).toEqual({
      classification: 'inside',
      kind: null,
      dwell: { pending: null, count: 0 },
    })
  })

  test('first observation inside establishes baseline silently', () => {
    const r = classify(50, 100, null)
    expect(r.classification).toBe('inside')
    expect(r.kind).toBeNull()
  })

  test('first observation outside is silent', () => {
    const r = classify(150, 100, null)
    expect(r.classification).toBe('outside')
    expect(r.kind).toBeNull()
  })

  test('inside → inside is silent', () => {
    expect(classify(50, 100, 'inside')).toMatchObject({ classification: 'inside', kind: null })
  })

  test('outside → outside is silent', () => {
    expect(classify(150, 100, 'outside')).toMatchObject({ classification: 'outside', kind: null })
  })

  describe('dwell: 2 consecutive confirming fixes required to commit a crossing', () => {
    test('a lone outside fix does NOT fire an exit (candidate pending)', () => {
      const r = classify(150, 100, 'inside')
      expect(r).toEqual({
        classification: 'inside', // held
        kind: null,
        dwell: { pending: 'outside', count: 1 },
      })
    })

    test('a second consecutive outside fix commits the exit', () => {
      const [first, second] = runFixes(100, [[150], [150]], 'inside')
      expect(first).toEqual({ classification: 'inside', kind: null })
      expect(second).toEqual({ classification: 'outside', kind: 'exit' })
    })

    test('a lone inside fix does NOT fire an enter, the second one does', () => {
      const [first, second] = runFixes(100, [[50], [50]], 'outside')
      expect(first).toEqual({ classification: 'outside', kind: null })
      expect(second).toEqual({ classification: 'inside', kind: 'enter' })
    })

    test('an agreeing fix between two outside fixes resets the dwell (no exit)', () => {
      // inside -> [outside(pending), inside(resets), outside(pending again)]:
      // the crossing never gets two IN A ROW, so no exit fires.
      const out = runFixes(100, [[150], [50], [150]], 'inside')
      expect(out.map((r) => r.kind)).toEqual([null, null, null])
      expect(out.map((r) => r.classification)).toEqual(['inside', 'inside', 'inside'])
    })

    test('DWELL_FIXES is 2 (guards the tests above)', () => {
      expect(DWELL_FIXES).toBe(2)
    })
  })

  describe('uncertainty-circle read (symmetric, uncapped)', () => {
    test('a noisy fix just outside the radius reads ambiguous, no exit', () => {
      // 120m off a 100m radius with 60m accuracy: near edge = 60m (inside the
      // radius), so the fix is ambiguous and cannot even become an exit
      // candidate. State holds.
      expect(classify(120, 100, 'inside', 60)).toEqual({
        classification: 'inside',
        kind: null,
        dwell: { pending: null, count: 0 },
      })
    })

    test('a confidently-outside fix becomes an exit candidate, commits on the second', () => {
      // 250m out with 30m accuracy: near edge = 220m > 100m -> confidently out.
      const [first, second] = runFixes(100, [[250, 30], [250, 30]], 'inside')
      expect(first.kind).toBeNull()
      expect(second).toEqual({ classification: 'outside', kind: 'exit' })
    })

    test('a garbage fix (huge accuracy) can never even become a candidate', () => {
      // 1500m off with 2000m accuracy: near edge = -500m, far edge = 3500m.
      // Straddles the boundary -> ambiguous -> holds forever no matter how
      // many arrive. This is the km-off GrapheneOS network fix.
      const out = runFixes(100, [[1500, 2000], [1500, 2000], [1500, 2000]], 'inside')
      expect(out.every((r) => r.kind === null && r.classification === 'inside')).toBe(true)
    })

    test('entry is damped symmetrically: a blurry inside fix cannot enter', () => {
      // 90m in with 60m accuracy: far edge = 150m > 100m -> ambiguous, no enter.
      expect(classify(90, 100, 'outside', 60)).toEqual({
        classification: 'outside',
        kind: null,
        dwell: { pending: null, count: 0 },
      })
    })

    test('zero/absent accuracy collapses to a plain distance read', () => {
      // With no accuracy the fix is confident, so two in a row commit.
      expect(runFixes(100, [[120, 0], [120, 0]], 'inside')[1]).toEqual({ classification: 'outside', kind: 'exit' })
      expect(runFixes(100, [[120], [120]], 'inside')[1]).toEqual({ classification: 'outside', kind: 'exit' })
    })
  })

  describe('the phantom "left … / arrived …" flap does not fire (2026-07-18)', () => {
    test('a single km-off fix among clean at-home fixes commits nothing', () => {
      // At Home (400m radius), sitting still ~30m from centre. One GrapheneOS
      // network fix lands 1500m away (±40m, so "confidently" outside), then the
      // stream returns to clean at-home fixes. The lone outlier is a candidate
      // but never gets a second consecutive confirmation -> no exit, no enter,
      // no phantom pair.
      const out = runFixes(400, [
        [30, 15],    // inside, clean
        [1500, 40],  // lone outlier: confidently outside -> candidate
        [35, 15],    // back home, clean -> resets candidate
        [28, 15],    // still home
      ], 'inside')
      expect(out.map((r) => r.kind)).toEqual([null, null, null, null])
      expect(out.every((r) => r.classification === 'inside')).toBe(true)
    })
  })

  test('a sequence simulating a walk produces the right transitions', () => {
    const radius = 100
    const out = runFixes(radius, [
      [200], // start outside (baseline)
      [150], // approaching, still outside
      [80],  // crossed in: candidate enter
      [70],  // confirms: ENTER
      [20],  // walking around
      [90],  // still inside
      [120], // crossed out: candidate exit
      [140], // confirms: EXIT
      [300], // far away
    ], null)
    expect(out.map((r) => r.classification)).toEqual([
      'outside', 'outside', 'outside', 'inside', 'inside', 'inside', 'inside', 'outside', 'outside',
    ])
    expect(out.map((r) => r.kind)).toEqual([
      null, null, null, 'enter', null, null, null, 'exit', null,
    ])
  })
})

describe('isFixUsable (accuracy gate)', () => {
  test('ACCURACY_CEILING_M is 150', () => {
    expect(ACCURACY_CEILING_M).toBe(150)
  })

  test('a clean fix is usable', () => {
    expect(isFixUsable(40)).toBe(true)
  })

  test('a fix exactly at the ceiling is usable', () => {
    expect(isFixUsable(150)).toBe(true)
  })

  test('a fix worse than the ceiling is gated out', () => {
    expect(isFixUsable(151)).toBe(false)
    expect(isFixUsable(2000)).toBe(false)
  })

  test('absent / NaN accuracy is trusted (older callers, tests)', () => {
    expect(isFixUsable(undefined)).toBe(true)
    expect(isFixUsable(null)).toBe(true)
    expect(isFixUsable(NaN)).toBe(true)
  })
})

describe('applyRegionEvent (native enter/exit dedup)', () => {
  test('enter from outside flips classification and is not deduped', () => {
    expect(applyRegionEvent('outside', 'enter')).toEqual({ deduped: false, classification: 'inside' })
  })

  test('exit from inside flips classification and is not deduped', () => {
    expect(applyRegionEvent('inside', 'exit')).toEqual({ deduped: false, classification: 'outside' })
  })

  test('enter while already inside is deduped (no double-write)', () => {
    expect(applyRegionEvent('inside', 'enter')).toEqual({ deduped: true, classification: 'inside' })
  })

  test('exit while already outside is deduped (no double-write)', () => {
    expect(applyRegionEvent('outside', 'exit')).toEqual({ deduped: true, classification: 'outside' })
  })

  test('enter with null prev establishes baseline and writes', () => {
    expect(applyRegionEvent(null, 'enter')).toEqual({ deduped: false, classification: 'inside' })
  })

  test('exit with null prev establishes baseline and writes', () => {
    expect(applyRegionEvent(null, 'exit')).toEqual({ deduped: false, classification: 'outside' })
  })

  test('unknown kind is treated as invalid and deduped (no write)', () => {
    const r = applyRegionEvent('outside', 'wat')
    expect(r.deduped).toBe(true)
    expect(r.invalid).toBe(true)
  })

  test('race between JS classifier and native event lands one write', () => {
    // Simulates: JS classifier sees the boundary cross first via
    // location:update, flips state to 'inside'. Native didEnterRegion
    // fires shortly after with the same observation. The second call
    // must dedup.
    let state = 'outside'
    const first = applyRegionEvent(state, 'enter')
    state = first.classification
    const second = applyRegionEvent(state, 'enter')
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
  })
})

describe('selectNearestRegions (proximity ranking for the OS region cap)', () => {
  const r = 100
  // device at (0,0); places spread east, so distance grows with longitude.
  const near = { id: 'near', lat: 0, lon: 0.1, radiusMeters: r }
  const mid = { id: 'mid', lat: 0, lon: 0.2, radiusMeters: r }
  const far = { id: 'far', lat: 0, lon: 0.3, radiusMeters: r }
  const dev = { lat: 0, lon: 0 }

  test('returns all when fewer than the cap', () => {
    const out = selectNearestRegions([near, mid], dev, 20)
    expect(out.map((p) => p.id).sort()).toEqual(['mid', 'near'])
  })

  test('keeps the nearest N when there are more places than slots', () => {
    // input order is deliberately not distance order
    const out = selectNearestRegions([far, near, mid], dev, 2)
    expect(out.map((p) => p.id)).toEqual(['near', 'mid'])
  })

  test('orders nearest-first', () => {
    const out = selectNearestRegions([far, near, mid], dev, 20)
    expect(out.map((p) => p.id)).toEqual(['near', 'mid', 'far'])
  })

  test('no device position falls back to input order, still capped', () => {
    const out = selectNearestRegions([far, near, mid], null, 2)
    expect(out.map((p) => p.id)).toEqual(['far', 'near'])
  })

  test('non-finite device position also falls back to input order', () => {
    const out = selectNearestRegions([far, near, mid], { lat: NaN, lon: 0 }, 20)
    expect(out.map((p) => p.id)).toEqual(['far', 'near', 'mid'])
  })

  test('drops entries with invalid coords or radius before ranking', () => {
    const badCoord = { id: 'badc', lat: NaN, lon: 0.05, radiusMeters: r }
    const badRadius = { id: 'badr', lat: 0, lon: 0.05, radiusMeters: 0 }
    const negRadius = { id: 'negr', lat: 0, lon: 0.05, radiusMeters: -10 }
    const out = selectNearestRegions([badCoord, far, badRadius, near, negRadius], dev, 20)
    expect(out.map((p) => p.id)).toEqual(['near', 'far'])
  })

  test('omitted cap returns the full ordered list', () => {
    const out = selectNearestRegions([far, near, mid], dev)
    expect(out.map((p) => p.id)).toEqual(['near', 'mid', 'far'])
  })

  test('preserves the other fields on each place', () => {
    const out = selectNearestRegions([near], dev, 20)
    expect(out[0]).toEqual(near)
  })
})

describe('regionAppendDecision (no-resurrection guard for the native region path)', () => {
  test('sharing on + writer NOT writable => queue (never advance-and-drop)', () => {
    // The load-bearing case: a native crossing arriving before the autobase is
    // writable must be queued, so the caller leaves the classifier untouched
    // and the crossing is not lost forever.
    expect(regionAppendDecision({ sharing: true, writable: false })).toBe('queue')
  })

  test('sharing on + writer writable => append', () => {
    expect(regionAppendDecision({ sharing: true, writable: true })).toBe('append')
  })

  test('muted circle => muted regardless of writer state', () => {
    expect(regionAppendDecision({ sharing: false, writable: true })).toBe('muted')
    expect(regionAppendDecision({ sharing: false, writable: false })).toBe('muted')
  })
})

describe('MIN_PLACE_RADIUS_M (iOS region-monitoring reliability floor)', () => {
  test('is at least 100m, the practical iOS floor', () => {
    expect(MIN_PLACE_RADIUS_M).toBeGreaterThanOrEqual(100)
  })

  test('flooring a small radius lifts it to the minimum, leaves a large one', () => {
    expect(Math.max(50, MIN_PLACE_RADIUS_M)).toBe(MIN_PLACE_RADIUS_M)
    expect(Math.max(400, MIN_PLACE_RADIUS_M)).toBe(400)
  })
})

describe('clampPlaceRadius (copying legacy Places into a new circle)', () => {
  test('lifts a pre-#139 default 100m Place to the floor', () => {
    expect(clampPlaceRadius(100)).toBe(MIN_PLACE_RADIUS_M)
  })

  test('leaves an in-range radius untouched', () => {
    expect(clampPlaceRadius(400)).toBe(400)
    expect(clampPlaceRadius(MIN_PLACE_RADIUS_M)).toBe(MIN_PLACE_RADIUS_M)
  })

  test('caps an oversized radius at the maximum', () => {
    expect(clampPlaceRadius(50000)).toBe(MAX_PLACE_RADIUS_M)
  })

  test('returns null for a non-numeric radius so the caller can skip the Place', () => {
    expect(clampPlaceRadius(undefined)).toBeNull()
    expect(clampPlaceRadius(NaN)).toBeNull()
    expect(clampPlaceRadius('150')).toBeNull()
  })

  test('every clamped value is accepted by the place:create bounds', () => {
    for (const r of [1, 10, 100, 149, 150, 9999, 10000, 1e9]) {
      const c = clampPlaceRadius(r)
      expect(c).toBeGreaterThanOrEqual(MIN_PLACE_RADIUS_M)
      expect(c).toBeLessThanOrEqual(MAX_PLACE_RADIUS_M)
    }
  })
})
