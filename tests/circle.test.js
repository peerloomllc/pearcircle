const { generateCircleId, generateCircleKey } = require('../src/circle')
const { buildInvite, parseInvite } = require('../src/invite')

describe('generateCircleId', () => {
  test('returns a 43-char string', () => {
    const id = generateCircleId()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(43)
  })

  test('uses only base64url charset (no +, /, =)', () => {
    const id = generateCircleId()
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('successive calls produce different values', () => {
    const a = generateCircleId()
    const b = generateCircleId()
    expect(a).not.toBe(b)
  })
})

describe('generateCircleKey', () => {
  test('returns a 64-char hex string', () => {
    const key = generateCircleKey()
    expect(typeof key).toBe('string')
    expect(key.length).toBe(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  test('successive calls produce different values', () => {
    const a = generateCircleKey()
    const b = generateCircleKey()
    expect(a).not.toBe(b)
  })
})

describe('circle.js × invite.js round-trip', () => {
  test('generated id + key feed buildInvite/parseInvite cleanly', () => {
    const circleId = generateCircleId()
    const circleKey = generateCircleKey()
    const inviterPublicKey = 'a'.repeat(64)
    const url = buildInvite({ circleId, name: 'Smith Family', circleKey, inviterPublicKey })
    const parsed = parseInvite(url)
    expect(parsed.ok).toBe(true)
    expect(parsed.circleId).toBe(circleId)
    expect(parsed.circleKey).toBe(circleKey)
  })
})
