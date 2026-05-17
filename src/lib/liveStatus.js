// Live / Reconnecting / old classification for a lastSeen value
// (proposal 2026-05-17). Pure function so LiveOrAge in App.jsx can be
// a thin render wrapper and the three-way decision is unit-testable
// without a DOM.
//
//   'live'         ts is within threshold AND not flagged stale
//   'reconnecting' ts is within threshold AND stale === true
//   'old'          ts is outside threshold (stale flag irrelevant)
//
// "stale" here is the wire-protocol flag introduced by the cold-boot
// preload + heartbeat path: when the worklet republishes a preloaded
// (potentially hours-old) lat/lon with a fresh ts, it sets stale: true
// so peers can render the appropriate UI instead of treating the
// position as current. Cleared on the first organic location:update
// per session.

const LIVE_THRESHOLD_MS = 60_000

function liveStatus (ts, stale, now = Date.now(), threshold = LIVE_THRESHOLD_MS) {
  if (typeof ts !== 'number') return null
  const fresh = (now - ts) < threshold
  if (!fresh) return 'old'
  if (stale === true) return 'reconnecting'
  return 'live'
}

module.exports = { LIVE_THRESHOLD_MS, liveStatus }
