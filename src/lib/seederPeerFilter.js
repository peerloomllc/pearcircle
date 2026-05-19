// Member-side peer-filter for seeder revocation. Proposal
// 2026-05-19-blind-seeder-peers slice 3d.
//
// Hyperswarm cannot remove a peer from a topic remotely. The only
// enforcement we have over a revoked seeder is to refuse to talk to it
// on every connection. Each member runs this check independently
// against its own autobase views, which is fine: the revoke tombstone
// replicates as a normal row, so eventually every member's view
// converges and drops the seeder.
//
// Pure async helper so jest can drive it without a real corestore or
// view. bare.js wires the lookup to the actual circle bases.

async function isConnectionFromRevokedSeeder ({ remotePubkeyHex, circleIds, getSeederRow }) {
  if (typeof remotePubkeyHex !== 'string' || remotePubkeyHex.length === 0) return false
  if (!Array.isArray(circleIds) || circleIds.length === 0) return false
  if (typeof getSeederRow !== 'function') return false
  for (const circleId of circleIds) {
    const row = await getSeederRow(circleId, remotePubkeyHex)
    if (row && row.revoked === true) return true
  }
  return false
}

module.exports = { isConnectionFromRevokedSeeder }
