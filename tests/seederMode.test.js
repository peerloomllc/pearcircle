// Seeder-mode primitives — proposal 2026-05-19-blind-seeder-peers slice 2.
// Pure-logic tests against an in-memory Hyperbee-shaped localDb. Network
// and Autobase wiring land in slice 3, so admission and replication are
// not exercised here.

const b4a = require('b4a')
const {
  SEED_METHODS,
  detectSeedMode,
  loadOrCreateSeederIdentity,
  enrollSeedInvite,
  createSeederHandlers,
} = require('../src/seeder')

// Minimal Hyperbee-shaped mock backed by a sorted Map. Captures the
// subset of the API the seeder module touches.
function makeFakeLocalDb () {
  const data = new Map()
  return {
    _data: data,
    async get (key) {
      if (!data.has(key)) return null
      return { value: data.get(key) }
    },
    async put (key, value) {
      data.set(key, value)
    },
    async del (key) {
      data.delete(key)
    },
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

describe('SEED_METHODS', () => {
  test('lists the slice-2 IPC surface', () => {
    expect(SEED_METHODS).toEqual([
      'seeder:status',
      'seeder:enroll',
      'seeder:enrolled:list',
      'seeder:leave',
      'seeder:retention:get',
      'seeder:retention:set',
      'seeder:retention:sweep',
      'seeder:pair:open',
      'seeder:pair:close',
    ])
  })

  test('is frozen so callers cannot mutate the contract', () => {
    expect(Object.isFrozen(SEED_METHODS)).toBe(true)
  })
})

describe('detectSeedMode', () => {
  test('argv with --seed returns true', () => {
    expect(detectSeedMode(['bare', 'bare.js', '--seed'])).toBe(true)
  })

  test('argv without --seed returns false', () => {
    expect(detectSeedMode(['bare', 'bare.js'])).toBe(false)
  })

  test('options.mode = "seed" returns true', () => {
    expect(detectSeedMode({ mode: 'seed' })).toBe(true)
  })

  test('options.mode = "member" returns false', () => {
    expect(detectSeedMode({ mode: 'member' })).toBe(false)
  })

  test('options without mode returns false', () => {
    expect(detectSeedMode({})).toBe(false)
  })

  test('null / undefined returns false', () => {
    expect(detectSeedMode(null)).toBe(false)
    expect(detectSeedMode(undefined)).toBe(false)
  })

  test('non-array, non-object input returns false', () => {
    expect(detectSeedMode('seed')).toBe(false)
    expect(detectSeedMode(42)).toBe(false)
  })
})

describe('loadOrCreateSeederIdentity', () => {
  test('first call generates a fresh keypair and persists it', async () => {
    const db = makeFakeLocalDb()
    const id = await loadOrCreateSeederIdentity(db)
    expect(id.fresh).toBe(true)
    expect(Buffer.isBuffer(id.publicKey)).toBe(true)
    expect(id.publicKey.length).toBe(32)
    expect(id.secretKey.length).toBe(64)
    const row = db._data.get('identity:seeder')
    expect(typeof row.publicKey).toBe('string')
    expect(row.publicKey).toBe(b4a.toString(id.publicKey, 'hex'))
    expect(typeof row.createdAt).toBe('number')
  })

  test('second call reuses the persisted identity', async () => {
    const db = makeFakeLocalDb()
    const first = await loadOrCreateSeederIdentity(db)
    const second = await loadOrCreateSeederIdentity(db)
    expect(second.fresh).toBe(false)
    expect(b4a.toString(second.publicKey, 'hex')).toBe(b4a.toString(first.publicKey, 'hex'))
    expect(b4a.toString(second.secretKey, 'hex')).toBe(b4a.toString(first.secretKey, 'hex'))
  })

  test('identity is stored under identity:seeder, not identity', async () => {
    const db = makeFakeLocalDb()
    await loadOrCreateSeederIdentity(db)
    expect(db._data.has('identity:seeder')).toBe(true)
    expect(db._data.has('identity')).toBe(false)
  })
})

describe('createSeederHandlers', () => {
  function makeHandlers (db, identityOverride) {
    const identity = identityOverride ?? {
      publicKey: b4a.from('a'.repeat(64), 'hex'),
      secretKey: b4a.from('b'.repeat(128), 'hex'),
    }
    return createSeederHandlers({ localDb: db, identity, bootTs: 1000 })
  }

  describe('seeder:status', () => {
    test('returns the seeder pubkey hex and uptime', async () => {
      const db = makeFakeLocalDb()
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:status']()
      expect(result.pubkey).toBe('a'.repeat(64))
      expect(typeof result.uptime).toBe('number')
      expect(result.uptime).toBeGreaterThanOrEqual(0)
      expect(result.totalBytesReplicated).toBe(0)
    })

    // Proposal 2026-06-05-seeder-update slice 1: the launcher stamps a build
    // version into init; seeder:status echoes it (null when run without one).
    test('echoes the build version when given, null otherwise', async () => {
      const db = makeFakeLocalDb()
      const identity = { publicKey: b4a.from('a'.repeat(64), 'hex'), secretKey: b4a.from('b'.repeat(128), 'hex') }
      const withV = createSeederHandlers({ localDb: db, identity, bootTs: 1000, version: '1.2.3' })
      expect((await withV['seeder:status']()).version).toBe('1.2.3')
      const without = createSeederHandlers({ localDb: db, identity, bootTs: 1000 })
      expect((await without['seeder:status']()).version).toBeNull()
    })
  })

  describe('seeder:enroll', () => {
    const VALID_SEED_INVITE = (() => {
      const { buildSeedInvite } = require('../src/invite')
      return buildSeedInvite({
        circleId: 'A'.repeat(43),
        name: 'Smith Family',
        circleKey: 'a'.repeat(64),
        bootstrap: 'c'.repeat(64),
        inviterPublicKey: 'b'.repeat(64),
      })
    })()
    const VALID_MEMBER_INVITE = (() => {
      const { buildInvite } = require('../src/invite')
      return buildInvite({
        circleId: 'A'.repeat(43),
        name: 'Smith Family',
        circleKey: 'a'.repeat(64),
        bootstrap: 'c'.repeat(64),
        inviterPublicKey: 'b'.repeat(64),
      })
    })()

    test('rejects non-string invite', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:enroll']({})).rejects.toThrow(/invite/)
      await expect(handlers['seeder:enroll']({ invite: 42 })).rejects.toThrow(/invite/)
    })

    test('rejects empty-string invite', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:enroll']({ invite: '' })).rejects.toThrow(/invite/)
    })

    test('rejects /circle/join member-shape invite (would leak encryption key)', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:enroll']({ invite: VALID_MEMBER_INVITE })).rejects.toThrow(/seed invite/)
    })

    test('rejects malformed seed invite URL', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:enroll']({ invite: 'https://not-a-pearcircle-host/foo' })).rejects.toThrow(/seed invite/)
    })

    test('persists the enrollment row on a valid invite', async () => {
      const db = makeFakeLocalDb()
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })
      expect(result.ok).toBe(true)
      expect(result.circleId).toBe('A'.repeat(43))
      expect(result.name).toBe('Smith Family')
      expect(result.inviter).toBe('b'.repeat(64))
      expect(result.alreadyEnrolled).toBe(false)
      const row = db._data.get('seeder:enrolled:' + 'A'.repeat(43))
      expect(row.circleId).toBe('A'.repeat(43))
      expect(row.circleKey).toBe('a'.repeat(64))
      expect(row.bootstrap).toBe('c'.repeat(64))
      expect(row.inviter).toBe('b'.repeat(64))
      expect(typeof row.enrolledAt).toBe('number')
    })

    test('fires mountCircle after persistence with the enrollment row', async () => {
      const db = makeFakeLocalDb()
      const calls = []
      const mountCircle = async (row) => { calls.push(row) }
      const identity = {
        publicKey: b4a.from('a'.repeat(64), 'hex'),
        secretKey: b4a.from('b'.repeat(128), 'hex'),
      }
      const handlers = createSeederHandlers({ localDb: db, identity, bootTs: 1000, mountCircle })
      await handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })
      expect(calls.length).toBe(1)
      expect(calls[0].circleId).toBe('A'.repeat(43))
      expect(calls[0].bootstrap).toBe('c'.repeat(64))
    })

    test('rolls back persistence when mountCircle throws', async () => {
      const db = makeFakeLocalDb()
      const identity = {
        publicKey: b4a.from('a'.repeat(64), 'hex'),
        secretKey: b4a.from('b'.repeat(128), 'hex'),
      }
      const mountCircle = async () => { throw new Error('hyperswarm fail') }
      const handlers = createSeederHandlers({ localDb: db, identity, bootTs: 1000, mountCircle })
      await expect(handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })).rejects.toThrow(/seeder mount failed/)
      expect(db._data.has('seeder:enrolled:' + 'A'.repeat(43))).toBe(false)
    })

    test('is idempotent on repeat enroll for the same circleId', async () => {
      const db = makeFakeLocalDb()
      const calls = []
      const mountCircle = async (row) => { calls.push(row) }
      const identity = {
        publicKey: b4a.from('a'.repeat(64), 'hex'),
        secretKey: b4a.from('b'.repeat(128), 'hex'),
      }
      const handlers = createSeederHandlers({ localDb: db, identity, bootTs: 1000, mountCircle })
      await handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })
      const second = await handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })
      expect(second.alreadyEnrolled).toBe(true)
      // mountCircle was only called once — the second enroll short-circuited
      expect(calls.length).toBe(1)
    })

    test('survives when mountCircle dep is absent', async () => {
      const db = makeFakeLocalDb()
      const handlers = makeHandlers(db)  // no mountCircle dep
      const result = await handlers['seeder:enroll']({ invite: VALID_SEED_INVITE })
      expect(result.ok).toBe(true)
      expect(db._data.has('seeder:enrolled:' + 'A'.repeat(43))).toBe(true)
    })
  })

  describe('seeder:enrolled:list', () => {
    test('returns empty list when no enrollments', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      const result = await handlers['seeder:enrolled:list']()
      expect(result).toEqual({ circles: [] })
    })

    test('returns rows in sorted order', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c-charlie', { circleId: 'c-charlie', name: 'Charlie', inviter: 'aaa', enrolledAt: 3 })
      await db.put('seeder:enrolled:a-alpha', { circleId: 'a-alpha', name: 'Alpha', inviter: 'bbb', enrolledAt: 1 })
      await db.put('seeder:enrolled:b-bravo', { circleId: 'b-bravo', name: 'Bravo', inviter: 'ccc', enrolledAt: 2 })
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:enrolled:list']()
      expect(result.circles.map((c) => c.circleId)).toEqual(['a-alpha', 'b-bravo', 'c-charlie'])
      expect(result.circles[0].name).toBe('Alpha')
    })

    test('skips malformed rows (no circleId)', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:good', { circleId: 'good' })
      await db.put('seeder:enrolled:bad', { somethingElse: true })
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:enrolled:list']()
      expect(result.circles.length).toBe(1)
      expect(result.circles[0].circleId).toBe('good')
    })

    test('does not bleed into unrelated key prefixes', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      await db.put('seeder:retention:c1', { pruneOlderThan: 1000 })
      await db.put('identity:seeder', { publicKey: 'x' })
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:enrolled:list']()
      expect(result.circles.length).toBe(1)
      expect(result.circles[0].circleId).toBe('c1')
    })

    // Revocation join — proposal 2026-05-21-seeder-revocation-signal.
    test('flags a circle that has a seeder:revoked row', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1', name: 'One', enrolledAt: 1 })
      await db.put('seeder:enrolled:c2', { circleId: 'c2', name: 'Two', enrolledAt: 2 })
      await db.put('seeder:revoked:c1', { circleId: 'c1', revokedAt: 1700, noticedAt: 1800 })
      const handlers = makeHandlers(db)
      const { circles } = await handlers['seeder:enrolled:list']()
      const c1 = circles.find((c) => c.circleId === 'c1')
      const c2 = circles.find((c) => c.circleId === 'c2')
      expect(c1.revoked).toBe(true)
      expect(c1.revokedAt).toBe(1700)
      expect(c2.revoked).toBe(false)
      expect(c2.revokedAt).toBe(null)
    })

    test('revoked defaults to false when no revoked row exists', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      const handlers = makeHandlers(db)
      const { circles } = await handlers['seeder:enrolled:list']()
      expect(circles[0].revoked).toBe(false)
      expect(circles[0].revokedAt).toBe(null)
    })

    test('revokedAt is null when the revoked row carries no timestamp', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      await db.put('seeder:revoked:c1', { circleId: 'c1', revokedAt: null, noticedAt: 5 })
      const handlers = makeHandlers(db)
      const { circles } = await handlers['seeder:enrolled:list']()
      expect(circles[0].revoked).toBe(true)
      expect(circles[0].revokedAt).toBe(null)
    })
  })

  describe('seeder:leave', () => {
    test('rejects non-string circleId', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:leave']({})).rejects.toThrow(/circleId/)
    })

    test('deletes both enrollment and retention rows', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      await db.put('seeder:retention:c1', { pruneOlderThan: 1000 })
      const handlers = makeHandlers(db)
      const result = await handlers['seeder:leave']({ circleId: 'c1' })
      expect(result.ok).toBe(true)
      expect(result.circleId).toBe('c1')
      expect(db._data.has('seeder:enrolled:c1')).toBe(false)
      expect(db._data.has('seeder:retention:c1')).toBe(false)
    })

    test('is idempotent on a circleId we never enrolled in', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      const result = await handlers['seeder:leave']({ circleId: 'unknown' })
      expect(result.ok).toBe(true)
    })

    test('fires leaveCircle dep before deleting persistence rows', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      let snapshotAtLeaveTime = null
      const leaveCircle = async (cid) => {
        // Capture the row state at leave time — must still be present so
        // the host can read enrollment data while tearing down the swarm.
        snapshotAtLeaveTime = db._data.has('seeder:enrolled:' + cid)
      }
      const identity = {
        publicKey: b4a.from('a'.repeat(64), 'hex'),
        secretKey: b4a.from('b'.repeat(128), 'hex'),
      }
      const handlers = createSeederHandlers({ localDb: db, identity, bootTs: 1000, leaveCircle })
      await handlers['seeder:leave']({ circleId: 'c1' })
      expect(snapshotAtLeaveTime).toBe(true)
      expect(db._data.has('seeder:enrolled:c1')).toBe(false)
    })

    test('still deletes persistence when leaveCircle throws', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      const leaveCircle = async () => { throw new Error('teardown failed') }
      const identity = {
        publicKey: b4a.from('a'.repeat(64), 'hex'),
        secretKey: b4a.from('b'.repeat(128), 'hex'),
      }
      const handlers = createSeederHandlers({ localDb: db, identity, bootTs: 1000, leaveCircle })
      const result = await handlers['seeder:leave']({ circleId: 'c1' })
      expect(result.ok).toBe(true)
      expect(db._data.has('seeder:enrolled:c1')).toBe(false)
    })

    // Proposal 2026-05-21: leaving clears the revocation row so a later
    // re-enroll of the same circle does not surface a stale badge.
    test('also deletes the seeder:revoked row', async () => {
      const db = makeFakeLocalDb()
      await db.put('seeder:enrolled:c1', { circleId: 'c1' })
      await db.put('seeder:revoked:c1', { circleId: 'c1', revokedAt: 1, noticedAt: 2 })
      const handlers = makeHandlers(db)
      await handlers['seeder:leave']({ circleId: 'c1' })
      expect(db._data.has('seeder:revoked:c1')).toBe(false)
    })
  })

  describe('seeder:retention:get / set', () => {
    test('get returns null for circles without a row', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      const result = await handlers['seeder:retention:get']({ circleId: 'c1' })
      expect(result.pruneOlderThan).toBe(null)
    })

    test('set then get round-trips a numeric ms value', async () => {
      const db = makeFakeLocalDb()
      const handlers = makeHandlers(db)
      await handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: 86_400_000 })
      const result = await handlers['seeder:retention:get']({ circleId: 'c1' })
      expect(result.pruneOlderThan).toBe(86_400_000)
    })

    test('set with null clears the row', async () => {
      const db = makeFakeLocalDb()
      const handlers = makeHandlers(db)
      await handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: 1000 })
      await handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: null })
      expect(db._data.has('seeder:retention:c1')).toBe(false)
      const result = await handlers['seeder:retention:get']({ circleId: 'c1' })
      expect(result.pruneOlderThan).toBe(null)
    })

    test('rejects negative pruneOlderThan', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: -1 }))
        .rejects.toThrow(/pruneOlderThan/)
    })

    test('rejects non-numeric pruneOlderThan', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: '1000' }))
        .rejects.toThrow(/pruneOlderThan/)
    })

    test('rejects Infinity / NaN', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: Infinity }))
        .rejects.toThrow(/pruneOlderThan/)
      await expect(handlers['seeder:retention:set']({ circleId: 'c1', pruneOlderThan: NaN }))
        .rejects.toThrow(/pruneOlderThan/)
    })

    test('rejects non-string circleId on both get and set', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:retention:get']({})).rejects.toThrow(/circleId/)
      await expect(handlers['seeder:retention:set']({ pruneOlderThan: 1000 })).rejects.toThrow(/circleId/)
    })
  })

  describe('seeder:retention:sweep', () => {
    test('runs the injected sweeps and returns their counts', async () => {
      let ran = 0
      const handlers = createSeederHandlers({
        localDb: makeFakeLocalDb(),
        identity: { publicKey: b4a.from('a'.repeat(64), 'hex'), secretKey: b4a.from('b'.repeat(128), 'hex') },
        bootTs: 1000,
        runRetentionSweeps: async () => {
          ran++
          return { bootstrap: { circles: 1, cleared: 3, errors: 0 }, writer: { cores: 1, cleared: 7, errors: 0 } }
        },
      })
      const r = await handlers['seeder:retention:sweep']()
      expect(ran).toBe(1)
      expect(r).toEqual({ ok: true, bootstrap: { circles: 1, cleared: 3, errors: 0 }, writer: { cores: 1, cleared: 7, errors: 0 } })
    })

    test('throws when no sweep runner is wired (e.g. a unit-test context)', async () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      await expect(handlers['seeder:retention:sweep']()).rejects.toThrow(/unavailable/)
    })
  })

  describe('handler map shape', () => {
    test('exposes exactly the SEED_METHODS surface', () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      const keys = Object.keys(handlers).sort()
      expect(keys).toEqual([...SEED_METHODS].sort())
    })

    test('does not expose member-mode methods', () => {
      const handlers = makeHandlers(makeFakeLocalDb())
      expect(handlers['circle:create']).toBeUndefined()
      expect(handlers['circle:join']).toBeUndefined()
      expect(handlers['lastSeen:write']).toBeUndefined()
      expect(handlers['ping']).toBeUndefined()
    })
  })
})

