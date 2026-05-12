// Pure helpers backing the per-circle trip replication wire (proposal
// 2026-05-10). bare.js delegates the per-row decisions to these so
// they can be exercised without standing up a real autobase + view.

const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

// Fixed-width key suffix so lexicographic prefix scans return
// chronological order. 13 digits covers up to year 2286 in epoch ms.
function padTripStartTs (ts) {
  return String(ts).padStart(13, '0')
}

// Apply-branch decision for a `trip:{pubkey}:{startTsPadded}` row.
//
// Returns:
//   'accept' → caller should view.put(key, incoming)
//   'reject' → caller should drop the op silently (continue the loop)
//
// Rules (proposal 2026-05-10 §Design):
//   1. Signature must verify.
//   2. Value must have a numeric startTs and a string pubkey.
//   3. startTs must not be more than FUTURE_TS_TOLERANCE_MS in the future.
//   4. The key's pubkey segment must equal incoming.pubkey.
//   5. The key's padded startTs must equal padTripStartTs(incoming.startTs).
//   6. If an existing row is already a delete tombstone (deleted: true),
//      reject ANY further write — "no resurrection" preserves the
//      privacy commitment of a deleted trip.
//   7. If an existing original is present and the incoming write is
//      also an original (no deleted flag), reject — past polylines
//      are immutable to writers.
function tripApplyDecision (key, incoming, existing, verifyValueFn) {
  if (typeof key !== 'string' || !key.startsWith('trip:')) return 'reject'
  if (!incoming || typeof incoming !== 'object') return 'reject'
  if (typeof incoming.pubkey !== 'string') return 'reject'
  if (typeof incoming.startTs !== 'number') return 'reject'
  if (incoming.startTs > Date.now() + FUTURE_TS_TOLERANCE_MS) return 'reject'

  const tail = key.slice('trip:'.length)
  const firstColon = tail.indexOf(':')
  if (firstColon < 0) return 'reject'
  const keyPubkey = tail.slice(0, firstColon)
  const keyStartTs = tail.slice(firstColon + 1)
  if (keyPubkey !== incoming.pubkey) return 'reject'
  if (keyStartTs !== padTripStartTs(incoming.startTs)) return 'reject'

  if (typeof verifyValueFn === 'function') {
    if (!verifyValueFn(incoming)) return 'reject'
  }

  const existingValue = existing && existing.value ? existing.value : null
  if (existingValue) {
    if (existingValue.deleted === true) return 'reject'  // no resurrection
    if (incoming.deleted !== true) return 'reject'       // no overwrite of original
  }

  return 'accept'
}

// Whether the worklet should replicate a freshly-completed trip to a
// given circle. Default-on (opt-out): missing row or row.enabled !==
// false returns true. Future-trips-only is enforced by where this is
// called (only from the trip-completion path, never during cold-start
// catch-up).
function shouldReplicateTrip (sharingRow) {
  if (!sharingRow || !sharingRow.value) return true
  return sharingRow.value.enabled !== false
}

// View-layer dedup for the merged trip list shown to the user in
// TripsView (Q4 of the proposal). Inputs:
//   - `localTrips`: own trips from the local Hyperbee (each {pubkey,
//     startTs, ...}, no tombstones since local deletes hard-delete)
//   - `circleTrips`: an array of trip arrays, one per circle the user
//     can see, each containing trips for any member visible in that
//     circle (may include tombstones with deleted:true)
//
// Output: a single deduplicated array, sorted by startTs descending,
// with any-tombstone-wins semantics: if the same (pubkey, startTs)
// appears as deleted in one circle and not in another, the deleted
// view wins and the trip is hidden. This matches user intent ("I
// deleted this trip; nobody should see it anywhere I can control").
function mergeTripStreams ({ localTrips = [], circleTrips = [] } = {}) {
  const byKey = new Map()   // `${pubkey}:${startTs}` -> trip object
  const deletedKeys = new Set()

  for (const trips of circleTrips) {
    if (!Array.isArray(trips)) continue
    for (const t of trips) {
      if (!t || typeof t.startTs !== 'number' || typeof t.pubkey !== 'string') continue
      const k = t.pubkey + ':' + t.startTs
      if (t.deleted === true) {
        deletedKeys.add(k)
        byKey.delete(k)
        continue
      }
      if (!byKey.has(k)) byKey.set(k, t)
    }
  }

  for (const t of localTrips) {
    if (!t || typeof t.startTs !== 'number' || typeof t.pubkey !== 'string') continue
    const k = t.pubkey + ':' + t.startTs
    if (deletedKeys.has(k)) continue
    if (!byKey.has(k)) byKey.set(k, t)
  }

  return [...byKey.values()].sort((a, b) => b.startTs - a.startTs)
}

module.exports = {
  FUTURE_TS_TOLERANCE_MS,
  padTripStartTs,
  tripApplyDecision,
  shouldReplicateTrip,
  mergeTripStreams,
}
