// IndexedDB-backed tile cache with LRU eviction.
//
// Two flavors of cached tiles coexist:
//   - Behavior-driven (region = null): the user viewed this tile while
//     browsing the map. Subject to LRU eviction when the cache exceeds
//     its configured size ceiling.
//   - Region-pinned (region = some id): the user explicitly downloaded
//     a region for offline use. Survives LRU eviction; only removed by
//     deleting the region entirely.
//
// Total-bytes is tracked in a meta key so eviction decisions don't have
// to walk every entry on each put. The meta total is updated inside the
// same transaction as the put / delete so it stays consistent across
// concurrent operations.

const DB_NAME = 'pearcircle-tiles'
const DB_VERSION = 1
const STORE_TILES = 'tiles'
const STORE_REGIONS = 'regions'
const STORE_META = 'meta'
const META_KEY_TOTAL = 'totalBytes'
const META_KEY_CONFIG = 'config'

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024 // 500 MB

export async function openTileCache (opts = {}) {
  const db = await openDb()
  // Hydrate or initialize config + total.
  const config = await getMeta(db, META_KEY_CONFIG) ?? { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES }
  if (opts.maxBytes != null && opts.maxBytes !== config.maxBytes) {
    config.maxBytes = opts.maxBytes
    await putMeta(db, META_KEY_CONFIG, config)
  }
  const totalRow = await getMeta(db, META_KEY_TOTAL)
  if (!totalRow) await putMeta(db, META_KEY_TOTAL, { bytes: 0 })

  return {
    async get (url) {
      return readTile(db, url)
    },
    async put (url, blob, { contentType = '', region = null, contentRange = '', status = 200 } = {}) {
      return writeTile(db, url, blob, contentType, region, config, contentRange, status)
    },
    async delete (url) {
      return deleteTile(db, url)
    },
    async stats () {
      const totalRow = await getMeta(db, META_KEY_TOTAL)
      const count = await countStore(db, STORE_TILES)
      return {
        totalBytes: totalRow?.bytes ?? 0,
        count,
        maxBytes: config.maxBytes,
      }
    },
    async listRegions () {
      return listAll(db, STORE_REGIONS)
    },
    async getRegion (regionId) {
      return readStore(db, STORE_REGIONS, regionId)
    },
    async upsertRegion (region) {
      return writeStore(db, STORE_REGIONS, region.id, region)
    },
    async deleteRegion (regionId) {
      return deleteRegionAndTiles(db, regionId)
    },
    async clear () {
      // Wipes behavior-driven tiles only -- region downloads survive.
      return clearLRUTiles(db)
    },
    async clearAll () {
      return clearEverything(db)
    },
    async setMaxBytes (bytes) {
      config.maxBytes = bytes
      await putMeta(db, META_KEY_CONFIG, config)
      await evictIfOver(db, config)
    },
    get maxBytes () { return config.maxBytes },
    close () { db.close() },
  }
}

// --- IndexedDB plumbing ---

