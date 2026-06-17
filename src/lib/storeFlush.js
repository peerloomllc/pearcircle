// Bound the rocksdb-native write-ahead log by flushing the corestore memtable
// to an on-disk SST on demand. The backend only auto-flushes when the 64 MB
// write buffer fills or on a clean close; a force-killed app rarely closes
// cleanly, so a busy device's first-ever flush is the giant 64 MB one whose
// cold-start replay trips Android's ANR watchdog and wedges the app (root
// cause, device 4fc221b3). Flushing on a cadence keeps the WAL small.
//
// Factored out of bare.js so the coalesce / read-only / error-swallow contract
// is unit-testable without standing up the whole worklet. `getStore` is a
// thunk returning the live Corestore (or null before init) so the flusher
// never closes over a stale reference.
function createStoreFlusher ({ getStore, mark, warn } = {}) {
  let flushing = false

  return async function flushStore (reason) {
    const store = typeof getStore === 'function' ? getStore() : null
    const db = store && store.storage && store.storage.db
    // No store yet, or a read-only (seed-replica) store: nothing to flush.
    if (!db || store.storage.readOnly) return false
    // Coalesce: a flush is already in flight. RocksDB rolls the memtable on
    // flush, so the in-flight one already captures everything committed; a
    // second concurrent flush would be redundant work.
    if (flushing) return false
    flushing = true
    try {
      await db.flush()
      if (typeof mark === 'function') mark('store:flush', { reason })
      return true
    } catch (e) {
      if (typeof warn === 'function') warn('[bare] store flush failed', reason, e && e.message)
      return false
    } finally {
      flushing = false
    }
  }
}

module.exports = { createStoreFlusher }
