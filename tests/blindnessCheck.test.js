const b4a = require('b4a')
const { isReadableBlock, blindnessVerdict } = require('../src/lib/blindnessCheck')

const toString = (b) => b4a.toString(b)
const buf = (s) => b4a.from(s)
// A real plaintext tip, the shape two Hudgins members were publishing.
const PLAINTEXT_TIP = buf(JSON.stringify({ pubkey: 'a'.repeat(64), lat: 37.7, lon: -122.4, ts: 1_750_000_000_000, v: 1 }))
// Ciphertext: high-entropy bytes, as a correctly encrypted block looks.
const CIPHERTEXT = b4a.from([0x2b, 0x73, 0x9f, 0xd8, 0x1e, 0x5f, 0x43, 0xb7, 0x74, 0x48, 0x42, 0x5d, 0x6a, 0xff, 0x00, 0x91])

describe('isReadableBlock', () => {
  test('flags a block the seeder can read', () => {
    expect(isReadableBlock(PLAINTEXT_TIP, toString)).toBe(true)
  })

  test('does not flag ciphertext', () => {
    expect(isReadableBlock(CIPHERTEXT, toString)).toBe(false)
  })

  test('does not flag an empty or missing block', () => {
    expect(isReadableBlock(null, toString)).toBe(false)
    expect(isReadableBlock(b4a.alloc(0), toString)).toBe(false)
  })

  test('a ciphertext block that happens to start with a digit is not an alarm', () => {
    // JSON.parse('42...') can succeed on a prefix-like fragment; only an object
    // counts, so random bytes cannot raise a false alarm.
    expect(isReadableBlock(buf('42'), toString)).toBe(false)
    expect(isReadableBlock(buf('true'), toString)).toBe(false)
    expect(isReadableBlock(buf('"a string"'), toString)).toBe(false)
    expect(isReadableBlock(buf('null'), toString)).toBe(false)
  })

  test('an array is not a fix either', () => {
    // Arrays are objects in JS; a position is never an array, and treating one
    // as a broken-blindness alarm would be a false positive.
    expect(isReadableBlock(buf('[1,2,3]'), toString)).toBe(true)
    // ^ documented as accepted: it IS readable content, which is the thing the
    //   canary is about. Blindness is broken regardless of the shape.
  })
})

describe('blindnessVerdict', () => {
  test('warns the first time a member publishes readable content', () => {
    expect(blindnessVerdict({ block: PLAINTEXT_TIP, alreadyWarned: false, toString }))
      .toEqual({ readable: true, warn: true })
  })

  test('does not repeat the alarm on every append', () => {
    // The condition persists until the member updates their app; warning per
    // fix would bury it.
    expect(blindnessVerdict({ block: PLAINTEXT_TIP, alreadyWarned: true, toString }))
      .toEqual({ readable: true, warn: false })
  })

  test('stays quiet for a properly encrypted tip', () => {
    expect(blindnessVerdict({ block: CIPHERTEXT, alreadyWarned: false, toString }))
      .toEqual({ readable: false, warn: false })
  })

  test('reports not-readable once a warned member heals, so the latch can clear', () => {
    const r = blindnessVerdict({ block: CIPHERTEXT, alreadyWarned: true, toString })
    expect(r.readable).toBe(false)
    expect(r.warn).toBe(false)
  })

  test('tolerates being called with nothing', () => {
    expect(blindnessVerdict({ toString })).toEqual({ readable: false, warn: false })
  })
})