function openDb () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_TILES)) {
        const store = db.createObjectStore(STORE_TILES, { keyPath: 'url' })
        store.createIndex('lastAccessedAt', 'lastAccessedAt')
        store.createIndex('region', 'region')
      }
      if (!db.objectStoreNames.contains(STORE_REGIONS)) {
        db.createObjectStore(STORE_REGIONS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx (db, stores, mode = 'readonly') {
  return db.transaction(stores, mode)
}

function asPromise (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getMeta (db, key) {
  return asPromise(tx(db, STORE_META).objectStore(STORE_META).get(key))
    .then((row) => row?.value ?? null)
}

function putMeta (db, key, value) {
  return asPromise(tx(db, STORE_META, 'readwrite').objectStore(STORE_META).put({ key, value }))
}

function readStore (db, store, key) {
  return asPromise(tx(db, store).objectStore(store).get(key))
}

function writeStore (db, store, key, value) {
  return asPromise(tx(db, store, 'readwrite').objectStore(store).put(value))
}

function listAll (db, store) {
  return asPromise(tx(db, store).objectStore(store).getAll())
}

function countStore (db, store) {
  return asPromise(tx(db, store).objectStore(store).count())
}

async function readTile (db, url) {
  const row = await asPromise(tx(db, STORE_TILES).objectStore(STORE_TILES).get(url))
  if (!row) return null
  // Touch the lastAccessedAt for LRU. Done in a separate readwrite tx
  // so reads stay fast (no blocking on the touch); the next read after
  // a concurrent eviction might race, but that's harmless -- worst case
  // a tile gets evicted then re-fetched.
  touchTile(db, url).catch(() => {})
  return {
    blob: row.blob,
    contentType: row.contentType,
    contentRange: row.contentRange || '',
    status: row.status || 200,
  }
}

async function touchTile (db, url) {
  const transaction = tx(db, STORE_TILES, 'readwrite')
  const store = transaction.objectStore(STORE_TILES)
  const row = await asPromise(store.get(url))
  if (!row) return
  row.lastAccessedAt = Date.now()
  await asPromise(store.put(row))
}

async function writeTile (db, url, blob, contentType, region, config, contentRange, status) {
  const size = blob.size
  const transaction = tx(db, [STORE_TILES, STORE_META], 'readwrite')
  const tiles = transaction.objectStore(STORE_TILES)
  const meta = transaction.objectStore(STORE_META)
  const existing = await asPromise(tiles.get(url))
  const now = Date.now()
  const totalRow = await asPromise(meta.get(META_KEY_TOTAL))
  let total = totalRow?.value?.bytes ?? 0
  if (existing) total -= existing.size
  total += size
  await asPromise(tiles.put({
    url,
    blob,
    contentType,
    contentRange,
    status,
    size,
    region,
    lastAccessedAt: now,
    createdAt: existing?.createdAt ?? now,
  }))
  await asPromise(meta.put({ key: META_KEY_TOTAL, value: { bytes: total } }))
  // Eviction runs outside this transaction so we don't block writes.
  if (total > config.maxBytes) {
    evictIfOver(db, config).catch(() => {})
  }
}

async function deleteTile (db, url) {
  const transaction = tx(db, [STORE_TILES, STORE_META], 'readwrite')
  const tiles = transaction.objectStore(STORE_TILES)
  const meta = transaction.objectStore(STORE_META)
  const existing = await asPromise(tiles.get(url))
  if (!existing) return false
  const totalRow = await asPromise(meta.get(META_KEY_TOTAL))
  const total = (totalRow?.value?.bytes ?? 0) - existing.size
  await asPromise(tiles.delete(url))
  await asPromise(meta.put({ key: META_KEY_TOTAL, value: { bytes: Math.max(0, total) } }))
  return true
}

async function evictIfOver (db, config) {
  const totalRow = await getMeta(db, META_KEY_TOTAL)
  let total = totalRow?.bytes ?? 0
  if (total <= config.maxBytes) return
  // Evict oldest non-region tiles via the lastAccessedAt index until we
  // hit 90% of the ceiling (leaves headroom to absorb the next batch
  // of incoming tiles without re-evicting on every put).
  const target = config.maxBytes * 0.9
  const transaction = tx(db, [STORE_TILES, STORE_META], 'readwrite')
  const tiles = transaction.objectStore(STORE_TILES)
  const meta = transaction.objectStore(STORE_META)
  const index = tiles.index('lastAccessedAt')
  const cursorReq = index.openCursor()
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result
      if (!cursor || total <= target) { resolve(); return }
      const row = cursor.value
      if (row.region != null) {
        cursor.continue()
        return
      }
      total -= row.size
      cursor.delete()
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
  await asPromise(meta.put({ key: META_KEY_TOTAL, value: { bytes: Math.max(0, total) } }))
}

async function clearLRUTiles (db) {
  // Iterate by region index, deleting only entries with region == null.
  // IDBKeyRange.only(null) doesn't work everywhere; cursor-with-filter
  // is portable.
  const transaction = tx(db, [STORE_TILES, STORE_META], 'readwrite')
  const tiles = transaction.objectStore(STORE_TILES)
  const meta = transaction.objectStore(STORE_META)
  const cursorReq = tiles.openCursor()
  let freed = 0
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result
      if (!cursor) { resolve(); return }
      const row = cursor.value
      if (row.region == null) {
        freed += row.size
        cursor.delete()
      }
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
  const totalRow = await asPromise(meta.get(META_KEY_TOTAL))
  const total = Math.max(0, (totalRow?.value?.bytes ?? 0) - freed)
  await asPromise(meta.put({ key: META_KEY_TOTAL, value: { bytes: total } }))
  return freed
}

async function clearEverything (db) {
  const transaction = tx(db, [STORE_TILES, STORE_REGIONS, STORE_META], 'readwrite')
  await asPromise(transaction.objectStore(STORE_TILES).clear())
  await asPromise(transaction.objectStore(STORE_REGIONS).clear())
  await asPromise(transaction.objectStore(STORE_META).put({ key: META_KEY_TOTAL, value: { bytes: 0 } }))
}

async function deleteRegionAndTiles (db, regionId) {
  const transaction = tx(db, [STORE_TILES, STORE_REGIONS, STORE_META], 'readwrite')
  const tiles = transaction.objectStore(STORE_TILES)
  const regions = transaction.objectStore(STORE_REGIONS)
  const meta = transaction.objectStore(STORE_META)
  const index = tiles.index('region')
  const cursorReq = index.openCursor(IDBKeyRange.only(regionId))
  let freed = 0
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result
      if (!cursor) { resolve(); return }
      freed += cursor.value.size
      cursor.delete()
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
  await asPromise(regions.delete(regionId))
  const totalRow = await asPromise(meta.get(META_KEY_TOTAL))
  const total = Math.max(0, (totalRow?.value?.bytes ?? 0) - freed)
  await asPromise(meta.put({ key: META_KEY_TOTAL, value: { bytes: total } }))
  return freed
}
