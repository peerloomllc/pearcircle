const { createStoreFlusher, createStoreCompactor } = require('../src/lib/storeFlush')

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

// A fake store whose compactRange() resolves on demand so we can hold a
// compaction "in flight" and assert coalescing. flush() resolves immediately.
function makeCompactStore ({ readOnly = false } = {}) {
  let resolve
  const order = []
  const db = {
    flush () { order.push('flush'); return Promise.resolve() },
    compactRange (start, end) {
      order.push(['compact', start ?? null, end ?? null])
      return new Promise((res) => { resolve = res })
    },
  }
  return { storage: { db, readOnly }, order, settle: () => resolve() }
}

describe('createStoreCompactor', () => {
  test('no store yet -> returns false, never throws', async () => {
    const compact = createStoreCompactor({ getStore: () => null })
    expect(await compact('boot')).toBe(false)
  })

  test('read-only store is skipped', async () => {
    const store = makeCompactStore({ readOnly: true })
    const compact = createStoreCompactor({ getStore: () => store })
    expect(await compact('interval')).toBe(false)
    expect(store.order.length).toBe(0)
  })

  test('flushes first, then compacts the whole keyspace, and marks', async () => {
    const store = makeCompactStore()
    const marks = []
    const compact = createStoreCompactor({ getStore: () => store, mark: (n, x) => marks.push([n, x]) })
    const p = compact('boot')
    await new Promise((r) => setImmediate(r)) // let the flush await resolve so compactRange is invoked
    store.settle()
    expect(await p).toBe(true)
    // flush precedes compact; compact is whole-keyspace (null, null)
    expect(store.order).toEqual(['flush', ['compact', null, null]])
    expect(marks).toEqual([['store:compact', { reason: 'boot' }]])
  })

  test('coalesces a concurrent compaction while one is in flight', async () => {
    const store = makeCompactStore()
    const compact = createStoreCompactor({ getStore: () => store })
    const first = compact('boot')
    const second = compact('interval') // arrives mid-flight
    expect(await second).toBe(false)
    store.settle()
    expect(await first).toBe(true)
  })

  test('swallows compact errors, warns, and resets the latch', async () => {
    const warnings = []
    const store = {
      storage: { readOnly: false, db: { flush: () => Promise.resolve(), compactRange: () => Promise.reject(new Error('io')) } },
    }
    const compact = createStoreCompactor({ getStore: () => store, warn: (...a) => warnings.push(a) })
    expect(await compact('interval')).toBe(false)
    expect(warnings.length).toBe(1)
    store.storage.db.compactRange = () => Promise.resolve()
    expect(await compact('interval')).toBe(true)
  })

  test('a flush error does not abort the compaction', async () => {
    const order = []
    const store = {
      storage: { readOnly: false, db: {
        flush: () => { order.push('flush'); return Promise.reject(new Error('flush failed')) },
        compactRange: () => { order.push('compact'); return Promise.resolve() },
      } },
    }
    const compact = createStoreCompactor({ getStore: () => store })
    expect(await compact('boot')).toBe(true)
    expect(order).toEqual(['flush', 'compact'])
  })
})
