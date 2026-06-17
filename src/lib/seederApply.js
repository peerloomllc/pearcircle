// Pure decision function for the seeder:{pubkey} apply branch.
// Proposal 2026-05-19-blind-seeder-peers slice 3a.
//
// Schema (deviates from the proposal text — the proposal used `addedBy`
// as the signer field; this implementation adds an explicit `writer`
// field so re-admits and revokes by different members can each carry
// their own signature without overloading addedBy. Will be folded into
// the wire-protocol amendment in slice 6):
//
//   seeder:{seederPubkey} → {
//     pubkey:      hex64  — seeder identity (matches key suffix)
//     writer:      hex64  — signer of this row (any current member)
//     addedBy:     hex64  — first admitter; preserved across re-admits
//     addedAt:     number — first admission ms
//     updatedAt:   number — LWW ordering field; every write bumps this
//     label?:      string — admin-supplied label
//     revoked?:    boolean
//     revokedAt?:  number
//     revokedBy?:  hex64
//     left?:       boolean — seeder-operator-initiated leave (proposal
//                            2026-06-17-seeder-leave-propagation); when true the
//                            member-facing lists hide the row entirely (vs
//                            `revoked`, which lingers for re-admit)
//     leftAt?:     number
//     leftBy?:     hex64
//     v:           1
//     sig:         hex128 — signature over canonical(rest) by `writer`
//   }
//
// Acceptance rules:
//   1. incoming.pubkey matches the key suffix
//   2. shape fields well-formed (lengths, numeric ranges)
//   3. timestamps not in the future beyond tolerance
//   4. updatedAt >= addedAt
//   5. if revoked: revokedAt + revokedBy present
//   6. signature verifies against `writer`
//   7. writer is in the member: view (currently admitted)
//   8. writer is not in the removed: view
//   9. if existing row, incoming.updatedAt strictly greater (LWW)

const HEX_64 = /^[0-9a-f]{64}$/i

function isHex64 (s) {
  return typeof s === 'string' && HEX_64.test(s)
}

function shouldAcceptSeederRow ({
  keyPubkey,
  incoming,
  writerMember,
  writerRemoved,
  existing,
  now,
  futureToleranceMs,
  verifySig,
}) {
  if (!incoming || typeof incoming !== 'object') return false
  if (!isHex64(incoming.pubkey)) return false
  if (incoming.pubkey !== keyPubkey) return false
  if (!isHex64(incoming.writer)) return false
  if (!isHex64(incoming.addedBy)) return false
  if (typeof incoming.addedAt !== 'number' || !Number.isFinite(incoming.addedAt)) return false
  if (incoming.addedAt > now + futureToleranceMs) return false
  if (typeof incoming.updatedAt !== 'number' || !Number.isFinite(incoming.updatedAt)) return false
  if (incoming.updatedAt > now + futureToleranceMs) return false
  if (incoming.updatedAt < incoming.addedAt) return false
  if (incoming.revoked === true) {
    if (typeof incoming.revokedAt !== 'number' || !Number.isFinite(incoming.revokedAt)) return false
    if (incoming.revokedAt > now + futureToleranceMs) return false
    if (!isHex64(incoming.revokedBy)) return false
  }
  // `left` tombstone (proposal 2026-06-17-seeder-leave-propagation). Same shape
  // discipline as revoked: a leave must carry a timestamp + the member who
  // recorded it. The member-facing list filters these out entirely.
  if (incoming.left === true) {
    if (typeof incoming.leftAt !== 'number' || !Number.isFinite(incoming.leftAt)) return false
    if (incoming.leftAt > now + futureToleranceMs) return false
    if (!isHex64(incoming.leftBy)) return false
  }
  if (typeof verifySig !== 'function' || !verifySig(incoming)) return false
  if (!writerMember) return false
  if (writerRemoved) return false
  if (existing && typeof existing.updatedAt === 'number') {
    if (incoming.updatedAt <= existing.updatedAt) return false
  }
  return true
}

