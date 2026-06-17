const { buildExport, validateImport, EXPORT_TYPE, MAX_PLACES } = require('../src/lib/circleExport')

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
