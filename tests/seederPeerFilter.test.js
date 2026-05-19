// Peer-filter for revoked seeder enforcement.
// Proposal 2026-05-19-blind-seeder-peers slice 3d.

const { isConnectionFromRevokedSeeder } = require('../src/lib/seederPeerFilter')

describe('isConnectionFromRevokedSeeder', () => {
  const remotePubkeyHex = 'a'.repeat(64)
  const otherPubkeyHex = 'b'.repeat(64)

  // Construct a getSeederRow mock from a circleId → row map.
  function mockGetter (rowsByCircle) {
    return async (circleId, pubkey) => {
      const circleMap = rowsByCircle[circleId]
      if (!circleMap) return null
      return circleMap[pubkey] ?? null
    }
  }

  test('returns false when no circles', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: [],
      getSeederRow: mockGetter({}),
    })
    expect(result).toBe(false)
  })

  test('returns false when remote is not a seeder for any circle', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1', 'c2'],
      getSeederRow: mockGetter({
        c1: { [otherPubkeyHex]: { pubkey: otherPubkeyHex, revoked: false } },
        c2: { [otherPubkeyHex]: { pubkey: otherPubkeyHex, revoked: true } },
      }),
    })
    expect(result).toBe(false)
  })

  test('returns false when remote is an admitted (non-revoked) seeder', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
      }),
    })
    expect(result).toBe(false)
  })

  test('returns true when remote is revoked in any of the circles', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1', 'c2', 'c3'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
        c2: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
        c3: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
      }),
    })
    expect(result).toBe(true)
  })

  test('returns true even if only one circle marks the remote as revoked', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
      }),
    })
    expect(result).toBe(true)
  })

  test('returns false on missing getSeederRow function', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: null,
    })
    expect(result).toBe(false)
  })

  test('returns false on missing remotePubkeyHex', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex: '',
      circleIds: ['c1'],
      getSeederRow: mockGetter({}),
    })
    expect(result).toBe(false)
  })

  test('treats missing revoked field as not revoked', async () => {
    const result = await isConnectionFromRevokedSeeder({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex } },  // no revoked field
      }),
    })
    expect(result).toBe(false)
  })
})
