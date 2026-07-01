// Trip retention policy (proposal 2026-05-10, retention follow-up).
//
// The trip-replication proposal explicitly deferred auto-retention:
// "Trips accumulate; user manually deletes via the per-trip 'delete'
// affordance. ... If real-world growth becomes a problem, a follow-up
// adds a worklet-side prune at e.g. 90 days."
//
// This is that follow-up. The 90-day suggestion in the proposal was
// a placeholder; the real call lives here. 14 days is the product
// decision: most user-relevant trip review happens within the past
// week or two, and the storage savings on the per-circle autobase
// view (which holds every peer's trips, not just self) are large.
//
// Trip records older than TRIP_RETENTION_MS are dropped at two points:
//   1. Apply-branch filter in src/bare.js — newly-replicated trip:*
//      records with stale endTs are never view.put. Bounds growth from
//      late-syncing peers.
//   2. Periodic sweep — scans local Hyperbee trips:* and each per-
//      circle autobase view trip:* and view.del expired records.
//      Catches anything already stored before this lands.
//
// Soft-delete tombstones (op.value.deleted === true from the user-driven
// trips:delete path) are pruned by the same rule: once the tombstone is
// older than the retention window the underlying trip is too, and a
// re-replication from a 91-day-stale peer would be filtered by rule 1
// anyway.

// 7 days (was 14, 2026-07-01 product decision). Most trip review happens
// within the past week; a shorter window keeps the per-circle autobase view
// (which holds every member's trips, not just self) small and cuts the trip-
// list map render on first open.
const TRIP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// Hard ceiling on trips shown/loaded per member, newest-first (2026-07-01).
// Independent of the time window: even a heavy-driving week can't push the
// trip list (and its map polylines) past this, which is the real UX lever for
// the first-open render lag. Applied at the read boundary (mergeTripStreams
// limit in trips:listFor); storage is bounded by TRIP_RETENTION_MS.
const MAX_TRIPS_PER_MEMBER = 15

function tripIsExpired (trip, now, retentionMs = TRIP_RETENTION_MS) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return false
  // Prefer endTs (when the trip finalized). Fall back to startTs for
  // records missing endTs (defensive — every shipped trip has endTs but
  // an in-flight crash could conceivably persist a partial record).
  // Non-numeric ts → not expired (we'd rather keep a malformed record
  // than silently delete real history).
  const ts = typeof trip?.endTs === 'number' && Number.isFinite(trip.endTs)
    ? trip.endTs
    : (typeof trip?.startTs === 'number' && Number.isFinite(trip.startTs) ? trip.startTs : null)
  if (ts == null) return false
  return now - ts > retentionMs
}

module.exports = { TRIP_RETENTION_MS, MAX_TRIPS_PER_MEMBER, tripIsExpired }
