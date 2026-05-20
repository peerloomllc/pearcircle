// Member-side classifier for seeder revocation enforcement. Proposal
// 2026-05-19-blind-seeder-peers slice 3d + 2026-05-19 amendment.
//
// One Hyperswarm connection multiplexes every circle a member and a
// seeder both belong to, plus the admission Protomux channel. The
// original slice-3d filter destroyed the whole connection when the
// seeder was revoked in any circle — which (a) collateral-killed other
// circles' replication on the same connection and (b) permanently
// bricked re-admission, since the seeder's re-announce can't cross a
// destroyed connection. The proposal's stated "re-admit by writing a
// fresh seeder row" was therefore impossible in practice.
//
// This classifier replaces the boolean. bare.js uses it to decide
// whether to pipe corestore replication — NOT whether to keep the
// connection. The connection (and its admission channel) always stays
// open so re-admission works.
//
//   'admitted'           — >=1 non-revoked seeder row in some shared
//                          circle. Replicate normally. A seeder revoked
//                          in circle A but still admitted in circle B
//                          keeps replicating; it is blind, so circle
//                          A's blocks are ciphertext to it — a bandwidth
//                          cost only, no data exposure.
//   'revoked-everywhere' — seeder rows exist and every one is revoked.
//                          Skip replication (revoke enforced) but keep
//                          the connection for re-admission.
//   'none'               — no seeder rows: an ordinary member peer, or
//                          a fresh seeder that has never been admitted.
//                          Replicate normally.
//
// Pure async helper so jest can drive it without a real corestore.

async function classifySeederConnection ({ remotePubkeyHex, circleIds, getSeederRow }) {
  if (typeof remotePubkeyHex !== 'string' || remotePubkeyHex.length === 0) return 'none'
  if (!Array.isArray(circleIds) || circleIds.length === 0) return 'none'
  if (typeof getSeederRow !== 'function') return 'none'
  let sawRevoked = false
  let sawLive = false
  for (const circleId of circleIds) {
    const row = await getSeederRow(circleId, remotePubkeyHex)
    if (!row) continue
    if (row.revoked === true) sawRevoked = true
    else sawLive = true
  }
  if (sawLive) return 'admitted'
  if (sawRevoked) return 'revoked-everywhere'
  return 'none'
}

module.exports = { classifySeederConnection }
