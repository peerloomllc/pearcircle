// Seeder retention helpers. Proposal 2026-05-19-blind-seeder-peers slice 5.
// Pure tests against the same in-memory Hyperbee mock pattern used by
// tests/seederMode.test.js. The actual hypercore clear + scheduling
// happen at the wiring layer in bare.js and aren't exercised here.

const {
  blockTimeKey,
  recordBlockReceived,
  removeBlockTracking,
  pickStaleBlocks,
  runSeederRetentionSweep,
} = require('../src/lib/seederRetention')

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

describe('blockTimeKey', () => {
  test('pads sequences to 13 digits for lexicographic order', () => {
    expect(blockTimeKey('cid', 0)).toBe('seeder:blockTime:cid:0000000000000')
    expect(blockTimeKey('cid', 42)).toBe('seeder:blockTime:cid:0000000000042')
    expect(blockTimeKey('cid', 9999999999999)).toBe('seeder:blockTime:cid:9999999999999')
  })

  test('keys sort chronologically by sequence in a hyperbee scan', () => {
    const a = blockTimeKey('cid', 1)
    const b = blockTimeKey('cid', 10)
    const c = blockTimeKey('cid', 100)
    expect([c, a, b].sort()).toEqual([a, b, c])
  })
})

describe('recordBlockReceived', () => {
  test('writes the sidecar row for valid input', async () => {
    const db = makeFakeLocalDb()
    const ok = await recordBlockReceived(db, 'cid', 5, 12345)
    expect(ok).toBe(true)
    const row = db._data.get('seeder:blockTime:cid:0000000000005')
    expect(row).toEqual({ seq: 5, receivedAt: 12345 })
  })

  test('rejects malformed circleId', async () => {
    const db = makeFakeLocalDb()
    expect(await recordBlockReceived(db, '', 5, 1)).toBe(false)
    expect(await recordBlockReceived(db, null, 5, 1)).toBe(false)
  })

  test('rejects negative or non-finite seq', async () => {
    const db = makeFakeLocalDb()
    expect(await recordBlockReceived(db, 'cid', -1, 1)).toBe(false)
    expect(await recordBlockReceived(db, 'cid', NaN, 1)).toBe(false)
    expect(await recordBlockReceived(db, 'cid', 'not a number', 1)).toBe(false)
  })

  test('rejects non-finite receivedAt', async () => {
    const db = makeFakeLocalDb()
    expect(await recordBlockReceived(db, 'cid', 5, NaN)).toBe(false)
    expect(await recordBlockReceived(db, 'cid', 5, Infinity)).toBe(false)
  })
})

describe('removeBlockTracking', () => {
  test('deletes the sidecar row', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'cid', 5, 12345)
    expect(db._data.size).toBe(1)
    await removeBlockTracking(db, 'cid', 5)
    expect(db._data.size).toBe(0)
  })

  test('is idempotent on missing rows', async () => {
    const db = makeFakeLocalDb()
    const ok = await removeBlockTracking(db, 'cid', 99)
    expect(ok).toBe(true)
  })
})

describe('pickStaleBlocks', () => {
  test('returns empty when no rows exist', async () => {
    const db = makeFakeLocalDb()
    const stale = await pickStaleBlocks(db, 'cid', 100, 10)
    expect(stale).toEqual([])
  })

  test('returns empty when pruneOlderThan is null', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'cid', 1, 0)  // very old
    expect(await pickStaleBlocks(db, 'cid', 1000, null)).toEqual([])
    expect(await pickStaleBlocks(db, 'cid', 1000, undefined)).toEqual([])
    expect(await pickStaleBlocks(db, 'cid', 1000, 0)).toEqual([])
    expect(await pickStaleBlocks(db, 'cid', 1000, -100)).toEqual([])
  })

  test('returns seqs older than (now - pruneOlderThan)', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'cid', 1, 100)   // old
    await recordBlockReceived(db, 'cid', 2, 500)   // old
    await recordBlockReceived(db, 'cid', 3, 950)   // fresh
    await recordBlockReceived(db, 'cid', 4, 980)   // fresh
    // now=1000, pruneOlderThan=100, cutoff=900. Anything before 900 is stale.
    const stale = await pickStaleBlocks(db, 'cid', 1000, 100)
    expect(stale.sort((a, b) => a - b)).toEqual([1, 2])
  })

  test('treats boundary (receivedAt === cutoff) as fresh', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'cid', 1, 900)
    // now=1000, pruneOlderThan=100, cutoff=900. receivedAt 900 is NOT < 900 → fresh.
    expect(await pickStaleBlocks(db, 'cid', 1000, 100)).toEqual([])
  })

  test('only scans the target circle', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'c1', 1, 0)
    await recordBlockReceived(db, 'c2', 2, 0)
    const stale = await pickStaleBlocks(db, 'c1', 1000, 100)
    expect(stale).toEqual([1])
  })
})

describe('runSeederRetentionSweep', () => {
  test('skips circles with no retention configured', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'c1', 1, 0)
    const cleared = []
    const result = await runSeederRetentionSweep({
      localDb: db,
      enrolledCircles: ['c1'],
      getRetentionMs: async () => null,
      clearBlock: async (cid, seq) => cleared.push([cid, seq]),
      now: 1000,
    })
    expect(result.cleared).toBe(0)
    expect(cleared).toEqual([])
  })

  test('calls clearBlock for each stale seq in each configured circle', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'c1', 1, 0)   // stale
    await recordBlockReceived(db, 'c1', 2, 500) // stale
    await recordBlockReceived(db, 'c1', 3, 950) // fresh
    await recordBlockReceived(db, 'c2', 1, 50)  // stale (different circle)
    const cleared = []
    const result = await runSeederRetentionSweep({
      localDb: db,
      enrolledCircles: ['c1', 'c2'],
      getRetentionMs: async (cid) => cid === 'c1' ? 100 : 200,
      clearBlock: async (cid, seq) => cleared.push([cid, seq]),
      now: 1000,
    })
    expect(result.cleared).toBe(3)
    expect(cleared.sort()).toEqual([['c1', 1], ['c1', 2], ['c2', 1]])
  })

  test('counts errors when clearBlock throws but keeps going', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'c1', 1, 0)
    await recordBlockReceived(db, 'c1', 2, 0)
    const cleared = []
    const result = await runSeederRetentionSweep({
      localDb: db,
      enrolledCircles: ['c1'],
      getRetentionMs: async () => 100,
      clearBlock: async (cid, seq) => {
        if (seq === 1) throw new Error('hypercore unavailable')
        cleared.push([cid, seq])
      },
      now: 1000,
    })
    expect(result.errors).toBe(1)
    expect(result.cleared).toBe(1)
    expect(cleared).toEqual([['c1', 2]])
  })

  test('counts errors when getRetentionMs throws and skips that circle', async () => {
    const db = makeFakeLocalDb()
    await recordBlockReceived(db, 'c1', 1, 0)
    await recordBlockReceived(db, 'c2', 1, 0)
    const cleared = []
    const result = await runSeederRetentionSweep({
      localDb: db,
      enrolledCircles: ['c1', 'c2'],
      getRetentionMs: async (cid) => {
        if (cid === 'c1') throw new Error('localDb closed')
        return 100
      },
      clearBlock: async (cid, seq) => cleared.push([cid, seq]),
      now: 1000,
    })
    expect(result.errors).toBe(1)
    expect(cleared).toEqual([['c2', 1]])
  })
})
