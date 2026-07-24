const {
  shouldAttemptAppend,
  nextAppendHealth,
  APPEND_FAILS_BEFORE_DEGRADE,
  DEGRADED_PROBE_INTERVAL_MS,
} = require('../src/lib/appendHealth')

const NOW = 1_750_000_000_000

describe('shouldAttemptAppend', () => {
  test('a healthy circle always writes', () => {
    expect(shouldAttemptAppend({ degraded: false })).toEqual({ attempt: true, probe: false })
  })

  test('a degraded circle gets one probe per interval, not a hard block', () => {
    // The old behaviour returned false forever, which made recovery impossible
    // by construction: the flag suppressed the very appends that would clear it.
    const first = shouldAttemptAppend({ degraded: true, lastProbeAt: 0, now: NOW })
    expect(first).toEqual({ attempt: true, probe: true })
    const tooSoon = shouldAttemptAppend({ degraded: true, lastProbeAt: NOW, now: NOW + 1000 })
    expect(tooSoon.attempt).toBe(false)
    const later = shouldAttemptAppend({ degraded: true, lastProbeAt: NOW, now: NOW + DEGRADED_PROBE_INTERVAL_MS })
    expect(later).toEqual({ attempt: true, probe: true })
  })

  test('the interval bounds in-flight appends on a wedged base to one per minute', () => {
    let last = 0
    let attempts = 0
    for (let t = 0; t < 10 * 60_000; t += 5_000) {
      const r = shouldAttemptAppend({ degraded: true, lastProbeAt: last, now: NOW + t })
      if (r.attempt) { attempts++; last = NOW + t }
    }
    expect(attempts).toBe(10) // ten minutes of 5s location fixes -> ten probes
  })
})

describe('nextAppendHealth', () => {
  test('the first attempt after a mount is never condemned for being slow', () => {
    // The measured case: a cold boot's first append blocks on the discovery
    // gate. 10.9s condemned the circle on 2026-07-24; 9.4s did not.
    const r = nextAppendHealth({ ok: false, timedOut: true, firstAttemptDone: false })
    expect(r).toEqual({ degrade: false, clearDegrade: false, streak: 0, firstSlow: true, firstAttemptDone: true })
  })

  test('but a base that never writes still gets condemned eventually', () => {
    // Exempting until the first SUCCESS would mean a dead base is never
    // flagged. The exemption is spent by the first attempt.
    let streak = 0
    let firstAttemptDone = false
    let degraded = false // the caller carries this, from _degradedCircles
    const verdicts = []
    for (let i = 0; i < 5; i++) {
      const r = nextAppendHealth({ ok: false, timedOut: true, streak, firstAttemptDone, degraded })
      streak = r.streak
      firstAttemptDone = r.firstAttemptDone
      if (r.degrade) degraded = true
      verdicts.push(r.degrade)
    }
    // First attempt is exempt, then three consecutive timeouts condemn. The
    // fifth does not re-flag an already-degraded circle.
    expect(verdicts).toEqual([false, false, false, true, false])
  })

  test('takes the full threshold of consecutive timeouts', () => {
    let streak = 0
    for (let i = 0; i < APPEND_FAILS_BEFORE_DEGRADE - 1; i++) {
      const r = nextAppendHealth({ ok: false, timedOut: true, streak, firstAttemptDone: true })
      expect(r.degrade).toBe(false)
      streak = r.streak
    }
    expect(nextAppendHealth({ ok: false, timedOut: true, streak, firstAttemptDone: true }).degrade).toBe(true)
  })

  test('one success resets the streak, so intermittent slowness never accrues', () => {
    const afterTwo = nextAppendHealth({ ok: false, timedOut: true, streak: 1, firstAttemptDone: true })
    expect(afterTwo.streak).toBe(2)
    const success = nextAppendHealth({ ok: true, streak: 2, firstAttemptDone: true })
    expect(success.streak).toBe(0)
  })

  test('a successful append clears a degraded circle', () => {
    // The heart of it: a circle that writes is not broken, whatever we decided
    // a minute ago. Previously only a manual repair could clear the flag.
    const r = nextAppendHealth({ ok: true, degraded: true, streak: 7, firstAttemptDone: true })
    expect(r.clearDegrade).toBe(true)
    expect(r.streak).toBe(0)
  })

  test('success on an already-healthy circle clears nothing', () => {
    expect(nextAppendHealth({ ok: true, degraded: false, firstAttemptDone: true }).clearDegrade).toBe(false)
  })

  test('a rejection is not evidence of a wedge', () => {
    // base closed mid-flight: never degraded before this proposal either.
    const r = nextAppendHealth({ ok: false, timedOut: false, streak: 2, firstAttemptDone: true })
    expect(r.degrade).toBe(false)
    expect(r.firstSlow).toBe(false)
    expect(r.streak).toBe(2) // untouched, neither progress nor penalty
  })

  test('an already-degraded circle is not re-flagged', () => {
    const r = nextAppendHealth({ ok: false, timedOut: true, degraded: true, streak: 99, firstAttemptDone: true })
    expect(r.degrade).toBe(false)
  })

  test('the 2026-07-24 sequence no longer condemns the circle', () => {
    // Cold boot, first append times out at 10.9s, next fix succeeds.
    const slow = nextAppendHealth({ ok: false, timedOut: true, firstAttemptDone: false })
    expect(slow.degrade).toBe(false)
    expect(slow.firstSlow).toBe(true)
    const good = nextAppendHealth({ ok: true, streak: slow.streak, firstAttemptDone: slow.firstAttemptDone })
    expect(good.degrade).toBe(false)
    expect(good.streak).toBe(0)
  })
})
