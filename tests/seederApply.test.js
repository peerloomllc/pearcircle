// Seeder admission apply-branch decision tests.
// Proposal 2026-05-19-blind-seeder-peers slice 3a.

const b4a = require('b4a')
const { shouldAcceptSeederRow } = require('../src/lib/seederApply')
const { signValue, verifyValueWithSigner } = require('../src/lib/sign')
const { generateKeypair } = require('../src/identity')

const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

function makeFixture () {
  const writer = generateKeypair()
  const seeder = generateKeypair()
  const writerHex = b4a.toString(writer.publicKey, 'hex')
  const seederHex = b4a.toString(seeder.publicKey, 'hex')
  const baseTs = 1714867200000

  const row = (overrides = {}) =>
    signValue(
      {
        pubkey: seederHex,
        writer: writerHex,
        addedBy: writerHex,
        addedAt: baseTs,
        updatedAt: baseTs,
        v: 1,
        ...overrides,
      },
      writer.secretKey,
    )

  return {
    writer,
    writerHex,
    seederHex,
    baseTs,
    row,
    // Convenience to evaluate the decision with sane defaults.
    decide: ({ incoming, writerMember = { pubkey: writerHex }, writerRemoved = null, existing = null, now = baseTs + 1 }) =>
      shouldAcceptSeederRow({
        keyPubkey: seederHex,
        incoming,
        writerMember,
        writerRemoved,
        existing,
        now,
        futureToleranceMs: FUTURE_TS_TOLERANCE_MS,
        verifySig: (val) => verifyValueWithSigner(val, 'writer'),
      }),
  }
}

describe('shouldAcceptSeederRow — positive cases', () => {
  test('admits a well-formed signed row by a current member', () => {
    const { row, decide } = makeFixture()
    expect(decide({ incoming: row() })).toBe(true)
  })

  test('accepts a revoke when revokedAt + revokedBy are present', () => {
    const f = makeFixture()
    const revokedAt = f.baseTs + 1000
    const revoke = f.row({
      revoked: true,
      revokedAt,
      revokedBy: f.writerHex,
      updatedAt: revokedAt,
    })
    const existing = { ...f.row(), updatedAt: f.baseTs }
    expect(f.decide({ incoming: revoke, existing })).toBe(true)
  })

  test('accepts a re-admission after revoke (newer updatedAt, no revoked flag)', () => {
    const f = makeFixture()
    const existing = { ...f.row({ revoked: true, revokedAt: f.baseTs + 500, revokedBy: f.writerHex, updatedAt: f.baseTs + 500 }) }
    const readmit = f.row({ updatedAt: f.baseTs + 1000 })
    expect(f.decide({ incoming: readmit, existing })).toBe(true)
  })
})

describe('shouldAcceptSeederRow — rejection cases', () => {
  test('rejects when key suffix does not match incoming.pubkey', () => {
    const f = makeFixture()
    const incoming = f.row({ pubkey: 'c'.repeat(64) })
    expect(f.decide({ incoming })).toBe(false)
  })

  test('rejects when writer is not in the member: view', () => {
    const f = makeFixture()
    expect(f.decide({ incoming: f.row(), writerMember: null })).toBe(false)
  })

  test('rejects when writer is in the removed: view', () => {
    const f = makeFixture()
    expect(f.decide({ incoming: f.row(), writerRemoved: { pubkey: f.writerHex, removedAt: 1 } })).toBe(false)
  })

  test('rejects unsigned row', () => {
    const f = makeFixture()
    const { sig: _drop, ...unsigned } = f.row()
    expect(f.decide({ incoming: unsigned })).toBe(false)
  })

  test('rejects row signed by someone other than writer field', () => {
    const f = makeFixture()
    const other = generateKeypair()
    const otherHex = b4a.toString(other.publicKey, 'hex')
    // writer field claims our writer, but signature was made with `other`
    const tampered = signValue(
      {
        pubkey: f.seederHex,
        writer: f.writerHex,
        addedBy: f.writerHex,
        addedAt: f.baseTs,
        updatedAt: f.baseTs,
        v: 1,
      },
      other.secretKey,
    )
    void otherHex
    expect(f.decide({ incoming: tampered })).toBe(false)
  })

  test('rejects future-stamped updatedAt beyond tolerance', () => {
    const f = makeFixture()
    const incoming = f.row({ updatedAt: f.baseTs + FUTURE_TS_TOLERANCE_MS + 1000 })
    expect(f.decide({ incoming, now: f.baseTs })).toBe(false)
  })

  test('rejects updatedAt earlier than addedAt', () => {
    const f = makeFixture()
    const incoming = f.row({ addedAt: f.baseTs + 1000, updatedAt: f.baseTs })
    expect(f.decide({ incoming })).toBe(false)
  })

  test('rejects revoke missing revokedAt', () => {
    const f = makeFixture()
    const incoming = f.row({ revoked: true, revokedBy: f.writerHex, updatedAt: f.baseTs + 500 })
    expect(f.decide({ incoming })).toBe(false)
  })

  test('rejects revoke missing revokedBy', () => {
    const f = makeFixture()
    const incoming = f.row({ revoked: true, revokedAt: f.baseTs + 500, updatedAt: f.baseTs + 500 })
    expect(f.decide({ incoming })).toBe(false)
  })

  test('rejects stale updatedAt vs existing (LWW)', () => {
    const f = makeFixture()
    const existing = { ...f.row(), updatedAt: f.baseTs + 5000 }
    const incoming = f.row({ updatedAt: f.baseTs + 100 })
    expect(f.decide({ incoming, existing })).toBe(false)
  })

  test('rejects equal updatedAt vs existing (LWW is strict greater)', () => {
    const f = makeFixture()
    const existing = { ...f.row(), updatedAt: f.baseTs + 1000 }
    const incoming = f.row({ updatedAt: f.baseTs + 1000 })
    expect(f.decide({ incoming, existing })).toBe(false)
  })

  test('rejects malformed pubkey / writer fields', () => {
    const f = makeFixture()
    expect(f.decide({ incoming: f.row({ pubkey: 'short' }) })).toBe(false)
    expect(f.decide({ incoming: f.row({ writer: 'short' }) })).toBe(false)
    expect(f.decide({ incoming: f.row({ addedBy: 'short' }) })).toBe(false)
  })

  test('rejects null / non-object incoming', () => {
    const f = makeFixture()
    expect(f.decide({ incoming: null })).toBe(false)
    expect(f.decide({ incoming: 'not an object' })).toBe(false)
  })
})
