const { topicForCircleKey, TOPIC_BYTES } = require('../src/swarm')
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
