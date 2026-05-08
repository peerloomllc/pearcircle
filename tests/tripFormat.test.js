const {
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTripDate,
  tripBoundingBox,
  polylineSvgPath,
  polylineGeoJson,
} = require('../src/lib/tripFormat')

describe('formatDistance', () => {
  test('km below 100m falls back to meters', () => {
    expect(formatDistance(75)).toBe('75 m')
  })
  test('km between 0.1 and 10 km uses one decimal', () => {
    expect(formatDistance(2540)).toBe('2.5 km')
  })
  test('km above 10 km rounds to integer', () => {
    expect(formatDistance(12450)).toBe('12 km')
  })
  test('miles below 0.1 falls back to feet', () => {
    expect(formatDistance(50, 'miles')).toBe('164 ft')
  })
  test('miles between 0.1 and 10 mi uses one decimal', () => {
    expect(formatDistance(8047, 'miles')).toBe('5.0 mi')
  })
  test('miles above 10 mi rounds to integer', () => {
    expect(formatDistance(20000, 'miles')).toBe('12 mi')
  })
  test('rejects garbage input', () => {
    expect(formatDistance(NaN)).toBe('')
    expect(formatDistance(-1)).toBe('')
    expect(formatDistance(undefined)).toBe('')
  })
})

describe('formatDuration', () => {
  test('sub-hour reads in minutes', () => {
    expect(formatDuration(45 * 60_000)).toBe('45 min')
  })
  test('whole hours drop the minute suffix', () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe('2 h')
  })
  test('h + min combo', () => {
    expect(formatDuration(75 * 60_000)).toBe('1 h 15 min')
  })
  test('rejects garbage input', () => {
    expect(formatDuration(NaN)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})

describe('formatSpeed', () => {
  test('km/h conversion', () => {
    expect(formatSpeed(35)).toBe('126 km/h') // 35 m/s = 126 km/h
    expect(formatSpeed(0)).toBe('0 km/h')
  })
  test('mph conversion', () => {
    expect(formatSpeed(35, 'miles')).toBe('78 mph') // 35 m/s ≈ 78.3 mph
    expect(formatSpeed(0, 'miles')).toBe('0 mph')
  })
  test('rejects garbage', () => {
    expect(formatSpeed(-1)).toBe('') // CLLocation unknown-speed sentinel
    expect(formatSpeed(NaN)).toBe('')
    expect(formatSpeed(undefined)).toBe('')
  })
})

describe('formatTripDate', () => {
  const fixedNow = new Date('2026-05-08T15:00:00Z').getTime()
  test('same-day prefix is "Today"', () => {
    const ts = new Date('2026-05-08T10:00:00Z').getTime()
    expect(formatTripDate(ts, fixedNow)).toMatch(/^Today /)
  })
  test('yesterday prefix is "Yesterday"', () => {
    const ts = new Date('2026-05-07T10:00:00Z').getTime()
    expect(formatTripDate(ts, fixedNow)).toMatch(/^Yesterday /)
  })
  test('older falls back to month + day', () => {
    const ts = new Date('2026-04-30T10:00:00Z').getTime()
    expect(formatTripDate(ts, fixedNow)).toMatch(/^Apr 30 /)
  })
})

describe('tripBoundingBox', () => {
  test('returns null on empty', () => {
    expect(tripBoundingBox([])).toBeNull()
    expect(tripBoundingBox(null)).toBeNull()
  })
  test('computes min/max from polyline', () => {
    const bb = tripBoundingBox([
      [40.0, -74.0, 0],
      [40.1, -73.9, 1],
      [40.05, -74.05, 2],
    ])
    expect(bb).toEqual({ minLat: 40.0, maxLat: 40.1, minLon: -74.05, maxLon: -73.9 })
  })
  test('skips malformed points', () => {
    const bb = tripBoundingBox([
      [40.0, -74.0],
      [null, -73.9],
      'garbage',
      [40.1, -73.9],
    ])
    expect(bb).toEqual({ minLat: 40.0, maxLat: 40.1, minLon: -74.0, maxLon: -73.9 })
  })
})

describe('polylineSvgPath', () => {
  test('empty polyline yields empty string', () => {
    expect(polylineSvgPath([], 100, 100)).toBe('')
  })
  test('produces M/L command sequence inside the viewBox', () => {
    const d = polylineSvgPath([
      [40.0, -74.0, 0],
      [40.05, -73.95, 1],
      [40.1, -73.9, 2],
    ], 100, 100, 4)
    expect(d).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/)
    const nums = d.match(/[\d.]+/g).map(Number)
    for (const n of nums) {
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(100)
    }
  })
  test('latitude grows northward; svg y grows downward, so northern points have smaller y', () => {
    const d = polylineSvgPath([
      [40.0, -74.0, 0],
      [40.1, -74.0, 1],
    ], 100, 100, 0)
    const points = d.match(/[\d.]+,[\d.]+/g).map(p => p.split(',').map(Number))
    const [, [, y1]] = [points[0], points[1]]
    const [, y0] = points[0]
    expect(y1).toBeLessThan(y0)
  })
})

describe('polylineGeoJson', () => {
  test('reorders [lat,lon,ts] to GeoJSON [lon,lat]', () => {
    const fc = polylineGeoJson([
      [40.0, -74.0, 0],
      [40.1, -73.9, 1],
    ])
    expect(fc.geometry.type).toBe('LineString')
    expect(fc.geometry.coordinates).toEqual([[-74.0, 40.0], [-73.9, 40.1]])
  })
  test('skips malformed entries', () => {
    const fc = polylineGeoJson([[40.0, -74.0], 'garbage', [null, 0]])
    expect(fc.geometry.coordinates).toEqual([[-74.0, 40.0]])
  })
})
