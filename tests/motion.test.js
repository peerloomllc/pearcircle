const { motionState, STILL_THRESHOLD_MPS, DRIVING_THRESHOLD_MPS } = require('../src/lib/motion')

describe('motionState', () => {
  test('null speed returns null', () => {
    expect(motionState(null)).toBeNull()
    expect(motionState(undefined)).toBeNull()
  })

  test('non-numeric speed returns null', () => {
    expect(motionState('5')).toBeNull()
    expect(motionState(NaN)).toBeNull()
    expect(motionState(Infinity)).toBeNull()
  })

  test('negative speed (CLLocation unknown sentinel) returns null', () => {
    expect(motionState(-1)).toBeNull()
  })

  test('zero speed is still', () => {
    expect(motionState(0)).toBe('still')
  })

  test('just under STILL_THRESHOLD is still', () => {
    expect(motionState(STILL_THRESHOLD_MPS - 0.01)).toBe('still')
  })

  test('exactly STILL_THRESHOLD is walking', () => {
    expect(motionState(STILL_THRESHOLD_MPS)).toBe('walking')
  })

  test('walking pace (1.4 m/s ~ 3 mph) is walking', () => {
    expect(motionState(1.4)).toBe('walking')
  })

  test('jogging pace (3 m/s) is walking', () => {
    expect(motionState(3)).toBe('walking')
  })

  test('just under DRIVING_THRESHOLD is walking', () => {
    expect(motionState(DRIVING_THRESHOLD_MPS - 0.01)).toBe('walking')
  })

  test('exactly DRIVING_THRESHOLD is driving', () => {
    expect(motionState(DRIVING_THRESHOLD_MPS)).toBe('driving')
  })

  test('highway speed (30 m/s ~ 67 mph) is driving', () => {
    expect(motionState(30)).toBe('driving')
  })
})
