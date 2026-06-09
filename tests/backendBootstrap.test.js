const { makeStartLock, autostartGateValue } = require('../src/lib/backendBootstrap')

describe('makeStartLock', () => {
  test('runs the body exactly once across concurrent callers (single-writer guard)', async () => {
    let calls = 0
    let release
    const gate = new Promise((r) => { release = r })
    const ensure = makeStartLock(async () => { calls++; await gate })

    // Three near-simultaneous callers, as in an Activity mount racing the
    // headless boot task. All must share one in-flight start.
    const a = ensure()
    const b = ensure()
    const c = ensure()
    expect(calls).toBe(1)
    release()
    await Promise.all([a, b, c])
    expect(calls).toBe(1)
  })

  test('is idempotent after settle: a later call does not re-run the body', async () => {
    let calls = 0
    const ensure = makeStartLock(async () => { calls++ })
    await ensure()
    await ensure()
    await ensure()
    expect(calls).toBe(1)
  })

  test('all callers observe the same resolved value', async () => {
    let n = 0
    const ensure = makeStartLock(async () => { n++; return n })
    const [a, b] = await Promise.all([ensure(), ensure()])
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(await ensure()).toBe(1)
  })

  test('a failed first start is retried, not cached', async () => {
    let calls = 0
    const ensure = makeStartLock(async () => {
      calls++
      if (calls === 1) throw new Error('bundle load failed')
    })
    await expect(ensure()).rejects.toThrow('bundle load failed')
    // Second call re-runs and succeeds.
    await expect(ensure()).resolves.toBeUndefined()
    expect(calls).toBe(2)
    // Now settled: no further runs.
    await ensure()
    expect(calls).toBe(2)
  })

  test('callers queued during an in-flight failing start all reject', async () => {
    let calls = 0
    let fail
    const gate = new Promise((_, reject) => { fail = reject })
    const ensure = makeStartLock(async () => { calls++; await gate })
    const a = ensure()
    const b = ensure()
    expect(calls).toBe(1)
    fail(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })
})

describe('autostartGateValue', () => {
  test('sharing:changed -> mirrors anyEnabled when boolean', () => {
    expect(autostartGateValue({ anyEnabled: true }, 'anyEnabled')).toEqual({ write: true, value: true })
    expect(autostartGateValue({ anyEnabled: false }, 'anyEnabled')).toEqual({ write: true, value: false })
  })

  test('ready -> mirrors sharingAnyEnabled when boolean', () => {
    expect(autostartGateValue({ sharingAnyEnabled: true }, 'sharingAnyEnabled')).toEqual({ write: true, value: true })
    expect(autostartGateValue({ sharingAnyEnabled: false }, 'sharingAnyEnabled')).toEqual({ write: true, value: false })
  })

  test('missing / non-boolean field -> do not touch the gate', () => {
    expect(autostartGateValue({}, 'anyEnabled')).toEqual({ write: false, value: false })
    expect(autostartGateValue({ anyEnabled: 'yes' }, 'anyEnabled')).toEqual({ write: false, value: false })
    expect(autostartGateValue(null, 'anyEnabled')).toEqual({ write: false, value: false })
    expect(autostartGateValue(undefined, 'sharingAnyEnabled')).toEqual({ write: false, value: false })
  })
})
