// Transition retention policy (storage audit 2026-06-22 follow-up).
//
// Geofence enter/exit events are written to the durable per-circle
// Autobase as `transition:{ts}:{pubkey}:{placeId}` (see appendTransition
// in src/bare.js). The original wire-protocol proposal stored them
// append-only with no retention, exactly the unbounded-durable-write
// shape that wedged circles via lastSeen (~340k ops). Volume is far
// lower than lastSeen (a handful per active member per day, not per
// fix), but it is still unbounded: the read path caps at the newest 50
// and the notification path has a freshness gate, yet nothing ever
// reclaimed storage.
//
// This mirrors the trip-retention design (src/lib/tripRetention.js),
// which already proved the pattern. Transition records older than
// TRANSITION_RETENTION_MS are dropped at two points:
//   1. Apply-branch filter in src/bare.js — newly-replicated
//      transition:* records with a stale ts are never view.put. Bounds
//      growth from late-syncing peers and cold-boot replay.
//   2. Periodic sweep — scans each per-circle autobase view transition:*
//      and view.del expired records. Catches anything already stored
//      before this lands.
//
// 90 days (vs trips' 14) because transitions are tiny and far lower
// volume, and a user reviewing their activity feed reasonably expects a
// longer history than a per-trip polyline list. View deletes are
// local-only (Hyperbee on top of the autobase log) so each peer prunes
// its own copy; re-replication of expired records is blocked by rule 1.

const TRANSITION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

function transitionIsExpired (transition, now, retentionMs = TRANSITION_RETENTION_MS) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return false
  // Non-numeric ts (defensive) → not expired: we'd rather keep a
  // malformed record than silently delete real history.
  const ts = transition?.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
  return now - ts > retentionMs
}

module.exports = { TRANSITION_RETENTION_MS, transitionIsExpired }
