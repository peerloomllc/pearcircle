// Pre-emptive tile downloader. Given a bbox + zoom range, enumerates
// tile coords from the configured tile source's URL template, fetches
// each tile, and stores it in the cache tagged with a region ID so
// LRU eviction leaves them alone.
//
// Uses raw fetch (via window.__pearOrigFetch saved by tileFetch.js at
// install time) so we don't double-write through the interceptor's
// region=null put. The downloader owns the cache writes and tags them
// explicitly with the region.

const DEFAULT_CONCURRENCY = 12

export function lonLatToTile (lon, lat, z) {
  const n = Math.pow(2, z)
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = lat * Math.PI / 180
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  }
}

// Enumerate every (z, x, y) covering the bbox at zoom levels zMin..zMax.
// bbox is [west, south, east, north] in WGS84 degrees.
export function tilesInBbox (bbox, zMin, zMax) {
  const [w, s, e, n] = bbox
  const out = []
  for (let z = zMin; z <= zMax; z++) {
    const tl = lonLatToTile(w, n, z)
    const br = lonLatToTile(e, s, z)
    const x0 = Math.min(tl.x, br.x)
    const x1 = Math.max(tl.x, br.x)
    const y0 = Math.min(tl.y, br.y)
    const y1 = Math.max(tl.y, br.y)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        out.push({ z, x, y })
      }
    }
  }
  return out
}

export function estimateTilesInBbox (bbox, zMin, zMax) {
  // Cheaper than enumerating -- multiplies the column / row counts at
  // each zoom level without materializing the (z,x,y) list.
  const [w, s, e, n] = bbox
  let total = 0
  for (let z = zMin; z <= zMax; z++) {
    const tl = lonLatToTile(w, n, z)
    const br = lonLatToTile(e, s, z)
    const cols = Math.abs(br.x - tl.x) + 1
    const rows = Math.abs(br.y - tl.y) + 1
    total += cols * rows
  }
  return total
}

// Resolve the {z}/{x}/{y} tile URL template from a MapLibre style URL.
// Walks every source, follows TileJSON references if the source is a
// `url` reference, and returns the highest-priority candidate. Vector
// sources are preferred over raster because most MapLibre styles
// include a raster source only as a low-zoom backdrop (e.g. OpenFreeMap
// Liberty has a `natural_earth_shaded_relief` raster valid only at
// z0..z6, plus the main `openmaptiles` vector source for the rest).
// Picking the raster by accident dooms anything past z6 to 404s.
export async function discoverTileUrlPattern (tileStyleUrl) {
  const fetch = window.__pearOrigFetch || window.fetch.bind(window)
  const styleRes = await fetch(tileStyleUrl)
  if (!styleRes.ok) throw new Error('Could not fetch style.json')
  const style = await styleRes.json()
  const candidates = []
  for (const src of Object.values(style.sources || {})) {
    if (src.type !== 'vector' && src.type !== 'raster') continue
    const pattern = await resolveTilePattern(src, fetch)
    if (pattern) candidates.push({ type: src.type, pattern })
  }
  if (candidates.length === 0) throw new Error('No usable tile source found in style')
  const vector = candidates.find((c) => c.type === 'vector')
  return (vector ?? candidates[0]).pattern
}

async function resolveTilePattern (src, fetch) {
  if (Array.isArray(src.tiles) && src.tiles.length > 0) return src.tiles[0]
  if (typeof src.url === 'string') {
    try {
      const tjRes = await fetch(src.url)
      if (!tjRes.ok) return null
      const tj = await tjRes.json()
      if (Array.isArray(tj.tiles) && tj.tiles.length > 0) return tj.tiles[0]
    } catch {}
  }
  return null
}

export function buildTileUrl (template, z, x, y) {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
}

export async function downloadRegion ({
  bbox,
  zMin,
  zMax,
  regionId,
  name,
  tileStyleUrl,
  cache,
  onProgress,
  signal,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const template = await discoverTileUrlPattern(tileStyleUrl)
  const coords = tilesInBbox(bbox, zMin, zMax)
  const total = coords.length

  const region = {
    id: regionId,
    name,
    bbox,
    zoomMin: zMin,
    zoomMax: zMax,
    totalTiles: total,
    downloadedTiles: 0,
    sizeBytes: 0,
    status: 'downloading',
    startedAt: Date.now(),
    completedAt: null,
  }
  await cache.upsertRegion(region)
  if (onProgress) onProgress({ ...region })

  let downloaded = 0
  let failed = 0
  let bytes = 0
  const rawFetch = window.__pearOrigFetch || window.fetch.bind(window)
  let cursor = 0
  let lastPersist = Date.now()

  // UI updates and IDB persistence have different cost profiles. Live
  // callbacks fire after every tile so the bottom-sheet progress text
  // moves visibly (cheap; React batches its own paints). Persistence
  // to the regions object store throttles to ~1 Hz -- it's only used
  // when the user reopens Settings mid-download, so coarser updates
  // are fine and keep IDB write traffic bounded.
  function emitLive () {
    if (!onProgress) return
    region.downloadedTiles = downloaded
    region.sizeBytes = bytes
    onProgress({ ...region })
  }
  function maybePersist () {
    const now = Date.now()
    if (now - lastPersist < 1000) return
    lastPersist = now
    region.downloadedTiles = downloaded
    region.sizeBytes = bytes
    cache.upsertRegion({ ...region }).catch(() => {})
  }

  async function worker () {
    while (cursor < coords.length && !signal?.aborted) {
      const idx = cursor++
      const { z, x, y } = coords[idx]
      const url = buildTileUrl(template, z, x, y)
      try {
        const existing = await cache.get(url)
        if (existing) {
          // Already cached -- promote to this region so it's protected
          // from LRU eviction.
          await cache.put(url, existing.blob, {
            contentType: existing.contentType,
            region: regionId,
          })
          downloaded++
          bytes += existing.blob.size
        } else {
          const res = await rawFetch(url)
          if (res.ok) {
            const blob = await res.blob()
            const ct = res.headers.get('content-type') || ''
            await cache.put(url, blob, { contentType: ct, region: regionId })
            downloaded++
            bytes += blob.size
          } else {
            failed++
          }
        }
      } catch {
        failed++
      }
      emitLive()
      maybePersist()
    }
  }

  const workers = []
  for (let i = 0; i < concurrency; i++) workers.push(worker())
  await Promise.all(workers)

  region.downloadedTiles = downloaded
  region.sizeBytes = bytes
  if (signal?.aborted) {
    region.status = 'cancelled'
  } else if (failed > 0 && downloaded === 0) {
    region.status = 'failed'
  } else {
    region.status = 'complete'
  }
  region.completedAt = Date.now()
  await cache.upsertRegion({ ...region })
  if (onProgress) onProgress({ ...region })
  return { region, downloaded, failed, bytes }
}
