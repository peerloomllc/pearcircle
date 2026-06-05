// Phase-2 lastSeen-write cutover decision (proposal 2026-06-04-lastseen-ephemeral
// slice 3). The high-frequency Autobase `lastSeen` write is what bloated the
// oplog and wedged circles (rca/2026-06-04-lastseen-oplog-bloat.md). Once every
// member of a circle supports the new read path (live ephemeral position + a
// per-member last-known core), the durable Autobase write is redundant and can
// stop, so the oplog stops growing.
//
// A member's support is observed durably from the view: a member that has
// announced a `lastknownCore:{pubkey}` row is a slice-2a+ peer (it both writes a
// core and reads peers' cores). A pre-slice-1 / slice-1-only peer has no such
// row, so it still depends on the Autobase `lastSeen:` view to see others.
//
// The rule is deliberately conservative — it returns true ONLY when EVERY
// currently-visible member has announced a core. Any visible member without an
// announce (an old peer, or a not-yet-announced fresh joiner) keeps the write
// on, so no peer ever silently stops seeing positions. This makes the cutover
// self-driving and per-circle: it engages as a circle's members converge and
// reverts the moment an unsupported member appears.

// Decide whether a circle's Autobase lastSeen write can stop.
//   visibleMemberPubkeys : string[] of currently-visible member identity keys
//                          (left/removed already filtered out by the caller)
//   announcedCorePubkeys : Set<string> of pubkeys with a lastknownCore announce
// Returns true only when there is at least one member and all of them have
// announced a core. Errs toward false (keep writing).
function allMembersAnnouncedCore (visibleMemberPubkeys, announcedCorePubkeys) {
  if (!Array.isArray(visibleMemberPubkeys) || visibleMemberPubkeys.length === 0) return false
  if (!announcedCorePubkeys || typeof announcedCorePubkeys.has !== 'function') return false
  for (const pubkey of visibleMemberPubkeys) {
    if (typeof pubkey !== 'string' || !announcedCorePubkeys.has(pubkey)) return false
  }
  return true
}

module.exports = { allMembersAnnouncedCore }
