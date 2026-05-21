// Seeder revocation signal helpers — proposal 2026-05-21-seeder-revocation-signal.
// Pure-logic tests against an in-memory Hyperbee-shaped localDb.

const {
  revokedKey,
  revocationNoticeFor,
  recordRevocationNotice,
  clearRevocationNotice,
  loadRevokedCircles,
} = require('../src/lib/seederRevocation')

// Minimal Hyperbee-shaped mock backed by a sorted Map — same shape as
// tests/seederMode.test.js.
function makeFakeLocalDb () {
  const data = new Map()
  return {
    _data: data,
    async get (key) {
      if (!data.has(key)) return null
      return { value: data.get(key) }
    },
    async put (key, value) { data.set(key, value) },
    async del (key) { data.delete(key) },
    async *createReadStream ({ gt, lt } = {}) {
      const keys = Array.from(data.keys()).sort()
      for (const key of keys) {
        if (gt !== undefined && !(key > gt)) continue
        if (lt !== undefined && !(key < lt)) continue
        yield { key, value: data.get(key) }
      }
    },
  }
}

describe('revokedKey', () => {
  test('namespaces under seeder:revoked:', () => {
    expect(revokedKey('circle-1')).toBe('seeder:revoked:circle-1')
  })
})

describe('revocationNoticeFor (member side)', () => {
  test('builds a notice for a revoked seeder row', () => {
    const notice = revocationNoticeFor('c1', { revoked: true, revokedAt: 1700 })
    expect(notice).toEqual({ type: 'revoked', circleId: 'c1', revokedAt: 1700 })
  })

  test('revokedAt defaults to null when missing or non-numeric', () => {
    expect(revocationNoticeFor('c1', { revoked: true }).revokedAt).toBe(null)
    expect(revocationNoticeFor('c1', { revoked: true, revokedAt: 'soon' }).revokedAt).toBe(null)
  })

  test('returns null for a non-revoked seeder row', () => {
    expect(revocationNoticeFor('c1', { revoked: false })).toBe(null)
    expect(revocationNoticeFor('c1', { updatedAt: 5 })).toBe(null)
  })

  test('returns null when there is no row (peer is not a revoked seeder)', () => {
    expect(revocationNoticeFor('c1', null)).toBe(null)
    expect(revocationNoticeFor('c1', undefined)).toBe(null)
  })

  test('returns null for a malformed circleId', () => {
    expect(revocationNoticeFor('', { revoked: true })).toBe(null)
    expect(revocationNoticeFor(42, { revoked: true })).toBe(null)
  })

  test('treats only revoked === true as revoked, not any truthy value', () => {
    expect(revocationNoticeFor('c1', { revoked: 1 })).toBe(null)
    expect(revocationNoticeFor('c1', { revoked: 'true' })).toBe(null)
  })
})

describe('recordRevocationNotice (seeder side)', () => {
  test('writes seeder:revoked:{circleId} with revokedAt + noticedAt', async () => {
    const db = makeFakeLocalDb()
    const ok = await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1700, now: 9000 })
    expect(ok).toBe(true)
    expect(db._data.get('seeder:revoked:c1')).toEqual({ circleId: 'c1', revokedAt: 1700, noticedAt: 9000 })
  })

  test('stores revokedAt null when the notice carries no timestamp', async () => {
    const db = makeFakeLocalDb()
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: null, now: 9000 })
    expect(db._data.get('seeder:revoked:c1').revokedAt).toBe(null)
  })

  test('is idempotent — a repeat notice rewrites the row', async () => {
    const db = makeFakeLocalDb()
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1700, now: 9000 })
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1700, now: 9500 })
    expect(db._data.get('seeder:revoked:c1').noticedAt).toBe(9500)
  })

  test('rejects a malformed circleId without throwing or writing', async () => {
    const db = makeFakeLocalDb()
    expect(await recordRevocationNotice(db, { circleId: '', revokedAt: 1, now: 2 })).toBe(false)
    expect(await recordRevocationNotice(db, {})).toBe(false)
    expect(db._data.size).toBe(0)
  })
})

describe('clearRevocationNotice (re-admission, proposal question 4)', () => {
  test('deletes the revocation row', async () => {
    const db = makeFakeLocalDb()
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1, now: 2 })
    const ok = await clearRevocationNotice(db, 'c1')
    expect(ok).toBe(true)
    expect(db._data.has('seeder:revoked:c1')).toBe(false)
  })

  test('is a no-op on a circle with no revocation row', async () => {
    const db = makeFakeLocalDb()
    expect(await clearRevocationNotice(db, 'c1')).toBe(true)
  })

  test('rejects a malformed circleId', async () => {
    const db = makeFakeLocalDb()
    expect(await clearRevocationNotice(db, '')).toBe(false)
  })
})

describe('loadRevokedCircles', () => {
  test('returns an empty map when no rows exist', async () => {
    const map = await loadRevokedCircles(makeFakeLocalDb())
    expect(map.size).toBe(0)
  })

  test('returns every revoked circle keyed by circleId', async () => {
    const db = makeFakeLocalDb()
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1, now: 10 })
    await recordRevocationNotice(db, { circleId: 'c2', revokedAt: 2, now: 20 })
    const map = await loadRevokedCircles(db)
    expect([...map.keys()].sort()).toEqual(['c1', 'c2'])
    expect(map.get('c1')).toEqual({ circleId: 'c1', revokedAt: 1, noticedAt: 10 })
  })

  test('does not bleed into adjacent seeder: key prefixes', async () => {
    const db = makeFakeLocalDb()
    await recordRevocationNotice(db, { circleId: 'c1', revokedAt: 1, now: 10 })
    await db.put('seeder:enrolled:c1', { circleId: 'c1' })
    await db.put('seeder:retention:c1', { pruneOlderThan: 1000 })
    const map = await loadRevokedCircles(db)
    expect(map.size).toBe(1)
    expect(map.has('c1')).toBe(true)
  })
})
