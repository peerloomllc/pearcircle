const { topicForCircleKey, seederPairTopic, TOPIC_BYTES } = require('../src/swarm')
const b4a = require('b4a')

describe('topicForCircleKey', () => {
  test('produces a 32-byte buffer', () => {
    const topic = topicForCircleKey('a'.repeat(64))
    expect(topic.length).toBe(TOPIC_BYTES)
    expect(TOPIC_BYTES).toBe(32)
  })

  test('is deterministic for a given circleKey', () => {
    const a = topicForCircleKey('a'.repeat(64))
    const b = topicForCircleKey('a'.repeat(64))
    expect(b4a.equals(a, b)).toBe(true)
  })

  test('differs across distinct circleKeys', () => {
    const a = topicForCircleKey('a'.repeat(64))
    const b = topicForCircleKey('b'.repeat(64))
    expect(b4a.equals(a, b)).toBe(false)
  })

  test('rejects non-string input', () => {
    expect(() => topicForCircleKey(null)).toThrow()
    expect(() => topicForCircleKey(undefined)).toThrow()
    expect(() => topicForCircleKey(42)).toThrow()
  })

  test('rejects wrong-length hex string', () => {
    expect(() => topicForCircleKey('a'.repeat(63))).toThrow()
    expect(() => topicForCircleKey('a'.repeat(65))).toThrow()
  })

  test('rejects non-hex characters', () => {
    expect(() => topicForCircleKey('z'.repeat(64))).toThrow()
  })

  test('case-insensitive on hex input', () => {
    const lower = topicForCircleKey('abcdef0123456789'.repeat(4))
    const upper = topicForCircleKey('ABCDEF0123456789'.repeat(4))
    expect(b4a.equals(lower, upper)).toBe(true)
  })
})

describe('seederPairTopic', () => {
  test('produces a deterministic 32-byte buffer', () => {
    const a = seederPairTopic('A'.repeat(43))
    const b = seederPairTopic('A'.repeat(43))
    expect(a.length).toBe(TOPIC_BYTES)
    expect(b4a.equals(a, b)).toBe(true)
  })

  test('differs across distinct rendezvous keys', () => {
    const a = seederPairTopic('A'.repeat(43))
    const b = seederPairTopic('B'.repeat(43))
    expect(b4a.equals(a, b)).toBe(false)
  })

  // Domain separation: an rv and a circleKey with the SAME underlying 32 bytes
  // (all-zero here) must derive DIFFERENT topics, so a pairing rendezvous can
  // never collide with a real circle's topic.
  test('is domain-separated from circle topics', () => {
    const rvAllZero = 'A'.repeat(43)        // base64url(32 zero bytes)
    const circleKeyAllZero = '0'.repeat(64) // hex(32 zero bytes)
    expect(b4a.equals(b4a.from(rvAllZero + '=', 'base64'), b4a.from(circleKeyAllZero, 'hex'))).toBe(true)
    const pairTopic = seederPairTopic(rvAllZero)
    const circleTopic = topicForCircleKey(circleKeyAllZero)
    expect(b4a.equals(pairTopic, circleTopic)).toBe(false)
  })

  test('rejects a malformed rendezvous key', () => {
    expect(() => seederPairTopic(null)).toThrow()
    expect(() => seederPairTopic('A'.repeat(42))).toThrow()
    expect(() => seederPairTopic('+'.repeat(43))).toThrow() // not base64url
  })
})
