const b4a = require('b4a')
const { generateKeypair } = require('../src/identity')
const { newBackupKey, buildPlain, sealBackup, openBackup, backupFingerprint, checkPassword } = require('../src/lib/accountBackup')

const kp = generateKeypair()
const identity = { publicKey: b4a.toString(kp.publicKey, 'hex'), secretKey: b4a.toString(kp.secretKey, 'hex') }
const circle = { circleId: 'c1', name: 'Family', circleKey: 'a'.repeat(64), bootstrap: 'b'.repeat(64), encryptionKey: 'c'.repeat(64), role: 'member', joinedAt: 5, rebuildGen: 3 }
const source = { identity, profile: { displayName: 'Tim', updatedAt: 1 }, circles: [circle] }

describe('account backup', () => {
  const keyed = newBackupKey('correct horse')
  const file = JSON.stringify(sealBackup(buildPlain(source), keyed))

  test('round trip with the password', () => {
    const p = openBackup(file, 'correct horse')
    expect(p.identity).toEqual(identity)
    expect(p.profile.displayName).toBe('Tim')
    expect(p.circles[0].circleKey).toBe(circle.circleKey)
  })
  test('local repair state is left out', () => {
    expect(openBackup(file, 'correct horse').circles[0].rebuildGen).toBeUndefined()
  })
  test('the file holds no plaintext keys', () => {
    expect(file).not.toContain(identity.secretKey)
    expect(file).not.toContain(circle.circleKey)
  })
  test('wrong password is refused', () => {
    expect(() => openBackup(file, 'wrong horse')).toThrow(/wrong password/)
  })
  test('a changed file is refused', () => {
    const env = JSON.parse(file)
    const c = b4a.from(env.ciphertext, 'base64'); c[c.length - 1] ^= 1
    env.ciphertext = b4a.toString(c, 'base64')
    expect(() => openBackup(JSON.stringify(env), 'correct horse')).toThrow(/wrong password/)
  })
  test('limits far above ours are refused', () => {
    const env = JSON.parse(file)
    env.kdf.mem = 4 * 1024 * 1024 * 1024
    expect(() => openBackup(JSON.stringify(env), 'correct horse')).toThrow(/unsupported/)
  })
  test('not a backup file', () => {
    expect(() => openBackup('{"type":"pearcircle.circle-export"}', 'x')).toThrow(/not a PearCircle account backup/)
    expect(() => openBackup('nope', 'x')).toThrow(/not a PearCircle backup/)
  })
  test('short passwords are refused', () => {
    expect(() => checkPassword('short')).toThrow(/at least 8/)
    expect(() => newBackupKey('short')).toThrow(/at least 8/)
  })
  test('fingerprint changes when circles change, not otherwise', () => {
    const a = backupFingerprint(source)
    expect(backupFingerprint(source)).toBe(a)
    expect(backupFingerprint({ ...source, circles: [] })).not.toBe(a)
    expect(backupFingerprint({ ...source, profile: { displayName: 'Tom' } })).not.toBe(a)
  })
})

describe('password-protected circle export', () => {
  const { sealCircleExport, isSealedCircleExport, openCircleExport } = require('../src/lib/accountBackup')
  const exp = { type: 'pearcircle.circle-export', v: 1, circle: { name: 'Family' }, places: [{ name: 'Home', lat: 1, lon: 2, radiusMeters: 100 }] }
  const sealed = sealCircleExport(exp, 'correct horse')
  test('round trip', () => {
    expect(isSealedCircleExport(sealed)).toBe(true)
    expect(openCircleExport(sealed, 'correct horse')).toEqual(exp)
  })
  test('coordinates are not readable without the password', () => {
    expect(JSON.stringify(sealed)).not.toContain('Home')
    expect(() => openCircleExport(sealed, 'wrong horse')).toThrow(/wrong password/)
  })
  test('a plain export is not sealed', () => {
    expect(isSealedCircleExport(exp)).toBe(false)
  })
})