// enrollSeedInvite is the shared enroll primitive. The seeder:enroll IPC
// (tested above) delegates to it; the seeder-sync channel's auto-follow
// path calls it directly. These cover the direct-call contract.
// Proposal amendment 2026-05-20 (blind-seeder auto-follow).
describe('enrollSeedInvite (direct call)', () => {
  const { buildSeedInvite } = require('../src/invite')
  const seedInvite = (circleId) => buildSeedInvite({
    circleId,
    name: 'Auto Circle',
    circleKey: 'a'.repeat(64),
    bootstrap: 'c'.repeat(64),
    inviterPublicKey: 'b'.repeat(64),
  })

  test('enrolls a fresh invite and persists the row', async () => {
    const db = makeFakeLocalDb()
    const mounted = []
    const r = await enrollSeedInvite({
      invite: seedInvite('A'.repeat(43)),
      localDb: db,
      mountCircle: async (row) => { mounted.push(row) },
    })
    expect(r.ok).toBe(true)
    expect(r.alreadyEnrolled).toBe(false)
    expect(r.circleId).toBe('A'.repeat(43))
    expect(db._data.has('seeder:enrolled:' + 'A'.repeat(43))).toBe(true)
    expect(mounted).toHaveLength(1)
  })

  test('is idempotent — re-enroll of a known circle does not re-mount', async () => {
    const db = makeFakeLocalDb()
    const mounted = []
    const mountCircle = async (row) => { mounted.push(row) }
    const invite = seedInvite('A'.repeat(43))
    await enrollSeedInvite({ invite, localDb: db, mountCircle })
    const second = await enrollSeedInvite({ invite, localDb: db, mountCircle })
    expect(second.alreadyEnrolled).toBe(true)
    expect(mounted).toHaveLength(1)
  })

  test('rejects a malformed invite', async () => {
    const db = makeFakeLocalDb()
    await expect(enrollSeedInvite({ invite: 'https://evil.example/foo', localDb: db }))
      .rejects.toThrow(/seed invite/)
  })

  // Franken-enrollment guard (bugfix 2026-06-19): a blind seeder can't verify a
  // circleId against the encrypted founder row, but it can refuse a second
  // circleId that reuses an already-enrolled bootstrap — which is always a
  // circleId-glued-onto-another-circle's-bootstrap franken. Reproduces the live
  // "duplicate name, different id" defect (New2's id bound to SeederTest's
  // bootstrap on the Mac mini seeder).
  const inviteWith = ({ circleId, bootstrap }) => buildSeedInvite({
    circleId, name: 'C', circleKey: 'a'.repeat(64), bootstrap, inviterPublicKey: 'b'.repeat(64),
  })

  test('refuses a new circleId that reuses an already-enrolled bootstrap (franken)', async () => {
    const db = makeFakeLocalDb()
    await enrollSeedInvite({ invite: inviteWith({ circleId: 'A'.repeat(43), bootstrap: 'c'.repeat(64) }), localDb: db })
    await expect(
      enrollSeedInvite({ invite: inviteWith({ circleId: 'B'.repeat(43), bootstrap: 'c'.repeat(64) }), localDb: db })
    ).rejects.toThrow(/franken/)
    // The franken must NOT have been persisted.
    expect(db._data.has('seeder:enrolled:' + 'B'.repeat(43))).toBe(false)
  })

  test('allows distinct circles with distinct bootstraps', async () => {
    const db = makeFakeLocalDb()
    const a = await enrollSeedInvite({ invite: inviteWith({ circleId: 'A'.repeat(43), bootstrap: 'c'.repeat(64) }), localDb: db })
    const b = await enrollSeedInvite({ invite: inviteWith({ circleId: 'B'.repeat(43), bootstrap: 'd'.repeat(64) }), localDb: db })
    expect(a.alreadyEnrolled).toBe(false)
    expect(b.alreadyEnrolled).toBe(false)
    expect(db._data.has('seeder:enrolled:' + 'B'.repeat(43))).toBe(true)
  })

  test('re-enroll of the same circleId+bootstrap stays idempotent (not flagged franken)', async () => {
    const db = makeFakeLocalDb()
    const invite = inviteWith({ circleId: 'A'.repeat(43), bootstrap: 'c'.repeat(64) })
    await enrollSeedInvite({ invite, localDb: db })
    const second = await enrollSeedInvite({ invite, localDb: db })
    expect(second.alreadyEnrolled).toBe(true)
  })
})
