const { TRIP_RETENTION_MS, MAX_TRIPS_PER_MEMBER, tripIsExpired } = require('../src/lib/tripRetention')

const DAY_MS = 24 * 60 * 60 * 1000

describe('TRIP_RETENTION_MS', () => {
  test('is 7 days', () => {
    expect(TRIP_RETENTION_MS).toBe(7 * DAY_MS)
  })
})

describe('MAX_TRIPS_PER_MEMBER', () => {
  test('is 20', () => {
    expect(MAX_TRIPS_PER_MEMBER).toBe(20)
  })
})

describe('tripIsExpired', () => {
  const now = 1_700_000_000_000

  test('trip ending one second ago is fresh', () => {
    expect(tripIsExpired({ endTs: now - 1000 }, now)).toBe(false)
  })

  test('trip ending exactly at retention edge is fresh (strict greater-than)', () => {
    expect(tripIsExpired({ endTs: now - TRIP_RETENTION_MS }, now)).toBe(false)
  })

  test('trip ending one ms past retention is expired', () => {
    expect(tripIsExpired({ endTs: now - TRIP_RETENTION_MS - 1 }, now)).toBe(true)
  })

  test('falls back to startTs when endTs is missing', () => {
    expect(tripIsExpired({ startTs: now - TRIP_RETENTION_MS - 1 }, now)).toBe(true)
    expect(tripIsExpired({ startTs: now - 1000 }, now)).toBe(false)
  })

  test('prefers endTs over startTs when both present', () => {
    // startTs old, endTs fresh -> not expired (active long trip)
    expect(tripIsExpired({ startTs: now - TRIP_RETENTION_MS - DAY_MS, endTs: now - DAY_MS }, now)).toBe(false)
    // startTs fresh, endTs old -> expired (somehow; defensive)
    expect(tripIsExpired({ startTs: now - DAY_MS, endTs: now - TRIP_RETENTION_MS - 1 }, now)).toBe(true)
  })

  test('non-numeric timestamps -> not expired (keep malformed over delete)', () => {
    expect(tripIsExpired({}, now)).toBe(false)
    expect(tripIsExpired({ endTs: null }, now)).toBe(false)
    expect(tripIsExpired({ endTs: 'yesterday' }, now)).toBe(false)
    expect(tripIsExpired(null, now)).toBe(false)
    expect(tripIsExpired(undefined, now)).toBe(false)
  })

  test('non-numeric now -> not expired', () => {
    expect(tripIsExpired({ endTs: 0 }, NaN)).toBe(false)
    expect(tripIsExpired({ endTs: 0 }, null)).toBe(false)
  })

  test('tombstone records (deleted: true) follow the same rule', () => {
    expect(tripIsExpired({ endTs: now - TRIP_RETENTION_MS - 1, deleted: true }, now)).toBe(true)
    expect(tripIsExpired({ endTs: now - DAY_MS, deleted: true }, now)).toBe(false)
  })

  test('custom retentionMs override', () => {
    const week = 7 * DAY_MS
    expect(tripIsExpired({ endTs: now - week - 1 }, now, week)).toBe(true)
    expect(tripIsExpired({ endTs: now - week + 1 }, now, week)).toBe(false)
  })
})
