const { shouldHealSelfTip } = require('../src/lib/lastKnownHeal')

const OURS = 'a'.repeat(64)
const THEIRS = 'b'.repeat(64)

describe('shouldHealSelfTip', () => {
  test('heals a tip we published in the clear', () => {
    const r = shouldHealSelfTip({
      hasEncryptionKey: true,
      tipReason: 'unparseable',
      recoveredPubkey: OURS,
      ourPubkey: OURS,
    })
    expect(r).toEqual({ heal: true, reason: 'plaintext-tip' })
  })

  test('does nothing when the tip already decrypts', () => {
    expect(shouldHealSelfTip({ hasEncryptionKey: true, tipReason: null, recoveredPubkey: OURS, ourPubkey: OURS }))
      .toEqual({ heal: false, reason: 'not-plaintext' })
  })

  test('does nothing for an empty or absent tip', () => {
    for (const tipReason of ['empty', 'absent', 'error']) {
      expect(shouldHealSelfTip({ hasEncryptionKey: true, tipReason, recoveredPubkey: OURS, ourPubkey: OURS }).heal).toBe(false)
    }
  })

  test('refuses without a key, since rewriting would republish in the clear', () => {
    // The failure mode this whole fix exists to prevent. Healing without a key
    // would write the position out in the open a second time.
    expect(shouldHealSelfTip({ hasEncryptionKey: false, tipReason: 'unparseable', recoveredPubkey: OURS, ourPubkey: OURS }))
      .toEqual({ heal: false, reason: 'no-key' })
  })

  test('only ever republishes our own position', () => {
    expect(shouldHealSelfTip({ hasEncryptionKey: true, tipReason: 'unparseable', recoveredPubkey: THEIRS, ourPubkey: OURS }))
      .toEqual({ heal: false, reason: 'not-ours' })
    expect(shouldHealSelfTip({ hasEncryptionKey: true, tipReason: 'unparseable', recoveredPubkey: undefined, ourPubkey: OURS }))
      .toEqual({ heal: false, reason: 'not-ours' })
  })

  test('tolerates being called with nothing', () => {
    expect(shouldHealSelfTip().heal).toBe(false)
    expect(shouldHealSelfTip({}).heal).toBe(false)
  })
})
