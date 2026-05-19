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
  if (typeof verifySig !== 'function' || !verifySig(incoming)) return false
  if (!writerMember) return false
  if (writerRemoved) return false
  if (existing && typeof existing.updatedAt === 'number') {
    if (incoming.updatedAt <= existing.updatedAt) return false
  }
  return true
}

module.exports = { shouldAcceptSeederRow }
