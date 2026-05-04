const { generateKeypair, sign, verify } = require('../src/identity')

describe('identity', () => {
  test('generateKeypair returns 32-byte publicKey and 64-byte secretKey buffers', () => {
    const kp = generateKeypair()
    expect(Buffer.isBuffer(kp.publicKey)).toBe(true)
    expect(Buffer.isBuffer(kp.secretKey)).toBe(true)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.secretKey.length).toBe(64)
  })

  test('sign returns a 64-byte signature buffer', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('hello pearcircle')
    const sig = sign(msg, kp.secretKey)
    expect(Buffer.isBuffer(sig)).toBe(true)
    expect(sig.length).toBe(64)
  })

  test('verify returns true for a valid signature', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('share my location')
    const sig = sign(msg, kp.secretKey)
    expect(verify(msg, sig, kp.publicKey)).toBe(true)
  })

  test('verify returns false for a tampered message', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('original')
    const sig = sign(msg, kp.secretKey)
    const tampered = Buffer.from('tampered')
    expect(verify(tampered, sig, kp.publicKey)).toBe(false)
  })

  test('verify returns false when checked against the wrong public key', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    const msg = Buffer.from('test')
    const sig = sign(msg, kp1.secretKey)
    expect(verify(msg, sig, kp2.publicKey)).toBe(false)
  })

  test('verify returns false for a tampered signature', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('test')
    const sig = sign(msg, kp.secretKey)
    sig[0] ^= 0xff
    expect(verify(msg, sig, kp.publicKey)).toBe(false)
  })

  test('verify returns false on malformed inputs without throwing', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('test')
    const wrongLengthSig = Buffer.alloc(32)
    expect(verify(msg, wrongLengthSig, kp.publicKey)).toBe(false)
  })

  test('two calls to generateKeypair produce distinct keypairs', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false)
    expect(kp1.secretKey.equals(kp2.secretKey)).toBe(false)
  })

  test('signatures are deterministic for a given (msg, secretKey)', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('deterministic')
    const sig1 = sign(msg, kp.secretKey)
    const sig2 = sign(msg, kp.secretKey)
    expect(sig1.equals(sig2)).toBe(true)
  })
})
