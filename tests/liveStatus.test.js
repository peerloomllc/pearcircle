const { LIVE_THRESHOLD_MS, liveStatus } = require('../src/lib/liveStatus')

const NOW = 1_700_000_000_000

describe('LIVE_THRESHOLD_MS', () => {
  test('is 60 seconds', () => {
    expect(LIVE_THRESHOLD_MS).toBe(60_000)
  })
})

describe('liveStatus', () => {
  test('null/undefined ts returns null', () => {
    expect(liveStatus(undefined, false, NOW)).toBeNull()
    expect(liveStatus(null, false, NOW)).toBeNull()
    expect(liveStatus('not a number', false, NOW)).toBeNull()
  })

  test('fresh ts without stale flag is "live"', () => {
    expect(liveStatus(NOW - 1000, false, NOW)).toBe('live')
    expect(liveStatus(NOW - LIVE_THRESHOLD_MS + 1, false, NOW)).toBe('live')
  })

  test('fresh ts with stale=true is "reconnecting"', () => {
    expect(liveStatus(NOW - 1000, true, NOW)).toBe('reconnecting')
    expect(liveStatus(NOW - LIVE_THRESHOLD_MS + 1, true, NOW)).toBe('reconnecting')
  })

  test('stale ts is "old" regardless of stale flag', () => {
    expect(liveStatus(NOW - LIVE_THRESHOLD_MS - 1, false, NOW)).toBe('old')
    expect(liveStatus(NOW - LIVE_THRESHOLD_MS - 1, true, NOW)).toBe('old')
    expect(liveStatus(NOW - 24 * 60 * 60 * 1000, true, NOW)).toBe('old')
  })

  test('absent stale flag (undefined) treated as not stale', () => {
    expect(liveStatus(NOW - 1000, undefined, NOW)).toBe('live')
  })

  test('non-true stale values (string, number, null) treated as not stale', () => {
    // Defensive: only strict boolean true triggers reconnecting. An
    // old peer's serialization might surface odd values; default to
    // the safe "live" rendering rather than misclassifying.
    expect(liveStatus(NOW - 1000, null, NOW)).toBe('live')
    expect(liveStatus(NOW - 1000, 'true', NOW)).toBe('live')
    expect(liveStatus(NOW - 1000, 1, NOW)).toBe('live')
  })

  test('boundary: exactly at threshold is "old" (strict less-than)', () => {
    expect(liveStatus(NOW - LIVE_THRESHOLD_MS, false, NOW)).toBe('old')
  })

  test('custom threshold override', () => {
    const tightThreshold = 10_000
    expect(liveStatus(NOW - 5_000, false, NOW, tightThreshold)).toBe('live')
    expect(liveStatus(NOW - 15_000, false, NOW, tightThreshold)).toBe('old')
  })
})
