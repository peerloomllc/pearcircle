// Movement gate for lastSeen appends (storage-growth remediation,
// proposal 2026-05-29 Phase 1).
//
// lastSeen is last-writer-wins current position. Appending a
// near-identical position on every native location fix - on Android the
// FusedLocation stream delivers every ~10s with no movement gate, so a
// stationary, sharing phone would append ~8,600 blocks/day/circle - only
// bloats the append-only Autobase core; the peer can see nothing the
// latest value didn't already convey. This gate suppresses an append
// until the device has moved at least minMoveM from the position we last
// actually wrote.
//
// Liveness is the swarm-connected dot (2026-05-17 swarm-live-signal), not
// lastSeen.ts, and freshness-on-open is the foreground one-shot (#63), so
// a stationary phone whose timestamp stops advancing is the already-
// accepted posture. The caller resets its last-appended position on app
// foreground so opening the app still publishes a current fix.

const { haversineMeters } = require('./geofence')

// Distance a device must move before its lastSeen is re-appended. Above
// the iOS native distanceFilter (5m) so the gate is meaningful, below a
// city block. Tunable (proposal open question O2).
const LASTSEEN_MIN_MOVE_M = 20

// Return true when a fix at (lat, lon) should be appended, given the last
// appended position `prev` ({ lat, lon } or null/undefined). The first
// fix for a circle (no prev) always writes.
function shouldAppendLastSeen (prev, lat, lon, minMoveM = LASTSEEN_MIN_MOVE_M) {
  if (!prev || typeof prev.lat !== 'number' || typeof prev.lon !== 'number') return true
  return haversineMeters(lat, lon, prev.lat, prev.lon) >= minMoveM
}

module.exports = { shouldAppendLastSeen, LASTSEEN_MIN_MOVE_M }
