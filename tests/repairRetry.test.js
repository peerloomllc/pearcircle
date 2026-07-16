const {
  REPAIR_MAX_ATTEMPTS,
  repairAttempts,
  repairEscalated,
  recordRepairFailure,
  shouldRetryStagedRepair,
} = require('../src/lib/repairRetry')

describe('repairAttempts', () => {
  test('reads the persisted count', () => {
    expect(repairAttempts({ ts: 1, attempts: 2 })).toBe(2)
  })

  test('a value written before this proposal has no count and reads as 0', () => {
    // The old staged path persisted exactly { ts }. Upgrading must not look
    // like a circle that has already burned its attempts.
    expect(repairAttempts({ ts: 1738000000000 })).toBe(0)
  })

  test('missing / malformed values are 0 (never a spurious escalation)', () => {
    expect(repairAttempts(undefined)).toBe(0)
    expect(repairAttempts(null)).toBe(0)
    expect(repairAttempts({})).toBe(0)
    expect(repairAttempts({ attempts: NaN })).toBe(0)
    expect(repairAttempts({ attempts: -3 })).toBe(0)
    expect(repairAttempts({ attempts: 'two' })).toBe(0)
    expect(repairAttempts({ attempts: 2.7 })).toBe(2)
  })
})

describe('recordRepairFailure', () => {
  test('counts up from nothing and does not escalate on the first failure', () => {
    const v = recordRepairFailure(undefined, 1000)
    expect(v).toEqual({ ts: 1000, attempts: 1, escalated: false })
  })

  test('escalates exactly on the REPAIR_MAX_ATTEMPTS-th failure', () => {
    // The original circle:repair, then two foreground retries.
    let v = recordRepairFailure(undefined, 1)
    expect(v.escalated).toBe(false)
    v = recordRepairFailure(v, 2)
    expect(v.attempts).toBe(2)
    expect(v.escalated).toBe(false)
    v = recordRepairFailure(v, 3)
    expect(v.attempts).toBe(REPAIR_MAX_ATTEMPTS)
    expect(v.escalated).toBe(true)
  })

  test('stays escalated past the threshold', () => {
    const v = recordRepairFailure({ attempts: REPAIR_MAX_ATTEMPTS }, 4)
    expect(v.attempts).toBe(REPAIR_MAX_ATTEMPTS + 1)
    expect(v.escalated).toBe(true)
  })

  test('round-trips through a persisted value (survives a restart)', () => {
    const stored = JSON.parse(JSON.stringify(recordRepairFailure(undefined, 1000)))
    const next = recordRepairFailure(stored, 2000)
    expect(next).toEqual({ ts: 2000, attempts: 2, escalated: false })
  })

  test('tolerates a missing clock rather than persisting NaN', () => {
    expect(recordRepairFailure(undefined, undefined).ts).toBe(0)
  })
})

describe('repairEscalated', () => {
  test('reads the persisted flag back on boot', () => {
    expect(repairEscalated({ attempts: 3, escalated: true })).toBe(true)
  })

  test('falls back to the count if the flag is absent', () => {
    expect(repairEscalated({ attempts: REPAIR_MAX_ATTEMPTS })).toBe(true)
    expect(repairEscalated({ attempts: 1 })).toBe(false)
  })

  test('old and empty values are not escalated', () => {
    expect(repairEscalated({ ts: 1738000000000 })).toBe(false)
    expect(repairEscalated(undefined)).toBe(false)
  })
})

describe('shouldRetryStagedRepair', () => {
  test('retries a staged circle', () => {
    expect(shouldRetryStagedRepair({ staged: true, escalated: false, inFlight: false })).toBe(true)
  })

  test('nothing to do when the circle is not staged', () => {
    expect(shouldRetryStagedRepair({ staged: false, escalated: false, inFlight: false })).toBe(false)
  })

  test('stops retrying once escalated (the mount is not converging)', () => {
    // Otherwise every foreground burns another 18s mount timeout forever.
    expect(shouldRetryStagedRepair({ staged: true, escalated: true, inFlight: false })).toBe(false)
  })

  test('does not stack a second mount while one is in flight', () => {
    // A fast background/foreground toggle fires app:state twice; the first
    // attempt is still inside the mount race.
    expect(shouldRetryStagedRepair({ staged: true, escalated: false, inFlight: true })).toBe(false)
  })

  test('fails closed on missing input', () => {
    expect(shouldRetryStagedRepair()).toBe(false)
    expect(shouldRetryStagedRepair({})).toBe(false)
  })
})
