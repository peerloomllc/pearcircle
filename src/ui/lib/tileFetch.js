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
    const res = await origFetch(input, init)
    if (res.ok || res.status === 206) {
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

