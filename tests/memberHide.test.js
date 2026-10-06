const b4a = require('b4a')
const { signValue, verifyValueWithSigner } = require('../src/lib/sign')
const { generateKeypair } = require('../src/identity')
const {
  HIDE_INACTIVE_MS,
  HIDE_INACTIVE_MIN_MS,
  memberHiddenByHide,
  memberLastActiveAt,
  hideThresholdMs,
  canHideMember,
  shouldAcceptHiddenRow,
} = require('../src/lib/memberHide')

const DAY = 24 * 60 * 60 * 1000
const hex = (kp) => b4a.toString(kp.publicKey, 'hex')

describe('memberHiddenByHide', () => {
  test('no hide means never hidden', () => {
    expect(memberHiddenByHide(undefined, 1000)).toBe(false)
    expect(memberHiddenByHide(null, 1000)).toBe(false)
  })
  test('hide with no member row hides', () => {
    expect(memberHiddenByHide(1000, undefined)).toBe(true)
  })
  test('hide newer than joinedAt hides', () => {
    expect(memberHiddenByHide(2000, 1000)).toBe(true)
  })
  test('member row rewritten after the hide shows them again', () => {
    expect(memberHiddenByHide(1000, 2000)).toBe(false)
    expect(memberHiddenByHide(1000, 1000)).toBe(false)
  })
})

describe('memberLastActiveAt', () => {
  test('takes the newest of joinedAt and any seen ts', () => {
    expect(memberLastActiveAt({ joinedAt: 100, seenTs: [50, 300, undefined, 200] })).toBe(300)
  })
  test('falls back to joinedAt, then 0', () => {
    expect(memberLastActiveAt({ joinedAt: 100 })).toBe(100)
    expect(memberLastActiveAt({})).toBe(0)
  })
})

describe('hideThresholdMs', () => {
  test('defaults to 30 days', () => {
    expect(hideThresholdMs()).toBe(HIDE_INACTIVE_MS)
    expect(HIDE_INACTIVE_MS).toBe(30 * DAY)
  })
  test('clamps an override between 1 minute and 30 days', () => {
    expect(hideThresholdMs(1)).toBe(HIDE_INACTIVE_MIN_MS)
    expect(hideThresholdMs(5 * 60 * 1000)).toBe(5 * 60 * 1000)
    expect(hideThresholdMs(365 * DAY)).toBe(HIDE_INACTIVE_MS)
    expect(hideThresholdMs(NaN)).toBe(HIDE_INACTIVE_MS)
  })
})

describe('canHideMember', () => {
  const now = 100 * DAY
  const pubkey = 'a'.repeat(64)
  const ourKey = 'b'.repeat(64)
  const base = { pubkey, ourKey, hasMemberRow: true, now }

  test('allows a member unseen for 30 days', () => {
    expect(canHideMember({ ...base, lastActiveAt: now - 31 * DAY })).toEqual({ ok: true })
  })
  test('refuses a member seen in the last 30 days', () => {
    expect(canHideMember({ ...base, lastActiveAt: now - 29 * DAY }).reason).toBe('recently_seen')
  })
  test('refuses ourselves, a non-member and a bad key', () => {
    expect(canHideMember({ ...base, pubkey: ourKey, lastActiveAt: 0 }).reason).toBe('self')
    expect(canHideMember({ ...base, hasMemberRow: false, lastActiveAt: 0 }).reason).toBe('not_member')
    expect(canHideMember({ ...base, pubkey: 'abc', lastActiveAt: 0 }).reason).toBe('bad_pubkey')
  })
  test('a debug threshold makes a member unseen for 2 minutes hideable', () => {
    expect(canHideMember({ ...base, lastActiveAt: now - 2 * 60 * 1000, inactiveMs: 60 * 1000 }).ok).toBe(true)
  })
})

describe('shouldAcceptHiddenRow', () => {
  const hider = generateKeypair()
  const target = hex(generateKeypair())
  const now = 1_000_000_000
  const verifySig = (v) => verifyValueWithSigner(v, 'hiddenBy')
  const row = (fields = {}) => signValue({ pubkey: target, hiddenBy: hex(hider), ts: now, v: 1, ...fields }, hider.secretKey)
  const accept = (value, keyPubkey = target) =>
    shouldAcceptHiddenRow({ keyPubkey, value, now, futureToleranceMs: 5 * 60 * 1000, verifySig })

  test('accepts a row signed by hiddenBy', () => {
    expect(accept(row())).toBe(true)
  })
  test('rejects a tampered row', () => {
    expect(accept({ ...row(), ts: now - 1 })).toBe(false)
  })
  test('rejects a key that does not match the pubkey', () => {
    expect(accept(row(), 'c'.repeat(64))).toBe(false)
  })
  test('rejects hiding yourself', () => {
    expect(accept(row({ pubkey: hex(hider) }), hex(hider))).toBe(false)
  })
  test('rejects a ts too far in the future', () => {
    expect(accept(row({ ts: now + 10 * 60 * 1000 }))).toBe(false)
  })
  test('rejects a missing ts or signer', () => {
    expect(accept({ pubkey: target, ts: now })).toBe(false)
    expect(accept(row({ ts: 'soon' }))).toBe(false)
  })
})
