const { shouldAcceptSupersede } = require('../src/lib/supersedeApply')
const { signValue, verifyValueWithSigner } = require('../src/lib/sign')
const { generateKeypair } = require('../src/identity')
const b4a = require('b4a')

// The owner of the OLD circle signs the supersede record; the apply branch
// verifies the signature against the `ownerKey` field (verifyValueWithSigner)
// and cross-checks that field against the circle row's ownerKey.
const verifySig = (val) => verifyValueWithSigner(val, 'ownerKey')

describe('shouldAcceptSupersede', () => {
  const owner = generateKeypair()
  const other = generateKeypair()
  const ownerHex = b4a.toString(owner.publicKey, 'hex')
  const otherHex = b4a.toString(other.publicKey, 'hex')
  const NEW_ID = 'a'.repeat(64)
  const now = 1_750_000_000_000

  // A supersede value as the worklet builds it, signed by the named key.
  const supersedeRow = (signerKey, overrides = {}) => signValue({
    newCircleId: NEW_ID,
    name: 'Family',
    invite: 'https://peerloomllc.com/circle/join?circle=...',
    ownerKey: ownerHex,
    postedAt: now,
    v: 1,
    ...overrides,
  }, signerKey)

  const accept = (row, opts = {}) => shouldAcceptSupersede({
    keyNew: NEW_ID,
    incoming: row,
    ownerKey: ownerHex,
    existing: null,
    now,
    futureToleranceMs: 5 * 60 * 1000,
    verifySig,
    ...opts,
  })

  test('accepts a record signed by the circle owner', () => {
    expect(accept(supersedeRow(owner.secretKey))).toBe(true)
  })

  test('rejects a record signed by any other writer', () => {
    // Another writer signs but still claims ownerKey = owner: the signature
    // no longer verifies against ownerKey, so it is rejected.
    expect(accept(supersedeRow(other.secretKey))).toBe(false)
  })

  test('rejects when the embedded ownerKey is not the circle owner', () => {
    // A writer signs honestly as themselves (ownerKey = their own key); the
    // signature verifies, but ownerKey != the circle row's ownerKey.
    const row = supersedeRow(other.secretKey, { ownerKey: otherHex })
    expect(accept(row)).toBe(false)
  })

  test('rejects when the key segment does not match the signed newCircleId', () => {
    expect(accept(supersedeRow(owner.secretKey), { keyNew: 'b'.repeat(64) })).toBe(false)
  })

  test('rejects tampered fields (signature no longer covers them)', () => {
    const row = supersedeRow(owner.secretKey)
    expect(accept({ ...row, invite: 'https://evil.example/join' })).toBe(false)
    expect(accept({ ...row, name: 'Hijacked' })).toBe(false)
  })

  test('rejects a future-dated postedAt beyond tolerance', () => {
    const row = supersedeRow(owner.secretKey, { postedAt: now + 60 * 60 * 1000 })
    expect(accept(row)).toBe(false)
  })

  test('rejects malformed records', () => {
    expect(accept(null)).toBe(false)
    expect(accept({})).toBe(false)
    expect(accept({ ...supersedeRow(owner.secretKey), invite: 42 })).toBe(false)
  })

  test('LWW: rejects a record not newer than the existing one', () => {
    const row = supersedeRow(owner.secretKey)
    expect(accept(row, { existing: { postedAt: now } })).toBe(false)        // equal
    expect(accept(row, { existing: { postedAt: now + 1 } })).toBe(false)    // older
    expect(accept(row, { existing: { postedAt: now - 1 } })).toBe(true)     // newer
  })
})
