// Runtime fix for hypercore's DefaultEncryption._reload (upstream bug, present
// in 11.29.0 through 11.35.0 at least).
//
// `deriveKeys` returns `{ blinding, block }`. `_reload` reads `keys.blockKey`
// and `keys.blindingKey`, which do not exist, so it assigns `undefined` to both
// and the core silently decrypts to garbage from then on. It also never updates
// `this.compat`, so the mismatch that triggered it persists and it re-runs on
// every subsequent block.
//
//   _reload (core) {
//     const keys = DefaultEncryption.deriveKeys(...)
//     this.blockKey = keys.blockKey        // undefined
//     this.blindingKey = keys.blindingKey  // undefined
//   }
//
// How PearCircle hits it: `openPeerCore` opens a member's last-known core by
// key with no manifest, and hypercore's `core.js` sets
// `compat = opts.compat === true || (opts.compat !== false && !opts.manifest)`,
// so compat starts TRUE. When the real manifest replicates in, core.js flips it
// to false - and the encryption object built for the old value trips `_reload`
// on the next block. Result, observed on the Pixel 9 on 2026-07-24: three of
// five members' position blocks downloaded, stored, and decrypted to binary
// noise ("Unexpected token '+', \"+s...HT_C\"... is not valid JSON"), forever.
// The block was always fine; the reader's cipher had been destroyed.
//
// The fix is the obvious one - use the property names `deriveKeys` actually
// returns, and record the compat we rebuilt for so it stops re-firing.
//
// Applied at worklet init, before any core is opened. Idempotent.

// `block` mode (encryptionKey used directly as the block key) is detected the
// way upstream does it, by comparing the two keys - but defensively, because a
// prior broken reload may already have left blockKey undefined, and comparing
// against that would throw and take the whole read path down.
function isBlockMode (enc, b4a) {
  try {
    return !!(enc.blockKey && b4a.equals(enc.key, enc.blockKey))
  } catch {
    return false
  }
}

// Returns { applied, reason } so the caller can trace which branch it took -
//'already-fixed' means upstream shipped the fix and we should drop this file.
function applyEncryptionReloadFix (Hypercore, b4a) {
  const Enc = Hypercore && Hypercore.DefaultEncryption
  if (!Enc || !Enc.prototype || typeof Enc.prototype._reload !== 'function') {
    return { applied: false, reason: 'not-found' }
  }
  if (Enc.prototype._reload.__pearcirclePatched) {
    return { applied: false, reason: 'already-applied' }
  }
  if (typeof Enc.deriveKeys !== 'function') {
    return { applied: false, reason: 'no-derive-keys' }
  }
  // Only patch a genuinely broken implementation: if upstream fixes this, the
  // probe below yields a real key and we leave their code alone.
  if (!isReloadBroken(Enc, b4a)) return { applied: false, reason: 'already-fixed' }

  const patched = function _reload (core) {
    const block = isBlockMode(this, b4a)
    const keys = Enc.deriveKeys(this.key, core.key, { block, compat: core.compat })
    this.blockKey = keys.block
    this.blindingKey = keys.blinding
    // Upstream omits this, so the mismatch survives and _reload runs again for
    // every block.
    this.compat = core.compat
  }
  patched.__pearcirclePatched = true
  Enc.prototype._reload = patched
  return { applied: true, reason: 'patched' }
}

// Does _reload leave the cipher unusable? Probes a throwaway instance rather
// than matching on a version number, so a future upstream fix disables us
// automatically.
function isReloadBroken (Enc, b4a) {
  try {
    const key = b4a.alloc(32, 1)
    const coreKey = b4a.alloc(32, 2)
    const probe = new Enc(key, coreKey, { compat: false })
    probe._reload({ key: coreKey, compat: true })
    return !probe.blockKey || !probe.blindingKey
  } catch {
    // A probe that throws is not a working implementation either, but we cannot
    // prove our replacement is right, so leave it alone.
    return false
  }
}

module.exports = { applyEncryptionReloadFix, isReloadBroken, isBlockMode }
