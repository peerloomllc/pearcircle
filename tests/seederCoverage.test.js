const { summarizeSeederCoverage } = require('../src/lib/seederCoverage')
const { createSeederHandlers } = require('../src/seeder')
const b4a = require('b4a')

// The seeder dashboard's "what do I actually hold" report (TODO found 2026-07-24:
// a seeder held a member's core reference but never the newest block, silently).

const NOW = 1_000_000_000

describe('summarizeSeederCoverage', () => {
  test('counts held positions and names the newest', () => {
    const r = summarizeSeederCoverage({
      members: [
        { pubkey: 'aaaaaaaa11', length: 5, tipHeld: true, tipAt: NOW - 60_000 },
        { pubkey: 'bbbbbbbb22', length: 9, tipHeld: true, tipAt: NOW - 3_600_000 },
        { pubkey: 'cccccccc33', length: 0, tipHeld: false, tipAt: null },
      ],
      writers: [{ length: 10, contiguousLength: 10 }, { length: 4, contiguousLength: 2 }],
    }, NOW)
    expect(r).toMatchObject({ membersAnnounced: 3, tipsHeld: 2, newestTipAgoMs: 60_000, writersTotal: 2, writersComplete: 1 })
  })

  test('lists missing members first, then the longest since a stored position', () => {
    const r = summarizeSeederCoverage({
      members: [
        { pubkey: 'fresh', length: 1, tipHeld: true, tipAt: NOW - 1000 },
        { pubkey: 'missing', length: 3, tipHeld: false },
        { pubkey: 'stale', length: 1, tipHeld: true, tipAt: NOW - 90_000_000 },
        { pubkey: 'unknown-time', length: 1, tipHeld: true, tipAt: null },
      ],
    }, NOW)
    expect(r.members.map((m) => m.pubkey)).toEqual(['missing', 'stale', 'fresh', 'unknown-time'])
  })

  test('a block flagged held on an empty core is not counted', () => {
    const r = summarizeSeederCoverage({ members: [{ pubkey: 'x', length: 0, tipHeld: true }] }, NOW)
    expect(r.tipsHeld).toBe(0)
    expect(r.members[0].tipHeld).toBe(false)
  })

  test('an empty writer core is not complete', () => {
    expect(summarizeSeederCoverage({ writers: [{ length: 0, contiguousLength: 0 }] }, NOW).writersComplete).toBe(0)
  })

  test('tolerates malformed input', () => {
    expect(summarizeSeederCoverage({ members: [null, { length: 1 }], writers: [null, {}] }, NOW)).toEqual({
      membersAnnounced: 0, tipsHeld: 0, newestTipAgoMs: null, writersTotal: 0, writersComplete: 0, members: [],
    })
    expect(summarizeSeederCoverage(undefined, NOW).membersAnnounced).toBe(0)
  })
})

describe('seeder:enrolled:list coverage', () => {
  function fakeDb () {
    const m = new Map()
    return {
      put: async (k, v) => { m.set(k, v) },
      get: async (k) => (m.has(k) ? { key: k, value: m.get(k) } : null),
      createReadStream: async function * ({ gt, lt }) {
        for (const k of [...m.keys()].sort()) if (k > gt && k < lt) yield { key: k, value: m.get(k) }
      },
    }
  }
  const identity = { publicKey: b4a.from('a'.repeat(64), 'hex'), secretKey: b4a.from('b'.repeat(128), 'hex') }

  test('attaches coverage per circle when the host wires it', async () => {
    const db = fakeDb()
    await db.put('seeder:enrolled:c1', { circleId: 'c1' })
    await db.put('seeder:enrolled:c2', { circleId: 'c2' })
    const handlers = createSeederHandlers({ localDb: db, identity, getCoverage: async (id) => (id === 'c1' ? { tipsHeld: 2 } : null) })
    const { circles } = await handlers['seeder:enrolled:list']()
    expect(circles.find((c) => c.circleId === 'c1').coverage).toEqual({ tipsHeld: 2 })
    expect(circles.find((c) => c.circleId === 'c2').coverage).toBeNull()
  })

  test('a failing coverage lookup does not break the list', async () => {
    const db = fakeDb()
    await db.put('seeder:enrolled:c1', { circleId: 'c1' })
    const handlers = createSeederHandlers({ localDb: db, identity, getCoverage: async () => { throw new Error('boom') } })
    const { circles } = await handlers['seeder:enrolled:list']()
    expect(circles[0].coverage).toBeNull()
  })

  test('omits coverage entirely when not wired', async () => {
    const db = fakeDb()
    await db.put('seeder:enrolled:c1', { circleId: 'c1' })
    const { circles } = await createSeederHandlers({ localDb: db, identity })['seeder:enrolled:list']()
    expect('coverage' in circles[0]).toBe(false)
  })
})
