// JS-side geofence math. We don't use Play Services GeofencingClient
// because GrapheneOS's gmscompat layer doesn't implement it, and OS
// geofencing is famously unreliable on stock Android too (Doze, App
// Standby, OEM aggression). Continuous distance checks against the
// stream of foreground location updates are simpler, portable, and
// reliable for the foreground/recently-foreground case that matters
// in v1. Background-survival is a separate hardening slice.

const EARTH_RADIUS_M = 6371000

function haversineMeters (lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// Pure state machine for transition detection. Given a measured distance
// to a place's centre, the place's radius, and the previous classification,
// returns the next classification and a transition kind if the boundary
// was crossed.
//
// `prev` is one of:
//   null       — no baseline yet (first-ever observation, or cold start
//                before classification was persisted). Establishes the
//                baseline silently; no transition fires. Notifications
//                only happen when the user actually crosses the boundary.
//   'inside'   — last observation was within the radius
//   'outside'  — last observation was outside the radius
//
// Returns `{ classification, kind }` where kind is 'enter', 'exit', or null.
function classify (distance, radius, prev) {
  const inside = distance <= radius
  const next = inside ? 'inside' : 'outside'
  if (prev === null) return { classification: next, kind: null }
  if (prev === 'outside' && inside) return { classification: next, kind: 'enter' }
  if (prev === 'inside' && !inside) return { classification: next, kind: 'exit' }
  return { classification: next, kind: null }
}

// Dedup helper for native CLCircularRegion / GeofencingClient events
// against the JS classifier's running state. When the app is alive AND
// the OS-level region monitor fires didEnterRegion (or exit), the JS
// classifier has likely already seen the boundary cross through the
// regular location:update path and flipped state. Both paths would
// otherwise race to append a transition, producing duplicate rows.
//
// `prev` is the lastClassification value the JS classifier maintains
// per place ('inside' / 'outside' / null). `kind` is 'enter' or 'exit'
// from the native event. Returns:
//   { deduped: true, classification }  // already in target state, skip
//   { deduped: false, classification } // first observation in target,
//                                      // caller must append + persist
//
// null prev is treated as "no baseline yet"; the native event itself
// establishes the baseline (deduped: false). This matches the JS
// classifier's behavior for an unknown-prev observation crossing into
// the target state.
function applyRegionEvent (prev, kind) {
  const target = kind === 'enter' ? 'inside' : kind === 'exit' ? 'outside' : null
  if (target == null) return { deduped: true, classification: prev, invalid: true }
  if (prev === target) return { deduped: true, classification: prev }
  return { deduped: false, classification: target }
}

// Select which Places get the limited OS region-monitoring slots. iOS caps
// an app at 20 simultaneously-monitored regions, so when there are more
// Places than slots (e.g. across multiple circles) we keep the ones NEAREST
// the device's last known position rather than whichever happened to be
// inserted first. Without proximity ranking a user's actual neighbourhood
// could go unmonitored in the background, dropping their real arrivals and
// departures (proposal 2026-05-30 fix 2).
//
// `places` is an array of { lat, lon, radiusMeters, ... }; the returned array
// is a new capped slice preserving each entry's other fields. Invalid
// coords/radius are dropped. With no usable `devicePos` (cold boot before the
// first fix) the input order is kept, matching the old insertion-order
// behavior. Pure.
function selectNearestRegions (places, devicePos, cap) {
  const valid = places.filter((p) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    Number.isFinite(p.radiusMeters) && p.radiusMeters > 0)
  let ordered = valid
  if (devicePos && Number.isFinite(devicePos.lat) && Number.isFinite(devicePos.lon)) {
    ordered = valid
      .map((p) => ({ p, d: haversineMeters(devicePos.lat, devicePos.lon, p.lat, p.lon) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.p)
  }
  return typeof cap === 'number' && cap >= 0 ? ordered.slice(0, cap) : ordered
}

module.exports = { haversineMeters, classify, applyRegionEvent, selectNearestRegions, EARTH_RADIUS_M }
