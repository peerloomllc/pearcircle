const { TRANSITION_RETENTION_MS, transitionIsExpired } = require('../src/lib/transitionRetention')

const DAY_MS = 24 * 60 * 60 * 1000

describe('TRANSITION_RETENTION_MS', () => {
  test('is 90 days', () => {
    expect(TRANSITION_RETENTION_MS).toBe(90 * DAY_MS)
  })
})

describe('transitionIsExpired', () => {
  const now = 1_700_000_000_000

  test('transition one second ago is fresh', () => {
    expect(transitionIsExpired({ ts: now - 1000 }, now)).toBe(false)
  })

  test('transition exactly at retention edge is fresh (strict greater-than)', () => {
    expect(transitionIsExpired({ ts: now - TRANSITION_RETENTION_MS }, now)).toBe(false)
  })

  test('transition one ms past retention is expired', () => {
    expect(transitionIsExpired({ ts: now - TRANSITION_RETENTION_MS - 1 }, now)).toBe(true)
  })

  test('non-numeric ts -> not expired (keep malformed over delete)', () => {
    expect(transitionIsExpired({}, now)).toBe(false)
    expect(transitionIsExpired({ ts: null }, now)).toBe(false)
    expect(transitionIsExpired({ ts: 'yesterday' }, now)).toBe(false)
    expect(transitionIsExpired({ ts: NaN }, now)).toBe(false)
    expect(transitionIsExpired(null, now)).toBe(false)
    expect(transitionIsExpired(undefined, now)).toBe(false)
  })

  test('non-numeric now -> not expired', () => {
    expect(transitionIsExpired({ ts: 0 }, NaN)).toBe(false)
    expect(transitionIsExpired({ ts: 0 }, null)).toBe(false)
  })

  test('custom retentionMs override', () => {
    const week = 7 * DAY_MS
    expect(transitionIsExpired({ ts: now - week - 1 }, now, week)).toBe(true)
    expect(transitionIsExpired({ ts: now - week + 1 }, now, week)).toBe(false)
  })
})
