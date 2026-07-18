// JS-side geofence math. We don't use Play Services GeofencingClient
// because GrapheneOS's gmscompat layer doesn't implement it, and OS
// geofencing is famously unreliable on stock Android too (Doze, App
// Standby, OEM aggression). Continuous distance checks against the
// stream of foreground location updates are simpler, portable, and
// reliable for the foreground/recently-foreground case that matters
// in v1. Background-survival is a separate hardening slice.

const EARTH_RADIUS_M = 6371000

// Minimum Place radius, in metres. iOS OS-level region monitoring geofences
// off cell towers and wifi rather than the GPS chip, so a CLCircularRegion
// much below ~100-150m is unreliable: didEnterRegion / didExitRegion often
// never fire, especially on a device moving through by car. 150m is the
// practical floor. This serves two roles:
//   - the minimum we accept in place:create / place:update (and the UI),
//     so no NEW Place is ever defined below the reliable floor.
//   - the value we clamp the OS-region copy up to for LEGACY Places already
//     stored below it (pushRegionsToShell). The JS classifier keeps each
//     Place's precise radiusMeters -- it runs against real GPS fixes and can
//     be tighter than the OS layer.
const MIN_PLACE_RADIUS_M = 150

// A fix whose reported horizontal accuracy (radius of uncertainty, metres) is
// worse than this is too blurry to drive a geofence transition and is ignored
// by the classifier. On GrapheneOS a phone sitting still at home loses the GPS
// chip and falls back to network/wifi location, which routinely reports a
// position hundreds of metres off the truth with a large error radius; a lone
// such fix bounces an at-home user "outside" a 400m radius and the next clean
// fix bounces them back, producing the phantom "left … / arrived …" pair. The
// gate is applied at ingest (checkPlaceTransitions), so a gated fix still
// updates lastSeen / the map, it just can't move geofence state. A fix with no
// accuracy supplied (older callers, unit tests) is trusted. See
// bugfix/geofence-flap-hardening (2026-07-18).
const ACCURACY_CEILING_M = 150

// Number of consecutive usable fixes that must agree on a boundary crossing
// before the classifier commits it. Network-location noise arrives as isolated
// outliers, so requiring a second confirming fix (~10s apart on the device
// stream) discards the single-outlier flap while adding only one fix of latency
// to a genuine crossing.
const DWELL_FIXES = 2

// Is this fix confident enough to drive a transition? False only when a finite
// accuracy is supplied AND it exceeds the ceiling. Absent/NaN accuracy is
// trusted (preserves older-caller and unit-test behaviour).
function isFixUsable (accuracy) {
  return !(Number.isFinite(accuracy) && accuracy > ACCURACY_CEILING_M)
}

function haversineMeters (lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// Pure state machine for transition detection. Given a measured distance to a
// place's centre, the place's radius, the previous confirmed classification,
// the fix's accuracy, and the running dwell state, returns the next confirmed
// classification, a transition kind if a crossing was committed this fix, and
// the next dwell state.
//
// `prev` is one of:
//   null       — no baseline yet (first-ever observation, or cold start
//                before classification was persisted). Establishes the
//                baseline silently; no transition fires. Notifications
//                only happen when the user actually crosses the boundary.
//   'inside'   — last confirmed observation was within the radius
//   'outside'  — last confirmed observation was outside the radius
//
// Two layers of anti-flap protection, both replacing the old capped exit
// margin (which let a garbage fix past `radius + radius` still fire an exit,
// and left entry entirely undamped — the 2026-07-18 flap bug):
//
//   1. Uncertainty-circle read. `accuracy` (metres, optional) is the fix's own
//      horizontal error radius. A fix reads 'outside' only if even its NEAREST
//      edge clears the boundary (`distance - accuracy > radius`), and 'inside'
//      only if its FARTHEST edge is within (`distance + accuracy <= radius`).
//      In the ambiguous band between, the fix supports neither side and the
//      confirmed state holds. This is symmetric: a blurry fix can neither
//      exit nor enter. Absent/zero accuracy collapses to the plain
//      distance-vs-radius read (older callers, unit tests).
//
//   2. Dwell. A fix that disagrees with the confirmed state is only a
//      CANDIDATE crossing; `DWELL_FIXES` consecutive supporting fixes are
//      required before the crossing is committed and a kind fires. Any fix
//      that agrees with the confirmed state — or is ambiguous — clears a
//      half-formed candidate, so a lone outlier can never accumulate.
//
// `dwell` is `{ pending, count }` (the value returned by the previous call);
// `pending` is the candidate side awaiting confirmation ('inside'/'outside'/
// null) and `count` how many consecutive fixes have supported it. Omit it on
// the first call. It is in-memory runtime state only — never persisted — so a
// cold boot simply re-confirms, no correctness loss.
//
// Returns `{ classification, kind, dwell }` where kind is 'enter', 'exit', or
// null.
function classify (distance, radius, prev, accuracy, dwell) {
  const acc = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0
  const priorPending =
    dwell && (dwell.pending === 'inside' || dwell.pending === 'outside')
      ? dwell.pending
      : null
  const priorCount = dwell && Number.isFinite(dwell.count) ? dwell.count : 0
  const cleared = { pending: null, count: 0 }

  // Uncertainty-circle read of this single fix (layer 1).
  let observation = null
  if (distance - acc > radius) observation = 'outside'
  else if (distance + acc <= radius) observation = 'inside'

  // No confirmed baseline yet: a confident observation establishes it silently;
  // an ambiguous fix leaves us unbaselined. Never fires a transition.
  if (prev !== 'inside' && prev !== 'outside') {
    return { classification: observation != null ? observation : (prev != null ? prev : null), kind: null, dwell: cleared }
  }

  // Fix agrees with the confirmed state, or is ambiguous: hold, and drop any
  // half-formed candidate so a stray fix can't accumulate toward a crossing.
  if (observation === null || observation === prev) {
    return { classification: prev, kind: null, dwell: cleared }
  }

  // Fix disagrees with the confirmed state: a candidate crossing (layer 2).
  const count = priorPending === observation ? priorCount + 1 : 1
  if (count >= DWELL_FIXES) {
    return {
      classification: observation,
      kind: observation === 'inside' ? 'enter' : 'exit',
      dwell: cleared,
    }
  }
  return { classification: prev, kind: null, dwell: { pending: observation, count } }
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

// Decide what to do with a fresh (non-deduped) crossing given whether the
// circle is sharing-enabled and whether its writer is ready to append. The
// load-bearing case is sharing-on + writer-NOT-writable: the caller MUST queue
// the crossing and leave the classifier untouched, never advance-and-drop it.
// iOS fires didEnterRegion/didExitRegion exactly once at the boundary, so
// advancing the persisted classification while dropping the append would
// strand the crossing forever -- no notification, no history, no re-fire
// (proposal 2026-07-01). Pure.
//   'append' -> writer ready: append, then advance the classifier.
//   'queue'  -> writer not ready: stash for the writable flush; do NOT advance.
//   'muted'  -> sharing off: advance the dedup classifier but suppress append.
function regionAppendDecision ({ sharing, writable } = {}) {
  if (sharing && !writable) return 'queue'
  if (!sharing) return 'muted'
  return 'append'
}

module.exports = { haversineMeters, classify, isFixUsable, applyRegionEvent, selectNearestRegions, regionAppendDecision, EARTH_RADIUS_M, MIN_PLACE_RADIUS_M, ACCURACY_CEILING_M, DWELL_FIXES }
