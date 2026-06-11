const { inviteCircleIdMismatch } = require('../src/invite')

// Proposal 2026-06-11-circleid-channel-binding, Fix 1: circle:join rejects an
// invite whose circleId disagrees with the founder-written canonical circle.id.

const REAL = 'n2Ca0yv3KECiI2BNMEo6WZo90k2cKkRI8FZWASQENrE'
const WRONG = 'IQvmfSanxZNtR5s3ab1qi_gl51MmBMzAh4ZDN9ep5Kc'

describe('inviteCircleIdMismatch', () => {
  test('rejects when the invite circleId differs from the circle row id', () => {
    expect(inviteCircleIdMismatch(WRONG, { id: REAL })).toBe(true)
  })

  test('accepts when they match', () => {
    expect(inviteCircleIdMismatch(REAL, { id: REAL })).toBe(false)
  })

  test('does not reject when the canonical id is absent (row not replicated yet)', () => {
    expect(inviteCircleIdMismatch(WRONG, undefined)).toBe(false)
    expect(inviteCircleIdMismatch(WRONG, {})).toBe(false)
    expect(inviteCircleIdMismatch(WRONG, { id: null })).toBe(false)
    expect(inviteCircleIdMismatch(WRONG, null)).toBe(false)
  })
})