// Build the unsigned value for a revoke write. Preserves addedBy / addedAt /
// label from the existing row so a future re-admit (slice 3d) can restore
// "who first admitted this seeder" without losing history. Caller signs the
// returned value with the revoker's secret key before appending.
//
// Returns null if the existing row is missing required fields (caller
// should refuse the IPC in that case rather than write a malformed revoke).
function buildSeederRevoke ({ existing, revokerPubkeyHex, now }) {
  if (!existing || typeof existing !== 'object') return null
  if (typeof existing.pubkey !== 'string') return null
  if (typeof existing.addedBy !== 'string') return null
  if (typeof existing.addedAt !== 'number') return null
  if (typeof revokerPubkeyHex !== 'string' || !HEX_64.test(revokerPubkeyHex)) return null
  if (typeof now !== 'number' || !Number.isFinite(now)) return null
  const out = {
    pubkey: existing.pubkey,
    writer: revokerPubkeyHex,
    addedBy: existing.addedBy,
    addedAt: existing.addedAt,
    updatedAt: now,
    revoked: true,
    revokedAt: now,
    revokedBy: revokerPubkeyHex,
    v: 1,
  }
  if (typeof existing.label === 'string' && existing.label.length > 0) {
    out.label = existing.label
  }
  return out
}

// Build the unsigned value for an admission write — fresh admit or re-admit
// after revoke. Proposal 2026-05-19-blind-seeder-peers slice 3d.
//
// Fresh admit (existing=null): addedBy=writer=adminPubkey,
// addedAt=updatedAt=now. Optional label.
//
// Re-admit (existing carries a previously-revoked row): preserves the
// original addedBy and addedAt so the row's history of "first admitter"
// stays intact. Sets writer=adminPubkey (may differ from addedBy),
// updatedAt=now, NO revoked field — that's what makes this a re-admit
// instead of a stale write. Label can be overridden by the new caller
// or inherited from existing.
//
// Caller signs the returned value with the admin's secret key before
// appending. Returns null on malformed input so the IPC refuses rather
// than writing a garbage row.
function buildSeederAdmission ({ seederPubkey, adminPubkeyHex, label, existing, now }) {
  if (!isHex64(seederPubkey)) return null
  if (!isHex64(adminPubkeyHex)) return null
  if (typeof now !== 'number' || !Number.isFinite(now)) return null
  if (label !== undefined && label !== null && typeof label !== 'string') return null

  const inheritedAddedBy = existing && isHex64(existing.addedBy) ? existing.addedBy : null
  const inheritedAddedAt = existing && typeof existing.addedAt === 'number' && Number.isFinite(existing.addedAt) ? existing.addedAt : null
  const inheritedLabel = existing && typeof existing.label === 'string' && existing.label.length > 0 ? existing.label : null

  const out = {
    pubkey: seederPubkey,
    writer: adminPubkeyHex,
    addedBy: inheritedAddedBy ?? adminPubkeyHex,
    addedAt: inheritedAddedAt ?? now,
    updatedAt: now,
    v: 1,
  }
  const resolvedLabel = (typeof label === 'string' && label.length > 0) ? label : inheritedLabel
  if (resolvedLabel) out.label = resolvedLabel
  return out
}

// Build the unsigned value for a `left` tombstone — the seeder operator left
// this circle (in-band notice or manual member-side Remove). Proposal
// 2026-06-17-seeder-leave-propagation. Like buildSeederRevoke, preserves
// addedBy / addedAt / label so a later re-enroll keeps its first-admit history,
// but marks the row `left` (hidden from the member list) rather than `revoked`
// (which lingers for re-admit). `byPubkeyHex` is the member recording the leave
// (the receiver of the in-band notice, or the user pressing Remove). Caller
// signs before appending. Returns null on malformed input.
function buildSeederGone ({ existing, byPubkeyHex, now }) {
  if (!existing || typeof existing !== 'object') return null
  if (typeof existing.pubkey !== 'string') return null
  if (typeof existing.addedBy !== 'string') return null
  if (typeof existing.addedAt !== 'number') return null
  if (typeof byPubkeyHex !== 'string' || !HEX_64.test(byPubkeyHex)) return null
  if (typeof now !== 'number' || !Number.isFinite(now)) return null
  const out = {
    pubkey: existing.pubkey,
    writer: byPubkeyHex,
    addedBy: existing.addedBy,
    addedAt: existing.addedAt,
    updatedAt: now,
    left: true,
    leftAt: now,
    leftBy: byPubkeyHex,
    v: 1,
  }
  if (typeof existing.label === 'string' && existing.label.length > 0) {
    out.label = existing.label
  }
  return out
}

module.exports = { shouldAcceptSeederRow, buildSeederRevoke, buildSeederAdmission, buildSeederGone }
