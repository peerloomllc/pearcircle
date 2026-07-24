const { buildExport, validateImport, planPlaceCopy, EXPORT_TYPE, MAX_PLACES } = require('../src/lib/circleExport')
const { MIN_PLACE_RADIUS_M } = require('../src/lib/geofence')

const goodConfig = {
  name: 'Family',
  places: [
    { name: 'Home', lat: 37.7749, lon: -122.4194, radiusMeters: 150 },
    { name: 'Work', lat: 37.78, lon: -122.41, radiusMeters: 200 },
  ],
  settings: { sharingDefault: true, tripSharing: false },
}

describe('buildExport', () => {
  test('emits a versioned envelope with only curated fields', () => {
    const e = buildExport(goodConfig, 1000)
    expect(e.type).toBe(EXPORT_TYPE)
    expect(e.v).toBe(1)
    expect(e.exportedAt).toBe(1000)
    expect(e.circle).toEqual({ name: 'Family' })
    expect(e.settings).toEqual({ sharingDefault: true, tripSharing: false })
  })

  test('strips ids/createdBy/createdAt from places', () => {
    const e = buildExport({
      name: 'C',
      places: [{ id: 'p1', name: 'Home', lat: 1, lon: 2, radiusMeters: 50, createdBy: 'abc', createdAt: 9 }],
    })
    expect(e.places[0]).toEqual({ name: 'Home', lat: 1, lon: 2, radiusMeters: 50 })
  })

  test('emits no keys, ids or member rows anywhere', () => {
    const json = JSON.stringify(buildExport(goodConfig))
    for (const banned of ['circleKey', 'encryptionKey', 'bootstrap', 'member', 'secretKey', 'createdBy']) {
      expect(json).not.toContain(banned)
    }
  })

  test('coerces missing/odd settings to false booleans', () => {
    const e = buildExport({ name: 'C', places: [] })
    expect(e.settings).toEqual({ sharingDefault: false, tripSharing: false })
  })
})

describe('validateImport', () => {
  test('round-trips a built export', () => {
    const r = validateImport(buildExport(goodConfig))
    expect(r.ok).toBe(true)
    expect(r.value.name).toBe('Family')
    expect(r.value.places).toHaveLength(2)
    expect(r.value.places[0]).toEqual({ name: 'Home', lat: 37.7749, lon: -122.4194, radiusMeters: 150 })
    expect(r.value.settings).toEqual({ sharingDefault: true, tripSharing: false })
  })

  test('rejects non-objects and wrong type', () => {
    expect(validateImport(null).ok).toBe(false)
    expect(validateImport('x').ok).toBe(false)
    expect(validateImport({ type: 'something-else', v: 1 }).ok).toBe(false)
  })

  test('rejects unknown version', () => {
    const e = buildExport(goodConfig)
    expect(validateImport({ ...e, v: 2 }).ok).toBe(false)
  })

  test('rejects bad circle name', () => {
    expect(validateImport(buildExport({ name: '', places: [] })).ok).toBe(false)
    expect(validateImport(buildExport({ name: 'x'.repeat(65), places: [] })).ok).toBe(false)
  })

  test('rejects out-of-bounds place fields', () => {
    const mk = (place) => ({ ...buildExport({ name: 'C', places: [] }), places: [place] })
    expect(validateImport(mk({ name: 'P', lat: 91, lon: 0, radiusMeters: 50 })).ok).toBe(false)
    expect(validateImport(mk({ name: 'P', lat: 0, lon: 181, radiusMeters: 50 })).ok).toBe(false)
    expect(validateImport(mk({ name: 'P', lat: 0, lon: 0, radiusMeters: 5 })).ok).toBe(false)
    expect(validateImport(mk({ name: 'P', lat: 0, lon: 0, radiusMeters: 99999 })).ok).toBe(false)
    expect(validateImport(mk({ name: '', lat: 0, lon: 0, radiusMeters: 50 })).ok).toBe(false)
    expect(validateImport(mk({ name: 'P', lat: 'x', lon: 0, radiusMeters: 50 })).ok).toBe(false)
  })

  test('rejects places that is not an array, and over-cap counts', () => {
    expect(validateImport({ ...buildExport({ name: 'C', places: [] }), places: 'nope' }).ok).toBe(false)
    const many = Array.from({ length: MAX_PLACES + 1 }, () => ({ name: 'P', lat: 0, lon: 0, radiusMeters: 50 }))
    expect(validateImport({ ...buildExport({ name: 'C', places: [] }), places: many }).ok).toBe(false)
  })

  test('trims circle and place names', () => {
    const r = validateImport(buildExport({ name: '  Trip  ', places: [{ name: '  Gym ', lat: 1, lon: 2, radiusMeters: 50 }] }))
    expect(r.ok).toBe(true)
    expect(r.value.name).toBe('Trip')
    expect(r.value.places[0].name).toBe('Gym')
  })
})

