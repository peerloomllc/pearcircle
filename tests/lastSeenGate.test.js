const { shouldAppendLastSeen, LASTSEEN_MIN_MOVE_M } = require('../src/lib/lastSeenGate')

describe('shouldAppendLastSeen', () => {
  const base = { lat: 37.7749, lon: -122.4194 } // SF

  test('first fix (no prev) always appends', () => {
    expect(shouldAppendLastSeen(null, base.lat, base.lon)).toBe(true)
    expect(shouldAppendLastSeen(undefined, base.lat, base.lon)).toBe(true)
  })

  test('malformed prev appends (fail open)', () => {
    expect(shouldAppendLastSeen({}, base.lat, base.lon)).toBe(true)
    expect(shouldAppendLastSeen({ lat: 'x', lon: 0 }, base.lat, base.lon)).toBe(true)
  })

  test('identical position is suppressed', () => {
    expect(shouldAppendLastSeen(base, base.lat, base.lon)).toBe(false)
  })

  test('a few meters of jitter is suppressed', () => {
    // ~0.00005 deg latitude is ~5.5m, under the 20m gate.
    expect(shouldAppendLastSeen(base, base.lat + 0.00005, base.lon)).toBe(false)
  })

  test('a move past the threshold appends', () => {
    // ~0.0003 deg latitude is ~33m, over the 20m gate.
    expect(shouldAppendLastSeen(base, base.lat + 0.0003, base.lon)).toBe(true)
  })

  test('honors a custom threshold', () => {
    const farther = { lat: base.lat + 0.0003, lon: base.lon } // ~33m
    expect(shouldAppendLastSeen(base, farther.lat, farther.lon, 100)).toBe(false)
    expect(shouldAppendLastSeen(base, farther.lat, farther.lon, 10)).toBe(true)
  })

  test('default threshold is the exported constant', () => {
    expect(LASTSEEN_MIN_MOVE_M).toBe(20)
  })
})
