// Diagnostics for the peer last-known fetch (investigation 2026-07-24).
//
// After the lastSeen cutover a member's position stops going into the
// replicated view and lives in their own last-known core instead, which peers
// fetch. `pullPeerTip` has two silent dead ends on that path:
//
//   1. `core.length === 0` -> return. We never learned the core's length, so we
//      never even ask for a block. This is the state of a cold boot before the
//      seeder connection is up.
//   2. tip not local -> fire a background `core.get` and return, with the
//      result swallowed by `.catch(() => {})`.
//
// Either one leaves the reader showing whatever the pre-cutover view held,
// which for the Hudgins circle is five days stale. Neither logs anything, so
// "Rachel is stale" cannot currently be attributed to a step.
//
// These are the pure parts: when to emit (this runs on the ~3s snapshot poll,
// so unthrottled marks would flood logcat) and how to summarise coverage.

// Per member+event throttle. Long enough that a 3s poll emits at most once a
// minute per member, short enough to show a state change while someone watches
// a device.
const DIAG_INTERVAL_MS = 60_000

function shouldEmit (lastAt, now = Date.now(), intervalMs = DIAG_INTERVAL_MS) {
  if (typeof lastAt !== 'number') return true
  return now - lastAt >= intervalMs
}

// One line describing a circle's whole last-known picture, which is what says
// whether this is one broken member or a broken path. `entries` are
// { pubkey, length, tipLocal, cachedTs }.
function coverageSummary (entries, now = Date.now()) {
  let members = 0
  let noLength = 0
  let tipRemote = 0
  let cached = 0
  let stalestAgeMs = null
  for (const e of entries || []) {
    if (!e) continue
    members++
    if (!e.length) noLength++
    else if (!e.tipLocal) tipRemote++
    if (typeof e.cachedTs === 'number') {
      cached++
      const age = now - e.cachedTs
      if (stalestAgeMs === null || age > stalestAgeMs) stalestAgeMs = age
    }
  }
  return { members, noLength, tipRemote, cached, stalestAgeMs }
}

module.exports = { shouldEmit, coverageSummary, DIAG_INTERVAL_MS }