describe('planPlaceCopy (copying Places into a freshly created circle)', () => {
  test('lifts a legacy sub-floor radius to the live floor instead of failing', () => {
    // The regression: circles created before #139 hold 100m Places (the old
    // Add Place default), which place:create now rejects. Recreating one used
    // to abort after the new circle had already been created, so the owner got
    // a duplicate circle, no invite and no migration nudge.
    const { copy, skipped } = planPlaceCopy([{ name: 'Home', lat: 1, lon: 2, radiusMeters: 100 }])
    expect(skipped).toEqual([])
    expect(copy).toEqual([{ name: 'Home', lat: 1, lon: 2, radiusMeters: MIN_PLACE_RADIUS_M }])
  })

  test('passes an in-range Place through untouched, minus its extra fields', () => {
    const { copy } = planPlaceCopy([
      { id: 'p1', name: 'Work', lat: 3, lon: 4, radiusMeters: 400, createdBy: 'abc', createdAt: 9 },
    ])
    expect(copy).toEqual([{ name: 'Work', lat: 3, lon: 4, radiusMeters: 400 }])
  })

  test('skips only the unusable Place and keeps the rest', () => {
    const { copy, skipped } = planPlaceCopy([
      { name: 'Home', lat: 1, lon: 2, radiusMeters: 100 },
      { name: '', lat: 1, lon: 2, radiusMeters: 200 },
      { name: 'Broken', lat: 'x', lon: 2, radiusMeters: 200 },
      { name: 'NoRadius', lat: 1, lon: 2 },
      { name: 'School', lat: 5, lon: 6, radiusMeters: 300 },
    ])
    expect(copy.map((p) => p.name)).toEqual(['Home', 'School'])
    expect(skipped.map((s) => s.reason)).toEqual(['invalid name', 'invalid lat', 'invalid radiusMeters'])
  })

  test('caps an oversized radius rather than dropping the Place', () => {
    const { copy, skipped } = planPlaceCopy([{ name: 'Big', lat: 0, lon: 0, radiusMeters: 99999 }])
    expect(skipped).toEqual([])
    expect(copy[0].radiusMeters).toBe(10000)
  })

  test('trims names and tolerates a missing/!array list', () => {
    expect(planPlaceCopy([{ name: ' Gym ', lat: 1, lon: 2, radiusMeters: 200 }]).copy[0].name).toBe('Gym')
    expect(planPlaceCopy().copy).toEqual([])
    expect(planPlaceCopy('nope').copy).toEqual([])
  })

  test('every planned Place satisfies the live place:create bounds', () => {
    const { copy } = planPlaceCopy([
      { name: 'A', lat: -90, lon: -180, radiusMeters: 1 },
      { name: 'B', lat: 90, lon: 180, radiusMeters: 1e9 },
      { name: 'C', lat: 0, lon: 0, radiusMeters: 149 },
    ])
    expect(copy).toHaveLength(3)
    for (const p of copy) {
      expect(p.radiusMeters).toBeGreaterThanOrEqual(MIN_PLACE_RADIUS_M)
      expect(p.radiusMeters).toBeLessThanOrEqual(10000)
      expect(Number.isFinite(p.lat) && Number.isFinite(p.lon)).toBe(true)
    }
  })

  test('a legacy export file round-trips into a copyable plan', () => {
    const legacy = buildExport({ name: 'Family', places: [{ name: 'Home', lat: 1, lon: 2, radiusMeters: 100 }] })
    const validated = validateImport(legacy)
    expect(validated.ok).toBe(true) // the envelope keeps the historical value
    expect(planPlaceCopy(validated.value.places).copy[0].radiusMeters).toBe(MIN_PLACE_RADIUS_M)
  })
})
