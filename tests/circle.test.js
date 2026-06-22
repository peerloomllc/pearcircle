const { generateCircleId, generateRendezvousKey, generateCircleKey, generateEncryptionKey, generatePlaceId } = require('../src/circle')
const { buildInvite, parseInvite } = require('../src/invite')

describe('generateRendezvousKey', () => {
  test('returns a 43-char base64url string (32 bytes), distinct each call', () => {
    const a = generateRendezvousKey()
    const b = generateRendezvousKey()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })
})

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

describe('generateEncryptionKey', () => {
  test('returns a 64-char hex string', () => {
    const key = generateEncryptionKey()
    expect(typeof key).toBe('string')
    expect(key.length).toBe(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  test('successive calls produce different values', () => {
    const a = generateEncryptionKey()
    const b = generateEncryptionKey()
    expect(a).not.toBe(b)
  })

  test('is distinct from a co-generated circleKey', () => {
    const circleKey = generateCircleKey()
    const encryptionKey = generateEncryptionKey()
    expect(circleKey).not.toBe(encryptionKey)
  })
})

describe('generatePlaceId', () => {
  test('returns a 32-char hex string', () => {
    const id = generatePlaceId()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(32)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('successive calls produce different values', () => {
    const a = generatePlaceId()
    const b = generatePlaceId()
    expect(a).not.toBe(b)
  })
})

describe('circle.js × invite.js round-trip', () => {
  test('generated id + key feed buildInvite/parseInvite cleanly', () => {
    const circleId = generateCircleId()
    const circleKey = generateCircleKey()
    const inviterPublicKey = 'a'.repeat(64)
    const bootstrap = 'b'.repeat(64)
    const url = buildInvite({ circleId, name: 'Smith Family', circleKey, bootstrap, inviterPublicKey })
    const parsed = parseInvite(url)
    expect(parsed.ok).toBe(true)
    expect(parsed.circleId).toBe(circleId)
    expect(parsed.circleKey).toBe(circleKey)
    expect(parsed.bootstrap).toBe(bootstrap)
    expect(parsed.encryptionKey).toBe(null)
  })

  test('full encrypted-circle round-trip', () => {
    const circleId = generateCircleId()
    const circleKey = generateCircleKey()
    const encryptionKey = generateEncryptionKey()
    const inviterPublicKey = 'a'.repeat(64)
    const bootstrap = 'b'.repeat(64)
    const url = buildInvite({ circleId, name: 'Smith Family', circleKey, bootstrap, encryptionKey, inviterPublicKey })
    const parsed = parseInvite(url)
    expect(parsed.ok).toBe(true)
    expect(parsed.circleKey).toBe(circleKey)
    expect(parsed.encryptionKey).toBe(encryptionKey)
  })
})
