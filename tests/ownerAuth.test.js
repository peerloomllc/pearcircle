const b4a = require('b4a')
const { signValue, verifyValueWithSigner } = require('../src/lib/sign')
const { generateKeypair } = require('../src/identity')
const { shouldAcceptSupersede } = require('../src/lib/supersedeApply')
const {
  OWNER_V2_CAP,
  activeCoowners,
  isAuthorized,
  circleOwnerV2Ready,
  shouldAcceptCircleRow,
  shouldAcceptSignedRemovedRow,
  shouldAcceptCoownerRow,
} = require('../src/lib/ownerAuth')

const hex = (kp) => b4a.toString(kp.publicKey, 'hex')
const owner = generateKeypair()
const coowner = generateKeypair()
const stranger = generateKeypair()
const member = generateKeypair()
const OWNER = hex(owner)
const CO = hex(coowner)
const STRANGER = hex(stranger)
const MEMBER = hex(member)
const coowners = new Set([CO])
const now = 1_000_000_000
const tol = 5 * 60 * 1000
const BOOT = 'b'.repeat(64)
const OTHER_CORE = 'c'.repeat(64)

describe('activeCoowners / isAuthorized', () => {
  test('revoked rows are not co-owners', () => {
    const set = activeCoowners(new Map([[CO, { revoked: false }], [MEMBER, { revoked: true }]]))
    expect(set.has(CO)).toBe(true)
    expect(set.has(MEMBER)).toBe(false)
  })
  test('the owner and co-owners are authorized, others are not', () => {
    expect(isAuthorized(OWNER, { ownerKey: OWNER, coowners })).toBe(true)
    expect(isAuthorized(CO, { ownerKey: OWNER, coowners })).toBe(true)
    expect(isAuthorized(STRANGER, { ownerKey: OWNER, coowners })).toBe(false)
    expect(isAuthorized(undefined, { ownerKey: OWNER, coowners })).toBe(false)
  })
})

describe('circleOwnerV2Ready', () => {
  test('ready when every visible member has the cap', () => {
    const r = circleOwnerV2Ready([{ value: { pubkey: OWNER, caps: [OWNER_V2_CAP] } }, { value: { pubkey: CO, caps: [OWNER_V2_CAP] } }])
    expect(r).toEqual({ ready: true, waitingOn: [] })
  })
  test('names the members still on an old version', () => {
    const r = circleOwnerV2Ready([{ value: { pubkey: OWNER, caps: [OWNER_V2_CAP] } }, { value: { pubkey: MEMBER, displayName: 'Ann' } }])
    expect(r).toEqual({ ready: false, waitingOn: ['Ann'] })
  })
})

describe('shouldAcceptCircleRow', () => {
  const existing = { id: 'c1', name: 'Family', ownerKey: OWNER, updatedAt: now - 1000, v: 1 }
  const row = (kp, fields = {}) => signValue({ ...existing, name: 'Renamed', by: hex(kp), updatedAt: now, ...fields }, kp.secretKey)
  const accept = (incoming, ex = existing, fromHex = OTHER_CORE) =>
    shouldAcceptCircleRow({ fromHex, bootstrapHex: BOOT, incoming, existing: ex, coowners, now, futureToleranceMs: tol, verifySig: verifyValueWithSigner })

  test('bootstrap-authored rows are accepted as before', () => {
    expect(accept({ id: 'c1', name: 'x', ownerKey: OWNER }, existing, BOOT)).toBe(true)
  })
  test('the owner identity from another phone is accepted', () => {
    expect(accept(row(owner))).toBe(true)
  })
  test('a co-owner is accepted', () => {
    expect(accept(row(coowner))).toBe(true)
  })
  test('a stranger is rejected', () => {
    expect(accept(row(stranger))).toBe(false)
  })
  test('a tampered row is rejected', () => {
    expect(accept({ ...row(coowner), name: 'Evil' })).toBe(false)
  })
  test('an older row replayed later is rejected', () => {
    expect(accept(row(coowner, { updatedAt: now - 2000 }))).toBe(false)
  })
  test('a co-owner cannot change ownerKey or id', () => {
    expect(accept(row(coowner, { ownerKey: CO }))).toBe(false)
    expect(accept(row(coowner, { id: 'c2' }))).toBe(false)
  })
  test('a deleted circle cannot be changed by a signed row', () => {
    expect(accept(row(coowner, { deleted: false }), { ...existing, deleted: true })).toBe(false)
  })
  test('a ts too far ahead is rejected', () => {
    expect(accept(row(coowner, { updatedAt: now + 10 * 60 * 1000 }))).toBe(false)
  })
  test('a legacy stored row without updatedAt can be replaced', () => {
    const { updatedAt: _u, ...legacy } = existing
    expect(accept(row(coowner), legacy)).toBe(true)
  })
})

