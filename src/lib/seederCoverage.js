// What a seeder actually holds for one circle, for its dashboard.
//
// A seeder can know a member's last-known core key and never manage to download
// the latest position block, and nothing reported it: the member simply got no
// offline fallback (found 2026-07-24 on the Mac mini seeder). The seeder cannot
// decrypt anything, so this reports only what it can see: whether it has the
// newest block for each member, when it last stored one, and whether it has
// every member's full writer history.
//
//   members: [{ pubkey, length, tipHeld, tipAt }]   last-known cores
//   writers: [{ length, contiguousLength }]         writer cores incl. bootstrap
function summarizeSeederCoverage ({ members = [], writers = [] } = {}, now = Date.now()) {
  const list = []
  let tipsHeld = 0
  let newestTipAt = null
  for (const m of members) {
    if (!m || typeof m.pubkey !== 'string') continue
    const held = m.tipHeld === true && Number.isFinite(m.length) && m.length > 0
    if (held) tipsHeld++
    const tipAt = Number.isFinite(m.tipAt) ? m.tipAt : null
    if (tipAt !== null && (newestTipAt === null || tipAt > newestTipAt)) newestTipAt = tipAt
    list.push({ pubkey: m.pubkey, tipHeld: held, tipAgoMs: tipAt === null ? null : Math.max(0, now - tipAt) })
  }
  let writersComplete = 0
  let writersTotal = 0
  for (const w of writers) {
    if (!w || !Number.isFinite(w.length)) continue
    writersTotal++
    if (w.length > 0 && Number.isFinite(w.contiguousLength) && w.contiguousLength >= w.length) writersComplete++
  }
  // Missing first, then the longest since a stored position, so the member who
  // needs attention is at the top.
  list.sort((a, b) => (a.tipHeld - b.tipHeld) || ((b.tipAgoMs ?? -1) - (a.tipAgoMs ?? -1)))
  return {
    membersAnnounced: list.length,
    tipsHeld,
    newestTipAgoMs: newestTipAt === null ? null : Math.max(0, now - newestTipAt),
    writersTotal,
    writersComplete,
    members: list,
  }
}

module.exports = { summarizeSeederCoverage }
