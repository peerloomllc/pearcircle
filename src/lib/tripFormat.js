// Pure formatters and geometry helpers for trip-history rendering.
// Kept out of App.jsx so the math is testable without a DOM.

const METERS_PER_MILE = 1609.344

function formatDistance (meters, unit = 'km') {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return ''
  if (unit === 'miles') {
    const miles = meters / METERS_PER_MILE
    if (miles < 0.1) return `${(miles * 5280).toFixed(0)} ft`
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${miles.toFixed(0)} mi`
  }
  const km = meters / 1000
  if (km < 0.1) return `${meters.toFixed(0)} m`
  return km < 10 ? `${km.toFixed(1)} km` : `${km.toFixed(0)} km`
}

function formatDuration (ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

// Today / Yesterday / "May 8" prefix + locale time. Mirrors the inline
// formatAbsoluteTime in App.jsx but extracted so it can run in node tests.
function formatTripDate (ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const ref = new Date(now)
  const sameDay = d.toDateString() === ref.toDateString()
  const yesterday = new Date(ref)
  yesterday.setDate(ref.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
}

function tripBoundingBox (polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0) return null
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const p of polyline) {
    if (!Array.isArray(p) || p.length < 2) continue
    const [lat, lon] = p
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  if (!Number.isFinite(minLat)) return null
  return { minLat, maxLat, minLon, maxLon }
}

// Equirectangular projection scaled into a (width x height) viewBox with
// uniform aspect (longest geographic side fits the corresponding canvas
// side, the other is centered). Good enough for shape-recognition
// thumbnails -- we are not navigating from these.
function polylineSvgPath (polyline, width, height, padding = 4) {
  const bbox = tripBoundingBox(polyline)
  if (!bbox) return ''
  const innerW = Math.max(1, width - padding * 2)
  const innerH = Math.max(1, height - padding * 2)
  const cosLat = Math.cos((bbox.minLat + bbox.maxLat) / 2 * Math.PI / 180)
  const dLon = Math.max(1e-9, (bbox.maxLon - bbox.minLon) * cosLat)
  const dLat = Math.max(1e-9, (bbox.maxLat - bbox.minLat))
  const scale = Math.min(innerW / dLon, innerH / dLat)
  const drawnW = dLon * scale
  const drawnH = dLat * scale
  const offsetX = padding + (innerW - drawnW) / 2
  const offsetY = padding + (innerH - drawnH) / 2
  let d = ''
  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i]
    if (!Array.isArray(p) || p.length < 2) continue
    const [lat, lon] = p
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    const x = offsetX + ((lon - bbox.minLon) * cosLat) * scale
    const y = offsetY + (bbox.maxLat - lat) * scale
    d += (d === '' ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' '
  }
  return d.trim()
}

// GeoJSON LineString feature for MapLibre sources in the detail view.
function polylineGeoJson (polyline) {
  const coords = []
  if (Array.isArray(polyline)) {
    for (const p of polyline) {
      if (!Array.isArray(p) || p.length < 2) continue
      const [lat, lon] = p
      if (typeof lat === 'number' && typeof lon === 'number') coords.push([lon, lat])
    }
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  }
}

module.exports = {
  formatDistance,
  formatDuration,
  formatTripDate,
  tripBoundingBox,
  polylineSvgPath,
  polylineGeoJson,
  METERS_PER_MILE,
}
