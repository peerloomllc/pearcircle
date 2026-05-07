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

module.exports = { haversineMeters, classify, EARTH_RADIUS_M }
