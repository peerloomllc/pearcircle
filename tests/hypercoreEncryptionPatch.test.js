const b4a = require('b4a')
const Hypercore = require('hypercore')
const { applyEncryptionReloadFix, isReloadBroken, isBlockMode } = require('../src/lib/hypercoreEncryptionPatch')

const Enc = Hypercore.DefaultEncryption
const KEY = b4a.alloc(32, 1)
const CORE_KEY = b4a.alloc(32, 2)

// Restore the original between tests so each one starts from the shipped
// implementation rather than a previously patched prototype.
const ORIGINAL_RELOAD = Enc.prototype._reload
beforeEach(() => { Enc.prototype._reload = ORIGINAL_RELOAD })
afterAll(() => { Enc.prototype._reload = ORIGINAL_RELOAD })

describe('the upstream bug this exists for', () => {
  test('hypercore _reload wipes both keys and leaves compat stale', () => {
    // Documented against the installed hypercore so this test starts failing
    // the day upstream fixes it - which is the signal to delete the patch.
    const enc = new Enc(KEY, CORE_KEY, { compat: false })
    expect(enc.blockKey).toBeDefined()
    enc._reload({ key: CORE_KEY, compat: true })
    expect(enc.blockKey).toBeUndefined()
    expect(enc.blindingKey).toBeUndefined()
    expect(enc.compat).toBe(false) // never updated, so it re-fires every block
  })

  test('isReloadBroken detects it without matching on a version number', () => {
    expect(isReloadBroken(Enc, b4a)).toBe(true)
  })
})

describe('applyEncryptionReloadFix', () => {
  test('restores the block key a compat flip should have derived', () => {
    applyEncryptionReloadFix(Hypercore, b4a)
    const enc = new Enc(KEY, CORE_KEY, { compat: false })
    enc._reload({ key: CORE_KEY, compat: true })
    const expected = Enc.deriveKeys(KEY, CORE_KEY, { block: false, compat: true })
    expect(b4a.equals(enc.blockKey, expected.block)).toBe(true)
    expect(b4a.equals(enc.blindingKey, expected.blinding)).toBe(true)
  })

  test('records the compat it rebuilt for, so it stops re-firing', () => {
    applyEncryptionReloadFix(Hypercore, b4a)
    const enc = new Enc(KEY, CORE_KEY, { compat: false })
    enc._reload({ key: CORE_KEY, compat: true })
    expect(enc.compat).toBe(true)
  })

  test('the two derivations really do differ, so the flip matters', () => {
    const modern = Enc.deriveKeys(KEY, CORE_KEY, { block: false, compat: false })
    const compat = Enc.deriveKeys(KEY, CORE_KEY, { block: false, compat: true })
    expect(b4a.equals(modern.block, compat.block)).toBe(false)
  })

  test('a block-mode instance keeps using the key directly', () => {
    applyEncryptionReloadFix(Hypercore, b4a)
    const enc = new Enc(KEY, CORE_KEY, { block: true, compat: false })
    expect(b4a.equals(enc.blockKey, KEY)).toBe(true)
    enc._reload({ key: CORE_KEY, compat: true })
    expect(b4a.equals(enc.blockKey, KEY)).toBe(true)
  })

  test('is idempotent', () => {
    expect(applyEncryptionReloadFix(Hypercore, b4a)).toEqual({ applied: true, reason: 'patched' })
    expect(applyEncryptionReloadFix(Hypercore, b4a)).toEqual({ applied: false, reason: 'already-applied' })
  })

  test('leaves a fixed upstream alone', () => {
    // Simulate upstream shipping the fix: the probe succeeds, so we must not
    // overwrite their implementation with ours.
    const fixed = function _reload (core) {
      const keys = Enc.deriveKeys(this.key, core.key, { block: false, compat: core.compat })
      this.blockKey = keys.block
      this.blindingKey = keys.blinding
    }
    Enc.prototype._reload = fixed
    expect(applyEncryptionReloadFix(Hypercore, b4a)).toEqual({ applied: false, reason: 'already-fixed' })
    expect(Enc.prototype._reload).toBe(fixed)
  })

  test('reports rather than throws when the shape is unrecognisable', () => {
    expect(applyEncryptionReloadFix({}, b4a)).toEqual({ applied: false, reason: 'not-found' })
    expect(applyEncryptionReloadFix(null, b4a)).toEqual({ applied: false, reason: 'not-found' })
  })
})

describe('isBlockMode', () => {
  test('survives an instance a prior broken reload already emptied', () => {
    // The state a device is in right now: blockKey undefined from an earlier
    // reload. Comparing against that must not throw.
    expect(isBlockMode({ key: KEY, blockKey: undefined }, b4a)).toBe(false)
    expect(isBlockMode({ key: KEY, blockKey: null }, b4a)).toBe(false)
  })

  test('detects genuine block mode', () => {
    expect(isBlockMode({ key: KEY, blockKey: KEY }, b4a)).toBe(true)
    expect(isBlockMode({ key: KEY, blockKey: b4a.alloc(32, 9) }, b4a)).toBe(false)
  })
})
