const { canonicalize, signValue, verifyValue } = require('../src/lib/sign')
const { generateKeypair } = require('../src/identity')
const b4a = require('b4a')

describe('canonicalize', () => {
  test('sorts object keys alphabetically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  test('recurses into nested objects', () => {
    expect(canonicalize({ b: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"b":{"x":2,"y":1}}')
  })

  test('preserves array order', () => {
    expect(canonicalize({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}')
  })

  test('matches across permutations of insertion order', () => {
    const a = canonicalize({ pubkey: 'p', ts: 1, lat: 2, lon: 3, v: 1 })
    const b = canonicalize({ v: 1, lon: 3, lat: 2, ts: 1, pubkey: 'p' })
    expect(a).toBe(b)
  })
})

describe('signValue / verifyValue', () => {
  const kp = generateKeypair()
  const pubkeyHex = b4a.toString(kp.publicKey, 'hex')

  const baseValue = () => ({
    pubkey: pubkeyHex,
    lat: 37.42342,
    lon: -122.08453,
    accuracy: 12,
    ts: 1714867200000,
    v: 1,
  })

  test('signed value carries a 128-char hex sig', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    expect(typeof signed.sig).toBe('string')
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/)
  })

  test('verifyValue returns true on an honest sign', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    expect(verifyValue(signed)).toBe(true)
  })

  test('round-trip is independent of insertion order', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    const reordered = {
      v: signed.v,
      sig: signed.sig,
      ts: signed.ts,
      lon: signed.lon,
      lat: signed.lat,
      accuracy: signed.accuracy,
      pubkey: signed.pubkey,
    }
    expect(verifyValue(reordered)).toBe(true)
  })

  test('tampering with any field breaks verification', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    expect(verifyValue({ ...signed, lat: 0 })).toBe(false)
    expect(verifyValue({ ...signed, ts: signed.ts + 1 })).toBe(false)
  })

  test('missing sig fails', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    const { sig: _drop, ...withoutSig } = signed
    expect(verifyValue(withoutSig)).toBe(false)
  })

  test('claiming a different pubkey than the signing key fails', () => {
    const other = generateKeypair()
    const otherHex = b4a.toString(other.publicKey, 'hex')
    const signed = signValue(baseValue(), kp.secretKey)
    expect(verifyValue({ ...signed, pubkey: otherHex })).toBe(false)
  })

  test('garbage sig hex returns false instead of throwing', () => {
    const signed = signValue(baseValue(), kp.secretKey)
    expect(verifyValue({ ...signed, sig: 'z'.repeat(128) })).toBe(false)
    expect(verifyValue({ ...signed, sig: 'short' })).toBe(false)
  })

  test('non-object input returns false', () => {
    expect(verifyValue(null)).toBe(false)
    expect(verifyValue(undefined)).toBe(false)
    expect(verifyValue('not an object')).toBe(false)
  })
})
