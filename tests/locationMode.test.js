const { phaseToMode, nextEmittedMode } = require('../src/lib/locationMode')

describe('phaseToMode', () => {
  test('idle phase maps to idle mode', () => {
    expect(phaseToMode('idle')).toBe('idle')
  })

  test.each(['arming', 'active', 'cooldown'])('%s phase maps to tracking mode', (phase) => {
    expect(phaseToMode(phase)).toBe('tracking')
  })
})

describe('nextEmittedMode', () => {
  test('first emission from null lastMode while idle emits idle', () => {
    expect(nextEmittedMode(null, 'idle', true)).toBe('idle')
  })

  test('idle -> arming triggers tracking emit (Q2 eager escalation)', () => {
    expect(nextEmittedMode('idle', 'arming', true)).toBe('tracking')
  })

  test('arming -> active does not re-emit tracking', () => {
    expect(nextEmittedMode('tracking', 'active', true)).toBeNull()
  })

  test('active -> cooldown does not re-emit tracking', () => {
    expect(nextEmittedMode('tracking', 'cooldown', true)).toBeNull()
  })

  test('cooldown -> idle triggers idle emit (Q3 step down on finalize)', () => {
    expect(nextEmittedMode('tracking', 'idle', true)).toBe('idle')
  })

  test('arming false-start back to idle also steps down', () => {
    expect(nextEmittedMode('tracking', 'idle', true)).toBe('idle')
  })

  test('repeat call with same desired mode returns null', () => {
    expect(nextEmittedMode('idle', 'idle', true)).toBeNull()
    expect(nextEmittedMode('tracking', 'active', true)).toBeNull()
  })

  test('feature flag off pins to tracking regardless of phase', () => {
    expect(nextEmittedMode(null, 'idle', false)).toBe('tracking')
    expect(nextEmittedMode('idle', 'idle', false)).toBe('tracking')
    expect(nextEmittedMode('tracking', 'idle', false)).toBeNull()
  })
})
