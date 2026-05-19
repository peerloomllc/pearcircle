const { canonicalize, signValue, verifyValue, verifyValueWithSigner } = require('../src/lib/sign')
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

describe('verifyValueWithSigner', () => {
  const writer = generateKeypair()
  const seeder = generateKeypair()
  const writerHex = b4a.toString(writer.publicKey, 'hex')
  const seederHex = b4a.toString(seeder.publicKey, 'hex')

  // A seeder admission row where pubkey = seeder identity and writer =
  // signing member. Mirrors the shape from src/lib/seederApply.js.
  const seederRow = () => ({
    pubkey: seederHex,
    writer: writerHex,
    addedBy: writerHex,
    addedAt: 1714867200000,
    updatedAt: 1714867200000,
    v: 1,
  })

  test('verifies a row signed by the writer when signer field is "writer"', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValueWithSigner(signed, 'writer')).toBe(true)
  })

  test('default verifyValue (signer=pubkey) rejects a row whose pubkey is not the signer', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValue(signed)).toBe(false)
  })

  test('rejects when the named signer field does not exist on the value', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValueWithSigner(signed, 'nonexistent')).toBe(false)
  })

  test('rejects when the signer field holds the wrong key', () => {
    const other = generateKeypair()
    const signed = signValue(seederRow(), other.secretKey)
    expect(verifyValueWithSigner(signed, 'writer')).toBe(false)
  })

  test('rejects malformed signer field (non-hex, wrong length)', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValueWithSigner({ ...signed, writer: 'z'.repeat(64) }, 'writer')).toBe(false)
    expect(verifyValueWithSigner({ ...signed, writer: 'short' }, 'writer')).toBe(false)
  })

  test('rejects non-string signerField', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValueWithSigner(signed, '')).toBe(false)
    expect(verifyValueWithSigner(signed, null)).toBe(false)
    expect(verifyValueWithSigner(signed, undefined)).toBe(false)
  })

  test('canonicalization covers every non-sig field including writer', () => {
    const signed = signValue(seederRow(), writer.secretKey)
    expect(verifyValueWithSigner({ ...signed, addedAt: signed.addedAt + 1 }, 'writer')).toBe(false)
  })
})
