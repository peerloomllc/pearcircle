const { phaseToMode, desiredMode, nextEmittedMode, MODE_BOOT_GRACE_MS } = require('../src/lib/locationMode')

describe('phaseToMode', () => {
  test('idle phase maps to idle mode', () => {
    expect(phaseToMode('idle')).toBe('idle')
  })

  test.each(['arming', 'active', 'cooldown'])('%s phase maps to tracking mode', (phase) => {
    expect(phaseToMode(phase)).toBe('tracking')
  })
})

describe('desiredMode', () => {
  test('backgrounded, stationary, trip-idle is the only idle case', () => {
    expect(desiredMode({ phase: 'idle', appForeground: false, recentMotion: false })).toBe('idle')
  })

  test('app foreground escalates even when stationary and trip-idle', () => {
    expect(desiredMode({ phase: 'idle', appForeground: true, recentMotion: false })).toBe('tracking')
  })

  test('recent motion escalates even when backgrounded and trip-idle', () => {
    expect(desiredMode({ phase: 'idle', appForeground: false, recentMotion: true })).toBe('tracking')
  })

  test.each(['arming', 'active', 'cooldown'])(
    'non-idle trip phase (%s) escalates even when backgrounded and stationary',
    (phase) => {
      expect(desiredMode({ phase, appForeground: false, recentMotion: false })).toBe('tracking')
    },
  )

  test('all three escalations active is still tracking', () => {
    expect(desiredMode({ phase: 'active', appForeground: true, recentMotion: true })).toBe('tracking')
  })
})

describe('nextEmittedMode', () => {
  // Steady state: location has started, so the idle step-down gate is open.
  const quiet = { phase: 'idle', appForeground: false, recentMotion: false, locationStarted: true }

  test('first emission from null lastMode while fully quiet emits idle', () => {
    expect(nextEmittedMode(null, quiet, true)).toBe('idle')
  })

  test('foreground-enter escalates idle -> tracking', () => {
    expect(nextEmittedMode('idle', { phase: 'idle', appForeground: true, recentMotion: false, locationStarted: true }, true)).toBe('tracking')
  })

  test('stationary-to-moving (recent motion) escalates idle -> tracking', () => {
    expect(nextEmittedMode('idle', { phase: 'idle', appForeground: false, recentMotion: true, locationStarted: true }, true)).toBe('tracking')
  })

  test('trip detection arming escalates idle -> tracking', () => {
    expect(nextEmittedMode('idle', { phase: 'arming', appForeground: false, recentMotion: false, locationStarted: true }, true)).toBe('tracking')
  })

  test('steps down to idle only when backgrounded, stationary, and trip-idle', () => {
    expect(nextEmittedMode('tracking', quiet, true)).toBe('idle')
  })

  test('does not step down while the app is still foregrounded', () => {
    expect(nextEmittedMode('tracking', { phase: 'idle', appForeground: true, recentMotion: false, locationStarted: true }, true)).toBeNull()
  })

  test('does not step down while motion is still recent', () => {
    expect(nextEmittedMode('tracking', { phase: 'idle', appForeground: false, recentMotion: true, locationStarted: true }, true)).toBeNull()
  })

  test('no re-emit when the desired mode already matches lastMode', () => {
    expect(nextEmittedMode('idle', quiet, true)).toBeNull()
    expect(nextEmittedMode('tracking', { phase: 'active', appForeground: false, recentMotion: false, locationStarted: true }, true)).toBeNull()
  })

  test('feature flag off pins to tracking regardless of escalation inputs', () => {
    expect(nextEmittedMode(null, quiet, false)).toBe('tracking')
    expect(nextEmittedMode('idle', quiet, false)).toBe('tracking')
    expect(nextEmittedMode('tracking', quiet, false)).toBeNull()
  })

  test('a missing locationStarted is treated as started (no gating)', () => {
    expect(nextEmittedMode(null, { phase: 'idle', appForeground: false, recentMotion: false }, true)).toBe('idle')
  })
})

describe('nextEmittedMode cold-start idle gate', () => {
  // Before the first location:update, native startUpdatesNow would skip
  // startUpdatingLocation() if its mode were "idle" -- so the worklet
  // must not emit "idle" until continuous delivery is confirmed up.
  const preLocation = { phase: 'idle', appForeground: false, recentMotion: false, locationStarted: false }

  test('suppresses the first idle emission before location has started', () => {
    expect(nextEmittedMode(null, preLocation, true)).toBeNull()
  })

  test('suppresses an idle step-down before location has started', () => {
    expect(nextEmittedMode('tracking', preLocation, true)).toBeNull()
  })

  test('still escalates to tracking before location has started', () => {
    expect(nextEmittedMode(null, { ...preLocation, appForeground: true }, true)).toBe('tracking')
    expect(nextEmittedMode('idle', { ...preLocation, recentMotion: true }, true)).toBe('tracking')
    expect(nextEmittedMode('idle', { ...preLocation, phase: 'arming' }, true)).toBe('tracking')
  })

  test('emits idle once the first location:update has been seen', () => {
    expect(nextEmittedMode(null, { ...preLocation, locationStarted: true }, true)).toBe('idle')
  })

  test('feature flag off still pins tracking even before location starts', () => {
    expect(nextEmittedMode(null, preLocation, false)).toBe('tracking')
  })
})

// The wake-up deadlock (real drive, 2026-07-22). Every escalation input lives in
// memory and iOS hands each background wake a brand-new process, so a fresh
// worklet always computes "idle" and calls stopUpdatingLocation within a second
// of booting -- releasing the very assertion keeping it alive. Staying awake
// required a detected trip; detecting a trip required staying awake.
describe('nextEmittedMode boot grace', () => {
  const freshBoot = {
    phase: 'idle',
    appForeground: false,
    recentMotion: false,
    locationStarted: true,
    sinceBootMs: 500,
  }

  test('suppresses the idle demotion in the first second of a wake', () => {
    expect(nextEmittedMode(null, freshBoot, true)).toBeNull()
  })

  test('suppresses an idle step-down from tracking during the grace', () => {
    expect(nextEmittedMode('tracking', freshBoot, true)).toBeNull()
  })

  test('suppresses right up to the grace boundary and emits after it', () => {
    expect(nextEmittedMode(null, { ...freshBoot, sinceBootMs: MODE_BOOT_GRACE_MS - 1 }, true)).toBeNull()
    expect(nextEmittedMode(null, { ...freshBoot, sinceBootMs: MODE_BOOT_GRACE_MS }, true)).toBe('idle')
  })

  test('escalations to tracking are never held back by the grace', () => {
    expect(nextEmittedMode(null, { ...freshBoot, recentMotion: true }, true)).toBe('tracking')
    expect(nextEmittedMode(null, { ...freshBoot, appForeground: true }, true)).toBe('tracking')
    expect(nextEmittedMode(null, { ...freshBoot, phase: 'active' }, true)).toBe('tracking')
  })

  test('a hydrated in-flight trip keeps tracking through and past the grace', () => {
    // The trip checkpoint rehydrates before the first location:update, so a
    // wake mid-drive must not be demoted at any point.
    const midDrive = { ...freshBoot, phase: 'active', sinceBootMs: MODE_BOOT_GRACE_MS * 10 }
    expect(nextEmittedMode('tracking', midDrive, true)).toBeNull()
    expect(nextEmittedMode('idle', midDrive, true)).toBe('tracking')
  })

  test('callers that do not pass sinceBootMs are unaffected', () => {
    const { sinceBootMs, ...noBoot } = freshBoot
    expect(nextEmittedMode(null, noBoot, true)).toBe('idle')
  })
})

