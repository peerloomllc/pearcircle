const { seederSeenKey, shouldPersistSeederContact, summarizeSeederCircles } = require('../src/lib/seederContact')

// Found 2026-07-27 on the live Hudgins circle: the Seeders screen listed three
// seeders against the circle when only one actually had it. The admission row a
// device writes at circle:create for every followed seeder was being rendered as
// evidence of coverage. These tests pin the distinction that fixes it - admitted
// is not held, and only a check-in proves held.

describe('seederSeenKey', () => {
  test('keys per (circle, seeder) pair, not per seeder', () => {
    expect(seederSeenKey('circleA', 'pub1')).toBe('circleA:pub1')
    expect(seederSeenKey('circleA', 'pub1')).not.toBe(seederSeenKey('circleB', 'pub1'))
  })
})

describe('shouldPersistSeederContact', () => {
  test('persists the first contact', () => {
    expect(shouldPersistSeederContact(undefined, 1000, 60000)).toBe(true)
    expect(shouldPersistSeederContact(null, 1000, 60000)).toBe(true)
  })

  test('throttles repeat contacts inside the window', () => {
    expect(shouldPersistSeederContact(1000, 30000, 60000)).toBe(false)
  })

  test('persists again once the window has passed', () => {
    expect(shouldPersistSeederContact(1000, 61000, 60000)).toBe(true)
    expect(shouldPersistSeederContact(1000, 999999, 60000)).toBe(true)
  })
})

describe('summarizeSeederCircles', () => {
  test('a seeder admitted but never heard from holds nothing', () => {
    // This is the exact shape of the bug: an admission row exists, so the old
    // code rendered "Seeding 1 circle". It has never checked in.
    const s = summarizeSeederCircles([
      { circleId: 'c1', name: 'Hudgins', revoked: false, lastSeenAt: null },
    ])
    expect(s.held).toEqual([])
    expect(s.unconfirmed).toHaveLength(1)
    expect(s.lastSeenAt).toBeNull()
  })

  test('splits held from unconfirmed on the same seeder', () => {
    const s = summarizeSeederCircles([
      { circleId: 'c1', name: 'Hudgins', revoked: false, lastSeenAt: 5000 },
      { circleId: 'c2', name: 'ABFG', revoked: false, lastSeenAt: null },
    ])
    expect(s.held.map((c) => c.name)).toEqual(['Hudgins'])
    expect(s.unconfirmed.map((c) => c.name)).toEqual(['ABFG'])
  })

  test('reports the most recent contact across circles', () => {
    const s = summarizeSeederCircles([
      { circleId: 'c1', revoked: false, lastSeenAt: 5000 },
      { circleId: 'c2', revoked: false, lastSeenAt: 9000 },
      { circleId: 'c3', revoked: false, lastSeenAt: null },
    ])
    expect(s.lastSeenAt).toBe(9000)
  })

  test('revoked circles are separated and never counted as held', () => {
    const s = summarizeSeederCircles([
      { circleId: 'c1', revoked: true, lastSeenAt: 5000 },
      { circleId: 'c2', revoked: false, lastSeenAt: 7000 },
    ])
    expect(s.revoked).toHaveLength(1)
    expect(s.held.map((c) => c.circleId)).toEqual(['c2'])
    expect(s.lastSeenAt).toBe(7000)
  })

  test('a malformed or missing stamp counts as unconfirmed, never as held', () => {
    // Conservative on purpose: over-reporting coverage is the failure this
    // exists to prevent, so anything unknown must not render as held.
    const s = summarizeSeederCircles([
      { circleId: 'c1', revoked: false },
      { circleId: 'c2', revoked: false, lastSeenAt: 'soon' },
      { circleId: 'c3', revoked: false, lastSeenAt: undefined },
    ])
    expect(s.held).toEqual([])
    expect(s.unconfirmed).toHaveLength(3)
    expect(s.lastSeenAt).toBeNull()
  })

  test('tolerates junk input', () => {
    expect(summarizeSeederCircles(null).live).toEqual([])
    expect(summarizeSeederCircles(undefined).lastSeenAt).toBeNull()
    expect(summarizeSeederCircles([null, undefined]).live).toEqual([])
  })
})
