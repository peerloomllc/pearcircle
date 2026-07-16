// Seeder admission apply-branch decision tests.
// Proposal 2026-05-19-blind-seeder-peers slice 3a.

const b4a = require('b4a')
const { shouldAcceptSeederRow, buildSeederRevoke, buildSeederAdmission, buildSeederGone, sanitizeSeederNickname } = require('../src/lib/seederApply')
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

// Proposal 2026-06-17-seeder-leave-propagation: the `left` tombstone.
describe('shouldAcceptSeederRow — left tombstone', () => {
  const leftRow = (f, overrides = {}) => f.row({
    left: true,
    leftAt: f.baseTs + 1000,
    leftBy: f.writerHex,
    updatedAt: f.baseTs + 1000,
    ...overrides,
  })

  test('accepts a well-formed left row by a current member', () => {
    const f = makeFixture()
    const existing = { ...f.row(), updatedAt: f.baseTs }
    expect(f.decide({ incoming: leftRow(f), existing })).toBe(true)
  })

  test('rejects a left row missing leftAt', () => {
    const f = makeFixture()
    const bad = f.row({ left: true, leftBy: f.writerHex, updatedAt: f.baseTs + 1000 })
    expect(f.decide({ incoming: bad })).toBe(false)
  })

  test('rejects a left row missing/short leftBy', () => {
    const f = makeFixture()
    const bad = f.row({ left: true, leftAt: f.baseTs + 1000, leftBy: 'short', updatedAt: f.baseTs + 1000 })
    expect(f.decide({ incoming: bad })).toBe(false)
  })

  test('rejects a future-dated leftAt', () => {
    const f = makeFixture()
    const future = f.baseTs + FUTURE_TS_TOLERANCE_MS + 10_000
    const bad = leftRow(f, { leftAt: future, updatedAt: future })
    expect(f.decide({ incoming: bad, now: f.baseTs + 1 })).toBe(false)
  })

  test('rejects a tampered left row (signature no longer verifies)', () => {
    const f = makeFixture()
    const signed = leftRow(f)
    expect(f.decide({ incoming: { ...signed, leftBy: f.seederHex } })).toBe(false)
  })

  test('LWW: a fresh re-admit (greater updatedAt) beats a left tombstone', () => {
    const f = makeFixture()
    const existing = { ...leftRow(f) } // updatedAt = baseTs+1000
    const readmit = f.row({ updatedAt: f.baseTs + 2000 })
    expect(f.decide({ incoming: readmit, existing })).toBe(true)
  })

  test('LWW: a left tombstone not newer than the existing row is rejected', () => {
    const f = makeFixture()
    const existing = { ...f.row({ updatedAt: f.baseTs + 1000 }) }
    const stale = leftRow(f, { leftAt: f.baseTs + 1000, updatedAt: f.baseTs + 1000 })
    expect(f.decide({ incoming: stale, existing })).toBe(false)
  })
})

