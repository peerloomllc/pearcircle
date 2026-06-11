const b4a = require('b4a')
const { admissionChannelId } = require('../src/seederAdmission')
const { topicForCircleKey } = require('../src/swarm')

// Proposal 2026-06-11-circleid-channel-binding: the seeder-admission channel id
// is derived from the circle's bootstrap (not its arbitrary circleId), so a
// mislabeled circleId can't cross-pair two circles' admission channels.

const BOOT_A = b4a.alloc(32, 1).toString('hex')
const BOOT_B = b4a.alloc(32, 2).toString('hex')

describe('admissionChannelId', () => {
  test('is a stable 32-byte id for a given bootstrap', () => {
    const a1 = admissionChannelId(BOOT_A)
    const a2 = admissionChannelId(BOOT_A)
    expect(a1.length).toBe(32)
    expect(b4a.equals(a1, a2)).toBe(true)
  })

  test('differs for different bootstraps (no cross-pair)', () => {
    expect(b4a.equals(admissionChannelId(BOOT_A), admissionChannelId(BOOT_B))).toBe(false)
  })

  test('differs from the swarm topic for the same circle (domain separation)', () => {
    // Same 32 bytes used as both bootstrap and circleKey: the label prefix must
    // still keep the admission id distinct from blake2b(circleKey).
    const same = b4a.alloc(32, 7).toString('hex')
    expect(b4a.equals(admissionChannelId(same), topicForCircleKey(same))).toBe(false)
  })

  test('rejects a non-hex / wrong-length bootstrap', () => {
    expect(() => admissionChannelId('nothex')).toThrow()
    expect(() => admissionChannelId(b4a.alloc(16, 1).toString('hex'))).toThrow()
    expect(() => admissionChannelId(undefined)).toThrow()
  })
})
