// Read-precedence resolver for live (ephemeral) vs view (Autobase) lastSeen
// (proposal 2026-06-04-lastseen-ephemeral, phase 1). Pure + unit-tested.
//
// snapshotCircle reads each member's last position from the Autobase view. With
// live position now arriving ephemerally off the oplog, we overlay the live
// value when it is fresher (higher ts) than the view value. Restricted to an
// allowed-pubkey set (the snapshot's already-computed visible members, with
// left/removed already filtered) so a stale live entry for a departed member
// can't reappear.
//
// Precedence: freshest-ts wins. A live value fills in a member with no view
// row at all. In phase 1 the view is still dual-written, so this mostly returns
// the live value (newer) for connected peers and the view value otherwise.

/**
 * @param {Object<string,Object>} viewLastSeen  pubkey -> signed value from the view
 * @param {Map<string,Object>|null} liveByPubkey  pubkey -> signed value (in-memory live)
 * @param {Set<string>|null} allowedPubkeys  if set, only overlay live for these pubkeys
 * @returns {Object<string,Object>} merged pubkey -> value (new object; inputs untouched)
 */
function mergeLiveLastSeen (viewLastSeen, liveByPubkey, allowedPubkeys = null) {
  const out = { ...(viewLastSeen || {}) }
  if (!liveByPubkey) return out
  for (const [pubkey, liveVal] of liveByPubkey) {
    if (!liveVal) continue
    if (allowedPubkeys && !allowedPubkeys.has(pubkey)) continue
    const cur = out[pubkey]
    if (isNewer(liveVal, cur)) out[pubkey] = liveVal
  }
  return out
}

// True when `candidate` should replace `current`: no current, or a strictly
// higher numeric ts. A candidate without a numeric ts only wins when there is
// no current value at all.
function isNewer (candidate, current) {
  if (!current) return true
  const ct = typeof current.ts === 'number' ? current.ts : -Infinity
  const nt = typeof candidate.ts === 'number' ? candidate.ts : -Infinity
  return nt > ct
}

module.exports = { mergeLiveLastSeen, isNewer }
