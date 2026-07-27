// Seeder last-contact tracking.
//
// The Seeders list used to report which seeders were ADMITTED to a circle, not
// which ones actually held it. Those are different things: at circle:create the
// device writes a `seeder:{pubkey}` admission row for every followed seeder
// (admitFollowedSeedersToCircle) precisely so admission does not depend on a
// cross-device handshake. The list then rendered those rows, so a seeder that
// was switched off, or that never received the circle, displayed exactly like a
// working one - and a user reading that screen to answer "is my circle safe
// while the phones sleep?" got a confidently wrong yes.
//
// The one signal that proves a seeder holds a circle is its admission announce,
// which only a connected seeder can send. These helpers key, throttle and
// summarize those contact stamps. Pure, so both the worklet and the UI can use
// them and both are covered by tests.

// `${circleId}:${pubkey}` — one stamp per (circle, seeder) pair, because a
// seeder can hold one of a device's circles and not another.
function seederSeenKey (circleId, pubkey) {
  return circleId + ':' + pubkey
}

// Announces arrive on every channel open, so persisting each one would churn
// the local DB for no extra information. The in-memory stamp is always updated;
// this only gates the durable write.
function shouldPersistSeederContact (prevAt, now, throttleMs) {
  if (typeof prevAt !== 'number') return true
  return now - prevAt >= throttleMs
}

// Split a seeder's circles into the ones it has demonstrably checked in for and
// the ones it is merely admitted to, and report its most recent contact across
// all of them. `circles` entries carry { revoked, lastSeenAt } as built by
// seeders:listAll.
//
// Deliberately conservative: a missing or non-numeric lastSeenAt counts as
// unconfirmed. Over-reporting coverage is the failure this exists to prevent,
// so an unknown must never render as held.
function summarizeSeederCircles (circles) {
  const all = Array.isArray(circles) ? circles : []
  const live = all.filter((c) => c && c.revoked !== true)
  const held = live.filter((c) => typeof c.lastSeenAt === 'number')
  const unconfirmed = live.filter((c) => typeof c.lastSeenAt !== 'number')
  const stamps = held.map((c) => c.lastSeenAt)
  return {
    live,
    held,
    unconfirmed,
    revoked: all.filter((c) => c && c.revoked === true),
    lastSeenAt: stamps.length > 0 ? Math.max(...stamps) : null,
  }
}

module.exports = { seederSeenKey, shouldPersistSeederContact, summarizeSeederCircles }
