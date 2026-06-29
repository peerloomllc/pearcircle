const { writerRewindStatus } = require('../src/lib/rewindGuard')

describe('writerRewindStatus', () => {
  test('not behind when local is at or ahead of the network', () => {
    expect(writerRewindStatus({ localLength: 100, networkLength: 100 }).behind).toBe(false)
    expect(writerRewindStatus({ localLength: 100, networkLength: 50 }).behind).toBe(false)
  })

  test('not behind when no peer is connected (networkLength 0)', () => {
    // No information that we are behind => authoritative, append allowed.
    expect(writerRewindStatus({ localLength: 100, networkLength: 0 }).behind).toBe(false)
  })

  test('behind when the network holds a longer copy of our own core (truncation)', () => {
    const s = writerRewindStatus({ localLength: 50, networkLength: 100 })
    expect(s.behind).toBe(true)
    expect(s.downloadFrom).toBe(50)
    expect(s.downloadTo).toBe(100)
  })

  test('downloads only the missing tail', () => {
    const s = writerRewindStatus({ localLength: 0, networkLength: 7 })
    expect(s).toEqual({ behind: true, downloadFrom: 0, downloadTo: 7 })
  })

  test('handles missing/garbage inputs as not-behind (fail open, never block appends spuriously)', () => {
    expect(writerRewindStatus({}).behind).toBe(false)
    expect(writerRewindStatus({ localLength: undefined, networkLength: undefined }).behind).toBe(false)
    expect(writerRewindStatus({ localLength: NaN, networkLength: 5 }).behind).toBe(true) // local treated as 0
  })
})