describe('buildSeederGone', () => {
  const writer = generateKeypair()
  const seeder = generateKeypair()
  const writerHex = b4a.toString(writer.publicKey, 'hex')
  const seederHex = b4a.toString(seeder.publicKey, 'hex')
  const now = 1714867300000
  const existing = { pubkey: seederHex, addedBy: writerHex, addedAt: now - 5000, updatedAt: now - 5000, label: 'Home Pi' }

  test('builds a left row preserving addedBy/addedAt/label', () => {
    const out = buildSeederGone({ existing, byPubkeyHex: writerHex, now })
    expect(out).toMatchObject({
      pubkey: seederHex,
      writer: writerHex,
      addedBy: existing.addedBy,
      addedAt: existing.addedAt,
      updatedAt: now,
      left: true,
      leftAt: now,
      leftBy: writerHex,
      label: 'Home Pi',
      v: 1,
    })
  })

  test('returns null on malformed input', () => {
    expect(buildSeederGone({ existing: null, byPubkeyHex: writerHex, now })).toBeNull()
    expect(buildSeederGone({ existing, byPubkeyHex: 'short', now })).toBeNull()
    expect(buildSeederGone({ existing, byPubkeyHex: writerHex, now: 'x' })).toBeNull()
  })

  test('signed output round-trips through shouldAcceptSeederRow', () => {
    const unsigned = buildSeederGone({ existing, byPubkeyHex: writerHex, now })
    const signed = signValue(unsigned, writer.secretKey)
    expect(verifyValueWithSigner(signed, 'writer')).toBe(true)
    const accept = shouldAcceptSeederRow({
      keyPubkey: seederHex,
      incoming: signed,
      writerMember: { pubkey: writerHex },
      writerRemoved: null,
      existing: { ...existing },
      now: now + 100,
      futureToleranceMs: FUTURE_TS_TOLERANCE_MS,
      verifySig: (val) => verifyValueWithSigner(val, 'writer'),
    })
    expect(accept).toBe(true)
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

describe('buildSeederRevoke', () => {
  const f = makeFixture()
  const revoker = generateKeypair()
  const revokerHex = b4a.toString(revoker.publicKey, 'hex')
  const existing = {
    pubkey: f.seederHex,
    writer: f.writerHex,
    addedBy: f.writerHex,
    addedAt: f.baseTs,
    updatedAt: f.baseTs,
    label: 'Pi in the garage',
    v: 1,
  }

  test('returns null on null or non-object existing', () => {
    expect(buildSeederRevoke({ existing: null, revokerPubkeyHex: revokerHex, now: f.baseTs + 100 })).toBe(null)
    expect(buildSeederRevoke({ existing: 'string', revokerPubkeyHex: revokerHex, now: f.baseTs + 100 })).toBe(null)
  })

  test('returns null when existing lacks required fields', () => {
    expect(buildSeederRevoke({ existing: { ...existing, pubkey: undefined }, revokerPubkeyHex: revokerHex, now: 1 })).toBe(null)
    expect(buildSeederRevoke({ existing: { ...existing, addedBy: undefined }, revokerPubkeyHex: revokerHex, now: 1 })).toBe(null)
    expect(buildSeederRevoke({ existing: { ...existing, addedAt: undefined }, revokerPubkeyHex: revokerHex, now: 1 })).toBe(null)
  })

  test('returns null on malformed revokerPubkeyHex', () => {
    expect(buildSeederRevoke({ existing, revokerPubkeyHex: 'short', now: f.baseTs + 100 })).toBe(null)
    expect(buildSeederRevoke({ existing, revokerPubkeyHex: 'z'.repeat(64), now: f.baseTs + 100 })).toBe(null)
  })

  test('preserves pubkey, addedBy, addedAt from existing', () => {
    const out = buildSeederRevoke({ existing, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    expect(out.pubkey).toBe(existing.pubkey)
    expect(out.addedBy).toBe(existing.addedBy)
    expect(out.addedAt).toBe(existing.addedAt)
  })

  test('sets writer, revokedBy, updatedAt, revokedAt, revoked', () => {
    const out = buildSeederRevoke({ existing, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    expect(out.writer).toBe(revokerHex)
    expect(out.revokedBy).toBe(revokerHex)
    expect(out.updatedAt).toBe(f.baseTs + 1000)
    expect(out.revokedAt).toBe(f.baseTs + 1000)
    expect(out.revoked).toBe(true)
    expect(out.v).toBe(1)
  })

  test('preserves label when present', () => {
    const out = buildSeederRevoke({ existing, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    expect(out.label).toBe('Pi in the garage')
  })

  test('omits label when absent or empty', () => {
    const { label: _drop, ...noLabel } = existing
    const out = buildSeederRevoke({ existing: noLabel, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    expect(out.label).toBeUndefined()
    const outEmpty = buildSeederRevoke({ existing: { ...existing, label: '' }, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    expect(outEmpty.label).toBeUndefined()
  })

  test('signed output round-trips through shouldAcceptSeederRow as a valid revoke', () => {
    const unsigned = buildSeederRevoke({ existing, revokerPubkeyHex: revokerHex, now: f.baseTs + 1000 })
    const signed = signValue(unsigned, revoker.secretKey)
    expect(verifyValueWithSigner(signed, 'writer')).toBe(true)
    // Apply branch should accept the revoke given a current-member revoker
    // and an existing non-revoked row.
    const accept = shouldAcceptSeederRow({
      keyPubkey: f.seederHex,
      incoming: signed,
      writerMember: { pubkey: revokerHex },
      writerRemoved: null,
      existing,
      now: f.baseTs + 1500,
      futureToleranceMs: 5 * 60 * 1000,
      verifySig: (val) => verifyValueWithSigner(val, 'writer'),
    })
    expect(accept).toBe(true)
  })
})

describe('buildSeederAdmission', () => {
  const admin = generateKeypair()
  const adminHex = b4a.toString(admin.publicKey, 'hex')
  const seederHex = 'a'.repeat(64)
  const otherAdminHex = 'd'.repeat(64)
  const now = 1714867200000

  test('returns null on malformed seederPubkey', () => {
    expect(buildSeederAdmission({ seederPubkey: 'short', adminPubkeyHex: adminHex, now })).toBe(null)
  })

  test('returns null on malformed adminPubkeyHex', () => {
    expect(buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: 'z'.repeat(64), now })).toBe(null)
  })

  test('returns null on non-finite now', () => {
    expect(buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, now: NaN })).toBe(null)
    expect(buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, now: 'string' })).toBe(null)
  })

  test('returns null on non-string label', () => {
    expect(buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: 42, now })).toBe(null)
  })

  test('fresh admit: addedBy=writer=admin, addedAt=updatedAt=now, no revoked', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, now })
    expect(out.pubkey).toBe(seederHex)
    expect(out.writer).toBe(adminHex)
    expect(out.addedBy).toBe(adminHex)
    expect(out.addedAt).toBe(now)
    expect(out.updatedAt).toBe(now)
    expect(out.revoked).toBeUndefined()
    expect(out.v).toBe(1)
  })

  test('fresh admit with label includes it', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: 'Pi @ home', now })
    expect(out.label).toBe('Pi @ home')
  })

  test('empty-string label is omitted', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: '', now })
    expect(out.label).toBeUndefined()
  })

  test('re-admit preserves addedBy + addedAt from existing', () => {
    const existing = {
      pubkey: seederHex,
      addedBy: otherAdminHex,
      addedAt: now - 1000,
      writer: otherAdminHex,
      updatedAt: now - 500,
      revoked: true,
      revokedAt: now - 500,
      revokedBy: otherAdminHex,
      v: 1,
    }
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, existing, now })
    expect(out.addedBy).toBe(otherAdminHex)  // preserved from original admitter
    expect(out.addedAt).toBe(now - 1000)
    expect(out.writer).toBe(adminHex)  // this admit by current admin
    expect(out.updatedAt).toBe(now)
    expect(out.revoked).toBeUndefined()  // re-admit clears revocation
  })

  test('re-admit inherits existing label when none provided', () => {
    const existing = {
      pubkey: seederHex,
      addedBy: otherAdminHex,
      addedAt: now - 1000,
      label: 'Old label',
    }
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, existing, now })
    expect(out.label).toBe('Old label')
  })

  test('re-admit prefers caller-provided label over inherited', () => {
    const existing = {
      pubkey: seederHex,
      addedBy: otherAdminHex,
      addedAt: now - 1000,
      label: 'Old label',
    }
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, existing, label: 'New label', now })
    expect(out.label).toBe('New label')
  })

  test('signed output round-trips through shouldAcceptSeederRow', () => {
    const unsigned = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, now })
    const signed = signValue(unsigned, admin.secretKey)
    expect(verifyValueWithSigner(signed, 'writer')).toBe(true)
    const accept = shouldAcceptSeederRow({
      keyPubkey: seederHex,
      incoming: signed,
      writerMember: { pubkey: adminHex },
      writerRemoved: null,
      existing: null,
      now: now + 100,
      futureToleranceMs: 5 * 60 * 1000,
      verifySig: (val) => verifyValueWithSigner(val, 'writer'),
    })
    expect(accept).toBe(true)
  })

  test('malformed existing.addedBy falls back to admin', () => {
    const existing = { pubkey: seederHex, addedBy: 'short', addedAt: now - 1000 }
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, existing, now })
    expect(out.addedBy).toBe(adminHex)
  })
})

