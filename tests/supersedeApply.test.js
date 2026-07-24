const { shouldAcceptSupersede, shouldRetrySupersede, supersedePendingNext, supersedeFailureMessage, SUPERSEDE_RETRYABLE, SUPERSEDE_MAX_ATTEMPTS } = require('../src/lib/supersedeApply')
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

describe('shouldRetrySupersede', () => {
  test('retries the failures a wedged circle produces', () => {
    // These are the whole reason the retry exists: the circles an owner
    // recreates are the wedged ones, and a wedged base refuses the append the
    // migration nudge needs. A repair or a writer re-admission fixes it.
    for (const reason of ['not_writable', 'append_timeout', 'append_failed', 'circle_unreadable']) {
      expect(shouldRetrySupersede(reason, 0)).toBe(true)
    }
  })

  test('does not retry a failure that waiting cannot change', () => {
    expect(shouldRetrySupersede('not_owner', 0)).toBe(false)
    expect(shouldRetrySupersede('unknown_new_circle', 0)).toBe(false)
    expect(shouldRetrySupersede('unknown_old_circle', 0)).toBe(false)
    expect(shouldRetrySupersede(undefined, 0)).toBe(false)
    expect(shouldRetrySupersede('failed', 0)).toBe(false)
  })

  test('gives up once the attempt cap is reached', () => {
    expect(shouldRetrySupersede('not_writable', SUPERSEDE_MAX_ATTEMPTS - 1)).toBe(true)
    expect(shouldRetrySupersede('not_writable', SUPERSEDE_MAX_ATTEMPTS)).toBe(false)
    expect(shouldRetrySupersede('not_writable', SUPERSEDE_MAX_ATTEMPTS + 100)).toBe(false)
  })

  test('every retryable reason has user-facing copy that points at the invite', () => {
    for (const reason of SUPERSEDE_RETRYABLE) {
      expect(supersedeFailureMessage(reason)).toMatch(/invite/)
    }
  })
})

describe('supersedeFailureMessage', () => {
  test('explains a stuck circle without jargon', () => {
    const m = supersedeFailureMessage('not_writable')
    expect(m).toContain('stuck')
    expect(m).not.toMatch(/append|autobase|writable|timeout/i)
  })

  test('names the owner as the only one who can post it', () => {
    expect(supersedeFailureMessage('not_owner')).toContain('owner')
  })

  test('falls back to a sane line for an unknown reason', () => {
    expect(supersedeFailureMessage(undefined)).toMatch(/invite/)
    expect(supersedeFailureMessage('something-new')).toMatch(/invite/)
  })
})

describe('supersedePendingNext (retry bookkeeping)', () => {
  const NEW = 'b'.repeat(64)
  const NOW = 1_750_000_000_000

  test('a first failure on a wedged circle starts the tally', () => {
    const r = supersedePendingNext({ prev: null, newCircleId: NEW, result: { ok: false, reason: 'not_writable' }, now: NOW })
    expect(r.action).toBe('keep')
    expect(r.row).toEqual({ newCircleId: NEW, attempts: 1, reason: 'not_writable', since: NOW, v: 1 })
  })

  test('each further failure bumps the tally and keeps the original since', () => {
    const prev = { newCircleId: NEW, attempts: 1, reason: 'not_writable', since: NOW, v: 1 }
    const r = supersedePendingNext({ prev, newCircleId: NEW, result: { ok: false, reason: 'append_timeout' }, now: NOW + 90_000 })
    expect(r.row.attempts).toBe(2)
    expect(r.row.since).toBe(NOW)
    expect(r.row.reason).toBe('append_timeout')
  })

  test('success clears a pending row', () => {
    const prev = { newCircleId: NEW, attempts: 4, since: NOW, v: 1 }
    expect(supersedePendingNext({ prev, newCircleId: NEW, result: { ok: true } }).action).toBe('clear')
  })

  test('success with nothing pending is a no-op, not a write', () => {
    // The happy-path recreate: the nudge posted first time, so there is no row
    // to clear and no row to create.
    expect(supersedePendingNext({ prev: null, newCircleId: NEW, result: { ok: true } }).action).toBe('none')
  })

  test('a terminal failure clears rather than spinning forever', () => {
    const prev = { newCircleId: NEW, attempts: 3, since: NOW, v: 1 }
    expect(supersedePendingNext({ prev, newCircleId: NEW, result: { ok: false, reason: 'not_owner' } }).action).toBe('clear')
    expect(supersedePendingNext({ prev, newCircleId: NEW, result: { ok: false, reason: 'unknown_new_circle' } }).action).toBe('clear')
  })

  test('hitting the cap clears the row so the sweep stops', () => {
    const prev = { newCircleId: NEW, attempts: SUPERSEDE_MAX_ATTEMPTS - 1, since: NOW, v: 1 }
    expect(supersedePendingNext({ prev, newCircleId: NEW, result: { ok: false, reason: 'not_writable' } }).action).toBe('clear')
  })

  test('a manual tap resets the tally, buying another run of auto retries', () => {
    const prev = { newCircleId: NEW, attempts: SUPERSEDE_MAX_ATTEMPTS - 1, since: NOW, v: 1 }
    const r = supersedePendingNext({ prev, newCircleId: NEW, result: { ok: false, reason: 'not_writable' }, manual: true, now: NOW })
    expect(r.action).toBe('keep')
    expect(r.row.attempts).toBe(0)
    expect(r.row.since).toBe(NOW)
  })
})
