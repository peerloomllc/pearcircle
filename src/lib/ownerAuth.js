// Owner actions that follow an identity, and co-owners (proposal
// 2026-10-06-owner-continuity, parts 1 and 2).
//
// Before this, owner power lived in the phone that created the circle: the
// `circle` row and `removed:` rows were accepted only from the bootstrap
// writer core, so an owner who lost their app data lost the circle. Now those
// rows are also accepted when signed by an authorized identity: the circle's
// ownerKey or a current co-owner. The bootstrap rule stays as a second way in.
//
// Old peers keep the bootstrap-only rule and Autobase applies each node once,
// so a row an old peer drops stays dropped after it updates. New versions
// therefore only create identity-signed owner rows once every visible member
// advertises OWNER_V2_CAP on their member row (circleOwnerV2Ready). Apply
// accepts them whenever they arrive.
//
// Pure helpers; signature checks are injected so this file stays sodium-free.

const OWNER_V2_CAP = 'owner-v2'

// Current co-owner set from `coowner:{pubkey}` rows: pubkey -> row.
// A row with revoked: true is not a co-owner.
function activeCoowners (rows) {
  const out = new Set()
  if (!rows) return out
  for (const [pubkey, row] of rows) {
    if (row && row.revoked !== true) out.add(pubkey)
  }
  return out
}

function isAuthorized (pubkey, { ownerKey, coowners } = {}) {
  if (typeof pubkey !== 'string' || pubkey.length !== 64) return false
  if (pubkey === ownerKey) return true
  return !!(coowners && coowners.has(pubkey))
}

function hasOwnerV2Cap (memberValue) {
  return !!(memberValue && Array.isArray(memberValue.caps) && memberValue.caps.includes(OWNER_V2_CAP))
}

// Ready when every visible member advertises the cap. Returns the names of
// the members who still need to update, so the UI can say who.
function circleOwnerV2Ready (visibleMembers) {
  const waitingOn = []
  for (const m of visibleMembers || []) {
    const v = m && (m.value || m)
    if (!hasOwnerV2Cap(v)) waitingOn.push(v?.displayName || (v?.pubkey || '').slice(0, 8))
  }
  return { ready: waitingOn.length === 0, waitingOn }
}

function futureOk (ts, now, tol) {
  return typeof tol !== 'number' || typeof now !== 'number' || ts <= now + tol
}

// `circle` row. Bootstrap-authored rows are accepted as before. Any other
// writer needs a row signed by an authorized identity in `by`, newer than the
// stored row (updatedAt, LWW), that keeps id and ownerKey and does not touch a
// deleted circle.
function shouldAcceptCircleRow ({ fromHex, bootstrapHex, incoming, existing, coowners, now, futureToleranceMs, verifySig }) {
  if (typeof fromHex === 'string' && fromHex === bootstrapHex) return true
  if (!incoming || typeof incoming !== 'object') return false
  if (!existing) return false
  if (existing.deleted === true) return false
  if (incoming.id !== existing.id) return false
  if (incoming.ownerKey !== existing.ownerKey) return false
  if (typeof incoming.updatedAt !== 'number') return false
  if (!futureOk(incoming.updatedAt, now, futureToleranceMs)) return false
  if (typeof existing.updatedAt === 'number' && incoming.updatedAt <= existing.updatedAt) return false
  if (!isAuthorized(incoming.by, { ownerKey: existing.ownerKey, coowners })) return false
  if (typeof verifySig !== 'function' || !verifySig(incoming, 'by')) return false
  return true
}

// `removed:{pubkey}` row. Bootstrap-authored as before, or signed by an
// authorized identity in `removedBy`. Nobody removes the owner identity this
// way. LWW on ts stays in the apply branch.
function shouldAcceptSignedRemovedRow ({ fromHex, bootstrapHex, keyPubkey, value, ownerKey, coowners, now, futureToleranceMs, verifySig }) {
  if (!value || typeof value.pubkey !== 'string') return false
  if (keyPubkey !== value.pubkey) return false
  if (typeof fromHex === 'string' && fromHex === bootstrapHex) return true
  if (value.pubkey === ownerKey) return false
  if (typeof value.ts !== 'number' || !futureOk(value.ts, now, futureToleranceMs)) return false
  if (!isAuthorized(value.removedBy, { ownerKey, coowners })) return false
  if (typeof verifySig !== 'function' || !verifySig(value, 'removedBy')) return false
  return true
}

// `coowner:{pubkey}` row: appoint (revoked: false) or revoke (revoked: true).
// Signed by an authorized identity in `by`; the owner can't be made or
// unmade a co-owner; LWW on ts.
function shouldAcceptCoownerRow ({ keyPubkey, incoming, existing, ownerKey, coowners, now, futureToleranceMs, verifySig }) {
  if (!incoming || typeof incoming !== 'object') return false
  if (typeof incoming.pubkey !== 'string' || incoming.pubkey.length !== 64) return false
  if (keyPubkey !== incoming.pubkey) return false
  if (incoming.pubkey === ownerKey) return false
  if (typeof incoming.revoked !== 'boolean') return false
  if (typeof incoming.ts !== 'number' || !futureOk(incoming.ts, now, futureToleranceMs)) return false
  if (existing && typeof existing.ts === 'number' && incoming.ts <= existing.ts) return false
  if (!isAuthorized(incoming.by, { ownerKey, coowners })) return false
  if (typeof verifySig !== 'function' || !verifySig(incoming, 'by')) return false
  return true
}

module.exports = {
  OWNER_V2_CAP,
  activeCoowners,
  isAuthorized,
  hasOwnerV2Cap,
  circleOwnerV2Ready,
  shouldAcceptCircleRow,
  shouldAcceptSignedRemovedRow,
  shouldAcceptCoownerRow,
}
