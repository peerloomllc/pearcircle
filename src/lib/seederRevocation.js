// Seeder revocation signal. Proposal 2026-05-21-seeder-revocation-signal.
//
// A blind seeder cannot read a circle's autobase, so it never learns it was
// revoked and its dashboard keeps listing a circle it can no longer seed.
// A member that shares a circle with the seeder, and finds the circle's
// seeder:{pubkey} row revoked, sends a content-blind notice over the
// seeder-admission Protomux channel. The seeder records it as
// seeder:revoked:{circleId} so the launcher dashboard can flag the circle.
//
// The notice is advisory and UI-only (proposal question 1): enforcement
// stays member-side, so a spoofed notice at worst shows a dismissable wrong
// badge and never changes the seeder's network behavior.
//
// Seeder-local row family (never replicated):
//   seeder:revoked:{circleId} -> { circleId, revokedAt, noticedAt }

function revokedKey (circleId) {
  return 'seeder:revoked:' + circleId
}

// Member side. Given the seeder:{pubkey} autobase row for a seeder the
// member shares `circleId` with, return the revocation notice to send over
// the admission channel, or null when the row is not a revocation. Pure.
function revocationNoticeFor (circleId, seederRow) {
  if (typeof circleId !== 'string' || circleId.length === 0) return null
  if (!seederRow || typeof seederRow !== 'object') return null
  if (seederRow.revoked !== true) return null
  const revokedAt = typeof seederRow.revokedAt === 'number' && Number.isFinite(seederRow.revokedAt)
    ? seederRow.revokedAt
    : null
  return { type: 'revoked', circleId, revokedAt }
}

// Seeder side. Persist an inbound revocation notice. `circleId` is the
// trusted seeder-admission channel id, not the message body. Idempotent: a
// repeat notice just rewrites the row. Returns false on a malformed
// circleId so the caller can skip without throwing.
async function recordRevocationNotice (localDb, { circleId, revokedAt, now } = {}) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  const noticedAt = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const at = typeof revokedAt === 'number' && Number.isFinite(revokedAt) ? revokedAt : null
  await localDb.put(revokedKey(circleId), { circleId, revokedAt: at, noticedAt })
  return true
}

// Seeder side. Drop the revocation row for a circle. Called when real block
// replication resumes (proposal question 4: evidence-based re-admission) and
// when the user leaves the circle.
async function clearRevocationNotice (localDb, circleId) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  await localDb.del(revokedKey(circleId)).catch(() => {})
  return true
}

// Seeder side. Read every seeder:revoked:* row into a Map circleId -> row.
// Used at boot to seed the in-memory revoked set and by seeder:enrolled:list.
async function loadRevokedCircles (localDb) {
  const out = new Map()
  for await (const { value } of localDb.createReadStream({
    gt: 'seeder:revoked:',
    lt: 'seeder:revoked:~',
  })) {
    if (value && typeof value.circleId === 'string') out.set(value.circleId, value)
  }
  return out
}

module.exports = {
  revokedKey,
  revocationNoticeFor,
  recordRevocationNotice,
  clearRevocationNotice,
  loadRevokedCircles,
}
