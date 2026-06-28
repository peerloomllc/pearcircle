const { shouldSwallowFault, isConflictFallout, CONFLICT_GRACE_MS } = require('../src/lib/conflictSeatbelt')

describe('isConflictFallout', () => {
  test('matches the escaping "Closed" rejection (the observed crash)', () => {
    expect(isConflictFallout(new Error('Closed'))).toBe(true)
  })

  test('matches the conflict error itself', () => {
    expect(isConflictFallout(new Error('Two conflicting signatures exist for length 51'))).toBe(true)
  })

  test('matches a bare string message', () => {
    expect(isConflictFallout('Closed')).toBe(true)
  })

  test('does not match unrelated errors', () => {
    expect(isConflictFallout(new Error('ENOMEM'))).toBe(false)
    expect(isConflictFallout(new Error('connection reset'))).toBe(false)
    expect(isConflictFallout(new Error('Channel closed by remote'))).toBe(false) // not exactly "Closed"
  })

  test('handles null/undefined safely', () => {
    expect(isConflictFallout(null)).toBe(false)
    expect(isConflictFallout(undefined)).toBe(false)
  })
})

describe('shouldSwallowFault', () => {
  const now = 1_000_000
  const closed = new Error('Closed')

  test('swallows conflict fallout within the grace window', () => {
    expect(shouldSwallowFault(closed, now - 1000, now)).toBe(true)
    expect(shouldSwallowFault(closed, now - (CONFLICT_GRACE_MS - 1), now)).toBe(true)
  })

  test('does NOT swallow once the grace window has elapsed', () => {
    expect(shouldSwallowFault(closed, now - CONFLICT_GRACE_MS, now)).toBe(false)
    expect(shouldSwallowFault(closed, now - (CONFLICT_GRACE_MS + 1), now)).toBe(false)
  })

  test('does NOT swallow when no conflict has ever fired (lastConflictAt 0)', () => {
    expect(shouldSwallowFault(closed, 0, now)).toBe(false)
  })

  test('does NOT swallow a non-conflict error even right after a conflict', () => {
    // A real bug that happens to fire just after a fork must still crash.
    expect(shouldSwallowFault(new Error('boom'), now - 10, now)).toBe(false)
  })

  test('honors a custom grace window', () => {
    expect(shouldSwallowFault(closed, now - 500, now, 1000)).toBe(true)
    expect(shouldSwallowFault(closed, now - 1500, now, 1000)).toBe(false)
  })
})
