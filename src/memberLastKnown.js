// Per-member last-known position core (proposal 2026-06-04-lastseen-ephemeral,
// phase 1 slice 2). The bounded, persisted offline-fallback that replaces the
// Autobase lastSeen oplog write (the bloat-wedge cure).
//
// Each member owns a single-writer Hypercore per circle holding their latest
// signed fix, encrypted with the circle enc key. We append our fix and clear
// the earlier blocks, so on-disk DATA stays O(1) (the merkle tree grows by one
// small node per fix, but never the blocks themselves - unlike the Autobase
// oplog, a plain Hypercore tip read is O(log n) with no linearization, so
// length growth is harmless). Peers replicate only the tip by key.
//
// Discovery: the core key is announced once per member in the Autobase
// (`lastknownCore:{pubkey}`), a negligible one-time op. Peers read the key from
// the view and open the core by key over the connection's existing corestore
// replication. Seeder replication of these cores is slice 2b.

const b4a = require('b4a')

// Open (creating on first use) our own last-known core for a circle. Lives in a
// dedicated namespace so it is stable across Autobase rebuilds (circle:repair
// changes the autobase namespace but must not orphan this core). Encrypted with
// the circle enc key when present.
function openSelfCore (store, circleId, encryptionKeyHex) {
  const opts = { name: 'self' }
  if (encryptionKeyHex) opts.encryptionKey = b4a.from(encryptionKeyHex, 'hex')
  return store.namespace('lastknown:' + circleId).get(opts)
}

// Open a peer's last-known core by its announced key (for replication + read).
// Does not download; corestore serves it over the existing connection once a
// block is requested.
function openPeerCore (store, coreKeyHex, encryptionKeyHex) {
  const opts = { key: b4a.from(coreKeyHex, 'hex') }
  if (encryptionKeyHex) opts.encryptionKey = b4a.from(encryptionKeyHex, 'hex')
  return store.get(opts)
}

// Append the latest signed fix, then clear all earlier blocks so stored DATA
// stays bounded to the tip. Returns the new length.
async function appendFix (core, signedValue) {
  await core.ready()
  await core.append(b4a.from(JSON.stringify(signedValue)))
  if (core.length > 1) {
    try { await core.clear(0, core.length - 1) } catch { /* clear is best-effort */ }
  }
  return core.length
}

// Read the tip (latest fix) of a last-known core, or null when empty or the tip
// block is not yet replicated locally. Non-blocking ({ wait: false }) so a
// snapshot read never hangs on an undownloaded peer core.
async function readTip (core) {
  await core.ready()
  if (core.length === 0) return null
  try {
    const block = await core.get(core.length - 1, { wait: false })
    if (!block) return null
    return JSON.parse(b4a.toString(block))
  } catch { return null }
}

module.exports = { openSelfCore, openPeerCore, appendFix, readTip }
