const { createStoreFlusher } = require('../src/lib/storeFlush')

// A fake rocksdb-native handle whose flush() resolves on demand, so we can
// hold a flush "in flight" and assert the coalescing behaviour.
function makeStore ({ readOnly = false } = {}) {
  let resolve
  const calls = []
  const db = {
    flush () {
      const p = new Promise((res) => { resolve = res })
      calls.push(p)
      return p
    },
  }
  return {
    storage: { db, readOnly },
    calls,
    settle: () => resolve(),
  }
}

describe('createStoreFlusher', () => {
  test('no store yet -> returns false, never throws', async () => {
    const flush = createStoreFlusher({ getStore: () => null })
    expect(await flush('init')).toBe(false)
  })

  test('read-only store is skipped', async () => {
    const store = makeStore({ readOnly: true })
    const flush = createStoreFlusher({ getStore: () => store })
    expect(await flush('interval')).toBe(false)
    expect(store.calls.length).toBe(0)
  })

  test('flushes the memtable and marks on success', async () => {
    const store = makeStore()
    const marks = []
    const flush = createStoreFlusher({ getStore: () => store, mark: (n, x) => marks.push([n, x]) })
    const p = flush('background')
    expect(store.calls.length).toBe(1)
    store.settle()
    expect(await p).toBe(true)
    expect(marks).toEqual([['store:flush', { reason: 'background' }]])
  })

  test('coalesces a concurrent flush while one is in flight', async () => {
    const store = makeStore()
    const flush = createStoreFlusher({ getStore: () => store })
    const first = flush('interval')
    const second = flush('background') // arrives mid-flight
    expect(await second).toBe(false)   // coalesced, no second db.flush
    expect(store.calls.length).toBe(1)
    store.settle()
    expect(await first).toBe(true)
  })

  test('allows a new flush after the prior one settles', async () => {
    const store = makeStore()
    const flush = createStoreFlusher({ getStore: () => store })
    const first = flush('interval')
    store.settle()
    await first
    const second = flush('interval')
    expect(store.calls.length).toBe(2)
    store.settle()
    expect(await second).toBe(true)
  })

  test('swallows flush errors, warns, and resets the in-flight latch', async () => {
    const warnings = []
    const store = {
      storage: { readOnly: false, db: { flush: () => Promise.reject(new Error('disk full')) } },
    }
    const flush = createStoreFlusher({ getStore: () => store, warn: (...a) => warnings.push(a) })
    expect(await flush('interval')).toBe(false)
    expect(warnings.length).toBe(1)
    // latch reset: a later (succeeding) flush still runs
    store.storage.db.flush = () => Promise.resolve()
    expect(await flush('interval')).toBe(true)
  })
})