describe('shouldAcceptSignedRemovedRow', () => {
  const removal = (kp, pubkey = MEMBER, fields = {}) => signValue({ pubkey, removedBy: hex(kp), ts: now, v: 1, ...fields }, kp.secretKey)
  const accept = (value, fromHex = OTHER_CORE, keyPubkey = value.pubkey) =>
    shouldAcceptSignedRemovedRow({ fromHex, bootstrapHex: BOOT, keyPubkey, value, ownerKey: OWNER, coowners, now, futureToleranceMs: tol, verifySig: verifyValueWithSigner })

  test('bootstrap-authored removal is accepted as before, even unsigned', () => {
    expect(accept({ pubkey: MEMBER, removedBy: OWNER, ts: now }, BOOT)).toBe(true)
  })
  test('a co-owner can remove a member from any phone', () => {
    expect(accept(removal(coowner))).toBe(true)
  })
  test('a stranger cannot', () => {
    expect(accept(removal(stranger))).toBe(false)
  })
  test('nobody removes the owner through a signed row', () => {
    expect(accept(removal(coowner, OWNER))).toBe(false)
  })
  test('key must match the pubkey', () => {
    expect(accept(removal(coowner), OTHER_CORE, STRANGER)).toBe(false)
  })
})

describe('shouldAcceptCoownerRow', () => {
  const grant = (kp, pubkey = MEMBER, fields = {}) => signValue({ pubkey, by: hex(kp), revoked: false, ts: now, v: 1, ...fields }, kp.secretKey)
  const accept = (incoming, { existing = null, set = coowners, keyPubkey = incoming.pubkey } = {}) =>
    shouldAcceptCoownerRow({ keyPubkey, incoming, existing, ownerKey: OWNER, coowners: set, now, futureToleranceMs: tol, verifySig: verifyValueWithSigner })

  test('the owner can appoint a co-owner', () => {
    expect(accept(grant(owner), { set: new Set() })).toBe(true)
  })
  test('a co-owner can appoint and revoke', () => {
    expect(accept(grant(coowner))).toBe(true)
    expect(accept(grant(coowner, MEMBER, { revoked: true }), { existing: { ts: now - 1 } })).toBe(true)
  })
  test('a stranger cannot appoint', () => {
    expect(accept(grant(stranger))).toBe(false)
  })
  test('a revoked co-owner cannot appoint', () => {
    expect(accept(grant(coowner), { set: new Set() })).toBe(false)
  })
  test('the owner cannot be made or unmade a co-owner', () => {
    expect(accept(grant(coowner, OWNER))).toBe(false)
  })
  test('an older grant replayed after a revoke is rejected', () => {
    expect(accept(grant(coowner, MEMBER, { ts: now - 10 }), { existing: { ts: now - 5, revoked: true } })).toBe(false)
  })
  test('revoked must be a boolean', () => {
    expect(accept(grant(coowner, MEMBER, { revoked: 'no' }))).toBe(false)
  })
})

describe('shouldAcceptSupersede with co-owners', () => {
  const post = (kp, fields = {}) => signValue({ newCircleId: 'n1', name: 'New', invite: 'x', ownerKey: OWNER, postedAt: now, v: 1, ...fields }, kp.secretKey)
  const verify = (val) => verifyValueWithSigner(val, typeof val?.by === 'string' ? 'by' : 'ownerKey')
  const accept = (incoming) => shouldAcceptSupersede({ keyNew: 'n1', incoming, ownerKey: OWNER, existing: null, now, futureToleranceMs: tol, coowners, verifySig: verify })

  test('the owner posts as before', () => {
    expect(accept(post(owner))).toBe(true)
  })
  test('a co-owner posts with by', () => {
    expect(accept(post(coowner, { by: CO }))).toBe(true)
  })
  test('a stranger with by is rejected', () => {
    expect(accept(post(stranger, { by: STRANGER }))).toBe(false)
  })
})
