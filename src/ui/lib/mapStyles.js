// Map style presets for Settings -> Map tiles.
//
// Street is OpenFreeMap: free, no key. Satellite is MapTiler's "hybrid"
// style (satellite imagery with road and place labels on top). No free
// satellite source is sharp enough to show houses, so satellite asks the
// user for their own MapTiler key. We ship no key and pay nothing.
//
// Only the style URL is persisted (AsyncStorage via shell:tileStyle:set),
// so the key travels inside the satellite URL. The key is also kept in
// localStorage so switching back to Street and then to Satellite again
// does not ask for it a second time.

export const STREET_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

const SATELLITE_PREFIX = 'https://api.maptiler.com/maps/hybrid/style.json'
const KEY_STORAGE = 'pc:maptilerKey'

export const MAPTILER_SIGNUP_URL = 'https://cloud.maptiler.com/account/keys/'

export function satelliteStyleUrl (key) {
  return `${SATELLITE_PREFIX}?key=${encodeURIComponent(String(key ?? '').trim())}`
}

export function isSatelliteStyle (url) {
  return typeof url === 'string' && url.startsWith(SATELLITE_PREFIX)
}

export function keyFromSatelliteStyle (url) {
  if (!isSatelliteStyle(url)) return null
  try {
    return new URL(url).searchParams.get('key') || null
  } catch {
    return null
  }
}

// 'street' | 'satellite' | 'custom'. A null or empty URL means the
// default, which is Street.
export function styleMode (url) {
  if (!url || url === STREET_STYLE_URL) return 'street'
  if (isSatelliteStyle(url)) return 'satellite'
  return 'custom'
}

// MapTiler keys are letters and digits. Rejects pasted URLs or text with
// spaces before we make a network call.
export function validateMaptilerKey (key) {
  const k = String(key ?? '').trim()
  if (!k) return 'Paste your MapTiler key'
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(k)) return 'That does not look like a MapTiler key'
  return null
}

export function loadSavedKey () {
  try { return localStorage.getItem(KEY_STORAGE) || null } catch { return null }
}

export function saveKey (key) {
  try { localStorage.setItem(KEY_STORAGE, String(key).trim()) } catch {}
}

// Fetch the satellite style once before saving, so a wrong key shows an
// error in Settings instead of a blank map.
export async function checkSatelliteKey (key, fetchImpl) {
  const f = fetchImpl || (typeof window !== 'undefined' && (window.__pearOrigFetch || window.fetch?.bind(window)))
  let res
  try {
    res = await f(satelliteStyleUrl(key))
  } catch {
    return 'Could not reach MapTiler. Check your connection.'
  }
  if (res.status === 401 || res.status === 403) return 'MapTiler did not accept that key'
  if (!res.ok) return `MapTiler returned an error (${res.status})`
  return null
}

// Credit line under the map. MapTiler's terms require crediting MapTiler
// as well as OpenStreetMap when its tiles are shown.
export function mapCredit (url) {
  return isSatelliteStyle(url)
    ? '© MapTiler © OpenStreetMap contributors'
    : '© OpenStreetMap contributors'
}
