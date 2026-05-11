// Tile-fetch interceptor. Wraps window.fetch so requests to known
// tile-server hosts go through the IndexedDB cache: cache hit returns a
// synthetic Response; cache miss does the real fetch, stores a clone,
// and returns the original. Non-tile requests pass through untouched.
//
// Installation runs once at WebView boot, before MapLibre initializes.
// MapLibre uses window.fetch for all of its requests (style.json,
// sprites, glyph PBFs, vector/raster tiles), so wrapping at this level
// captures every byte without per-source hooks.

// Hostnames whose responses we treat as tile traffic. Currently
// OpenFreeMap (default) and the Protomaps fallback. Add more by
// updating this list; the matcher is hostname-suffix based so any
// subdomain under these registrable domains qualifies.
const CACHEABLE_HOST_SUFFIXES = [
  'openfreemap.org',
  'protomaps.com',
]

// Tile-fetch failure tracker for the reactive offline banner. The
// interceptor tracks a sliding window of recent failures; consumers
// (App.jsx's offline banner) read it via getOfflineState() and react
// when the failure rate crosses a threshold.
const FAILURE_WINDOW_MS = 10_000
const FAILURE_THRESHOLD = 3
const _recentFailures = []  // array of timestamps
let _offlineListeners = []

export function installTileFetchInterceptor ({ cache }) {
  const origFetch = window.fetch.bind(window)
  // Expose the unwrapped fetch so the region downloader can fetch tiles
  // without going through the cache-write side of this interceptor
  // (the downloader owns those writes and tags them with the region).
  window.__pearOrigFetch = origFetch
  window.fetch = async function pearcircleTileFetch (input, init) {
    const url = typeof input === 'string' ? input : input?.url
    const method = (init?.method || (input?.method) || 'GET').toUpperCase()
    if (!url || method !== 'GET' || !isCacheableUrl(url)) {
      return origFetch(input, init)
    }
    // OpenFreeMap (and Protomaps) serve tiles via PMTiles, a single
    // archive file accessed by HTTP Range requests. Each Range is a
    // distinct response, so the cache key must include it. Plain GETs
    // (style.json, sprites, glyph PBFs) cache under the URL alone.
    const rangeHeader = extractHeader(input, init, 'range')
    const cacheKey = rangeHeader ? url + '#' + rangeHeader : url
    try {
      const cached = await cache.get(cacheKey)
      if (cached) {
        return synthesizeResponse(cached, rangeHeader)
      }
    } catch {
      // Cache read failure is not fatal; fall through to network.
    }
    // Cache miss -> real fetch, store a clone if successful, return
    // the original to the caller. Storage runs out of band so
    // MapLibre doesn't pay for the IDB write.
    try {
      const res = await origFetch(input, init)
      if (res.ok || res.status === 206) {
        recordFetchSuccess()
        const clone = res.clone()
        const contentRange = res.headers.get('content-range') || ''
        const status = res.status
        clone.blob().then((blob) => {
          const ct = res.headers.get('content-type') || ''
          cache.put(cacheKey, blob, {
            contentType: ct,
            contentRange,
            status,
          }).catch(() => {})
        }).catch(() => {})
      }
      return res
    } catch (err) {
      // Network failure on a tile fetch. Track it for the offline
      // banner heuristic and rethrow so MapLibre handles its own
      // retry / error state as usual.
      recordFetchFailure()
      throw err
    }
  }
}

function extractHeader (input, init, name) {
  const lower = name.toLowerCase()
  const fromInit = init?.headers
  if (fromInit) {
    if (typeof fromInit.get === 'function') return fromInit.get(name) || fromInit.get(lower) || null
    if (Array.isArray(fromInit)) {
      for (const [k, v] of fromInit) if (k.toLowerCase() === lower) return v
    } else if (typeof fromInit === 'object') {
      for (const k of Object.keys(fromInit)) if (k.toLowerCase() === lower) return fromInit[k]
    }
  }
  if (input?.headers?.get) return input.headers.get(name) || input.headers.get(lower) || null
  return null
}

function synthesizeResponse (cached, requestedRange) {
  // Cached PMTiles range responses come back as 206 with the original
  // Content-Range header so the PMTiles client can verify byte offsets.
  // Non-range responses are plain 200 OK.
  const headers = {}
  if (cached.contentType) headers['content-type'] = cached.contentType
  if (cached.contentRange) headers['content-range'] = cached.contentRange
  const status = cached.status === 206 || cached.contentRange ? 206 : 200
  const statusText = status === 206 ? 'Partial Content' : 'OK'
  return new Response(cached.blob, { status, statusText, headers })
}

function isCacheableUrl (url) {
  try {
    const u = new URL(url)
    for (const suffix of CACHEABLE_HOST_SUFFIXES) {
      if (u.hostname === suffix || u.hostname.endsWith('.' + suffix)) return true
    }
  } catch {
    return false
  }
  return false
}

function recordFetchSuccess () {
  // A successful fetch indicates we're back online; clear the failure
  // window and notify listeners so the offline banner can dismiss.
  if (_recentFailures.length > 0) {
    _recentFailures.length = 0
    notifyOfflineState(false)
  }
}

function recordFetchFailure () {
  const now = Date.now()
  // Prune entries outside the window.
  while (_recentFailures.length > 0 && now - _recentFailures[0] > FAILURE_WINDOW_MS) {
    _recentFailures.shift()
  }
  _recentFailures.push(now)
  if (_recentFailures.length >= FAILURE_THRESHOLD) {
    notifyOfflineState(true)
  }
}

let _lastOfflineState = false
function notifyOfflineState (offline) {
  if (offline === _lastOfflineState) return
  _lastOfflineState = offline
  for (const fn of _offlineListeners) {
    try { fn(offline) } catch {}
  }
}

export function subscribeOfflineState (fn) {
  _offlineListeners.push(fn)
  // Fire current state on subscribe so the consumer can render
  // immediately without waiting for the next failure event.
  try { fn(_lastOfflineState) } catch {}
  return () => {
    _offlineListeners = _offlineListeners.filter((f) => f !== fn)
  }
}

export function getOfflineState () {
  return _lastOfflineState
}
