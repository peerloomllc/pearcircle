const { shouldEmit, coverageSummary, DIAG_INTERVAL_MS } = require('../src/lib/lastKnownDiag')

const NOW = 1_750_000_000_000

describe('shouldEmit', () => {
  test('emits the first time it sees a member+event', () => {
    expect(shouldEmit(undefined, NOW)).toBe(true)
    expect(shouldEmit(null, NOW)).toBe(true)
  })

  test('throttles the ~3s snapshot poll down to once a minute', () => {
    expect(shouldEmit(NOW, NOW + 3_000)).toBe(false)
    expect(shouldEmit(NOW, NOW + DIAG_INTERVAL_MS - 1)).toBe(false)
    expect(shouldEmit(NOW, NOW + DIAG_INTERVAL_MS)).toBe(true)
  })

  test('a five-minute watch produces five lines per member, not a hundred', () => {
    let last
    let emitted = 0
    for (let t = 0; t < 5 * 60_000; t += 3_000) {
      if (shouldEmit(last, NOW + t)) { emitted++; last = NOW + t }
    }
    expect(emitted).toBe(5)
  })
})

describe('coverageSummary', () => {
  test('separates never-learned-the-length from tip-not-local', () => {
    // The two silent dead ends in pullPeerTip. Telling them apart is the whole
    // point: one means we never asked, the other means we asked and got nothing.
    const r = coverageSummary([
      { pubkey: 'a', length: 0, tipLocal: false, cachedTs: undefined },
      { pubkey: 'b', length: 12, tipLocal: false, cachedTs: undefined },
      { pubkey: 'c', length: 40, tipLocal: true, cachedTs: NOW - 1000 },
    ], NOW)
    expect(r).toEqual({ members: 3, noLength: 1, tipRemote: 1, cached: 1, stalestAgeMs: 1000 })
  })

  test('reports the stalest cached position, which is what the user complains about', () => {
    const fiveDays = 5 * 24 * 60 * 60 * 1000
    const r = coverageSummary([
      { pubkey: 'a', length: 5, tipLocal: true, cachedTs: NOW - 1000 },
      { pubkey: 'b', length: 5, tipLocal: true, cachedTs: NOW - fiveDays },
    ], NOW)
    expect(r.cached).toBe(2)
    expect(r.stalestAgeMs).toBe(fiveDays)
  })

  test('a healthy circle reports every member cached and no dead ends', () => {
    const r = coverageSummary([
      { pubkey: 'a', length: 5, tipLocal: true, cachedTs: NOW },
      { pubkey: 'b', length: 9, tipLocal: true, cachedTs: NOW },
    ], NOW)
    expect(r).toEqual({ members: 2, noLength: 0, tipRemote: 0, cached: 2, stalestAgeMs: 0 })
  })

  test('nothing cached yet leaves the stalest age null rather than zero', () => {
    // Zero would read as "perfectly fresh", which is the opposite of the truth.
    expect(coverageSummary([{ pubkey: 'a', length: 0, tipLocal: false }], NOW).stalestAgeMs).toBeNull()
  })

  test('survives an empty or junk member list', () => {
    expect(coverageSummary([], NOW).members).toBe(0)
    expect(coverageSummary(null, NOW).members).toBe(0)
    expect(coverageSummary([null, undefined], NOW).members).toBe(0)
  })
})
