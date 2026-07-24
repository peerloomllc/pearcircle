// Should this device rewrite its own last-known tip? (2026-07-24)
//
// A join-time race could create a member's last-known core UNENCRYPTED: the
// base went live for location writes before the joined record carrying the
// encryption key was persisted, so a fix arriving in that window resolved "no
// key" and the core was created in the clear for the whole session. Two Hudgins
// members published positions that way from 2026-06-19.
//
// The write path no longer allows it. But an affected device still carries a
// plaintext tip that every peer must fall back to reading unencrypted, so the
// leak persists in the data until that member writes again - which, for someone
// who rarely opens the app, could be months.
//
// So on boot, a device that finds its OWN tip unreadable through the encrypted
// session rewrites it. Re-appending the same signed value is deliberate: the
// signature and `ts` are unchanged, so this republishes the identical position
// under encryption without inventing freshness the device cannot vouch for.
//
// Pure decision; the worklet does the I/O.

// `tipReason` is readTipDetailed's verdict on our own core, read through the
// encrypted session:
//   'unparseable' - present but not decodable => written in the clear, heal it
//   null          - decodes fine              => already encrypted, nothing to do
//   'empty'       - never written             => nothing to heal
//   'absent'      - our own tip missing locally, which should not happen for a
//                   core we wrote; do nothing rather than guess
function shouldHealSelfTip ({ hasEncryptionKey, tipReason, recoveredPubkey, ourPubkey } = {}) {
  // Without a key there is nothing to upgrade TO - rewriting would republish in
  // the clear, which is the bug.
  if (!hasEncryptionKey) return { heal: false, reason: 'no-key' }
  if (tipReason !== 'unparseable') return { heal: false, reason: 'not-plaintext' }
  // Only ever rewrite our own position. A core announced under our pubkey whose
  // tip is signed by someone else is not something to republish.
  if (!recoveredPubkey || recoveredPubkey !== ourPubkey) return { heal: false, reason: 'not-ours' }
  return { heal: true, reason: 'plaintext-tip' }
}

module.exports = { shouldHealSelfTip }
