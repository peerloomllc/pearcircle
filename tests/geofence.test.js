const { haversineMeters, classify, applyRegionEvent } = require('../src/lib/geofence')

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
  test('first observation inside establishes baseline silently', () => {
    expect(classify(50, 100, null)).toEqual({ classification: 'inside', kind: null })
  })

  test('first observation outside is silent', () => {
    expect(classify(150, 100, null)).toEqual({ classification: 'outside', kind: null })
  })

  test('outside → inside fires enter', () => {
    expect(classify(50, 100, 'outside')).toEqual({ classification: 'inside', kind: 'enter' })
  })

  test('inside → outside fires exit', () => {
    expect(classify(150, 100, 'inside')).toEqual({ classification: 'outside', kind: 'exit' })
  })

  test('inside → inside is silent', () => {
    expect(classify(50, 100, 'inside')).toEqual({ classification: 'inside', kind: null })
  })

  test('outside → outside is silent', () => {
    expect(classify(150, 100, 'outside')).toEqual({ classification: 'outside', kind: null })
  })

  test('exact radius is treated as inside', () => {
    expect(classify(100, 100, 'outside')).toEqual({ classification: 'inside', kind: 'enter' })
  })

  test('a sequence simulating a walk produces the right transitions', () => {
    const radius = 100
    const points = [
      { d: 200, expectClass: 'outside', expectKind: null },   // start outside
      { d: 150, expectClass: 'outside', expectKind: null },   // approaching
      { d: 80,  expectClass: 'inside',  expectKind: 'enter' }, // crossed in
      { d: 20,  expectClass: 'inside',  expectKind: null },   // walking around
      { d: 90,  expectClass: 'inside',  expectKind: null },   // still inside
      { d: 120, expectClass: 'outside', expectKind: 'exit' }, // crossed out
      { d: 300, expectClass: 'outside', expectKind: null },   // far away
    ]
    let state = null
    for (const p of points) {
      const r = classify(p.d, radius, state)
      expect(r.classification).toBe(p.expectClass)
      expect(r.kind).toBe(p.expectKind)
      state = r.classification
    }
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