// Operator nickname (proposal 2026-07-15-seeder-nickname): the `label` field
// doubles as the seeder's self-set display name. buildSeederAdmission must be
// able to set, clear, and inherit it, and sanitizeSeederNickname normalizes it.
describe('seeder nickname label semantics', () => {
  const adminHex = 'a'.repeat(64)
  const seederHex = 'b'.repeat(64)
  const now = 1714867200000
  const withLabel = { pubkey: seederHex, addedBy: adminHex, addedAt: now - 1000, label: 'Home Pi' }

  test('non-empty string sets the label', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: 'Office NAS', existing: null, now })
    expect(out.label).toBe('Office NAS')
  })
  test('undefined inherits the existing label', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: undefined, existing: withLabel, now })
    expect(out.label).toBe('Home Pi')
  })
  test('null explicitly clears the label (back to hex)', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: null, existing: withLabel, now })
    expect('label' in out).toBe(false)
  })
  test('empty string clears the label', () => {
    const out = buildSeederAdmission({ seederPubkey: seederHex, adminPubkeyHex: adminHex, label: '', existing: withLabel, now })
    expect('label' in out).toBe(false)
  })
})

describe('sanitizeSeederNickname', () => {
  test('trims surrounding whitespace', () => {
    expect(sanitizeSeederNickname('  Home Pi  ')).toBe('Home Pi')
  })
  test('caps length at 48', () => {
    expect(sanitizeSeederNickname('x'.repeat(100)).length).toBe(48)
  })
  test('strips control characters', () => {
    const input = 'Home' + String.fromCharCode(0, 9, 31) + 'Pi'
    expect(sanitizeSeederNickname(input)).toBe('HomePi')
  })
  test('blank / non-string returns null', () => {
    expect(sanitizeSeederNickname('   ')).toBe(null)
    expect(sanitizeSeederNickname('')).toBe(null)
    expect(sanitizeSeederNickname(null)).toBe(null)
    expect(sanitizeSeederNickname(42)).toBe(null)
  })
})
